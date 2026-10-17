/**
 * Fixed rotation through every MSC2020 top-level class. The index is not the MSC code:
 * entry 17 is "26 Real functions". Order is the brief's, including the codes MSC skips.
 */
export const MSC_CLASSES: readonly { readonly code: string; readonly title: string }[] = [
	{ code: "00", title: "General and overarching topics; collections" },
	{ code: "01", title: "History and biography" },
	{ code: "03", title: "Mathematical logic and foundations" },
	{ code: "05", title: "Combinatorics" },
	{ code: "06", title: "Order, lattices, ordered algebraic structures" },
	{ code: "08", title: "General algebraic systems" },
	{ code: "11", title: "Number theory" },
	{ code: "12", title: "Field theory and polynomials" },
	{ code: "13", title: "Commutative algebra" },
	{ code: "14", title: "Algebraic geometry" },
	{ code: "15", title: "Linear and multilinear algebra; matrix theory" },
	{ code: "16", title: "Associative rings and algebras" },
	{ code: "17", title: "Nonassociative rings and algebras" },
	{ code: "18", title: "Category theory; homological algebra" },
	{ code: "19", title: "K-theory" },
	{ code: "20", title: "Group theory and generalizations" },
	{ code: "22", title: "Topological groups, Lie groups" },
	{ code: "26", title: "Real functions" },
	{ code: "28", title: "Measure and integration" },
	{ code: "30", title: "Functions of a complex variable" },
	{ code: "31", title: "Potential theory" },
	{ code: "32", title: "Several complex variables and analytic spaces" },
	{ code: "33", title: "Special functions" },
	{ code: "34", title: "Ordinary differential equations" },
	{ code: "35", title: "Partial differential equations" },
	{ code: "37", title: "Dynamical systems and ergodic theory" },
	{ code: "39", title: "Difference and functional equations" },
	{ code: "40", title: "Sequences, series, summability" },
	{ code: "41", title: "Approximations and expansions" },
	{ code: "42", title: "Harmonic analysis on Euclidean spaces" },
	{ code: "43", title: "Abstract harmonic analysis" },
	{ code: "44", title: "Integral transforms, operational calculus" },
	{ code: "45", title: "Integral equations" },
	{ code: "46", title: "Functional analysis" },
	{ code: "47", title: "Operator theory" },
	{ code: "49", title: "Calculus of variations and optimal control; optimization" },
	{ code: "51", title: "Geometry" },
	{ code: "52", title: "Convex and discrete geometry" },
	{ code: "53", title: "Differential geometry" },
	{ code: "54", title: "General topology" },
	{ code: "55", title: "Algebraic topology" },
	{ code: "57", title: "Manifolds and cell complexes" },
	{ code: "58", title: "Global analysis, analysis on manifolds" },
	{ code: "60", title: "Probability theory and stochastic processes" },
	{ code: "62", title: "Statistics" },
	{ code: "65", title: "Numerical analysis" },
	{ code: "68", title: "Computer science" },
	{ code: "70", title: "Mechanics of particles and systems" },
	{ code: "74", title: "Mechanics of deformable solids" },
	{ code: "76", title: "Fluid mechanics" },
	{ code: "78", title: "Optics, electromagnetic theory" },
	{ code: "80", title: "Classical thermodynamics, heat transfer" },
	{ code: "81", title: "Quantum theory" },
	{ code: "82", title: "Statistical mechanics, structure of matter" },
	{ code: "83", title: "Relativity and gravitational theory" },
	{ code: "85", title: "Astronomy and astrophysics" },
	{ code: "86", title: "Geophysics" },
	{ code: "90", title: "Operations research, mathematical programming" },
	{
		code: "91",
		title: "Game theory, economics, finance, and other social and behavioral sciences",
	},
	{ code: "92", title: "Biology and other natural sciences" },
	{ code: "93", title: "Systems theory; control" },
	{ code: "94", title: "Information and communication theory, circuits" },
	{ code: "97", title: "Mathematics education" },
];

export const MSC_ROTATION_LENGTH = 63;
export const MSC_EPOCH = "2000-01-01";
export const MSC_TIMEZONE = "America/New_York";

export interface MscClass {
	date: string;
	timezone: typeof MSC_TIMEZONE;
	/** Whole days from 2000-01-01 to `date`. 2000-01-01 itself is 0. */
	n: number;
	/** `n` modulo 63, in 0..62. */
	index: number;
	code: string;
	title: string;
	/** Section line, e.g. "MSC 26 · Real functions". */
	heading: string;
}

if (MSC_CLASSES.length !== MSC_ROTATION_LENGTH) {
	throw new Error(`MSC rotation must have ${MSC_ROTATION_LENGTH} classes`);
}

/** Calendar date in America/New_York as YYYY-MM-DD. DST is the zone's, not UTC's. */
export function newYorkDate(now: Date): string {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: MSC_TIMEZONE,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(now);
	const value = (type: Intl.DateTimeFormatPartTypes): string => {
		const found = parts.find((part) => part.type === type)?.value;
		if (found === undefined) throw new Error(`missing ${type} in New York date`);
		return found;
	};
	return `${value("year")}-${value("month")}-${value("day")}`;
}

/** Whole days from 2000-01-01 to an ISO calendar date. Negative before the epoch. */
export function daysSinceEpoch(isoDate: string): number {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
	if (match === null) throw new Error(`not an ISO date: ${isoDate}`);
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const utc = Date.UTC(year, month - 1, day);
	const epoch = Date.UTC(2000, 0, 1);
	return Math.round((utc - epoch) / 86_400_000);
}

/** Today's class. The brief must not compute this itself. */
export function mscClass(now: Date): MscClass {
	const date = newYorkDate(now);
	const n = daysSinceEpoch(date);
	const index = ((n % MSC_ROTATION_LENGTH) + MSC_ROTATION_LENGTH) % MSC_ROTATION_LENGTH;
	const entry = MSC_CLASSES[index];
	if (entry === undefined) throw new Error("rotation index out of range");
	return {
		date,
		timezone: MSC_TIMEZONE,
		n,
		index,
		code: entry.code,
		title: entry.title,
		heading: `MSC ${entry.code} · ${entry.title}`,
	};
}
