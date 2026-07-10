"use strict";

const mysql = require("mysql2/promise");
const { verboseLog } = require("./utils");

async function initDatabase() {
	const maxRetries = 30;

	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		let pool = null;
		try {
			pool = mysql.createPool({
				host: process.env["DB_HOST"] || "localhost",
				port: process.env["DB_PORT"] || 3306,
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
			return pool;
		} catch (error) {
			if (pool) {
				try {
					await pool.end();
				} catch (_) {
					/* best effort */
				}
			}

			verboseLog(`Database connection attempt ${attempt}/${maxRetries} failed:`, error.message);

			await new Promise((resolve) => setTimeout(resolve, 2000));

			if (attempt === maxRetries) throw error;
		}
	}
}

async function loadFeeds(db) {
	const feeds = new Map();

	try {
		const [rows] = await db.execute("SELECT * FROM feeds");
		for (const feed of rows) {
			feeds.set(`${feed.url}-${feed.channel_id}`, feed);
		}
		verboseLog(`Loaded ${rows.length} feeds from database`);
	} catch (error) {
		console.error("Error loading feeds:", error);
	}

	return feeds;
}

module.exports = { initDatabase, loadFeeds };
