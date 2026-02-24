const { Client } = require("stoat.js");
const mysql = require("mysql2/promise");
const Parser = require("rss-parser");
const cron = require("node-cron");

class AutoFeeds {
	constructor() {
		this.client = new Client();
		this.parser = new Parser({
			customFields: {
				feed: ["language", "ttl", "skipHours", "skipDays"],
				item: ["guid", "pubDate", "published", "updated"],
			},
		});
		this.db = null;
		this.feeds = new Map();
		this.notifiedOwners = new Set();
		this.setupErrorHandlers();
	}

	setupErrorHandlers() {
		this.client.on("error", (error) => {
			console.error("Stoat client error:", error);
		});

		this.client.on("disconnect", () => {
			console.log("Bot disconnected from Stoat");
		});

		this.client.on("ready", () => {
			console.log(`Bot connected to Stoat as ${this.client.user?.username || "AutoFeeds"}!`);
		});

		process.on("uncaughtException", (error) => {
			console.error("Uncaught Exception:", error);
		});

		process.on("unhandledRejection", (reason, promise) => {
			console.error("Unhandled Rejection at:", promise, "reason:", reason);
		});
	}

	async init() {
		try {
			await this.initDatabase();
			await this.loadFeeds();
			await this.connectBot();
			await this.setBotStatus();

			cron.schedule("*/20 * * * *", () => {
				this.checkAllFeeds();
			});

			this.setupCommands();
		} catch (error) {
			console.error("Failed to initialise bot:", error);
			process.exit(1);
		}
	}

	async connectBot() {
		const maxRetries = 5;
		let retries = 0;

		while (retries < maxRetries) {
			try {
				await this.client.loginBot(process.env["BOT_TOKEN"]);
				return;
			} catch (error) {
				retries++;
				console.error(`Bot connection attempt ${retries}/${maxRetries} failed:`, error);

				if (retries === maxRetries) {
					throw error;
				}

				console.log("Retrying bot connection in 5 seconds...");
				await new Promise((resolve) => setTimeout(resolve, 5000));
			}
		}
	}

	async initDatabase() {
		const maxRetries = 30;
		let retries = 0;

		while (retries < maxRetries) {
			try {
				this.db = mysql.createPool({
					host: process.env["DB_HOST"] || "localhost",
					port: process.env["DB_PORT"] || 3306,
					user: process.env["DB_USER"] || "feeduser",
					password: process.env["DB_PASS"] || "",
					database: process.env["DB_NAME"] || "autofeeds",
					charset: "utf8mb4",
					waitForConnections: true,
					connectionLimit: 10,
					queueLimit: 0,
				});

				await this.db.execute("SELECT 1");
				console.log("Database pool established successfully");
				return;
			} catch (error) {
				retries++;
				console.log(`Database connection attempt ${retries}/${maxRetries} failed:`, error.message);

				if (this.db) {
					try {
						await this.db.end();
					} catch (e) {
						/* Ignore */
					}
					this.db = null;
				}

				await new Promise((resolve) => setTimeout(resolve, 2000));

				if (retries === maxRetries) {
					throw error;
				}
			}
		}
	}

	async loadFeeds() {
		try {
			const [rows] = await this.db.execute("SELECT * FROM feeds");
			for (const feed of rows) {
				this.feeds.set(`${feed.url}-${feed.channel_id}`, feed);
			}
			console.log(`Loaded ${rows.length} feeds from database`);
		} catch (error) {
			console.error("Error loading feeds:", error);
		}
	}

	async setBotStatus() {
		const botName = this.client.user?.username || "AutoFeeds";
		const statusText = `@${botName} help | Handling ${this.feeds.size} feeds`;

		try {
			if (!this.client.user) {
				await new Promise((resolve) => setTimeout(resolve, 1000));
			}

			const response = await fetch(`${this.client.options.baseURL || "https://api.stoat.chat"}/users/@me`, {
				method: "PATCH",
				headers: {
					"Content-Type": "application/json",
					"x-bot-token": process.env["BOT_TOKEN"],
				},
				body: JSON.stringify({
					status: {
						text: statusText,
						presence: "Online",
					},
				}),
			});

			if (!response.ok) {
				throw new Error(`HTTP Error ${response.status}`);
			}

			console.log(`Bot status updated: ${statusText}`);
		} catch (error) {
			console.error("Failed to update bot status:", error.message);
		}
	}

