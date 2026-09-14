const COMBINING_MARKS = /\p{M}/gu;
const POSSESSIVE = /['\u2019]s\b/g;
const NON_ALPHANUMERIC_RUN = /[^\p{L}\p{N}]+/gu;
const LEADING_ARTICLE = /^(?:the|a|an) /;

/**
 * Canonical form used for exact and trigram matching. Never used as embedding input.
 * Steps (spec "Normalization"): NFKD + strip marks, lowercase, & → and, drop possessive
 * 's, collapse non-alphanumerics to single spaces, trim, drop one leading article.
 */
export function normalize(text: string): string {
	return text
		.normalize("NFKD")
		.replace(COMBINING_MARKS, "")
		.toLowerCase()
		.replace(/&/g, " and ")
		.replace(POSSESSIVE, "")
		.replace(NON_ALPHANUMERIC_RUN, " ")
		.trim()
		.replace(LEADING_ARTICLE, "");
}

export function normalizeCategory(text: string): string {
	return text.trim().toLowerCase();
}
