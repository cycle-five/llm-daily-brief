import type { Thresholds } from "./core/match";
import type { Env } from "./env";

export const DEFAULT_THRESHOLDS: Thresholds = {
	trigramRepeat: 0.6,
	semanticRepeat: 0.85,
	semanticPossible: 0.75,
};

const DEFAULT_GLOBAL_MIN_USERS = 2;

function readNumber(name: string, raw: string | undefined, fallback: number): number {
	if (raw === undefined || raw.trim() === "") return fallback;
	const value = Number(raw);
	if (!Number.isFinite(value)) throw new Error(`${name} must be a number, got "${raw}"`);
	return value;
}

export function thresholdsFromEnv(
	env: Pick<
		Env,
		"TRIGRAM_REPEAT_THRESHOLD" | "SEMANTIC_REPEAT_THRESHOLD" | "SEMANTIC_POSSIBLE_THRESHOLD"
	>,
): Thresholds {
	const thresholds: Thresholds = {
		trigramRepeat: readNumber(
			"TRIGRAM_REPEAT_THRESHOLD",
			env.TRIGRAM_REPEAT_THRESHOLD,
			DEFAULT_THRESHOLDS.trigramRepeat,
		),
		semanticRepeat: readNumber(
			"SEMANTIC_REPEAT_THRESHOLD",
			env.SEMANTIC_REPEAT_THRESHOLD,
			DEFAULT_THRESHOLDS.semanticRepeat,
		),
		semanticPossible: readNumber(
			"SEMANTIC_POSSIBLE_THRESHOLD",
			env.SEMANTIC_POSSIBLE_THRESHOLD,
			DEFAULT_THRESHOLDS.semanticPossible,
		),
	};
	if (thresholds.semanticPossible > thresholds.semanticRepeat) {
		throw new Error("SEMANTIC_POSSIBLE_THRESHOLD must not exceed SEMANTIC_REPEAT_THRESHOLD");
	}
	return thresholds;
}

export function globalMinUsersFromEnv(env: Pick<Env, "GLOBAL_MIN_USERS">): number {
	const value = readNumber("GLOBAL_MIN_USERS", env.GLOBAL_MIN_USERS, DEFAULT_GLOBAL_MIN_USERS);
	if (!Number.isInteger(value) || value < 1) {
		throw new Error(`GLOBAL_MIN_USERS must be a positive integer, got "${env.GLOBAL_MIN_USERS}"`);
	}
	return value;
}
