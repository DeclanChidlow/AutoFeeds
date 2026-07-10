"use strict";

const { verboseLog } = require("./utils");

async function detectFeedType(url) {
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
				const json = JSON.parse(text);
				if (json.version && json.version.startsWith("https://jsonfeed.org/version/")) {
					return json.expired === true ? { type: "expired_json" } : { type: "json" };
				}
			} catch (_) {
				/* not JSON */
			}
		}

		// XML feeds
		if (text.includes("<rss") || text.includes("<feed")) {
			if (text.includes("<rss")) return { type: "rss" };
			if (text.includes("<feed") && text.includes('xmlns="http://www.w3.org/2005/Atom"')) return { type: "atom" };
		}

		return { type: null };
	} catch (error) {
		console.error("Error detecting feed type:", error);
		return { error: "fetch_failed" };
	}
}

function shouldSkipFeedCheck(feed) {
	if (feed.nextCheckTime && Date.now() < feed.nextCheckTime) return true;

	const now = new Date();

	if (feed.skipHours && feed.skipHours.includes(now.getUTCHours())) return true;

	const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
	if (feed.skipDays && feed.skipDays.includes(days[now.getUTCDay()])) return true;

	return false;
}

function processCacheHeaders(feed, response) {
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
 * Build a safe Date from a feed date string. Returns Date.now() if the input
 * is missing, empty, or unparseable (to avoid Invalid Date objects).
 */
function safeFeedDate(...candidates) {
	for (const c of candidates) {
		if (!c) continue;
		const d = new Date(c);
		if (!isNaN(d.getTime())) return d;
	}
	return new Date();
}

function formatFeedMessage(item) {
	const title = (item.title || "").substring(0, 300);
	const parts = [`**${title}${item.title && item.title.length > 300 ? "…" : ""}**`];

	if (item.description) {
		const description = item.description.substring(0, 200);
		parts.push(`${description}${description.length === 200 ? "…" : ""}`);
	}

	if (item.link) parts.push(`🔗: ${item.link}`);

	return parts.join("\n");
}

async function parseXmlFeed(parser, feed) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 10000);

	try {
		const headers = {
			"User-Agent": "AutoFeeds/1.0",
			"Accept":
				"application/rss+xml, application/xml, application/atom+xml, application/rdf+xml;q=0.9, application/xml;q=0.8, text/xml;q=0.8, text/html;q=0.7, unknown/unknown;q=0.1, application/unknown;q=0.1, */*;q=0.1",
		};

		if (feed.etag) headers["If-None-Match"] = feed.etag;
		if (feed.lastModified) headers["If-Modified-Since"] = feed.lastModified;

		const response = await fetch(feed.url, { headers, signal: controller.signal });

		if (response.status === 304) return [];
		if (response.status === 402) {
			const err = new Error(`Feed ${feed.url} returned HTTP 402`);
			err.feedGone = true;
			err.status = 402;
			throw err;
		}
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

		return feedData.items.map((item) => ({
			id: item.guid || item.link || item.title,
			title: item.title,
			link: item.link,
			description: item.contentSnippet || item.content,
			published: safeFeedDate(item.pubDate, item.isoDate),
		}));
	} catch (error) {
		console.error(`Error parsing XML feed ${feed.url}:`, error.message);
		return [];
	} finally {
		clearTimeout(timeout);
	}
}

async function parseJsonFeed(feed) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 10000);

	try {
		const headers = { "User-Agent": "AutoFeeds/1.0" };
		if (feed.etag) headers["If-None-Match"] = feed.etag;
		if (feed.lastModified) headers["If-Modified-Since"] = feed.lastModified;

		const response = await fetch(feed.url, { headers, signal: controller.signal });

		if (response.status === 304) return [];
		if (response.status === 402) {
			const err = new Error(`Feed ${feed.url} returned HTTP 402`);
			err.feedGone = true;
			err.status = 402;
			throw err;
		}
		if (response.status === 429) return [];
		if (!response.ok) throw new Error(`HTTP Error ${response.status}`);

		const feedData = await response.json();

		// Only update cache headers after a successful parse
		processCacheHeaders(feed, response);

		return (feedData.items || []).map((item) => ({
			id: item.id || item.url || item.title,
			title: item.title,
			link: item.url || item.external_url,
			description: item.summary || item.content_text,
			published: safeFeedDate(item.date_published, item.date_modified),
		}));
	} catch (error) {
		console.error(`Error parsing JSON feed ${feed.url}:`, error.message);
		return [];
	} finally {
		clearTimeout(timeout);
	}
}

async function checkAllFeeds(ctx) {
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

async function _processFeedItems(ctx, feed, shouldPost) {
	let items = [];

	if (feed.feed_type === "json") {
		items = await parseJsonFeed(feed);
	} else {
		items = await parseXmlFeed(ctx.parser, feed);
	}

	if (items.length === 0) return shouldPost ? { newItemsCount: 0 } : undefined;

	const [feedRows] = await ctx.db.execute("SELECT id FROM feeds WHERE url = ? AND channel_id = ?", [feed.url, feed.channel_id]);
	if (feedRows.length === 0) return shouldPost ? { newItemsCount: 0 } : undefined;
	const feedId = feedRows[0].id;

	let newItemsCount = 0;
	for (const item of items.slice(0, 5)) {
		try {
			const [insertResult] = await ctx.db.execute("INSERT IGNORE INTO feed_items (feed_id, item_id, title, link, published_at) VALUES (?, ?, ?, ?, ?)", [
				feedId,
				item.id ?? null,
				item.title ?? null,
				item.link ?? null,
				item.published ?? null,
			]);

			if (insertResult.affectedRows > 0 && shouldPost) {
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

async function _removeFeedAndNotify(ctx, feed, status) {
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

async function checkFeed(ctx, feed) {
	try {
		return await _processFeedItems(ctx, feed, true);
	} catch (error) {
		if (error.feedGone) {
			await _removeFeedAndNotify(ctx, feed, error.status);
			return { newItemsCount: 0, error: true };
		}
		console.error(`Error checking feed ${feed.url}:`, error);
		return { newItemsCount: 0, error: true };
	}
}

async function initialiseFeed(ctx, feed) {
	try {
		await _processFeedItems(ctx, feed, false);
	} catch (error) {
		console.error(`Error initialising feed ${feed.url}:`, error);
	}
}

async function postFeedItem(ctx, feed, item) {
	try {
		const channelData = await ctx.stoat.getChannel(feed.channel_id);
		if (!channelData) {
			console.log(`Channel ${feed.channel_id} gone. Removing feed ${feed.url}`);
			await ctx.db.execute("DELETE FROM feeds WHERE url = ? AND channel_id = ?", [feed.url, feed.channel_id]);
			ctx.feeds.delete(`${feed.url}-${feed.channel_id}`);
			ctx.setBotStatus();
			return;
		}

		await ctx.stoat.sendMessage(channelData._id, formatFeedMessage(item));
	} catch (error) {
		console.error("Error posting feed item:", error);
		await notifyServerOwner(ctx, feed);
	}
}

async function notifyServerOwner(ctx, feed) {
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

module.exports = {
	detectFeedType,
	shouldSkipFeedCheck,
	processCacheHeaders,
	parseXmlFeed,
	parseJsonFeed,
	checkAllFeeds,
	checkFeed,
	initialiseFeed,
	formatFeedMessage,
	postFeedItem,
	notifyServerOwner,
};