	async isUserModerator(message) {
		try {
			if (!message.server || !message.authorId) {
				return false;
			}

			if (message.server.ownerId === message.authorId) {
				return true;
			}

			const member = await message.server.fetchMember(message.authorId);
			if (!member) return false;

			return member.hasPermission(message.server, "ManageServer") || member.hasPermission(message.server, "ManageChannel");
		} catch (error) {
			console.error("Error checking moderator status:", error);
			return false;
		}
	}

	async getDmChannel(userOrId) {
		let user = userOrId;
		if (typeof user === "string") {
			user = this.client.users.get(user) || (await this.client.users.fetch(user));
		} else if (user && !user.openDM && user.id) {
			user = this.client.users.get(user.id) || (await this.client.users.fetch(user.id));
		}

		if (!user) throw new Error("Could not resolve user");

		const channels = Array.from(this.client.channels.values());
		const existingDM = channels.find((c) => c.type === "DirectMessage" && c.recipient?.id === user.id);

		return existingDM || (await user.openDM());
	}

	async safeReply(message, content) {
		try {
			await message.reply(content);
		} catch (error) {
			console.log(`Failed to reply in channel ${message.channelId}, notifying in DM`);
			try {
				const dmChannel = await this.getDmChannel(message.authorId);
				await dmChannel.sendMessage(
					`⚠️ AutoFeeds acted on your command in <#${message.channelId}> and tried to reply but couldn't due to not having the required permissions.\nYou can consult the setup documentation here: https://automod.vale.rocks/docs/autofeeds/setup`,
				);
			} catch (dmError) {
				console.error("Failed to send message failure DM to user:", dmError);
			}
		}
	}

	async notifyServerOwner(feed) {
		const cacheKey = `${feed.server_id}-${feed.channel_id}`;
		if (this.notifiedOwners.has(cacheKey)) return;

		try {
			let server = this.client.servers.get(feed.server_id);
			if (!server) {
				server = await this.client.servers.fetch(feed.server_id).catch(() => null);
			}
			if (!server || !server.ownerId) return;

			const dmChannel = await this.getDmChannel(server.ownerId);
			await dmChannel.sendMessage(
				`⚠️ AutoFeeds tried to post a feed update to <#${feed.channel_id}> for \`${feed.url}\`, but it failed. This is likely due to not having the required permissions.\nYou can consult the setup documentation here: https://automod.vale.rocks/docs/autofeeds/setup`,
			);

			this.notifiedOwners.add(cacheKey);

			setTimeout(() => this.notifiedOwners.delete(cacheKey), 86400000);
		} catch (err) {
			console.error("Failed to notify server owner:", err);
		}
	}

	setupCommands() {
		this.client.on("messageCreate", async (message) => {
			try {
				if (message.author?.bot || !message.content) return;

				const botId = this.client.user?.id;
				if (!botId) return;

				const mention = `<@${botId}>`;

				if (!message.content.startsWith(mention)) return;

				const args = message.content.slice(mention.length).trim().split(/\s+/);
				const command = args[0]?.toLowerCase();

				if (!command) {
					await this.handleHelp(message);
					return;
				}

				switch (command) {
					case "add":
						await this.handleAddFeed(message, args);
						break;
					case "remove":
						await this.handleRemoveFeed(message, args);
						break;
					case "list":
						await this.handleListFeeds(message);
						break;
					case "check":
						await this.handleCheckFeed(message, args);
						break;
					case "help":
						await this.handleHelp(message);
						break;
					default:
						await message.reply(`That isn't a command. You can see the documentation with \`@${this.client.user?.username || "AutoFeeds"} help\`.`);
						break;
				}
			} catch (error) {
				if (error.type === "MissingPermission") {
					const urlAttempt = message.content.split(/\s+/)[2];
					await this.safeReply(message, "", urlAttempt);
				} else {
					console.error("Command error:", error);
					await this.safeReply(message, "❌ An error occurred while processing your command.");
				}
			}
		});
	}

