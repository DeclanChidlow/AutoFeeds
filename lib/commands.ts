"use strict";

import type { Ctx, FeedType } from "./types";
import type { MessageContext } from "./stoat";
import { verboseLog, stripUrlBrackets, formatUrlForMarkdown } from "./utils";
import { detectFeedType, initialiseFeed, checkFeed, FILTER_FIELDS, FILTER_OPERATORS } from "./feeds";
import { TEMPLATE_VAR_FIELDS, unknownTemplateVars } from "./templates";

const PODCAST_ONLY_FIELDS = ["type", "episode", "season", "duration"];
const GENERAL_FILTER_FIELDS = Object.keys(FILTER_FIELDS).filter((field) => !PODCAST_ONLY_FIELDS.includes(field));
const GENERAL_TEMPLATE_VARS = Object.keys(TEMPLATE_VAR_FIELDS).filter((name) => !PODCAST_ONLY_FIELDS.includes(name));

async function isUserModerator(msg: MessageContext): Promise<boolean> {
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

async function safeReply(ctx: Ctx, msg: MessageContext, content: string): Promise<void> {
	try {
		await msg.reply(content);
	} catch (error) {
		verboseLog(`Failed to reply in channel ${msg.channelId}, notifying in DM`);
		try {
			const dmChannel = await ctx.stoat.openDM(msg.authorId);
			await dmChannel.sendMessage(
				`⚠️ AutoFeeds acted on your command in <#${msg.channelId}> and tried to reply but couldn't due to not having the required permissions.\nYou can consult the setup documentation here: <https://automod.vale.rocks/docs/autofeeds/setup>`,
			);
		} catch (dmError) {
			console.error("Failed to send message failure DM to user:", dmError);
		}
	}
}

async function handleAddFeed(ctx: Ctx, msg: MessageContext, args: string[]): Promise<void> {
	if (!(await isUserModerator(msg))) {
		await safeReply(ctx, msg, "❌ You lack the permissions required to add feeds.");
		return;
	}

	if (args.length < 2) {
		await safeReply(ctx, msg, `Usage: \`@${ctx.stoat.botUser?.username || "AutoFeeds"} add <url>\``);
		return;
	}

	const url = stripUrlBrackets(args[1]);
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

		const feed = { url, channel_id: channelId, server_id: serverId, feed_type: feedType as FeedType };
		ctx.feeds.set(`${url}-${channelId}`, feed);

		await safeReply(ctx, msg, `✅ Added ${feedType.toUpperCase()} feed: ${formatUrlForMarkdown(url)}`);
		await ctx.setBotStatus();

		await initialiseFeed(ctx, feed);
	} catch (error) {
		console.error("Error adding feed:", error);
		if ((error as { code?: string }).code === "ER_DUP_ENTRY") {
			await safeReply(ctx, msg, "⚠️ This feed is already added to this channel.");
		} else {
			await safeReply(ctx, msg, "❌ Failed to add feed. Please check the URL and try again.");
		}
	}
}

async function handleRemoveFeed(ctx: Ctx, msg: MessageContext, args: string[]): Promise<void> {
	if (!(await isUserModerator(msg))) {
		await safeReply(ctx, msg, "❌ You lack the permissions required to remove feeds.");
		return;
	}

	if (args.length < 2) {
		await safeReply(ctx, msg, `Usage: \`@${ctx.stoat.botUser?.username || "AutoFeeds"} remove <url>\``);
		return;
	}

	const url = stripUrlBrackets(args[1]);
	const channelId = msg.channelId;

	try {
		const [result] = (await ctx.db.execute("DELETE FROM feeds WHERE url = ? AND channel_id = ?", [url, channelId])) as [{ affectedRows: number }, unknown];

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

async function handleListFeeds(ctx: Ctx, msg: MessageContext): Promise<void> {
	const channelId = msg.channelId;

	try {
		const [rows] = (await ctx.db.execute("SELECT url, feed_type, last_updated, template FROM feeds WHERE channel_id = ?", [channelId])) as [
			{ url: string; feed_type: FeedType; last_updated: Date | null; template: string | null }[],
			unknown,
		];

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
			response += `${index + 1}. [${feed.feed_type.toUpperCase()}] ${formatUrlForMarkdown(feed.url)}${feed.template ? " 📝" : ""}\n`;
			response += `   Last checked: ${updated}`;
			if (index < rows.length - 1) response += "\n";
		});

		await safeReply(ctx, msg, response);
	} catch (error) {
		console.error("Error listing feeds:", error);
		await safeReply(ctx, msg, "Failed to list feeds.");
	}
}

