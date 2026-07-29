"use strict";

const { JSONParse } = require("json-with-bigint");

const API_BASE = process.env["STOAT_API_URL"] || "https://api.stoat.chat/0.8";

// Permission bit masks used by fetchMember's hasPermission wrapper
const PERM = { ManageChannel: 1n, ManageServer: 2n };

class StoatClient {
	constructor() {
		this.botUser = null;
		this.wsPing = -1;

		this._token = null;
		this._ws = null;
		this._wsUrl = null;
		this._heartbeatTimer = null;
		this._pongTimer = null;

		// Caches populated from the Ready event / API calls
		this._users = new Map();
		this._servers = new Map();
		this._channels = new Map();
		this._members = new Map(); // "serverId:userId" → data

		// Callbacks
		this._onMessage = null;

		// Track intentional disconnects so onclose doesn't kill the process
		this._intentionalClose = false;
	}

	async _request(method, path, { body, extraHeaders, params } = {}) {
		const url = params
			? (() => {
					const u = new URL(API_BASE + path);
					for (const [k, v] of Object.entries(params)) {
						u.searchParams.set(k, String(v));
					}
					return u.toString();
				})()
			: API_BASE + path;

		const fetchOpts = {
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
			const err = new Error(`${method} ${path} → ${res.status}`);
			err.status = res.status;
			try {
				const p = JSON.parse(text);
				if (p.type) err.type = p.type;
			} catch (_) {
				/* ignore non-JSON error bodies */
			}
			throw err;
		}
		if (res.status === 204) return null;
		return JSONParse(await res.text());
	}

	_authHeaders() {
		return { "x-bot-token": this._token };
	}

	async get(path, params) {
		return this._request("GET", path, { params });
	}

	async post(path, body, extraHeaders) {
		return this._request("POST", path, { body, extraHeaders });
	}

	async patch(path, body) {
		return this._request("PATCH", path, { body });
	}

	async sendMessage(channelId, data) {
		const body = typeof data === "string" ? { content: data } : data;
		return this.post(`/channels/${channelId}/messages`, body, {
			"Idempotency-Key": crypto.randomUUID(),
		});
	}

	async replyToMessage(event, data, mention) {
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

	makeMessageContext(event) {
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
				? { id: channelData._id, type: channelData.channel_type, server: serverData ? { id: serverData._id } : null }
				: serverId
					? { id: event.channel, type: null, server: { id: serverId } }
					: null,

			server: serverData
				? {
						id: serverData._id,
						ownerId: serverData.owner,
						fetchMember: (userId) => this.fetchMember(serverData._id, userId),
					}
				: null,

			reply: (data) => this.replyToMessage(event, data),
			edit: (data) => this.patch(`/channels/${event.channel}/messages/${event._id}`, data),
		};
	}

	async openDM(userId) {
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
	async getChannel(channelId) {
		let data = this._channels.get(channelId);
		if (!data) {
			data = await this.get(`/channels/${channelId}`);
			if (data) this._channels.set(data._id, data);
		}
		return data ?? null;
	}

	/**
	 * Public accessor — returns cached server data or fetches + caches it.
	 */
	async getServer(serverId) {
		let data = this._servers.get(serverId);
		if (!data) {
			data = await this.get(`/servers/${serverId}`);
			if (data) this._servers.set(data._id, data);
		}
		return data ?? null;
	}

	async fetchMember(serverId, userId) {
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
			hasPermission(...perms) {
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
					for (const roleId of m.roles) {
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

	async connect(token) {
		this._token = token;
		await this._fetchWsUrl();
		return this._connectWS();
	}

	async _fetchWsUrl() {
		const res = await fetch(API_BASE);
		if (!res.ok) throw new Error(`API root returned ${res.status}`);
		const data = JSONParse(await res.text());
		const ws = data.ws ?? data.gateway ?? data.ws_url ?? data.websocket_url;
		if (typeof ws !== "string") throw new Error("API root missing WebSocket URL");
		this._wsUrl = ws;
	}

	disconnect() {
		this._intentionalClose = true;
		this._cleanupWS();
	}

	onMessage(fn) {
		this._onMessage = fn;
	}

	_connectWS() {
		this._cleanupWS();
		this._intentionalClose = false;

		return new Promise((resolve, reject) => {
			const url = new URL(this._wsUrl);
			url.searchParams.set("version", "1");
			url.searchParams.set("format", "json");
			url.searchParams.set("token", this._token);

			const ws = new WebSocket(url.toString());
			this._ws = ws;

			const connectTimer = setTimeout(() => {
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
				const raw = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
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

	_cleanupWS() {
		clearInterval(this._heartbeatTimer);
		clearTimeout(this._pongTimer);
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

	_handleWSEvent(event, readyResolve) {
		switch (event.type) {
			case "Ping":
				if (this._ws && this._ws.readyState === WebSocket.OPEN) {
					this._ws.send(JSON.stringify({ type: "Pong", data: event.data }));
				}
				break;

			case "Pong":
				clearTimeout(this._pongTimer);
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

module.exports = { StoatClient, API_BASE };
