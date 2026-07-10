"use strict";

const { StoatClient } = require("./lib/stoat");
const { initDatabase, loadFeeds } = require("./lib/database");
const { setupCommands } = require("./lib/commands");
const { checkAllFeeds } = require("./lib/feeds");
const cron = require("node-cron");
const Parser = require("rss-parser");

class AutoFeeds {
	constructor() {
		this.stoat = new StoatClient();
		this.parser = new Parser({
			customFields: {
				feed: ["language", "ttl", "skipHours", "skipDays"],
				item: ["guid", "pubDate", "published", "updated"],
			},
		});
		this.db = null;
		this.feeds = new Map();
		this.notifiedOwners = new Set();

		this._setupErrorHandlers();
	}

	_setupErrorHandlers() {
		process.on("uncaughtException", (error) => {
			console.error("Uncaught Exception:", error);
			process.exit(1);
		});

		process.on("unhandledRejection", (reason, promise) => {
			console.error("Unhandled Rejection at:", promise, "reason:", reason);
			process.exit(1);
		});
	}

	async init() {
		try {
			this.db = await initDatabase();
			this.feeds = await loadFeeds(this.db);

			const maxRetries = 5;
			for (let attempt = 1; attempt <= maxRetries; attempt++) {
				try {
					await this.stoat.connect(process.env["BOT_TOKEN"]);
					break;
				} catch (error) {
					console.error(`Bot connection attempt ${attempt}/${maxRetries} failed:`, error);
					if (attempt === maxRetries) throw error;
					console.log("Retrying bot connection in 5 seconds...");
					await new Promise((resolve) => setTimeout(resolve, 5000));
				}
			}

			await this._setBotStatus();

			const ctx = {
				stoat: this.stoat,
				db: this.db,
				feeds: this.feeds,
				parser: this.parser,
				notifiedOwners: this.notifiedOwners,
				setBotStatus: () => this._setBotStatus(),
			};

			cron.schedule("*/20 * * * *", () => checkAllFeeds(ctx));
			setupCommands(ctx);
		} catch (error) {
			console.error("Failed to initialise bot:", error);
			process.exit(1);
		}
	}

	async _setBotStatus() {
		const botName = this.stoat.botUser?.username || "AutoFeeds";
		const statusText = `@${botName} help | Handling ${this.feeds.size} feeds`;

		try {
			if (!this.stoat.botUser) {
				await new Promise((resolve) => setTimeout(resolve, 1000));
			}

			await this.stoat.patch("/users/@me", {
				status: { text: statusText, presence: "Online" },
			});

			console.log(`Bot status updated: ${statusText}`);
		} catch (error) {
			console.error("Failed to update bot status:", error.message);
		}
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

async function shutdown() {
	console.log("Shutting down bot gracefully...");
	bot.stoat.disconnect();
	if (bot.db) {
		try {
			await bot.db.end();
			console.log("Database connection pool closed.");
		} catch (error) {
			console.error("Error closing database connection pool:", error);
		}
	}
	process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
