import type { SemanticHit } from "../core/match";

export interface SemanticDocument {
	entryId: string;
	userId: string;
	category: string;
	/** Raw display name — never the normalized form. */
	text: string;
}

export interface SemanticQuery {
	userId: string;
	category: string;
	text: string;
	topK: number;
}

/** Any method may throw; callers treat a throw as "semantic layer unavailable". */
export interface SemanticIndex {
	query(query: SemanticQuery): Promise<SemanticHit[]>;
	upsert(documents: readonly SemanticDocument[]): Promise<void>;
	remove(entryIds: readonly string[]): Promise<void>;
}

export class UnavailableSemanticIndex implements SemanticIndex {
	async query(): Promise<SemanticHit[]> {
		throw new Error("semantic index is not configured");
	}

	async upsert(): Promise<void> {
		throw new Error("semantic index is not configured");
	}

	async remove(): Promise<void> {
		throw new Error("semantic index is not configured");
	}
}
