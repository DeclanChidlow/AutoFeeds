"use strict";

import { JSONParse } from "json-with-bigint";

const API_BASE = process.env["STOAT_API_URL"] || "https://api.stoat.chat/0.8";

// Permission bit masks used by fetchMember's hasPermission wrapper
const PERM: Record<string, bigint> = { ManageChannel: 1n, ManageServer: 2n };

export interface BotUser {
	_id: string;
	username?: string;
	bot?: boolean;
}

export interface ChannelData {
	_id: string;
	channel_type?: string;
	recipients?: string[];
	server?: string;
}

export interface ServerData {
	_id: string;
	owner?: string;
}

export interface MemberContext {
	hasPermission(...perms: string[]): boolean;
}

export interface MessageContext {
	id: string;
	authorId: string;
	channelId: string;
	content: string;
	author: BotUser | null;
	channel: { id: string; type: string | null; server: { id: string } | null } | null;
	server: { id: string; ownerId: string; fetchMember: (userId: string) => Promise<MemberContext | null> } | null;
	reply: (data: string | object) => Promise<unknown>;
	edit: (data: object) => Promise<unknown>;
}

class StoatApiError extends Error {
	status?: number;
	type?: string;
}

class StoatClient {
	botUser: BotUser | null = null;
	wsPing = -1;

	private _token: string | null = null;
	private _ws: WebSocket | null = null;
	private _wsUrl: string | null = null;
	private _heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	private _pongTimer: ReturnType<typeof setTimeout> | null = null;

	// Caches populated from the Ready event / API calls
	private _users = new Map<string, any>();
	private _servers = new Map<string, any>();
	private _channels = new Map<string, any>();
	private _members = new Map<string, any>(); // "serverId:userId" → data

	// Callbacks
	private _onMessage: ((event: any) => void) | null = null;

	// Track intentional disconnects so onclose doesn't kill the process
	private _intentionalClose = false;

	async _request(method: string, path: string, { body, extraHeaders, params }: { body?: unknown; extraHeaders?: Record<string, string>; params?: Record<string, unknown> } = {}): Promise<any> {
		const url = params
			? (() => {
					const u = new URL(API_BASE + path);
					for (const [k, v] of Object.entries(params)) {
						u.searchParams.set(k, String(v));
					}
					return u.toString();
				})()
			: API_BASE + path;

		const fetchOpts: RequestInit = {
			method,
			headers: {
				...(body !== undefined ? { "Content-Type": "application/json" } : {}),
				...this._authHeaders(),
				...(extraHeaders || {}),
			},
		};
		if (body !== undefined) fetchOpts.body = JSON.stringify(body);

		const res = await fetch(url, fetchOpts);

		if (!res.ok) {
			const text = await res.text();
			const err = new StoatApiError(`${method} ${path} → ${res.status}`);
			err.status = res.status;
			try {
				const p = JSON.parse(text) as { type?: string };
				if (p.type) err.type = p.type;
			} catch (_) {
				/* ignore non-JSON error bodies */
			}
			throw err;
		}
		if (res.status === 204) return null;
		return JSONParse(await res.text());
	}

	_authHeaders(): Record<string, string> {
		return { "x-bot-token": this._token ?? "" };
	}

	async get(path: string, params?: Record<string, unknown>): Promise<any> {
		return this._request("GET", path, { params });
	}

