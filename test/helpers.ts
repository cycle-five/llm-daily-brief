import { env } from "cloudflare:test";
import { normalize } from "../src/core/normalize";
import type { EntryRow, HitRow } from "../src/core/rows";
import { LedgerStore } from "../src/store/d1";

export function testStore(): LedgerStore {
	return new LedgerStore(env.DB);
}

export function seedUser(label = "user"): Promise<string> {
	return testStore().findOrCreateUserByIdentity(
		{
			provider: "github",
			subject: `${label}-${crypto.randomUUID()}`,
			email: null,
			displayName: label,
		},
		Date.now(),
		() => crypto.randomUUID(),
	);
}

export function uniqueCategory(): string {
	return `c-${crypto.randomUUID()}`;
}

export function makeEntry(
	userId: string,
	category: string,
	displayName: string,
	overrides: Partial<EntryRow> = {},
): EntryRow {
	return {
		id: crypto.randomUUID(),
		user_id: userId,
		category,
		display_name: displayName,
		normalized: normalize(displayName),
		vector_status: "pending",
		hit_count: 0,
		created_at: Date.now(),
		...overrides,
	};
}

export function makeHit(
	entry: EntryRow,
	candidate: string,
	overrides: Partial<HitRow> = {},
): HitRow {
	return {
		id: crypto.randomUUID(),
		entry_id: entry.id,
		user_id: entry.user_id,
		candidate_text: candidate,
		candidate_normalized: normalize(candidate),
		match_kind: "exact",
		score: 1,
		created_at: Date.now(),
		...overrides,
	};
}
