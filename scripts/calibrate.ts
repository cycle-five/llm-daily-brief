import { z } from "zod";
import { chunk } from "../src/core/chunk.ts";
import { PAIRS } from "./calibration-pairs.ts";

/** Keep in sync with EMBEDDING_MODEL in src/semantic/cloudflare.ts. */
const MODEL = "@cf/qwen/qwen3-embedding-0.6b";
/** The embedding model accepts at most 32 texts per call. */
const BATCH_SIZE = 32;

const AiRunResponse = z.object({
	success: z.boolean(),
	result: z.object({ data: z.array(z.array(z.number())) }).optional(),
	errors: z.array(z.object({ message: z.string() })).default([]),
});

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
if (!accountId || !apiToken) {
	console.error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (Workers AI read) first.");
	process.exit(1);
}

async function embed(texts: string[]): Promise<number[][]> {
	const response = await fetch(
		`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${MODEL}`,
		{
			method: "POST",
			headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" },
			body: JSON.stringify({ text: texts }),
		},
	);
	const body = AiRunResponse.parse(await response.json());
	if (!response.ok || !body.success || !body.result) {
		throw new Error(
			`Workers AI ${response.status}: ${body.errors.map((e) => e.message).join("; ")}`,
		);
	}
	return body.result.data;
}

async function embedAll(texts: string[]): Promise<number[][]> {
	const out: number[][] = [];
	for (const batch of chunk(texts, BATCH_SIZE)) out.push(...(await embed(batch)));
	return out;
}

function cosine(a: number[], b: number[]): number {
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i++) {
		const x = a[i] ?? 0;
		const y = b[i] ?? 0;
		dot += x * y;
		normA += x * x;
		normB += y * y;
	}
	return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

const texts = [...new Set(PAIRS.flatMap((pair) => [pair.a, pair.b]))];
const vectors = new Map<string, number[]>();
const embeddings = await embedAll(texts);
texts.forEach((text, i) => {
	const vector = embeddings[i];
	if (!vector) throw new Error(`no embedding returned for ${text}`);
	vectors.set(text, vector);
});

const scored = PAIRS.map((pair) => ({
	...pair,
	score: cosine(vectors.get(pair.a) ?? [], vectors.get(pair.b) ?? []),
})).sort((x, y) => y.score - x.score);

for (const pair of scored) {
	console.log(`${pair.score.toFixed(3)}  ${pair.same ? "SAME" : "diff"}  ${pair.a}  |  ${pair.b}`);
}

const sameScores = scored.filter((p) => p.same).map((p) => p.score);
const differentScores = scored.filter((p) => !p.same).map((p) => p.score);
const minSame = Math.min(...sameScores);
const maxDifferent = Math.max(...differentScores);
console.log(`\nmin SAME score:      ${minSame.toFixed(3)}`);
console.log(`max different score: ${maxDifferent.toFixed(3)}`);
console.log(
	`suggested SEMANTIC_POSSIBLE_THRESHOLD = ${(Math.floor(minSame * 100) / 100).toFixed(2)} (surfaces every SAME pair as a possible match for the brief to judge)`,
);
console.log(
	minSame > maxDifferent
		? `SAME and different pairs separate: SEMANTIC_REPEAT_THRESHOLD could be ${(Math.ceil((maxDifferent + 0.005) * 100) / 100).toFixed(2)}`
		: "SAME and different pairs overlap: keep SEMANTIC_REPEAT_THRESHOLD = 1 so semantic matches stay advisory",
);