	async post(path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<any> {
		return this._request("POST", path, { body, extraHeaders });
	}

	async patch(path: string, body?: unknown): Promise<any> {
		return this._request("PATCH", path, { body });
	}

	async sendMessage(channelId: string, data: string | object): Promise<any> {
		const body = typeof data === "string" ? { content: data } : data;
		return this.post(`/channels/${channelId}/messages`, body, {
			"Idempotency-Key": crypto.randomUUID(),
		});
	}

	async replyToMessage(event: { channel: string; _id: string }, data: string | object, mention?: boolean): Promise<{ id: string; edit: (d: object) => Promise<any> }> {
		const body = typeof data === "string" ? { content: data } : data;
		const result = await this.post(`/channels/${event.channel}/messages`, { ...body, replies: [{ id: event._id, mention: mention ?? true }] }, { "Idempotency-Key": crypto.randomUUID() });
		if (!result) {
			throw new Error("Message creation returned unexpected 204");
		}
		return {
			id: result._id,
			edit: (d) => this.patch(`/channels/${event.channel}/messages/${result._id}`, d),
		};
	}

	makeMessageContext(event: any): MessageContext {
		const channelData = this._channels.get(event.channel);
		// Derive the server ID from the channel cache, or fall back to the member data embedded in the Message event (so commands in channels created after the Ready event still work).
		const serverId = channelData?.server || event.member?._id?.server;
		const serverData = serverId ? this._servers.get(serverId) : null;

		return {
			id: event._id,
			authorId: event.author,
			channelId: event.channel,
			content: event.content ?? "",
			author: this._users.get(event.author) ?? null,

			channel: channelData
				? { id: channelData._id, type: channelData.channel_type ?? null, server: serverData ? { id: serverData._id } : null }
				: serverId
					? { id: event.channel, type: null, server: { id: serverId } }
					: null,

			server: serverData
				? {
						id: serverData._id,
						ownerId: serverData.owner,
						fetchMember: (userId: string) => this.fetchMember(serverData._id, userId),
					}
				: null,

			reply: (data) => this.replyToMessage(event, data),
			edit: (data) => this.patch(`/channels/${event.channel}/messages/${event._id}`, data),
		};
	}

	async openDM(userId: string): Promise<{ id: string; sendMessage: (data: string | object) => Promise<any> }> {
		// Look for an existing DM in the cache
		for (const ch of this._channels.values()) {
			if (ch.channel_type === "DirectMessage" && ch.recipients?.includes(userId)) {
				return { id: ch._id, sendMessage: (data) => this.sendMessage(ch._id, data) };
			}
		}

		// Create a new DM channel
		const data = await this.get(`/users/${userId}/dm`);
		this._channels.set(data._id, data);
		return { id: data._id, sendMessage: (d) => this.sendMessage(data._id, d) };
	}

	/**
	 * Public accessor — returns cached channel data or fetches + caches it.
	 */
	async getChannel(channelId: string): Promise<ChannelData | null> {
		let data = this._channels.get(channelId) as ChannelData | undefined;
		if (!data) {
			data = (await this.get(`/channels/${channelId}`)) as ChannelData | undefined;
			if (data) this._channels.set(data._id, data);
		}
		return data ?? null;
	}

	/**
	 * Public accessor — returns cached server data or fetches + caches it.
	 */
	async getServer(serverId: string): Promise<ServerData | null> {
		let data = this._servers.get(serverId) as ServerData | undefined;
		if (!data) {
			data = (await this.get(`/servers/${serverId}`)) as ServerData | undefined;
			if (data) this._servers.set(data._id, data);
		}
		return data ?? null;
	}

	async fetchMember(serverId: string, userId: string | { id: string }): Promise<MemberContext | null> {
		const id = typeof userId === "string" ? userId : userId.id;
		const key = serverId + ":" + id;

		let m = this._members.get(key);
		if (!m) {
			m = await this.get(`/servers/${serverId}/members/${id}`);
			if (m) this._members.set(key, m);
		}
		if (!m) return null;

		const serverData = this._servers.get(serverId);

		return {
			hasPermission(...perms: string[]): boolean {
				const needed = perms.reduce((a, n) => {
					const bit = PERM[n];
					if (bit === undefined) {
						throw new Error(`Unknown permission: ${n}`);
					}
					return a | bit;
				}, 0n);

				if (serverData?.owner === (m._id?.user ?? m._id)) return true;

				let perm = typeof serverData?.default_permissions === "bigint" ? serverData.default_permissions : BigInt(serverData?.default_permissions ?? 0);

				if (m.roles && serverData?.roles) {
					for (const roleId of m.roles as string[]) {
						const role = serverData.roles[roleId];
						if (role?.permissions) {
							const a = typeof role.permissions.a === "bigint" ? role.permissions.a : BigInt(role.permissions.a ?? 0);
							const d = typeof role.permissions.d === "bigint" ? role.permissions.d : BigInt(role.permissions.d ?? 0);
							perm = (perm | a) & ~d;
						}
					}
				}

				return (perm & needed) === needed;
			},
		};
	}

	async connect(token: string): Promise<void> {
		this._token = token;
		await this._fetchWsUrl();
		return this._connectWS();
	}

	async _fetchWsUrl(): Promise<void> {
		const res = await fetch(API_BASE);
		if (!res.ok) throw new Error(`API root returned ${res.status}`);
		const data = JSONParse(await res.text()) as Record<string, unknown>;
		const ws = data["ws"] ?? data["gateway"] ?? data["ws_url"] ?? data["websocket_url"];
		if (typeof ws !== "string") throw new Error("API root missing WebSocket URL");
		this._wsUrl = ws;
	}

	disconnect(): void {
		this._intentionalClose = true;
		this._cleanupWS();
	}

	onMessage(fn: (event: any) => void): void {
		this._onMessage = fn;
	}

	_connectWS(): Promise<void> {
		this._cleanupWS();
		this._intentionalClose = false;
		if (!this._wsUrl) return Promise.reject(new Error("WebSocket URL not set"));

		return new Promise((resolve, reject) => {
			const url = new URL(this._wsUrl as string);
			url.searchParams.set("version", "1");
			url.searchParams.set("format", "json");
			url.searchParams.set("token", this._token ?? "");

			const ws = new WebSocket(url.toString());
			this._ws = ws;

			const connectTimer: ReturnType<typeof setTimeout> = setTimeout(() => {
				ws.close();
				reject(new Error("WebSocket connection timeout"));
			}, 10_000);

			ws.onopen = () => {
				clearTimeout(connectTimer);
				this._heartbeatTimer = setInterval(() => {
					if (this._ws && this._ws.readyState === WebSocket.OPEN) {
						this._ws.send(JSON.stringify({ type: "Ping", data: +new Date() }));
						this._pongTimer = setTimeout(() => this.disconnect(), 10_000);
					}
				}, 30_000);
			};

			ws.onmessage = (event) => {
				clearTimeout(connectTimer);
				const raw = typeof event === "string" ? event : typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer);
				this._handleWSEvent(JSONParse(raw), resolve);
			};

			ws.onerror = (err) => {
				clearTimeout(connectTimer);
				console.error("Stoat WebSocket error:", err);
				reject(err instanceof Error ? err : new Error("WebSocket error"));
			};

			ws.onclose = () => {
				this._cleanupWS();
				if (!this._intentionalClose) {
					console.log("Bot disconnected from Stoat. Exiting to allow Docker restart.");
					process.exit(1);
				}
			};
		});
	}

