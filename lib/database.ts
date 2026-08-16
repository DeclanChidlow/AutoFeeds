"use strict";

import mysql from "mysql2/promise";
import type { Pool } from "mysql2/promise";
import type { Feed } from "./types";
import { verboseLog } from "./utils";

async function initDatabase(): Promise<Pool> {
	const maxRetries = 30;

	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		let pool: Pool | null = null;
		try {
			pool = mysql.createPool({
				host: process.env["DB_HOST"] || "localhost",
				port: Number(process.env["DB_PORT"]) || 3306,
				user: process.env["DB_USER"] || "feeduser",
				password: process.env["DB_PASS"] || "",
				database: process.env["DB_NAME"] || "autofeeds",
				charset: "utf8mb4",
				waitForConnections: true,
				connectionLimit: 10,
				queueLimit: 0,
				enableKeepAlive: true,
				keepAliveInitialDelay: 10000,
			});

			await pool.execute("SELECT 1");
			verboseLog("Database pool established successfully");
			await runMigrations(pool);
			return pool;
		} catch (error) {
			if (pool) {
				try {
					await pool.end();
				} catch (_) {
					/* best effort */
				}
			}

			verboseLog(`Database connection attempt ${attempt}/${maxRetries} failed:`, (error as Error).message);

			await new Promise((resolve) => setTimeout(resolve, 2000));

			if (attempt === maxRetries) throw error;
		}
	}

	throw new Error("Database initialisation failed");
}

async function runMigrations(db: Pool): Promise<void> {
	try {
		const [tables] = await db.execute("SHOW TABLES LIKE 'feeds'");
		if ((tables as unknown[]).length === 0) {
			console.warn("The 'feeds' table does not exist - skipping migrations. Ensure init.sql has been applied.");
			return;
		}

		const [typeRows] = await db.execute("SHOW COLUMNS FROM feeds LIKE 'feed_type'");
		const currentType = (typeRows as { Type?: string }[])[0]?.Type || "";
		if (!currentType.includes("podcast")) {
			await db.execute("ALTER TABLE feeds MODIFY COLUMN feed_type ENUM('rss', 'atom', 'json', 'podcast') NOT NULL");
			verboseLog("Migrated feeds.feed_type to include 'podcast'");
		}

		await db.execute(
			`CREATE TABLE IF NOT EXISTS feed_filters (
				id INT AUTO_INCREMENT PRIMARY KEY,
				feed_id INT NOT NULL,
				field_name VARCHAR(32) NOT NULL,
				operator VARCHAR(16) NOT NULL,
				filter_value VARCHAR(256),
				created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
				FOREIGN KEY (feed_id) REFERENCES feeds(id) ON DELETE CASCADE,
				UNIQUE KEY unique_rule (feed_id, field_name, operator, filter_value),
				INDEX idx_feed_id (feed_id)
			) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
		);

		const [templateCols] = await db.execute("SHOW COLUMNS FROM feeds LIKE 'template'");
		if ((templateCols as unknown[]).length === 0) {
			await db.execute("ALTER TABLE feeds ADD COLUMN template TEXT NULL AFTER feed_type");
			verboseLog("Migrated feeds to add template column");
		}
	} catch (error) {
		console.error("Error running database migrations:", error);
		throw error;
	}
}

async function loadFeeds(db: Pool): Promise<Map<string, Feed>> {
	const feeds = new Map<string, Feed>();

	try {
		const [rows] = await db.execute("SELECT * FROM feeds");
		for (const feed of rows as Feed[]) {
			feeds.set(`${feed.url}-${feed.channel_id}`, feed);
		}
		verboseLog(`Loaded ${feeds.size} feeds from database`);
	} catch (error) {
		console.error("Error loading feeds:", error);
	}

	return feeds;
}

export { initDatabase, loadFeeds };
