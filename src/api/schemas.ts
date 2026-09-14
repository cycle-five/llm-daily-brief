import { z } from "zod";

const utf8Length = (value: string): number => new TextEncoder().encode(value).length;

export const Category = z
	.string()
	.trim()
	.toLowerCase()
	.refine((value) => {
		const bytes = utf8Length(value);
		return bytes >= 1 && bytes <= 64;
	}, "category must be 1-64 UTF-8 bytes after trimming");
export type Category = z.infer<typeof Category>;

export const TopicName = z.string().trim().min(1).max(200);
export type TopicName = z.infer<typeof TopicName>;

const Limit = z.coerce.number().int().min(1).max(100).default(20);

export const MatchKind = z.enum(["exact", "trigram", "semantic"]);
export type MatchKind = z.infer<typeof MatchKind>;

export const Confidence = z.enum(["repeat", "possible"]);
export type Confidence = z.infer<typeof Confidence>;

export const SemanticStatus = z.enum(["ok", "unavailable"]);
export type SemanticStatus = z.infer<typeof SemanticStatus>;

export const Match = z.object({
	entry_id: z.string(),
	display_name: z.string(),
	category: z.string(),
	kind: MatchKind,
	score: z.number(),
	confidence: Confidence,
	first_seen: z.string(),
	hit_count: z.number().int(),
});
export type Match = z.infer<typeof Match>;

export const Entry = z.object({
	id: z.string(),
	category: z.string(),
	display_name: z.string(),
	created_at: z.string(),
	hit_count: z.number().int(),
});
export type Entry = z.infer<typeof Entry>;

export const ClaimInput = z.object({
	category: Category,
	name: TopicName,
	force: z.boolean().default(false),
});
export type ClaimInput = z.infer<typeof ClaimInput>;

export const ClaimResult = z.discriminatedUnion("status", [
	z.object({
		status: z.literal("claimed"),
		entry: Entry,
		forced: z.boolean(),
		possible_matches: z.array(Match),
		semantic: SemanticStatus,
	}),
	z.object({
		status: z.literal("repeat"),
		matches: z.array(Match),
		semantic: SemanticStatus,
	}),
]);
export type ClaimResult = z.infer<typeof ClaimResult>;

export const CheckInput = z.object({ category: Category, name: TopicName });
export type CheckInput = z.infer<typeof CheckInput>;

export const CheckResult = z.object({
	likely_repeat: z.boolean(),
	matches: z.array(Match),
	semantic: SemanticStatus,
});
export type CheckResult = z.infer<typeof CheckResult>;

export const ListInput = z.object({
	category: Category.optional(),
	limit: Limit,
	since: z.iso.datetime().optional(),
});
export type ListInput = z.infer<typeof ListInput>;

export const ListResult = z.object({ entries: z.array(Entry) });
export type ListResult = z.infer<typeof ListResult>;

export const ForgetInput = z.object({ entry_id: z.string().min(1) });
export type ForgetInput = z.infer<typeof ForgetInput>;

export const StatsInput = z.object({
	scope: z.enum(["me", "global"]).default("me"),
	category: Category.optional(),
	limit: Limit,
});
export type StatsInput = z.infer<typeof StatsInput>;

export const RepeatStat = z.object({
	display_name: z.string(),
	category: z.string(),
	hit_count: z.number().int(),
	distinct_users: z.number().int().optional(),
	recent_phrasings: z.array(z.string()).optional(),
});
export type RepeatStat = z.infer<typeof RepeatStat>;

export const StatsResult = z.object({
	scope: z.enum(["me", "global"]),
	repeats: z.array(RepeatStat),
});
export type StatsResult = z.infer<typeof StatsResult>;

export const ErrorCode = z.enum([
	"unauthorized",
	"invalid_input",
	"not_found",
	"rate_limited",
	"upstream_unavailable",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorBody = z.object({
	error: z.object({ code: ErrorCode, message: z.string() }),
});
export type ErrorBody = z.infer<typeof ErrorBody>;
