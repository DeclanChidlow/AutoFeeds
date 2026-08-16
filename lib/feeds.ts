"use strict";

import type Parser from "rss-parser";
import type { Ctx, Feed, FeedItem, FilterRule } from "./types";
import { verboseLog } from "./utils";
import { renderTemplate } from "./templates";

class FeedGoneError extends Error {
	feedGone = true;
	status: number;

	constructor(message: string, status: number) {
		super(message);
		this.status = status;
	}
}

function looksLikePodcast(text: string): boolean {
	if (/xmlns:itunes|xmlns:podcast|<\/?itunes:|<\/?podcast:/i.test(text)) return true;
	return /<enclosure[^>]*type=["']audio\//i.test(text);
}

async function detectFeedType(url: string): Promise<{ type?: string | null; error?: string | number }> {
	if (!url || typeof url !== "string" || url.trim() === "") {
		console.error("detectFeedType called with invalid URL:", url);
		return { error: "invalid_url" };
	}

	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 5000);

		const response = await fetch(url, {
			headers: { "User-Agent": "AutoFeeds/1.0" },
			signal: controller.signal,
		});
		clearTimeout(timeout);

		if (!response.ok) return { error: response.status };

		const contentType = response.headers.get("content-type") || "";
		const text = await response.text();

		// JSON Feed
		if (contentType.includes("application/json") || text.trim().startsWith("{")) {
			try {
				const json = JSON.parse(text) as { version?: string; expired?: boolean };
				if (json.version && json.version.startsWith("https://jsonfeed.org/version/")) {
					return json.expired === true ? { type: "expired_json" } : { type: "json" };
				}
			} catch (_) {
				/* not JSON */
			}
		}

		// XML feeds
		if (text.includes("<rss") || text.includes("<feed")) {
			if (text.includes("<rss")) return { type: looksLikePodcast(text) ? "podcast" : "rss" };
			if (text.includes("<feed") && text.includes('xmlns="http://www.w3.org/2005/Atom"')) return { type: "atom" };
		}

		return { type: null };
	} catch (error) {
		console.error("Error detecting feed type:", error);
		return { error: "fetch_failed" };
	}
}

function shouldSkipFeedCheck(feed: Feed): boolean {
	if (feed.nextCheckTime && Date.now() < feed.nextCheckTime) return true;

	const now = new Date();

	if (feed.skipHours && feed.skipHours.includes(now.getUTCHours())) return true;

	const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
	if (feed.skipDays && feed.skipDays.includes(days[now.getUTCDay()])) return true;

	return false;
}

function processCacheHeaders(feed: Feed, response: Response): void {
	feed.etag = response.headers.get("etag");
	feed.lastModified = response.headers.get("last-modified");

	const cacheControl = response.headers.get("cache-control");
	const expires = response.headers.get("expires");

	let maxAge = 0;
	if (cacheControl) {
		const match = cacheControl.match(/max-age=(\d+)/);
		if (match) maxAge = parseInt(match[1], 10);
	}

	if (maxAge > 0) {
		feed.nextCheckTime = Date.now() + maxAge * 1000;
	} else if (expires) {
		const expiresTime = new Date(expires).getTime();
		if (!isNaN(expiresTime) && expiresTime > Date.now()) {
			feed.nextCheckTime = expiresTime;
		}
	}
}

/**
 * Build a safe Date from a feed date string. Returns Date.now() if the input is missing, empty, or unparseable (to avoid Invalid Date objects).
 */
function safeFeedDate(...candidates: unknown[]): Date {
	for (const c of candidates) {
		if (!c) continue;
		const d = new Date(c as string);
		if (!isNaN(d.getTime())) return d;
	}
	return new Date();
}

function formatFeedMessage(item: FeedItem, feed?: Feed): string {
	if (feed?.template) {
		const rendered = renderTemplate(feed.template, item);
		if (rendered) return rendered;
	}

	const title = (item.title || "").substring(0, 300);
	const parts: string[] = [`**${title}${item.title && item.title.length > 300 ? "…" : ""}**`];

	if (item.description) {
		const description = item.description.substring(0, 200);
		parts.push(`${description}${description.length === 200 ? "…" : ""}`);
	}

	if (item.isPodcast) {
		const meta: string[] = [];
		if (item.episodeType && String(item.episodeType).toLowerCase() !== "full") meta.push(String(item.episodeType));
		if (item.seasonNumber) meta.push(`Season ${item.seasonNumber}`);
		if (item.episodeNumber) meta.push(`Episode ${item.episodeNumber}`);
		if (item.duration) meta.push(item.duration);
		if (meta.length) parts.push(`🎙️ ${meta.join(" · ")}`);
	}

	if (item.link) parts.push(`🔗: ${item.link}`);
	if (item.isPodcast && item.audioUrl) parts.push(`🎧: ${item.audioUrl}`);

	return parts.join("\n");
}

