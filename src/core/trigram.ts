export function trigrams(normalized: string): Set<string> {
	const out = new Set<string>();
	if (normalized.length === 0) return out;
	const padded = ` ${normalized} `;
	for (let i = 0; i + 3 <= padded.length; i++) {
		out.add(padded.slice(i, i + 3));
	}
	return out;
}

/** Jaccard similarity of character trigrams. Inputs must already be normalized. */
export function trigramSimilarity(a: string, b: string): number {
	const left = trigrams(a);
	const right = trigrams(b);
	if (left.size === 0 && right.size === 0) return 1;
	let shared = 0;
	for (const gram of left) {
		if (right.has(gram)) shared++;
	}
	return shared / (left.size + right.size - shared);
}
