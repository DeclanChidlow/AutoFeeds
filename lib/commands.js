"use strict";

const { verboseLog } = require("./utils");

async function isUserModerator(msg) {
	try {
		if (!msg.server || !msg.authorId) return false;
		if (msg.server.ownerId === msg.authorId) return true;

		const member = await msg.server.fetchMember(msg.authorId);
		if (!member) return false;

		return member.hasPermission("ManageServer") || member.hasPermission("ManageChannel");
	} catch (error) {
		console.error("Error checking moderator status:", error);
		return false;
	}
}

async function safeReply(ctx, msg, content) {
	try {
		await msg.reply(content);
	} catch (error) {
		verboseLog(`Failed to reply in channel ${msg.channelId}, notifying in DM`);
		try {
			const dmChannel = await ctx.stoat.openDM(msg.authorId);
			await dmChannel.sendMessage(
				`⚠️ AutoFeeds acted on your command in <#${msg.channelId}> and tried to reply but couldn't due to not having the required permissions.\nYou can consult the setup documentation here: https://automod.vale.rocks/docs/autofeeds/setup`,
			);
		} catch (dmError) {
			console.error("Failed to send message failure DM to user:", dmError);
		}
	}
}

const { detectFeedType, initialiseFeed, checkFeed } = require("./feeds");

async function handleAddFeed(ctx, msg, args) {
	if (!(await isUserModerator(msg))) {
		await safeReply(ctx, msg, "❌ You lack the permissions required to add feeds.");
		return;
	}

	if (args.length < 2) {
		await safeReply(ctx, msg, `Usage: \`@${ctx.stoat.botUser?.username || "AutoFeeds"} add <url>\``);
		return;
	}

	const url = args[1];
	const channelId = msg.channelId;
	const serverId = msg.channel?.server?.id;

	if (!serverId) {
		await safeReply(ctx, msg, "This command can only be used in server channels.");
		return;
	}

	if (ctx.feeds.has(`${url}-${channelId}`)) {
		await safeReply(ctx, msg, "⚠️ This feed is already configured for this channel.");
		return;
	}

	try {
		const detectResult = await detectFeedType(url);

		if (detectResult?.error) {
			if (detectResult.error === 402) {
				await safeReply(ctx, msg, "❌ Cannot add feed: Payment Required (HTTP 402). The feed publisher requires payment or authentication to access this feed.");
			} else if (detectResult.error === 429) {
				await safeReply(ctx, msg, "❌ Cannot add feed: Too Many Requests (HTTP 429). The feed publisher is rate-limiting requests.");
			} else if (detectResult.error === 404) {
				await safeReply(ctx, msg, "❌ Cannot add feed: Not Found (HTTP 404). The feed URL does not exist.");
			} else {
				await safeReply(ctx, msg, `❌ Invalid feed URL or unsupported format (HTTP ${detectResult.error}).`);
			}
			return;
		}

		const feedType = detectResult.type;

		if (feedType === "expired_json") {
			await safeReply(ctx, msg, "Cannot add feed: This JSON feed has been marked as 'expired' by its publisher, meaning it will no longer be updated.");
			return;
		}

		if (!feedType) {
			await safeReply(ctx, msg, "Invalid feed URL or unsupported feed format.");
			return;
		}

		await ctx.db.execute("INSERT IGNORE INTO feeds (url, channel_id, server_id, feed_type) VALUES (?, ?, ?, ?)", [url, channelId, serverId, feedType]);

		const feed = { url, channel_id: channelId, server_id: serverId, feed_type: feedType };
		ctx.feeds.set(`${url}-${channelId}`, feed);

		await safeReply(ctx, msg, `✅ Added ${feedType.toUpperCase()} feed: ${url}`);
		await ctx.setBotStatus();

		await initialiseFeed(ctx, feed);
	} catch (error) {
		console.error("Error adding feed:", error);
		if (error.code === "ER_DUP_ENTRY") {
			await safeReply(ctx, msg, "⚠️ This feed is already added to this channel.");
		} else {
			await safeReply(ctx, msg, "❌ Failed to add feed. Please check the URL and try again.");
		}
	}
}

async function handleRemoveFeed(ctx, msg, args) {
	if (!(await isUserModerator(msg))) {
		await safeReply(ctx, msg, "❌ You lack the permissions required to remove feeds.");
		return;
	}

	if (args.length < 2) {
		await safeReply(ctx, msg, `Usage: \`@${ctx.stoat.botUser?.username || "AutoFeeds"} remove <url>\``);
		return;
	}

	const url = args[1];
	const channelId = msg.channelId;

	try {
		const [result] = await ctx.db.execute("DELETE FROM feeds WHERE url = ? AND channel_id = ?", [url, channelId]);

		if (result.affectedRows > 0) {
			ctx.feeds.delete(`${url}-${channelId}`);
			await safeReply(ctx, msg, "✅ Feed removed successfully.");
			await ctx.setBotStatus();
		} else {
			await safeReply(ctx, msg, "Feed not found in this channel.");
		}
	} catch (error) {
		console.error("Error removing feed:", error);
		await safeReply(ctx, msg, "Failed to remove feed.");
	}
}