	async handleAddFeed(message, args) {
		if (!(await this.isUserModerator(message))) {
			await this.safeReply(message, "❌ You lack the permissions required to add feeds.");
			return;
		}

		if (args.length < 2) {
			await this.safeReply(message, `Usage: \`@${this.client.user?.username || "AutoFeeds"} add <url>\``);
			return;
		}

		const url = args[1];
		const channelId = message.channelId;
		const serverId = message.channel?.server?.id;

		if (!serverId) {
			await this.safeReply(message, "This command can only be used in server channels.");
			return;
		}

		if (this.feeds.has(`${url}-${channelId}`)) {
			await this.safeReply(message, "⚠️ This feed is already configured for this channel.");
			return;
		}

		try {
			const detectResult = await this.detectFeedType(url);

			if (detectResult?.error) {
				if (detectResult.error === 402) {
					await this.safeReply(message, "❌ Cannot add feed: Payment Required (HTTP 402). The feed publisher requires payment or authentication to access this feed.");
					return;
				} else if (detectResult.error === 404) {
					await this.safeReply(message, "❌ Cannot add feed: Not Found (HTTP 404). The feed URL does not exist.");
					return;
				} else {
					await this.safeReply(message, `❌ Invalid feed URL or unsupported format (HTTP ${detectResult.error}).`);
					return;
				}
			}

			const feedType = detectResult.type;

			if (feedType === "expired_json") {
				await this.safeReply(message, "Cannot add feed: This JSON feed has been marked as 'expired' by its publisher, meaning it will no longer be updated.");
				return;
			}

			if (!feedType) {
				await this.safeReply(message, "Invalid feed URL or unsupported feed format.");
				return;
			}

			await this.db.execute("INSERT IGNORE INTO feeds (url, channel_id, server_id, feed_type) VALUES (?, ?, ?, ?)", [url, channelId, serverId, feedType]);

			const feed = { url, channel_id: channelId, server_id: serverId, feed_type: feedType };
			this.feeds.set(`${url}-${channelId}`, feed);

			await this.safeReply(message, `✅ Added ${feedType.toUpperCase()} feed: ${url}`);
			this.setBotStatus();

			await this.initialiseFeed(feed);
		} catch (error) {
			console.error("Error adding feed:", error);
			if (error.code === "ER_DUP_ENTRY") {
				await this.safeReply(message, "⚠️ This feed is already added to this channel.");
			} else {
				await this.safeReply(message, "❌ Failed to add feed. Please check the URL and try again.");
			}
		}
	}

	async handleRemoveFeed(message, args) {
		if (!(await this.isUserModerator(message))) {
			await message.reply("Only moderators may remove feeds.");
			return;
		}

		if (args.length < 2) {
			await message.reply(`Usage: \`@${this.client.user?.username || "AutoFeeds"} remove <url>\``);
			return;
		}

		const url = args[1];
		const channelId = message.channelId;

		try {
			const [result] = await this.db.execute("DELETE FROM feeds WHERE url = ? AND channel_id = ?", [url, channelId]);

			if (result.affectedRows > 0) {
				this.feeds.delete(`${url}-${channelId}`);
				await message.reply("✅ Feed removed successfully.");
				this.setBotStatus();
			} else {
				await message.reply("Feed not found in this channel.");
			}
		} catch (error) {
			console.error("Error removing feed:", error);
			await message.reply("Failed to remove feed.");
		}
	}

	async handleListFeeds(message) {
		const channelId = message.channelId;

		try {
			const [rows] = await this.db.execute("SELECT url, feed_type, last_updated FROM feeds WHERE channel_id = ?", [channelId]);

			if (rows.length === 0) {
				await message.reply("No feeds configured for this channel.");
				return;
			}

			let response = "📡 **Configured Feeds:**\n";
			rows.forEach((feed, index) => {
				response += `${index + 1}. [${feed.feed_type.toUpperCase()}] ${feed.url}\n`;
				response += `   Last updated: ${feed.last_updated || "Never"}\n`;
			});

			await message.reply(response);
		} catch (error) {
			console.error("Error listing feeds:", error);
			await message.reply("Failed to list feeds.");
		}
	}

	async handleCheckFeed(message, args) {
		if (args.length < 2) {
			await message.reply(`Usage: \`@${this.client.user?.username || "AutoFeeds"} check <url>\``);
			return;
		}

		const url = args[1];
		const channelId = message.channelId;
		const feedKey = `${url}-${channelId}`;
		const feed = this.feeds.get(feedKey);

		if (!feed) {
			await message.reply("Feed not found in this channel.");
			return;
		}

		await message.reply("⏳ Checking feed…");

		const result = await this.checkFeed(feed, true);

		if (result?.error) {
			await message.reply("❌ Error checking feed.");
			return;
		}

		await message.reply(`Feed checked. ${result.newItemsCount} new items found.`);
	}