/**
 * Normalise an itunes:duration value ("1234", "12:34", or "1:12:34") to a display-friendly h:mm:ss / m:ss string. Returns null for invalid values.
 */
function formatItunesDuration(raw: unknown): string | null {
	if (raw === null || raw === undefined) return null;

	const str = String(raw).trim();
	if (!str) return null;

	let seconds: number;
	if (/^\d+(\.\d+)?$/.test(str)) {
		seconds = Math.round(parseFloat(str));
	} else {
		const parts = str.split(":").map((p) => parseInt(p, 10));
		if (parts.length === 0 || parts.length > 3 || parts.some((p) => isNaN(p))) return null;
		seconds = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts.length === 2 ? parts[0] * 60 + parts[1] : parts[0];
	}

	if (!seconds || seconds <= 0) return null;

	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = seconds % 60;
	return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

const FILTER_FIELDS: Record<string, keyof FeedItem> = {
	title: "title",
	body: "description",
	description: "description",
	link: "link",
	audio: "audioUrl",
	duration: "duration",
	episode: "episodeNumber",
	season: "seasonNumber",
	type: "episodeType",
};

const FILTER_OPERATORS = ["contains", "equals", "missing", "present"];

function shouldBlockItem(item: FeedItem, rules: FilterRule[]): boolean {
	return rules.some((rule) => ruleMatchesItem(rule, item));
}

function ruleMatchesItem(rule: FilterRule, item: FeedItem): boolean {
	const field = FILTER_FIELDS[String(rule.field_name || "").toLowerCase()];
	if (!field) return false;

	const raw = item[field];
	const value = raw === null || raw === undefined ? "" : String(raw);

	switch (String(rule.operator || "").toLowerCase()) {
		case "contains": {
			const needle = String(rule.filter_value || "").toLowerCase();
			return needle !== "" && value !== "" && value.toLowerCase().includes(needle);
		}
		case "equals":
			return value.toLowerCase() === String(rule.filter_value || "").toLowerCase();
		case "missing":
			return value === "";
		case "present":
			return value !== "";
		default:
			return false;
	}
}

async function parseXmlFeed(parser: Parser, feed: Feed): Promise<FeedItem[]> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 10000);

	try {
		const headers: Record<string, string> = {
			"User-Agent": "AutoFeeds/1.0",
			"Accept":
				"application/rss+xml, application/xml, application/atom+xml, application/rdf+xml;q=0.9, application/xml;q=0.8, text/xml;q=0.8, text/html;q=0.7, unknown/unknown;q=0.1, application/unknown;q=0.1, */*;q=0.1",
		};

		if (feed.etag) headers["If-None-Match"] = feed.etag;
		if (feed.lastModified) headers["If-Modified-Since"] = feed.lastModified;

		const response = await fetch(feed.url, { headers, signal: controller.signal });

		if (response.status === 304) return [];
		if (response.status === 402) throw new FeedGoneError(`Feed ${feed.url} returned HTTP 402`, 402);
		if (response.status === 429) return [];
		if (!response.ok) throw new Error(`HTTP Error ${response.status}: ${response.statusText}`);

		const text = await response.text();
		const feedData = await parser.parseString(text);

		// Only update cache headers after a successful parse
		processCacheHeaders(feed, response);

		if (feedData.ttl) feed.ttl = parseInt(feedData.ttl, 10);
		if (feedData.skipHours) feed.skipHours = String(feedData.skipHours).match(/\d+/g)?.map(Number) || [];
		if (feedData.skipDays) {
			feed.skipDays =
				String(feedData.skipDays)
					.match(/(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)/gi)
					?.map((d) => d.charAt(0).toUpperCase() + d.slice(1).toLowerCase()) || [];
		}

		if (feed.ttl) {
			const ttlLimit = Date.now() + feed.ttl * 60 * 1000;
			if (!feed.nextCheckTime || ttlLimit > feed.nextCheckTime) feed.nextCheckTime = ttlLimit;
		}

		const feedTitle = feedData.title || null;
		const feedLink = feedData.link || null;

		return feedData.items.map((item: any): FeedItem => {
			const enclosure = item.enclosure || null;
			const mapped: FeedItem = {
				id: item.guid || item.link || item.title,
				title: item.title,
				link: item.link,
				description: item.contentSnippet || item.content,
				bodyHtml: item.content || null,
				published: safeFeedDate(item.pubDate, item.isoDate),
				author: item.creator || item.author || item.itunesAuthor || null,
				categories: Array.isArray(item.categories) ? item.categories : [],
				audioUrl: enclosure?.url || null,
				audioType: enclosure?.type || null,
				audioLength: enclosure?.length ?? null,
				feedTitle,
				feedLink,
			};

			if (feed.feed_type === "podcast") {
				mapped.isPodcast = true;
				mapped.episodeType = item.itunesEpisodeType || null;
				mapped.episodeNumber = item.itunesEpisode ?? item.podcastEpisode ?? null;
				mapped.seasonNumber = item.itunesSeason ?? item.podcastSeason ?? null;
				mapped.duration = formatItunesDuration(item.itunesDuration);
			}

			return mapped;
		});
	} catch (error) {
		console.error(`Error parsing XML feed ${feed.url}:`, (error as Error).message);
		return [];
	} finally {
		clearTimeout(timeout);
	}
}

