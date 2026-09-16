import { z } from "zod";
import { MatchKind } from "../api/schemas";

export const UserRowSchema = z.object({
	id: z.string(),
	display_name: z.string().nullable(),
	email: z.string().nullable(),
	created_at: z.number(),
	/** Stored as 0 or 1. True shares one ledger across all of the user's models. */
	share_ledger: z
		.number()
		.int()
		.transform((value) => value === 1),
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
	/** The declared model family. Null for an unattributed row, which belongs to every model. */
	model: z.string().nullable(),
	/** The declared model version: a label that never affects matching. */
	model_version: z.string().nullable(),
	/** The connection's name (token label or OAuth client name), kept for audit. */
	client: z.string().nullable(),
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
	/** The model that made the attempt. With a shared ledger it can differ from the entry's model. */
	model: z.string().nullable(),
	model_version: z.string().nullable(),
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