	async handleHelp(message) {
		const botName = this.client.user?.username || "AutoFeeds";
		const help = `## AutoFeeds Help\n\nVisit [the documentation](<https://automod.vale.rocks/docs/autofeeds>) for usage information and [the AutoMod server](https://stt.gg/automod) for help.\n\n\`@${botName} add <url>\` - Add an RSS/Atom/JSON feed to this channel\n\`@${botName} remove <url>\` - Remove a feed from this channel\n\`@${botName} list\` - List all feeds in this channel\n\`@${botName} check <url>\` - Manually check a specific feed for new items\n\`@${botName} help\` - Show this help message\n\n**Supported Feed Types:**\n- RSS 2.0\n- Atom 1.0\n- JSON Feed 1.0/1.1\n\nFeeds are automatically checked every 20 minutes or as specified by the feed.`;

		await message.reply(help);
	}

	async detectFeedType(url) {
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

			if (!response.ok) {
				return { error: response.status };
			}

			const contentType = response.headers.get("content-type") || "";
			const text = await response.text();

			if (contentType.includes("application/json") || text.trim().startsWith("{")) {
				try {
					const json = JSON.parse(text);
					if (json.version && json.version.startsWith("https://jsonfeed.org/version/")) {
						if (json.expired === true) {
							return { type: "expired_json" };
						}
						return { type: "json" };
					}
				} catch (e) {}
			}

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

	shouldSkipFeedCheck(feed) {
		if (feed.nextCheckTime && Date.now() < feed.nextCheckTime) return true;

		const now = new Date();

		if (feed.skipHours && feed.skipHours.includes(now.getUTCHours())) {
			return true;
		}

		const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
		const currentDay = days[now.getUTCDay()];
		if (feed.skipDays && feed.skipDays.includes(currentDay)) {
			return true;
		}

		return false;
	}

	async checkAllFeeds() {
		console.log(`Checking ${this.feeds.size} feeds...`);

		for (const feed of this.feeds.values()) {
			if (this.shouldSkipFeedCheck(feed)) continue;

			try {
				await this.checkFeed(feed);
				await new Promise((resolve) => setTimeout(resolve, 1000));
			} catch (error) {
				console.error(`Error checking feed ${feed.url}:`, error);
			}
		}
	}

	async checkFeed(feed) {
		try {
			let items = [];

			if (feed.feed_type === "json") {
				items = await this.parseJsonFeed(feed);
			} else {
				items = await this.parseXmlFeed(feed);
			}

			if (items.length === 0) {
				return { newItemsCount: 0 };
			}

			const [feedRows] = await this.db.execute("SELECT id FROM feeds WHERE url = ? AND channel_id = ?", [feed.url, feed.channel_id]);
			if (feedRows.length === 0) return { newItemsCount: 0 };
			const feedId = feedRows[0].id;

			let newItemsCount = 0;
			for (const item of items.slice(0, 5)) {
				try {
					const [insertResult] = await this.db.execute("INSERT IGNORE INTO feed_items (feed_id, item_id, title, link, published_at) VALUES (?, ?, ?, ?, ?)", [
						feedId,
						item.id ?? null,
						item.title ?? null,
						item.link ?? null,
						item.published ?? null,
					]);

					if (insertResult.affectedRows > 0) {
						await this.postFeedItem(feed, item);
						newItemsCount++;
					}
				} catch (error) {
					console.error("Error processing feed item:", error);
				}
			}

			await this.db.execute("UPDATE feeds SET last_updated = CURRENT_TIMESTAMP WHERE id = ?", [feedId]);

			if (newItemsCount > 0) {
				console.log(`Posted ${newItemsCount} new items from ${feed.url}`);
			}

			return { newItemsCount };
		} catch (error) {
			console.error(`Error checking feed ${feed.url}:`, error);
			return { newItemsCount: 0, error: true };
		}
	}

	async initialiseFeed(feed) {
		try {
			let items = [];

			if (feed.feed_type === "json") {
				items = await this.parseJsonFeed(feed);
			} else {
				items = await this.parseXmlFeed(feed);
			}

			if (items.length === 0) return;

			const [feedRows] = await this.db.execute("SELECT id FROM feeds WHERE url = ? AND channel_id = ?", [feed.url, feed.channel_id]);

			if (feedRows.length === 0) return;
			const feedId = feedRows[0].id;

			for (const item of items.slice(0, 5)) {
				try {
					await this.db.execute("INSERT IGNORE INTO feed_items (feed_id, item_id, title, link, published_at) VALUES (?, ?, ?, ?, ?)", [
						feedId,
						item.id ?? null,
						item.title ?? null,
						item.link ?? null,
						item.published ?? null,
					]);
				} catch (error) {
					console.error("Error storing feed item:", error);
				}
			}

			await this.db.execute("UPDATE feeds SET last_updated = CURRENT_TIMESTAMP WHERE id = ?", [feedId]);
		} catch (error) {
			console.error(`Error initialising feed ${feed.url}:`, error);
		}
	}

	async parseXmlFeed(feed) {
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
			if (!response.ok) throw new Error(`HTTP Error ${response.status}: ${response.statusText}`);

			this.processCacheHeaders(feed, response);

			const text = await response.text();
			const feedData = await this.parser.parseString(text);

			if (feedData.ttl) feed.ttl = parseInt(feedData.ttl, 10);
			if (feedData.skipHours) feed.skipHours = String(feedData.skipHours).match(/\d+/g)?.map(Number) || [];
			if (feedData.skipDays) feed.skipDays = String(feedData.skipDays).match(/(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)/gi) || [];

			if (feed.ttl) {
				const ttlLimit = Date.now() + feed.ttl * 60 * 1000;
				if (!feed.nextCheckTime || ttlLimit > feed.nextCheckTime) {
					feed.nextCheckTime = ttlLimit;
				}
			}

			return feedData.items.map((item) => ({
				id: item.guid || item.link || item.title,
				title: item.title,
				link: item.link,
				description: item.contentSnippet || item.content,
				published: new Date(item.pubDate || item.isoDate || Date.now()),
			}));
		} catch (error) {
			console.error(`Error parsing XML feed ${feed.url}:`, error.message);
			return [];
		} finally {
			clearTimeout(timeout);
		}
	}

