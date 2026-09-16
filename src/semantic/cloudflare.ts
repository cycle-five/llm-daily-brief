import { chunk } from "../core/chunk";
import type { SemanticHit } from "../core/match";
import type { Env } from "../env";
import {
	type SemanticDocument,
	type SemanticIndex,
	type SemanticQuery,
	UnavailableSemanticIndex,
} from "./index";

/**
 * Chosen by calibration (docs/calibration.md). Changing the model requires a new Vectorize index
 * whose dimensions match EMBEDDING_DIMENSIONS.
 */
export const EMBEDDING_MODEL = "@cf/qwen/qwen3-embedding-0.6b";
export const EMBEDDING_DIMENSIONS = 1024;
/** The embedding model accepts at most 32 texts per call. */
const EMBEDDING_BATCH_SIZE = 32;
const DELETE_BATCH_SIZE = 100;

export class CloudflareSemanticIndex implements SemanticIndex {
	constructor(
		private readonly ai: Ai,
		private readonly vectors: Vectorize,
	) {}

	async query(query: SemanticQuery): Promise<SemanticHit[]> {
		const [vector] = await this.embed([query.text]);
		if (!vector) throw new Error("embedding model returned no vector");
		const result = await this.vectors.query(vector, {
			topK: query.topK,
			filter: { user_id: { $eq: query.userId }, category: { $eq: query.category } },
		});
		return result.matches.map((match) => ({ entryId: match.id, score: match.score }));
	}

	async upsert(documents: readonly SemanticDocument[]): Promise<void> {
		for (const batch of chunk(documents, EMBEDDING_BATCH_SIZE)) {
			const embeddings = await this.embed(batch.map((doc) => doc.text));
			await this.vectors.upsert(
				batch.map((doc, i) => {
					const values = embeddings[i];
					if (!values) throw new Error(`missing embedding for entry ${doc.entryId}`);
					return {
						id: doc.entryId,
						values,
						metadata: { user_id: doc.userId, category: doc.category },
					};
				}),
			);
		}
	}

	async remove(entryIds: readonly string[]): Promise<void> {
		for (const batch of chunk(entryIds, DELETE_BATCH_SIZE)) {
			await this.vectors.deleteByIds(batch);
		}
	}

	private async embed(texts: string[]): Promise<number[][]> {
		const output = await this.ai.run(EMBEDDING_MODEL, { text: texts });
		const data = output.data;
		if (!data || data.length !== texts.length) {
			throw new Error(`expected ${texts.length} embeddings, got ${data?.length ?? 0}`);
		}
		return data;
	}
}

export function semanticIndexFromEnv(env: Pick<Env, "AI" | "VECTORS">): SemanticIndex {
	if (!env.AI || !env.VECTORS) return new UnavailableSemanticIndex();
	return new CloudflareSemanticIndex(env.AI, env.VECTORS);
}
