"use strict";

import { StoatClient } from "./lib/stoat";
import { initDatabase, loadFeeds } from "./lib/database";
import { setupCommands } from "./lib/commands";
import { checkAllFeeds } from "./lib/feeds";
import { schedule } from "node-cron";
import Parser from "rss-parser";
import type { Pool } from "mysql2/promise";
import type { Ctx, Feed } from "./lib/types";

const STATUS_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;

class AutoFeeds {
	stoat = new StoatClient();
	parser = new Parser({
		customFields: {
			feed: ["language", "ttl", "skipHours", "skipDays"],
			item: [
				"guid",
				"pubDate",
				"published",
				"updated",
				["itunes:duration", "itunesDuration"],
				["itunes:episode", "itunesEpisode"],
				["itunes:season", "itunesSeason"],
				["itunes:episodeType", "itunesEpisodeType"],
				["itunes:author", "itunesAuthor"],
				["podcast:guid", "podcastGuid"],
				["podcast:episode", "podcastEpisode"],
				["podcast:season", "podcastSeason"],
			],
		},
	});
	db: Pool | null = null;
	feeds = new Map<string, Feed>();
	notifiedOwners = new Set<string>();
	private _lastStatusUpdate = 0;

	constructor() {
		this._setupErrorHandlers();
	}

	_setupErrorHandlers(): void {
		process.on("uncaughtException", (error) => {
			console.error("Uncaught Exception:", error);
			process.exit(1);
		});

		process.on("unhandledRejection", (reason, promise) => {
			console.error("Unhandled Rejection at:", promise, "reason:", reason);
			process.exit(1);
		});
	}

	async init(): Promise<void> {
		try {
			this.db = await initDatabase();
			this.feeds = await loadFeeds(this.db);

			const maxRetries = 5;
			for (let attempt = 1; attempt <= maxRetries; attempt++) {
				try {
					await this.stoat.connect(process.env["BOT_TOKEN"] ?? "");
					break;
				} catch (error) {
					console.error(`Bot connection attempt ${attempt}/${maxRetries} failed:`, error);
					if (attempt === maxRetries) throw error;
					console.log("Retrying bot connection in 5 seconds...");
					await new Promise((resolve) => setTimeout(resolve, 5000));
				}
			}

			await this._setBotStatus();

			const ctx: Ctx = {
				stoat: this.stoat,
				db: this.db,
				feeds: this.feeds,
				parser: this.parser,
				notifiedOwners: this.notifiedOwners,
				setBotStatus: () => this._setBotStatus(),
			};

			schedule("*/20 * * * *", () => checkAllFeeds(ctx));
			setupCommands(ctx);
		} catch (error) {
			console.error("Failed to initialise bot:", error);
			process.exit(1);
		}
	}

	async _setBotStatus(): Promise<void> {
		if (Date.now() - this._lastStatusUpdate < STATUS_UPDATE_INTERVAL_MS) return;

		const botName = this.stoat.botUser?.username || "AutoFeeds";
		const statusText = `@${botName} help | Handling ${formatFeedCount(this.feeds.size)} feeds`;

		try {
			if (!this.stoat.botUser) {
				await new Promise((resolve) => setTimeout(resolve, 1000));
			}

			this._lastStatusUpdate = Date.now();
			await this.stoat.patch("/users/@me", {
				status: { text: statusText, presence: "Online" },
			});

			console.log(`Bot status updated: ${statusText}`);
		} catch (error) {
			console.error("Failed to update bot status:", (error as Error).message);
		}
	}
}

/**
 * Format a feed count using general figures: 42, 1K+, 15K+, 1M+.
 */
function formatFeedCount(count: number): string {
	if (count >= 1_000_000) return `${Math.floor(count / 1_000_000)}M+`;
	if (count >= 1000) return `${Math.floor(count / 1000)}K+`;
	return `${count}`;
}

if (import.meta.main) {
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

	async function shutdown(): Promise<void> {
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
}

export { AutoFeeds, formatFeedCount };