async function handleCheckFeed(ctx: Ctx, msg: MessageContext, args: string[]): Promise<void> {
	if (args.length < 2) {
		await safeReply(ctx, msg, `Usage: \`@${ctx.stoat.botUser?.username || "AutoFeeds"} check <url>\``);
		return;
	}

	const url = stripUrlBrackets(args[1]);
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

async function handleFilter(ctx: Ctx, msg: MessageContext, args: string[]): Promise<void> {
	const sub = args[1]?.toLowerCase();
	if (sub === "list") return handleFilterList(ctx, msg, args);
	if (sub === "remove") return handleFilterRemove(ctx, msg, args);
	return handleFilterAdd(ctx, msg, args);
}

async function handleFilterAdd(ctx: Ctx, msg: MessageContext, args: string[]): Promise<void> {
	if (!(await isUserModerator(msg))) {
		await safeReply(ctx, msg, "❌ You lack the permissions required to manage filters.");
		return;
	}

	if (args.length < 4) {
		await safeReply(ctx, msg, `Usage: \`@${ctx.stoat.botUser?.username || "AutoFeeds"} filter <url> <field> <operator> [value]\``);
		return;
	}

	const url = stripUrlBrackets(args[1]);
	const field = args[2].toLowerCase();
	const operator = args[3].toLowerCase();
	const value = args.slice(4).join(" ");

	if (!FILTER_FIELDS[field]) {
		await safeReply(ctx, msg, `❌ Unknown field. Valid fields: ${Object.keys(FILTER_FIELDS).join(", ")}.`);
		return;
	}

	if (!FILTER_OPERATORS.includes(operator)) {
		await safeReply(ctx, msg, `❌ Unknown operator. Valid operators: ${FILTER_OPERATORS.join(", ")}.`);
		return;
	}

	if ((operator === "contains" || operator === "equals") && !value) {
		await safeReply(ctx, msg, `❌ The \`${operator}\` operator requires a value.`);
		return;
	}

	const [feedRows] = (await ctx.db.execute("SELECT id, feed_type FROM feeds WHERE url = ? AND channel_id = ?", [url, msg.channelId])) as [{ id: number; feed_type: FeedType }[], unknown];
	if (feedRows.length === 0) {
		await safeReply(ctx, msg, "Feed not found in this channel.");
		return;
	}

	if (PODCAST_ONLY_FIELDS.includes(field) && feedRows[0].feed_type !== "podcast") {
		await safeReply(ctx, msg, `❌ The \`${field}\` field is podcast-only, but this feed is ${feedRows[0].feed_type.toUpperCase()}.`);
		return;
	}

	const filterValue = value || null;
	const [existing] = (await ctx.db.execute("SELECT id FROM feed_filters WHERE feed_id = ? AND field_name = ? AND operator = ? AND (filter_value = ? OR (filter_value IS NULL AND ? IS NULL))", [
		feedRows[0].id,
		field,
		operator,
		filterValue,
		filterValue,
	])) as [{ id: number }[], unknown];
	if (existing.length > 0) {
		await safeReply(ctx, msg, "⚠️ This filter rule already exists for this feed.");
		return;
	}

	await ctx.db.execute("INSERT INTO feed_filters (feed_id, field_name, operator, filter_value) VALUES (?, ?, ?, ?)", [feedRows[0].id, field, operator, filterValue]);

	await safeReply(ctx, msg, `✅ Added filter: \`${field} ${operator}${value ? ` "${value}"` : ""}\` to ${formatUrlForMarkdown(url)}`);
}

async function handleFilterRemove(ctx: Ctx, msg: MessageContext, args: string[]): Promise<void> {
	if (!(await isUserModerator(msg))) {
		await safeReply(ctx, msg, "❌ You lack the permissions required to manage filters.");
		return;
	}

	if (args.length < 4) {
		await safeReply(ctx, msg, `Usage: \`@${ctx.stoat.botUser?.username || "AutoFeeds"} filter remove <url> <rule id>\``);
		return;
	}

	const url = stripUrlBrackets(args[2]);
	if (!/^\d+$/.test(args[3])) {
		await safeReply(ctx, msg, "❌ Invalid rule ID. Use `filter list <url>` to see rule IDs.");
		return;
	}
	const ruleId = parseInt(args[3], 10);

	const [result] = (await ctx.db.execute("DELETE f FROM feed_filters f INNER JOIN feeds ON feeds.id = f.feed_id WHERE f.id = ? AND feeds.url = ? AND feeds.channel_id = ?", [
		ruleId,
		url,
		msg.channelId,
	])) as [{ affectedRows: number }, unknown];

	if (result.affectedRows > 0) {
		await safeReply(ctx, msg, "✅ Filter rule removed.");
	} else {
		await safeReply(ctx, msg, "Filter rule not found for this feed in this channel.");
	}
}

async function handleFilterList(ctx: Ctx, msg: MessageContext, args: string[]): Promise<void> {
	if (args.length < 3) {
		await safeReply(ctx, msg, `Usage: \`@${ctx.stoat.botUser?.username || "AutoFeeds"} filter list <url>\``);
		return;
	}

	const url = stripUrlBrackets(args[2]);

	const [feedRows] = (await ctx.db.execute("SELECT id FROM feeds WHERE url = ? AND channel_id = ?", [url, msg.channelId])) as [{ id: number }[], unknown];
	if (feedRows.length === 0) {
		await safeReply(ctx, msg, "Feed not found in this channel.");
		return;
	}

	const [rules] = (await ctx.db.execute("SELECT id, field_name, operator, filter_value FROM feed_filters WHERE feed_id = ? ORDER BY id", [feedRows[0].id])) as [
		{ id: number; field_name: string; operator: string; filter_value: string | null }[],
		unknown,
	];

	if (rules.length === 0) {
		await safeReply(ctx, msg, `No filter rules configured for ${formatUrlForMarkdown(url)}. Add one with \`filter\`.`);
		return;
	}

	let response = `📡 **Filters for ${formatUrlForMarkdown(url)}:**\n`;
	rules.forEach((rule, index) => {
		response += `${index + 1}. \`${rule.field_name} ${rule.operator}${rule.filter_value ? ` "${rule.filter_value}"` : ""}\` (ID ${rule.id})`;
		if (index < rules.length - 1) response += "\n";
	});
	response += `\nRemove with \`@${ctx.stoat.botUser?.username || "AutoFeeds"} filter remove <url> <rule id>\`.`;

	await safeReply(ctx, msg, response);
}

async function handleTemplate(ctx: Ctx, msg: MessageContext, args: string[]): Promise<void> {
	if (!(await isUserModerator(msg))) {
		await safeReply(ctx, msg, "❌ You lack the permissions required to manage templates.");
		return;
	}

	if (args.length < 2) {
		await safeReply(ctx, msg, `Usage: \`@${ctx.stoat.botUser?.username || "AutoFeeds"} template <url> [template text | reset]\``);
		return;
	}

	const url = stripUrlBrackets(args[1]);
	const templateText = args.slice(2).join(" ");

	const feedKey = `${url}-${msg.channelId}`;
	const feed = ctx.feeds.get(feedKey);
	if (!feed) {
		await safeReply(ctx, msg, "Feed not found in this channel.");
		return;
	}

	if (!templateText) {
		if (feed.template) {
			await safeReply(ctx, msg, `📝 **Template for ${formatUrlForMarkdown(url)}:**\n${feed.template}\n\nSet a new one with \`template <url> <text>\` or reset with \`template <url> reset\`.`);
		} else {
			await safeReply(ctx, msg, `📝 No custom template set for ${formatUrlForMarkdown(url)} - the default format is used.`);
		}
		return;
	}

	if (templateText.toLowerCase() === "reset") {
		await ctx.db.execute("UPDATE feeds SET template = NULL WHERE url = ? AND channel_id = ?", [url, msg.channelId]);
		delete feed.template;
		await safeReply(ctx, msg, "✅ Template reset to the default format.");
		return;
	}

	const template = templateText.replace(/\\n/g, "\n");
	if (template.length > 2000) {
		await safeReply(ctx, msg, "❌ Template too long (max 2000 characters).");
		return;
	}

	if (feed.feed_type !== "podcast") {
		const podcastOnlyVars = PODCAST_ONLY_FIELDS.filter((v) => new RegExp(`\\{${v}\\}`).test(template));
		if (podcastOnlyVars.length > 0) {
			await safeReply(
				ctx,
				msg,
				`❌ ${podcastOnlyVars.map((v) => `{${v}}`).join(", ")} ${podcastOnlyVars.length > 1 ? "are" : "is a"} podcast-only variable${podcastOnlyVars.length > 1 ? "s" : ""}, but this feed is ${feed.feed_type.toUpperCase()}.`,
			);
			return;
		}
	}

	const unknown = unknownTemplateVars(template);

	await ctx.db.execute("UPDATE feeds SET template = ? WHERE url = ? AND channel_id = ?", [template, url, msg.channelId]);
	feed.template = template;

	let response = `✅ Template set for ${formatUrlForMarkdown(url)}.`;
	if (unknown.length > 0) {
		response += `\n⚠️ Unknown variable${unknown.length > 1 ? "s" : ""} left as-is: ${unknown.map((v) => `{${v}}`).join(", ")}`;
	}
	await safeReply(ctx, msg, response);
}

async function handlePing(ctx: Ctx, msg: MessageContext): Promise<void> {
	const now = Date.now();
	const wsPing = ctx.stoat.wsPing;
	const wsDisplay = wsPing < 0 ? "`Reconnecting/Syncing…`" : `\`${wsPing}ms\``;

	try {
		const replyMsg = (await msg.reply("⌛ Measuring...")) as { edit: (data: object) => Promise<unknown> };

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

function helpMain(ctx: Ctx): string {
	const botName = ctx.stoat.botUser?.username || "AutoFeeds";
	return [
		"## AutoFeeds Help",
		`AutoFeeds posts new items from RSS, Atom, JSON, and podcast feeds to your channel. Type \`@${botName} help [category]\` to view commands within a category. Visit [the documentation](<https://automod.vale.rocks/docs/autofeeds>) for usage information and [the AutoMod server](https://stt.gg/automod) for help.`,
		"",
		`- \`@${botName} add <url>\` - Add a feed to this channel`,
		`- \`@${botName} remove <url>\` - Remove a feed from this channel`,
		`- \`@${botName} list\` - List all feeds in this channel`,
		`- \`@${botName} check <url>\` - Manually check a feed for new items`,
		"",
		`For more commands and features, see \`@${botName} help filters\`, \`@${botName} help templates\`, and \`@${botName} help feeds\`.`,
	].join("\n");
}

function helpFilters(ctx: Ctx): string {
	const botName = ctx.stoat.botUser?.username || "AutoFeeds";
	return [
		"## Filtering",
		"Block feed items from being posted based on field content or existence. Rules are set per feed.",
		"",
		`**Add a rule**: \`@${botName} filter <url> <field> <operator> [value]\``,
		"",
		`**Fields**: \`${GENERAL_FILTER_FIELDS.join("`, `")}\``,
		`**Operators**: \`${FILTER_OPERATORS.join("`, `")}\``,
		"",
		"**Examples**",
		`- \`@${botName} filter <url> title contains sponsor\``,
		`- \`@${botName} filter <url> type equals trailer\``,
		`- \`@${botName} filter <url> audio missing\``,
		"",
		`**Podcast-only fields**: \`${PODCAST_ONLY_FIELDS.join("`, `")}\``,
		"",
		`Remove rules with \`@${botName} filter remove <url> <rule id>\` and list them with \`@${botName} filter list <url>\`.`,
	].join("\n");
}

function helpTemplates(ctx: Ctx): string {
	const botName = ctx.stoat.botUser?.username || "AutoFeeds";
	return [
		"## Templates",
		"Customise how feed items are posted using variables. Templates are set per feed.",
		"",
		`**Usage**: \`@${botName} template <url> [template text | reset]\``,
		"",
		`**Variables**: \`${["pubTime", "pubTimeUnix", ...GENERAL_TEMPLATE_VARS].map((v) => `{${v}}`).join("`, `")}\``,
		`**Podcast-only variables**: \`${PODCAST_ONLY_FIELDS.map((v) => `{${v}}`).join("`, `")}\``,
		"",
		"- `{pubTime}` accepts an optional format: `{pubTime:YYYY-MM-DD HH:mm}` (tokens `YYYY`, `MM`, `DD`, `HH`, `mm`, `ss`, UTC)",
		"- Use `\\n` for newlines",
		"- Unknown variables are left as-is",
	].join("\n");
}

function helpFeeds(): string {
	return [
		"## Supported Feed Types",
		"- **RSS 2.0** and **Atom 1.0** - XML syndication feeds",
		"- **JSON Feed 1.0/1.1** - JSON-based feeds",
		"- **Podcasts** - RSS feeds with iTunes/podcast namespaces",
		"",
		"Podcast feeds post all episode types by default. Block trailers or bonus episodes with `filter <url> type equals trailer`.",
		"Feeds are automatically checked every 20 minutes or as specified by the feed.",
	].join("\n");
}

async function handleHelp(ctx: Ctx, msg: MessageContext, args?: string[]): Promise<void> {
	const topic = args?.[1]?.toLowerCase();

	let help: string;
	switch (topic) {
		case "filters":
		case "filter":
			help = helpFilters(ctx);
			break;
		case "templates":
		case "template":
			help = helpTemplates(ctx);
			break;
		case "feeds":
		case "feed":
			help = helpFeeds();
			break;
		case undefined:
			help = helpMain(ctx);
			break;
		default:
			help = `❌ Unknown help topic \`${topic}\`. Topics: \`filters\`, \`templates\`, \`feeds\`.`;
	}

	await safeReply(ctx, msg, help);
}

function setupCommands(ctx: Ctx): void {
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
					case "filter":
						await handleFilter(ctx, msg, args);
						break;
					case "template":
						await handleTemplate(ctx, msg, args);
						break;
					case "ping":
						await handlePing(ctx, msg);
						break;
					case "help":
						await handleHelp(ctx, msg, args);
						break;
					default:
						await safeReply(ctx, msg, `That isn't a command. You can see the documentation with \`@${stoat.botUser?.username || "AutoFeeds"} help\`.`);
				}
			} catch (error) {
				if ((error as { type?: string }).type === "MissingPermission") {
					await safeReply(ctx, msg, "⚠️ AutoFeeds couldn't reply in this channel due to missing permissions.");
				} else {
					console.error("Command error:", error);
					await safeReply(ctx, msg, "❌ An error occurred while processing your command.");
				}
			}
		})();
	});
}

export { setupCommands, isUserModerator, safeReply };
