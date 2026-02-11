const { Client } = require("stoat.js");
const mysql = require("mysql2/promise");
const Parser = require("rss-parser");
const fetch = require("node-fetch");
const cron = require("node-cron");

class AutoFeeds {
	constructor() {
		this.client = new Client();
		this.parser = new Parser({
			customFields: {
				feed: ["language", "ttl"],
				item: ["guid", "pubDate", "published", "updated"],
			},
		});
		this.db = null;
		this.feeds = new Map();
		this.setupErrorHandlers();
	}

	setupErrorHandlers() {
		this.client.on("error", (error) => {
			console.error("Stoat client error:", error);
		});

		this.client.on("disconnect", () => {
			console.log("Bot disconnected from Stoat");
		});

		this.client.on("connect", () => {
			console.log("Bot connected to Stoat");
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

			console.log("Bot connected to Stoat!");

			cron.schedule("*/15 * * * *", () => {
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
				this.db = await mysql.createConnection({
					host: process.env["DB_HOST"] || "localhost",
					port: process.env["DB_PORT"] || 3306,
					user: process.env["DB_USER"] || "feeduser",
					password: process.env["DB_PASS"] || "",
					database: process.env["DB_NAME"] || "autofeeds",
					charset: "utf8mb4",
					connectTimeout: 10000,
					acquireTimeout: 10000,
					timeout: 10000,
				});

				// Test the connection
				await this.db.execute("SELECT 1");
				console.log("Database connection established successfully");
				break;
			} catch (error) {
				retries++;
				console.log(`Database connection attempt ${retries}/${maxRetries} failed:`, error.message);

				if (this.db) {
					try {
						await this.db.end();
					} catch (e) {
						// Ignore cleanup errors
					}
					this.db = null;
				}

				await new Promise((resolve) => setTimeout(resolve, 2000));

				if (retries === maxRetries) {
					throw error;
				}
			}
		}

		this.db.on("error", (error) => {
			console.error("Database connection error:", error);
			if (error.code === "PROTOCOL_CONNECTION_LOST") {
				console.log("Attempting to reconnect to database...");
				this.initDatabase();
			}
		});

		await this.db.execute(`
            CREATE TABLE IF NOT EXISTS feeds (
                id INT AUTO_INCREMENT PRIMARY KEY,
                url VARCHAR(512) NOT NULL,
                channel_id VARCHAR(26) NOT NULL,
                server_id VARCHAR(26) NOT NULL,
                feed_type ENUM('rss', 'atom', 'json') NOT NULL,
                last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY unique_feed_channel (url, channel_id),
                INDEX idx_channel_id (channel_id),
                INDEX idx_server_id (server_id),
                INDEX idx_last_updated (last_updated)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

		await this.db.execute(`
            CREATE TABLE IF NOT EXISTS feed_items (
                id INT AUTO_INCREMENT PRIMARY KEY,
                feed_id INT NOT NULL,
                item_id VARCHAR(512) NOT NULL,
                title VARCHAR(512),
                link VARCHAR(512),
                published_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (feed_id) REFERENCES feeds(id) ON DELETE CASCADE,
                UNIQUE KEY unique_item (feed_id, item_id),
                INDEX idx_feed_id (feed_id),
                INDEX idx_published_at (published_at),
                INDEX idx_created_at (created_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

		console.log("Database initialised successfully");
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

	async isUserModerator(message) {
		try {
			if (!message.server) {
				return false;
			}

			if (message.server.ownerId === message.authorId) {
				return true;
			}

			return false;
		} catch (error) {
			console.error("Error checking moderator status:", error);
			return false;
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

				const args = message.content.slice(mention.length).trim().split(" ");
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
						await message.reply(`That isn't a command. You can see the documentation with \`@${this.client.user?.username} help\`.`);
						break;
				}
			} catch (error) {
				console.error("Command error:", error);
				try {
					await message.reply("An error occurred while processing your command.");
				} catch (replyError) {
					console.error("Failed to send error reply:", replyError);
				}
			}
		});
	}

	async handleAddFeed(message, args) {
		if (!(await this.isUserModerator(message))) {
			await message.reply("Only moderators may add feeds.");
			return;
		}

		if (args.length < 2) {
			await message.reply(`Usage: \`@${this.client.user?.username} add <url>\``);
			return;
		}

		const url = args[1];
		const channelId = message.channelId;
		const serverId = message.channel?.server?.id;

		if (!serverId) {
			await message.reply("This command can only be used in server channels.");
			return;
		}

		try {
			const feedType = await this.detectFeedType(url);
			if (!feedType) {
				await message.reply("Invalid feed URL or unsupported feed format.");
				return;
			}

			await this.db.execute("INSERT IGNORE INTO feeds (url, channel_id, server_id, feed_type) VALUES (?, ?, ?, ?)", [url, channelId, serverId, feedType]);

			// Add to memory
			const feed = { url, channel_id: channelId, server_id: serverId, feed_type: feedType };
			this.feeds.set(`${url}-${channelId}`, feed);

			await message.reply(`✅ Added ${feedType.toUpperCase()} feed: ${url}`);

			// Initialise feed without posting items
			await this.initialiseFeed(feed);
		} catch (error) {
			console.error("Error adding feed:", error);
			if (error.code === "ER_DUP_ENTRY") {
				await message.reply("This feed is already added to this channel.");
			} else {
				await message.reply("Failed to add feed. Please check the URL and try again.");
			}
		}
	}

	async handleRemoveFeed(message, args) {
		if (!(await this.isUserModerator(message))) {
			await message.reply("Only moderators may remove feeds.");
			return;
		}

		if (args.length < 2) {
			await message.reply(`Usage: \`@${this.client.user?.username} remove <url>\``);
			return;
		}

		const url = args[1];
		const channelId = message.channelId;

		try {
			const [result] = await this.db.execute("DELETE FROM feeds WHERE url = ? AND channel_id = ?", [url, channelId]);

			if (result.affectedRows > 0) {
				this.feeds.delete(`${url}-${channelId}`);
				await message.reply("✅ Feed removed successfully.");
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
			await message.reply(`Usage: \`@${this.client.user?.username} check <url>\``);
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

		await message.reply("Checking feed...");
		await this.checkFeed(feed, false);
	}

	async handleHelp(message) {
		const botName = this.client.user?.username;
		const help = `## AutoFeeds Help

		\`@${botName} add <url>\` - Add an RSS/Atom/JSON feed to this channel
		\`@${botName} remove <url>\` - Remove a feed from this channel
		\`@${botName} list\` - List all feeds in this channel
		\`@${botName} check <url>\` - Manually check a specific feed for new items
		\`@${botName} help\` - Show this help message

		**Supported Feed Types:**
		- RSS 2.0
		- Atom 1.0
		- JSON Feed 1.0/1.1

		Feeds are automatically checked every 15 minutes.`;

		await message.reply(help);
	}

	async detectFeedType(url) {
		try {
			const response = await fetch(url, {
				headers: { "User-Agent": "AutoFeeds/1.0" },
				timeout: 10000,
			});

			if (!response.ok) return null;

			const contentType = response.headers.get("content-type") || "";
			const text = await response.text();

			if (contentType.includes("application/json") || text.trim().startsWith("{")) {
				try {
					const json = JSON.parse(text);
					if (json.version && json.version.startsWith("https://jsonfeed.org/version/")) {
						return "json";
					}
				} catch (e) {}
			}

			if (text.includes("<rss") || text.includes("<feed")) {
				if (text.includes("<rss")) return "rss";
				if (text.includes("<feed") && text.includes('xmlns="http://www.w3.org/2005/Atom"')) return "atom";
			}

			return null;
		} catch (error) {
			console.error("Error detecting feed type:", error);
			return null;
		}
	}

	async checkAllFeeds() {
		console.log(`Checking ${this.feeds.size} feeds...`);

		for (const feed of this.feeds.values()) {
			try {
				await this.checkFeed(feed);
				// Small delay between feeds to avoid rate limiting
				await new Promise((resolve) => setTimeout(resolve, 1000));
			} catch (error) {
				console.error(`Error checking feed ${feed.url}:`, error);
			}
		}
	}

	async checkFeed(feed, isManual = false) {
		try {
			let items = [];

			if (feed.feed_type === "json") {
				items = await this.parseJsonFeed(feed.url);
			} else {
				items = await this.parseXmlFeed(feed.url);
			}

			if (items.length === 0) return;

			const [feedRows] = await this.db.execute("SELECT id FROM feeds WHERE url = ? AND channel_id = ?", [feed.url, feed.channel_id]);

			if (feedRows.length === 0) return;
			const feedId = feedRows[0].id;

			// Process items (newest first)
			let newItemsCount = 0;

			for (const item of items.slice(0, 5)) {
				// Limit to 5 most recent items
				try {
					// Try to insert the item. This will fail silently if it already exists
					const [insertResult] = await this.db.execute("INSERT IGNORE INTO feed_items (feed_id, item_id, title, link, published_at) VALUES (?, ?, ?, ?, ?)", [
						feedId,
						item.id,
						item.title,
						item.link,
						item.published,
					]);

					// Only post if this is a new item
					if (insertResult.affectedRows > 0) {
						await this.postFeedItem(feed, item);
						newItemsCount++;
					}
				} catch (error) {
					console.error("Error processing feed item:", error);
				}
			}

			// Update last_updated timestamp
			await this.db.execute("UPDATE feeds SET last_updated = CURRENT_TIMESTAMP WHERE id = ?", [feedId]);

			if (newItemsCount > 0) {
				console.log(`Posted ${newItemsCount} new items from ${feed.url}`);
			}
		} catch (error) {
			console.error(`Error checking feed ${feed.url}:`, error);
		}
	}

	async initialiseFeed(feed) {
		try {
			let items = [];

			if (feed.feed_type === "json") {
				items = await this.parseJsonFeed(feed.url);
			} else {
				items = await this.parseXmlFeed(feed.url);
			}

			if (items.length === 0) return;

			const [feedRows] = await this.db.execute("SELECT id FROM feeds WHERE url = ? AND channel_id = ?", [feed.url, feed.channel_id]);

			if (feedRows.length === 0) return;
			const feedId = feedRows[0].id;

			// Store existing items without posting them
			for (const item of items.slice(0, 5)) {
				try {
					await this.db.execute("INSERT IGNORE INTO feed_items (feed_id, item_id, title, link, published_at) VALUES (?, ?, ?, ?, ?)", [feedId, item.id, item.title, item.link, item.published]);
				} catch (error) {
					console.error("Error storing feed item:", error);
				}
			}

			// Update last_updated timestamp
			await this.db.execute("UPDATE feeds SET last_updated = CURRENT_TIMESTAMP WHERE id = ?", [feedId]);
		} catch (error) {
			console.error(`Error initialising feed ${feed.url}:`, error);
		}
	}

	async parseXmlFeed(url) {
		const feed = await this.parser.parseURL(url);

		return feed.items.map((item) => ({
			id: item.guid || item.link || item.title,
			title: item.title,
			link: item.link,
			description: item.contentSnippet || item.content,
			published: new Date(item.pubDate || item.isoDate || Date.now()),
		}));
	}

	async parseJsonFeed(url) {
		const response = await fetch(url, {
			headers: { "User-Agent": "AutoFeeds/1.0" },
		});

		const feed = await response.json();

		return (feed.items || []).map((item) => ({
			id: item.id || item.url || item.title,
			title: item.title,
			link: item.url || item.external_url,
			description: item.summary || item.content_text,
			published: new Date(item.date_published || item.date_modified || Date.now()),
		}));
	}

	async postFeedItem(feed, item) {
		try {
			const channel = this.client.channels.get(feed.channel_id);
			if (!channel) {
				console.error(`Channel ${feed.channel_id} not found`);
				return;
			}

			const message = this.formatFeedMessage(item);
			await channel.sendMessage(message);
		} catch (error) {
			console.error("Error posting feed item:", error);
		}
	}

	formatFeedMessage(item) {
		let message = `**${item.title}**\n`;

		if (item.description) {
			const description = item.description.substring(0, 200);
			message += `${description}${description.length === 200 ? "..." : ""}\n\n`;
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

process.on("SIGINT", async () => {
	console.log("Shutting down bot...");
	if (bot.db) {
		try {
			await bot.db.end();
		} catch (error) {
			console.error("Error closing database connection:", error);
		}
	}
	process.exit(0);
});

process.on("SIGTERM", async () => {
	console.log("Received SIGTERM, shutting down gracefully...");
	if (bot.db) {
		try {
			await bot.db.end();
		} catch (error) {
			console.error("Error closing database connection:", error);
		}
	}
	process.exit(0);
});

