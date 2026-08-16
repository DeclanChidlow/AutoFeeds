"use strict";

const VERBOSE = process.env["VERBOSE_LOGGING"] === "true" || process.env["VERBOSE_LOGGING"] === "1";

function verboseLog(...args: unknown[]): void {
	if (VERBOSE) console.log(...args);
}

/**
 * Normalise a URL given in a command. Strips surrounding angle brackets
 */
function stripUrlBrackets(url: string): string {
	let cleaned = url.trim();
	if (cleaned.startsWith("<") && cleaned.endsWith(">")) {
		cleaned = cleaned.slice(1, -1).trim();
	}
	return cleaned;
}

/**
 * Wrap a URL in angle brackets so markdown renders it as a plain link.
 * Used for bot replies; posted feed items use bare links so embeds render.
 */
function formatUrlForMarkdown(url: string): string {
	if (url === "") return url;
	return `<${url}>`;
}

export { VERBOSE, verboseLog, stripUrlBrackets, formatUrlForMarkdown };