async function parseJsonFeed(feed: Feed): Promise<FeedItem[]> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 10000);

	try {
		const headers: Record<string, string> = { "User-Agent": "AutoFeeds/1.0" };
		if (feed.etag) headers["If-None-Match"] = feed.etag;
		if (feed.lastModified) headers["If-Modified-Since"] = feed.lastModified;

		const response = await fetch(feed.url, { headers, signal: controller.signal });

		if (response.status === 304) return [];
		if (response.status === 402) throw new FeedGoneError(`Feed ${feed.url} returned HTTP 402`, 402);
		if (response.status === 429) return [];
		if (!response.ok) throw new Error(`HTTP Error ${response.status}`);

		const feedData = (await response.json()) as any;

		// Only update cache headers after a successful parse
		processCacheHeaders(feed, response);

		const feedTitle = feedData.title || null;
		const feedLink = feedData.home_page_url || feedData.feed_url || null;

		return (feedData.items || []).map((item: any): FeedItem => {
			const mapped: FeedItem = {
				id: item.id || item.url || item.title,
				title: item.title,
				link: item.url || item.external_url,
				description: item.summary || item.content_text,
				bodyHtml: item.content_html || null,
				published: safeFeedDate(item.date_published, item.date_modified),
				author: item.author?.name || item.author || null,
				categories: Array.isArray(item.tags) ? item.tags : [],
				feedTitle,
				feedLink,
			};

			const audioAttachment = (item.attachments || []).find((a: any) => String(a.mime_type || "").startsWith("audio/"));
			if (audioAttachment) {
				mapped.audioUrl = audioAttachment.url;
				mapped.audioType = audioAttachment.mime_type || null;
				mapped.audioLength = audioAttachment.size_in_bytes ?? null;
			}

			return mapped;
		});
	} catch (error) {
		console.error(`Error parsing JSON feed ${feed.url}:`, (error as Error).message);
		return [];
	} finally {
		clearTimeout(timeout);
	}
}

async function checkAllFeeds(ctx: Ctx): Promise<void> {
	const { feeds } = ctx;
	verboseLog(`Checking ${feeds.size} feeds...`);

	for (const feed of feeds.values()) {
		if (shouldSkipFeedCheck(feed)) continue;

		try {
			await checkFeed(ctx, feed);
			await new Promise((resolve) => setTimeout(resolve, 1000));
		} catch (error) {
			console.error(`Error checking feed ${feed.url}:`, error);
		}
	}
}

async function _processFeedItems(ctx: Ctx, feed: Feed, shouldPost: boolean): Promise<{ newItemsCount: number } | undefined> {
	let items: FeedItem[] = [];

	if (feed.feed_type === "json") {
		items = await parseJsonFeed(feed);
	} else {
		items = await parseXmlFeed(ctx.parser, feed);
	}

	if (items.length === 0) return shouldPost ? { newItemsCount: 0 } : undefined;

	const [feedRows] = (await ctx.db.execute("SELECT id FROM feeds WHERE url = ? AND channel_id = ?", [feed.url, feed.channel_id])) as [{ id: number }[], unknown];
	if (feedRows.length === 0) return shouldPost ? { newItemsCount: 0 } : undefined;
	const feedId = feedRows[0].id;

	const [filterRows] = (await ctx.db.execute("SELECT id, field_name, operator, filter_value FROM feed_filters WHERE feed_id = ?", [feedId])) as [FilterRule[], unknown];

	let newItemsCount = 0;
	for (const item of items.slice(0, 5)) {
		try {
			// Blocked items are still recorded as seen so removing a filter
			// later doesn't re-post old items.
			const blocked = shouldBlockItem(item, filterRows);

			const [insertResult] = (await ctx.db.execute("INSERT IGNORE INTO feed_items (feed_id, item_id, title, link, published_at) VALUES (?, ?, ?, ?, ?)", [
				feedId,
				item.id ?? null,
				item.title ?? null,
				item.link ?? null,
				item.published ?? null,
			])) as [{ affectedRows: number }, unknown];

			if (insertResult.affectedRows > 0 && shouldPost && !blocked) {
				await postFeedItem(ctx, feed, item);
				newItemsCount++;
			}
		} catch (error) {
			console.error("Error processing feed item:", error);
		}
	}

	await ctx.db.execute("UPDATE feeds SET last_updated = CURRENT_TIMESTAMP WHERE id = ?", [feedId]);

	if (shouldPost && newItemsCount > 0) verboseLog(`Posted ${newItemsCount} new items from ${feed.url}`);

	return shouldPost ? { newItemsCount } : undefined;
}