	async parseJsonFeed(feed) {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 10000);

		try {
			const headers = { "User-Agent": "AutoFeeds/1.0" };
			if (feed.etag) headers["If-None-Match"] = feed.etag;
			if (feed.lastModified) headers["If-Modified-Since"] = feed.lastModified;

			const response = await fetch(feed.url, { headers, signal: controller.signal });

			if (response.status === 304) return [];
			if (!response.ok) throw new Error(`HTTP Error ${response.status}`);

			this.processCacheHeaders(feed, response);

			const feedData = await response.json();

			return (feedData.items || []).map((item) => ({
				id: item.id || item.url || item.title,
				title: item.title,
				link: item.url || item.external_url,
				description: item.summary || item.content_text,
				published: new Date(item.date_published || item.date_modified || Date.now()),
			}));
		} catch (error) {
			console.error(`Error parsing JSON feed ${feed.url}:`, error.message);
			return [];
		} finally {
			clearTimeout(timeout);
		}
	}

	processCacheHeaders(feed, response) {
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

	async postFeedItem(feed, item) {
		try {
			let channel = this.client.channels.get(feed.channel_id);
			if (!channel) {
				channel = await this.client.channels.fetch(feed.channel_id).catch(() => null);
			}

			if (!channel) {
				console.error(`Channel ${feed.channel_id} not found`);
				return;
			}

			const message = this.formatFeedMessage(item);
			await channel.sendMessage(message);
		} catch (error) {
			console.error("Error posting feed item:", error);
			await this.notifyServerOwner(feed);
		}
	}

	formatFeedMessage(item) {
		let message = `**${item.title}**\n`;

		if (item.description) {
			const description = item.description.substring(0, 200);
			message += `${description}${description.length === 200 ? "…" : ""}\n`;
		}

		if (item.link) {
			message += `🔗: ${item.link}`;
		}

		return message;
	}
}

const requiredEnvVars = ["BOT_TOKEN"];
const missingEnvVars = requiredEnvVars.filter((envVar) => !process.env[envVar]);

if (missingEnvVars.length > 0) {
	console.error("Missing required environment variables:", missingEnvVars.join(", "));
	console.error("Please create a .env file with the required variables.");
	process.exit(1);
}

const bot = new AutoFeeds();
bot.init().catch((error) => {
	console.error("Failed to start bot:", error);
	process.exit(1);
});

const shutdownHandler = async () => {
	console.log("Shutting down bot gracefully...");

	if (bot.client && typeof bot.client.logout === "function") {
		try {
			await bot.client.logout();
		} catch (error) {
			console.error("Error logging out bot:", error);
		}
	}

	if (bot.db) {
		try {
			await bot.db.end();
			console.log("Database connection pool closed.");
		} catch (error) {
			console.error("Error closing database connection pool:", error);
		}
	}

	process.exit(0);
};

process.on("SIGINT", shutdownHandler);
process.on("SIGTERM", shutdownHandler);
