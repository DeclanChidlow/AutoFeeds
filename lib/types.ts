import type { Pool } from "mysql2/promise";
import type Parser from "rss-parser";
import type { StoatClient } from "./stoat";

export type FeedType = "rss" | "atom" | "json" | "podcast";

export interface Feed {
	id?: number;
	url: string;
	channel_id: string;
	server_id: string;
	feed_type: FeedType;
	template?: string | null;
	etag?: string | null;
	lastModified?: string | null;
	nextCheckTime?: number;
	ttl?: number;
	skipHours?: number[];
	skipDays?: string[];
	last_updated?: Date;
	created_at?: Date;
}

export interface FeedItem {
	id?: string | null;
	title?: string | null;
	link?: string | null;
	description?: string | null;
	bodyHtml?: string | null;
	published?: Date;
	author?: string | null;
	categories: string[];
	audioUrl?: string | null;
	audioType?: string | null;
	audioLength?: string | number | null;
	isPodcast?: boolean;
	episodeType?: string | null;
	episodeNumber?: string | number | null;
	seasonNumber?: string | number | null;
	duration?: string | null;
	feedTitle?: string | null;
	feedLink?: string | null;
}

export interface FilterRule {
	id: number;
	field_name: string;
	operator: string;
	filter_value: string | null;
}

export interface Ctx {
	stoat: StoatClient;
	db: Pool;
	feeds: Map<string, Feed>;
	parser: Parser;
	notifiedOwners: Set<string>;
	setBotStatus: () => Promise<void>;
}