async function _removeFeedAndNotify(ctx: Ctx, feed: Feed, status: number): Promise<void> {
	const reason = "now requires payment";
	console.log(`Feed ${feed.url} ${reason} — removing`);

	await ctx.db.execute("DELETE FROM feeds WHERE url = ? AND channel_id = ?", [feed.url, feed.channel_id]);
	ctx.feeds.delete(`${feed.url}-${feed.channel_id}`);
	ctx.setBotStatus();

	try {
		const serverData = await ctx.stoat.getServer(feed.server_id);
		if (serverData?.owner) {
			const dmChannel = await ctx.stoat.openDM(serverData.owner);
			await dmChannel.sendMessage(`⚠️ AutoFeeds removed the feed \`${feed.url}\` from <#${feed.channel_id}> because the feed ${reason} (HTTP ${status}).`);
		}
	} catch (err) {
		console.error("Failed to notify server owner about feed removal:", err);
	}
}

async function checkFeed(ctx: Ctx, feed: Feed): Promise<{ newItemsCount: number; error?: boolean }> {
	try {
		return (await _processFeedItems(ctx, feed, true)) ?? { newItemsCount: 0 };
	} catch (error) {
		if (error instanceof FeedGoneError) {
			await _removeFeedAndNotify(ctx, feed, error.status);
			return { newItemsCount: 0, error: true };
		}
		console.error(`Error checking feed ${feed.url}:`, error);
		return { newItemsCount: 0, error: true };
	}
}

async function initialiseFeed(ctx: Ctx, feed: Feed): Promise<void> {
	try {
		await _processFeedItems(ctx, feed, false);
	} catch (error) {
		console.error(`Error initialising feed ${feed.url}:`, error);
	}
}

async function postFeedItem(ctx: Ctx, feed: Feed, item: FeedItem): Promise<void> {
	try {
		const channelData = await ctx.stoat.getChannel(feed.channel_id);
		if (!channelData) {
			console.log(`Channel ${feed.channel_id} gone. Removing feed ${feed.url}`);
			await ctx.db.execute("DELETE FROM feeds WHERE url = ? AND channel_id = ?", [feed.url, feed.channel_id]);
			ctx.feeds.delete(`${feed.url}-${feed.channel_id}`);
			ctx.setBotStatus();
			return;
		}

		await ctx.stoat.sendMessage(channelData._id, formatFeedMessage(item, feed));
	} catch (error) {
		console.error("Error posting feed item:", error);
		await notifyServerOwner(ctx, feed);
	}
}

async function notifyServerOwner(ctx: Ctx, feed: Feed): Promise<void> {
	const cacheKey = `${feed.server_id}-${feed.channel_id}`;
	if (ctx.notifiedOwners.has(cacheKey)) return;

	try {
		const serverData = await ctx.stoat.getServer(feed.server_id);
		if (!serverData || !serverData.owner) return;

		const dmChannel = await ctx.stoat.openDM(serverData.owner);
		await dmChannel.sendMessage(
			`⚠️ AutoFeeds tried to post a feed update to <#${feed.channel_id}> for \`${feed.url}\`, but it failed. This is likely due to not having the required permissions.\nYou can consult the setup documentation here: https://automod.vale.rocks/docs/autofeeds/setup`,
		);

		ctx.notifiedOwners.add(cacheKey);
		setTimeout(() => ctx.notifiedOwners.delete(cacheKey), 86_400_000);
	} catch (err) {
		console.error("Failed to notify server owner:", err);
	}
}

export {
	detectFeedType,
	looksLikePodcast,
	shouldSkipFeedCheck,
	processCacheHeaders,
	parseXmlFeed,
	parseJsonFeed,
	checkAllFeeds,
	checkFeed,
	initialiseFeed,
	formatFeedMessage,
	formatItunesDuration,
	shouldBlockItem,
	FILTER_FIELDS,
	FILTER_OPERATORS,
	postFeedItem,
	notifyServerOwner,
};
