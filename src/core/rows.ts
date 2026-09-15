import { z } from "zod";
import { MatchKind } from "../api/schemas";

export const UserRowSchema = z.object({
	id: z.string(),
	display_name: z.string().nullable(),
	email: z.string().nullable(),
	created_at: z.number(),
});
export type UserRow = z.infer<typeof UserRowSchema>;

export const EntryRowSchema = z.object({
	id: z.string(),
	user_id: z.string(),
	category: z.string(),
	display_name: z.string(),
	normalized: z.string(),
	vector_status: z.enum(["pending", "indexed"]),
	hit_count: z.number().int(),
	/** Null for an original topic; the original's id for an alias. */
	alias_of: z.string().nullable(),
	created_at: z.number(),
});
export type EntryRow = z.infer<typeof EntryRowSchema>;

export const HitRowSchema = z.object({
	id: z.string(),
	entry_id: z.string(),
	user_id: z.string(),
	candidate_text: z.string(),
	candidate_normalized: z.string(),
	match_kind: MatchKind,
	score: z.number(),
	created_at: z.number(),
});
export type HitRow = z.infer<typeof HitRowSchema>;

export const VerdictSchema = z.enum(["pending", "repeat", "distinct"]);
export type Verdict = z.infer<typeof VerdictSchema>;

export const NearMissRowSchema = z.object({
	id: z.string(),
	user_id: z.string(),
	claim_entry_id: z.string(),
	matched_entry_id: z.string(),
	via_entry_id: z.string().nullable(),
	match_kind: MatchKind,
	score: z.number(),
	verdict: VerdictSchema,
	note: z.string().nullable(),
	created_at: z.number(),
	decided_at: z.number().nullable(),
});
export type NearMissRow = z.infer<typeof NearMissRowSchema>;

export const TokenRowSchema = z.object({
	id: z.string(),
	user_id: z.string(),
	token_hash: z.string(),
	label: z.string(),
	created_at: z.number(),
	last_used_at: z.number().nullable(),
	revoked_at: z.number().nullable(),
});
export type TokenRow = z.infer<typeof TokenRowSchema>;
