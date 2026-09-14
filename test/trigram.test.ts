import { describe, expect, it } from "vitest";
import { trigramSimilarity, trigrams } from "../src/core/trigram";

describe("trigrams", () => {
	it("pads with one space on each side", () => {
		expect([...trigrams("ab")].sort()).toEqual([" ab", "ab "]);
	});

	it("returns an empty set for an empty string", () => {
		expect(trigrams("").size).toBe(0);
	});
});

describe("trigramSimilarity", () => {
	it("is 1 for identical strings", () => {
		expect(trigramSimilarity("euler identity", "euler identity")).toBe(1);
	});

	it("keeps different topics that share a word well below 0.6", () => {
		expect(trigramSimilarity("euler identity", "euler totient")).toBeCloseTo(6 / 21, 5);
	});

	it("scores a one-letter misspelling of a long name above 0.6", () => {
		expect(trigramSimilarity("srinivasa ramanujan", "srinivasa ramanujam")).toBeCloseTo(17 / 21, 5);
	});

	it("is symmetric", () => {
		expect(trigramSimilarity("godel", "kurt godel")).toBe(trigramSimilarity("kurt godel", "godel"));
	});

	it("is 0 when exactly one side is empty and 1 when both are", () => {
		expect(trigramSimilarity("", "ab")).toBe(0);
		expect(trigramSimilarity("", "")).toBe(1);
	});
});
