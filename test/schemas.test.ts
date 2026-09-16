import { describe, expect, it } from "vitest";
import {
	CheckInput,
	ClaimInput,
	ClaimResult,
	KeepInput,
	ListInput,
	SkipInput,
	StatsInput,
} from "../src/api/schemas";

describe("ClaimInput", () => {
	it("trims and lowercases the category, trims the name, defaults force to false", () => {
		expect(ClaimInput.parse({ category: "  Math ", name: " Euler " })).toEqual({
			category: "math",
			name: "Euler",
			force: false,
		});
	});

	it("accepts a 64-byte category and rejects 65+ bytes", () => {
		expect(CheckInput.safeParse({ category: "é".repeat(32), name: "x" }).success).toBe(true);
		expect(CheckInput.safeParse({ category: "é".repeat(33), name: "x" }).success).toBe(false);
		expect(CheckInput.safeParse({ category: "a".repeat(65), name: "x" }).success).toBe(false);
	});

	it("rejects blank categories and names, and names over 200 characters", () => {
		expect(CheckInput.safeParse({ category: "   ", name: "x" }).success).toBe(false);
		expect(CheckInput.safeParse({ category: "math", name: "   " }).success).toBe(false);
		expect(CheckInput.safeParse({ category: "math", name: "x".repeat(201) }).success).toBe(false);
	});
});

describe("ListInput", () => {
	it("coerces string query parameters and applies the default limit", () => {
		expect(ListInput.parse({ limit: "5" })).toEqual({ limit: 5 });
		expect(ListInput.parse({})).toEqual({ limit: 20 });
	});

	it("rejects out-of-range limits and non-ISO since values", () => {
		expect(ListInput.safeParse({ limit: "0" }).success).toBe(false);
		expect(ListInput.safeParse({ limit: "101" }).success).toBe(false);
		expect(ListInput.safeParse({ since: "yesterday" }).success).toBe(false);
		expect(ListInput.safeParse({ since: "2026-09-14T00:00:00.000Z" }).success).toBe(true);
	});
});

describe("StatsInput", () => {
	it("defaults to scope me", () => {
		expect(StatsInput.parse({})).toEqual({ scope: "me", limit: 20 });
	});
});

describe("ClaimResult", () => {
	it("parses all three variants", () => {
		const entry = {
			id: "e1",
			category: "math",
			display_name: "Euler",
			created_at: "2026-09-14T00:00:00.000Z",
			hit_count: 0,
		};
		expect(
			ClaimResult.parse({
				status: "claimed",
				entry,
				forced: false,
				overridden_matches: [],
				semantic: "ok",
			}).status,
		).toBe("claimed");
		expect(
			ClaimResult.parse({
				status: "possible_repeat",
				entry,
				possible_matches: [],
				next_step: "decide",
				semantic: "ok",
			}).status,
		).toBe("possible_repeat");
		expect(
			ClaimResult.parse({ status: "repeat", matches: [], semantic: "unavailable" }).status,
		).toBe("repeat");
		expect(
			ClaimResult.safeParse({
				status: "claimed",
				entry,
				forced: false,
				possible_matches: [],
				semantic: "ok",
			}).success,
		).toBe(false);
	});
});

describe("verdict inputs", () => {
	it("trims notes, bounds them to 1-500 characters, and requires repeat_of for skip", () => {
		expect(KeepInput.parse({ entry_id: "e1", note: "  different people " })).toEqual({
			entry_id: "e1",
			note: "different people",
		});
		expect(KeepInput.parse({ entry_id: "e1" })).toEqual({ entry_id: "e1" });
		expect(KeepInput.safeParse({ entry_id: "e1", note: "   " }).success).toBe(false);
		expect(
			SkipInput.safeParse({ entry_id: "e1", repeat_of: "e2", note: "x".repeat(501) }).success,
		).toBe(false);
		expect(SkipInput.safeParse({ entry_id: "e1" }).success).toBe(false);
		expect(SkipInput.safeParse({ entry_id: "", repeat_of: "e2" }).success).toBe(false);
	});
});
