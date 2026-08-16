"use strict";

import type { FeedItem } from "./types";

/**
 * Maps template variable names to standardised item fields. The field names are produced by parseXmlFeed/parseJsonFeed so the same variables work across RSS, Atom, JSON, and podcast feeds.
 */
const TEMPLATE_VAR_FIELDS: Record<string, keyof FeedItem> = {
	title: "title",
	body: "description",
	bodyHtml: "bodyHtml",
	link: "link",
	id: "id",
	author: "author",
	categories: "categories",
	audio: "audioUrl",
	audioType: "audioType",
	audioLength: "audioLength",
	duration: "duration",
	season: "seasonNumber",
	episode: "episodeNumber",
	type: "episodeType",
	feedTitle: "feedTitle",
	feedLink: "feedLink",
};

const DEFAULT_PUB_TIME_FORMAT = "YYYY-MM-DD HH:mm";

function isKnownTemplateVar(name: string): boolean {
	return name === "pubTime" || name === "pubTimeUnix" || Object.hasOwn(TEMPLATE_VAR_FIELDS, name);
}

/**
 * Format a date using strftime-like tokens: YYYY, MM, DD, HH, mm, ss (UTC).
 */
function formatTemplateDate(date: unknown, fmt?: string): string {
	const d = date instanceof Date && !isNaN(date.getTime()) ? date : new Date();
	const pad = (n: number): string => String(n).padStart(2, "0");
	const tokens: Record<string, string> = {
		YYYY: String(d.getUTCFullYear()),
		MM: pad(d.getUTCMonth() + 1),
		DD: pad(d.getUTCDate()),
		HH: pad(d.getUTCHours()),
		mm: pad(d.getUTCMinutes()),
		ss: pad(d.getUTCSeconds()),
	};
	return String(fmt || DEFAULT_PUB_TIME_FORMAT).replace(/YYYY|MM|DD|HH|mm|ss/g, (m) => tokens[m] ?? m);
}

/**
 * Render a template, replacing {var} placeholders with values from the item.
 * {pubTime} accepts an optional format: {pubTime:YYYY-MM-DD}. Unknown variables are left as-is so typos are visible in the output.
 */
function renderTemplate(template: string, item: FeedItem): string | null {
	if (template === "") return null;

	return template.replace(/\{([a-zA-Z]+)(?::([^}]+))?\}/g, (match, name: string, fmt?: string) => {
		if (name === "pubTime") return formatTemplateDate(item.published, fmt);
		if (name === "pubTimeUnix") {
			const d = item.published instanceof Date && !isNaN(item.published.getTime()) ? item.published : null;
			return d ? String(Math.floor(d.getTime() / 1000)) : "";
		}

		const key = TEMPLATE_VAR_FIELDS[name];
		if (!key) return match;

		const value = item[key];
		if (value === null || value === undefined || value === "") return "";
		return Array.isArray(value) ? value.join(", ") : String(value);
	});
}

/**
 * Return the names of unknown variables used in a template ([] if all known).
 */
function unknownTemplateVars(template: string): string[] {
	const names = [...template.matchAll(/\{([a-zA-Z]+)(?::[^}]+)?\}/g)].map((m) => m[1]);
	return [...new Set(names.filter((name) => name !== undefined && !isKnownTemplateVar(name)))];
}

export { TEMPLATE_VAR_FIELDS, DEFAULT_PUB_TIME_FORMAT, isKnownTemplateVar, formatTemplateDate, renderTemplate, unknownTemplateVars };