	_cleanupWS(): void {
		clearInterval(this._heartbeatTimer ?? undefined);
		clearTimeout(this._pongTimer ?? undefined);
		this._heartbeatTimer = null;
		this._pongTimer = null;
		if (this._ws) {
			try {
				this._ws.close();
			} catch (_) {
				/* best effort */
			}
			this._ws = null;
		}
	}

	_handleWSEvent(event: any, readyResolve?: () => void): void {
		switch (event.type) {
			case "Ping":
				if (this._ws && this._ws.readyState === WebSocket.OPEN) {
					this._ws.send(JSON.stringify({ type: "Pong", data: event.data }));
				}
				break;

			case "Pong":
				clearTimeout(this._pongTimer ?? undefined);
				this.wsPing = +new Date() - event.data;
				break;

			case "Ready":
				if (event.users) {
					for (const u of event.users) {
						this._users.set(u._id, u);
						if (u.relationship === "User") this.botUser = u;
					}
				}
				if (event.servers) for (const s of event.servers) this._servers.set(s._id, s);
				if (event.channels) for (const c of event.channels) this._channels.set(c._id, c);
				if (event.members) {
					for (const m of event.members) this._members.set(m._id.server + ":" + m._id.user, m);
				}

				console.log(`Bot connected to Stoat as ${this.botUser?.username || "AutoFeeds"}!`);
				if (readyResolve) readyResolve();
				break;

			case "Message":
				if (event.user) this._users.set(event.user._id, event.user);
				if (event.member) this._members.set(event.member._id.server + ":" + event.member._id.user, event.member);
				// Fire-and-forget: warm the channel cache for channels created after Ready
				if (!this._channels.has(event.channel)) {
					this.get(`/channels/${event.channel}`)
						.then((data) => {
							if (data) this._channels.set(data._id, data);
						})
						.catch(() => {});
				}
				if (this._onMessage) this._onMessage(event);
				break;

			case "Bulk":
				if (Array.isArray(event.v)) {
					for (const item of event.v) this._handleWSEvent(item, readyResolve);
				}
				break;

			case "Authenticated":
				break;

			case "Error":
				console.error("Stoat server error:", event);
				break;

			default:
				break;
		}
	}
}

export { StoatClient, StoatApiError, API_BASE };
