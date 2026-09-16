import { describe, expect, it } from "vitest";
import { normalize, normalizeCategory } from "../src/core/normalize";

describe("normalize", () => {
	it.each([
		["Euler's Identity", "euler identity"],
		["Euler\u2019s Identity", "euler identity"],
		["Kurt Gödel", "kurt godel"],
		["The Banach–Tarski Paradox", "banach tarski paradox"],
		["P & NP", "p and np"],
		["  Ada   Lovelace  ", "ada lovelace"],
		["An Introduction", "introduction"],
		["A Mathematician's Apology", "mathematician apology"],
		["Theory of Everything", "theory of everything"],
		["e^(iπ)+1=0", "e iπ 1 0"],
		["!!!", ""],
	])("normalize(%j) === %j", (input, expected) => {
		expect(normalize(input)).toBe(expected);
	});
});

describe("normalizeCategory", () => {
	it("trims and lowercases without folding punctuation", () => {
		expect(normalizeCategory("  Math-History ")).toBe("math-history");
	});
});