async function handleListFeeds(ctx, msg) {
	const channelId = msg.channelId;

	try {
		const [rows] = await ctx.db.execute("SELECT url, feed_type, last_updated FROM feeds WHERE channel_id = ?", [channelId]);

		if (rows.length === 0) {
			await safeReply(ctx, msg, "No feeds configured for this channel.");
			return;
		}

		let response = "📡 **Configured Feeds:**\n";
		rows.forEach((feed, index) => {
			const updated = feed.last_updated
				? (() => {
						const ts = Math.floor(new Date(feed.last_updated).getTime() / 1000);
						return `<t:${ts}:f> (<t:${ts}:R>)`;
					})()
				: "Never";
			response += `${index + 1}. [${feed.feed_type.toUpperCase()}] ${feed.url}\n`;
			response += `   Last checked: ${updated}`;
			if (index < rows.length - 1) response += "\n";
		});

		await safeReply(ctx, msg, response);
	} catch (error) {
		console.error("Error listing feeds:", error);
		await safeReply(ctx, msg, "Failed to list feeds.");
	}
}

async function handleCheckFeed(ctx, msg, args) {
	if (args.length < 2) {
		await safeReply(ctx, msg, `Usage: \`@${ctx.stoat.botUser?.username || "AutoFeeds"} check <url>\``);
		return;
	}

	const url = args[1];
	const feedKey = `${url}-${msg.channelId}`;
	const feed = ctx.feeds.get(feedKey);

	if (!feed) {
		await safeReply(ctx, msg, "Feed not found in this channel.");
		return;
	}

	await safeReply(ctx, msg, "⏳ Checking feed…");

	const result = await checkFeed(ctx, feed);

	if (result?.error) {
		await safeReply(ctx, msg, "❌ Error checking feed.");
		return;
	}

	await safeReply(ctx, msg, `Feed checked. ${result.newItemsCount} new items found.`);
}

async function handlePing(ctx, msg) {
	const now = Date.now();
	const wsPing = ctx.stoat.wsPing;
	const wsDisplay = wsPing < 0 ? "`Reconnecting/Syncing…`" : `\`${wsPing}ms\``;

	try {
		const replyMsg = await msg.reply("⌛ Measuring...");

		const messagePing = Math.round(Date.now() - now);
		const uptime = process.uptime();
		const d = Math.floor(uptime / 86400);
		const h = Math.floor((uptime % 86400) / 3600);
		const m = Math.floor((uptime % 3600) / 60);
		const s = Math.floor(uptime % 60);

		let uptimeStr = "";
		if (d > 0) uptimeStr += `${d}d `;
		if (h > 0) uptimeStr += `${h}h `;
		if (m > 0) uptimeStr += `${m}m `;
		if (uptime < 300) uptimeStr += `${s}s`;

		const content = ["## Ping Pong!", `WebSocket: ${wsDisplay}`, `Message: \`${messagePing}ms\``, `Uptime: \`${uptimeStr.trim() || "0s"}\``].join("\n");

		await replyMsg.edit({ content });
	} catch (error) {
		console.error("Ping error:", error);
	}
}

async function handleHelp(ctx, msg) {
	const botName = ctx.stoat.botUser?.username || "AutoFeeds";
	const help = [
		"## AutoFeeds Help",
		"",
		"Visit [the documentation](<https://automod.vale.rocks/docs/autofeeds>) for usage information and [the AutoMod server](https://stt.gg/automod) for help.",
		"",
		`\`@${botName} add <url>\` - Add an RSS/Atom/JSON feed to this channel`,
		`\`@${botName} remove <url>\` - Remove a feed from this channel`,
		`\`@${botName} list\` - List all feeds in this channel`,
		`\`@${botName} check <url>\` - Manually check a specific feed for new items`,
		`\`@${botName} ping\` - Check bot latency and uptime`,
		`\`@${botName} help\` - Show this help message`,
		"",
		"**Supported Feed Types:**",
		"- RSS 2.0",
		"- Atom 1.0",
		"- JSON Feed 1.0/1.1",
		"",
		"Feeds are automatically checked every 20 minutes or as specified by the feed.",
	].join("\n");

	await safeReply(ctx, msg, help);
}

function setupCommands(ctx) {
	const { stoat } = ctx;

	stoat.onMessage((event) => {
		const msg = stoat.makeMessageContext(event);

		(async () => {
			try {
				if (msg.author?.bot || !msg.content) return;

				const botId = stoat.botUser?._id;
				if (!botId) return;

				const mention = `<@${botId}>`;
				if (!msg.content.startsWith(mention)) return;

				const args = msg.content.slice(mention.length).trim().split(/\s+/);
				const command = args[0]?.toLowerCase();

				if (!command) {
					await handleHelp(ctx, msg);
					return;
				}

				switch (command) {
					case "add":
						await handleAddFeed(ctx, msg, args);
						break;
					case "remove":
						await handleRemoveFeed(ctx, msg, args);
						break;
					case "list":
						await handleListFeeds(ctx, msg);
						break;
					case "check":
						await handleCheckFeed(ctx, msg, args);
						break;
					case "ping":
						await handlePing(ctx, msg);
						break;
					case "help":
						await handleHelp(ctx, msg);
						break;
					default:
						await safeReply(ctx, msg, `That isn't a command. You can see the documentation with \`@${stoat.botUser?.username || "AutoFeeds"} help\`.`);
				}
			} catch (error) {
				if (error.type === "MissingPermission") {
					await safeReply(ctx, msg, "⚠️ AutoFeeds couldn't reply in this channel due to missing permissions.");
				} else {
					console.error("Command error:", error);
					await safeReply(ctx, msg, "❌ An error occurred while processing your command.");
				}
			}
		})();
	});
}

module.exports = { setupCommands, isUserModerator, safeReply };
