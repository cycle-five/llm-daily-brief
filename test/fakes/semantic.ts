import type { SemanticHit } from "../../src/core/match";
import type { SemanticDocument, SemanticIndex, SemanticQuery } from "../../src/semantic/index";

/**
 * Deterministic in-memory SemanticIndex. Texts equal ignoring case score 1; pairs registered
 * with setSimilarity score that value; everything else scores 0 and is not returned.
 */
export class FakeSemanticIndex implements SemanticIndex {
	readonly documents = new Map<string, SemanticDocument>();
	failing = false;
	private readonly scores = new Map<string, number>();

	setSimilarity(a: string, b: string, score: number): void {
		this.scores.set(this.pairKey(a, b), score);
	}

	async query(query: SemanticQuery): Promise<SemanticHit[]> {
		this.assertAvailable();
		const hits: SemanticHit[] = [];
		for (const doc of this.documents.values()) {
			if (doc.userId !== query.userId || doc.category !== query.category) continue;
			const score =
				doc.text.toLowerCase() === query.text.toLowerCase()
					? 1
					: (this.scores.get(this.pairKey(doc.text, query.text)) ?? 0);
			if (score > 0) hits.push({ entryId: doc.entryId, score });
		}
		return hits.sort((a, b) => b.score - a.score).slice(0, query.topK);
	}

	async upsert(documents: readonly SemanticDocument[]): Promise<void> {
		this.assertAvailable();
		for (const doc of documents) this.documents.set(doc.entryId, doc);
	}

	async remove(entryIds: readonly string[]): Promise<void> {
		this.assertAvailable();
		for (const id of entryIds) this.documents.delete(id);
	}

	private pairKey(a: string, b: string): string {
		return [a.toLowerCase(), b.toLowerCase()].sort().join("\u0000");
	}

	private assertAvailable(): void {
		if (this.failing) throw new Error("fake semantic index is failing");
	}
}
