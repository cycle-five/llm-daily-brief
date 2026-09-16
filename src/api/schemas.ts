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
	via_alias: z.string().optional(),
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
		/** Matches a forced claim overrode; empty unless forced. */
		overridden_matches: z.array(Match),
		semantic: SemanticStatus,
	}),
	z.object({
		status: z.literal("possible_repeat"),
		entry: Entry,
		possible_matches: z.array(Match),
		next_step: z.string(),
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

const EntryId = z.string().min(1);
const Note = z.string().trim().min(1).max(500);

export const SkipBody = z.object({ repeat_of: EntryId, note: Note.optional() });
export type SkipBody = z.infer<typeof SkipBody>;

export const SkipInput = SkipBody.extend({ entry_id: EntryId });
export type SkipInput = z.infer<typeof SkipInput>;

export const SkipResult = z.object({ skipped: z.string(), alias_of: Match });
export type SkipResult = z.infer<typeof SkipResult>;

export const KeepBody = z.object({ note: Note.optional() });
export type KeepBody = z.infer<typeof KeepBody>;

export const KeepInput = KeepBody.extend({ entry_id: EntryId });
export type KeepInput = z.infer<typeof KeepInput>;

export const KeepResult = z.object({ kept: z.string(), distinct: z.number().int() });
export type KeepResult = z.infer<typeof KeepResult>;

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

/** MCP arguments arrive as JSON numbers, so tools use a plain number instead of query-string coercion. */
const ToolLimit = z.number().int().min(1).max(100).default(20);

export const ListToolInput = ListInput.extend({ limit: ToolLimit });
export type ListToolInput = z.infer<typeof ListToolInput>;

export const StatsToolInput = StatsInput.extend({ limit: ToolLimit });
export type StatsToolInput = z.infer<typeof StatsToolInput>;

export const ForgetResult = z.object({ forgotten: z.string() });
export type ForgetResult = z.infer<typeof ForgetResult>;
