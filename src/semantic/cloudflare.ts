import { chunk } from "../core/chunk";
import type { SemanticHit } from "../core/match";
import type { Env } from "../env";
import {
	type SemanticDocument,
	type SemanticIndex,
	type SemanticQuery,
	UnavailableSemanticIndex,
} from "./index";

export const EMBEDDING_MODEL = "@cf/google/embeddinggemma-300m";
export const EMBEDDING_DIMENSIONS = 768;
const BATCH_SIZE = 100;

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
		for (const batch of chunk(documents, BATCH_SIZE)) {
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
		for (const batch of chunk(entryIds, BATCH_SIZE)) {
			await this.vectors.deleteByIds(batch);
		}
	}

	private async embed(texts: string[]): Promise<number[][]> {
		const output = await this.ai.run(EMBEDDING_MODEL, { text: texts });
		if (output.data.length !== texts.length) {
			throw new Error(`expected ${texts.length} embeddings, got ${output.data.length}`);
		}
		return output.data;
	}
}

export function semanticIndexFromEnv(env: Pick<Env, "AI" | "VECTORS">): SemanticIndex {
	if (!env.AI || !env.VECTORS) return new UnavailableSemanticIndex();
	return new CloudflareSemanticIndex(env.AI, env.VECTORS);
}
