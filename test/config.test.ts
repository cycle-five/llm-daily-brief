import { describe, expect, it } from "vitest";
import { DEFAULT_THRESHOLDS, globalMinUsersFromEnv, thresholdsFromEnv } from "../src/config";

const vars = {
	TRIGRAM_REPEAT_THRESHOLD: "0.6",
	SEMANTIC_REPEAT_THRESHOLD: "0.85",
	SEMANTIC_POSSIBLE_THRESHOLD: "0.75",
	GLOBAL_MIN_USERS: "2",
};

describe("config", () => {
	it("parses thresholds from string vars", () => {
		expect(thresholdsFromEnv(vars)).toEqual(DEFAULT_THRESHOLDS);
		expect(thresholdsFromEnv({ ...vars, SEMANTIC_REPEAT_THRESHOLD: "0.9" }).semanticRepeat).toBe(
			0.9,
		);
	});

	it("falls back to defaults for blank vars", () => {
		expect(thresholdsFromEnv({ ...vars, TRIGRAM_REPEAT_THRESHOLD: "" }).trigramRepeat).toBe(0.6);
	});

	it("rejects non-numeric values and a possible threshold above the repeat threshold", () => {
		expect(() => thresholdsFromEnv({ ...vars, TRIGRAM_REPEAT_THRESHOLD: "high" })).toThrow(
			/TRIGRAM_REPEAT_THRESHOLD/,
		);
		expect(() => thresholdsFromEnv({ ...vars, SEMANTIC_POSSIBLE_THRESHOLD: "0.95" })).toThrow(
			/SEMANTIC_POSSIBLE_THRESHOLD/,
		);
	});

	it("rejects thresholds outside [0, 1]", () => {
		expect(() => thresholdsFromEnv({ ...vars, TRIGRAM_REPEAT_THRESHOLD: "6" })).toThrow(
			/TRIGRAM_REPEAT_THRESHOLD/,
		);
		expect(() => thresholdsFromEnv({ ...vars, SEMANTIC_REPEAT_THRESHOLD: "-0.1" })).toThrow(
			/SEMANTIC_REPEAT_THRESHOLD/,
		);
		expect(thresholdsFromEnv({ ...vars, TRIGRAM_REPEAT_THRESHOLD: "1" }).trigramRepeat).toBe(1);
		expect(thresholdsFromEnv({ ...vars, SEMANTIC_POSSIBLE_THRESHOLD: "0" }).semanticPossible).toBe(
			0,
		);
	});

	it("parses GLOBAL_MIN_USERS as a positive integer", () => {
		expect(globalMinUsersFromEnv(vars)).toBe(2);
		expect(() => globalMinUsersFromEnv({ GLOBAL_MIN_USERS: "0" })).toThrow(/GLOBAL_MIN_USERS/);
		expect(() => globalMinUsersFromEnv({ GLOBAL_MIN_USERS: "1.5" })).toThrow(/GLOBAL_MIN_USERS/);
	});
});
