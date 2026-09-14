export interface CalibrationPair {
	a: string;
	b: string;
	/** true when a brief should treat b as a repeat of a. */
	same: boolean;
}

export const PAIRS: CalibrationPair[] = [
	{ a: "Euler's identity", b: "e^(iπ) + 1 = 0", same: true },
	{ a: "Fermat's Last Theorem", b: "Wiles' proof of Fermat's Last Theorem", same: true },
	{ a: "Pythagorean theorem", b: "a² + b² = c²", same: true },
	{ a: "Gödel's incompleteness theorems", b: "Incompleteness theorem", same: true },
	{ a: "Banach–Tarski paradox", b: "Banach-Tarski theorem", same: true },
	{ a: "Riemann hypothesis", b: "Zeros of the Riemann zeta function", same: true },
	{ a: "Monty Hall problem", b: "Monty Hall paradox", same: true },
	{
		a: "Infinitude of primes",
		b: "Euclid's proof that there are infinitely many primes",
		same: true,
	},
	{ a: "Leonhard Euler", b: "Euler", same: true },
	{ a: "Ada Lovelace", b: "Augusta Ada King, Countess of Lovelace", same: true },
	{ a: "Isaac Newton", b: "Sir Isaac Newton", same: true },
	{ a: "Hypatia", b: "Hypatia of Alexandria", same: true },
	{ a: "Euler's identity", b: "Euler's totient function", same: false },
	{ a: "Fermat's Last Theorem", b: "Fermat's little theorem", same: false },
	{ a: "Riemann hypothesis", b: "Riemann integral", same: false },
	{ a: "Gaussian elimination", b: "Gaussian curvature", same: false },
	{ a: "Cantor's diagonal argument", b: "Cantor set", same: false },
	{ a: "Pythagorean theorem", b: "Pythagorean tuning", same: false },
	{ a: "Four color theorem", b: "Five color theorem", same: false },
	{ a: "Mandelbrot set", b: "Julia set", same: false },
	{ a: "Hilbert's hotel", b: "Hilbert space", same: false },
	{ a: "Isaac Newton", b: "Gottfried Wilhelm Leibniz", same: false },
	{ a: "Marie Curie", b: "Pierre Curie", same: false },
	{ a: "Carl Friedrich Gauss", b: "Carl Gustav Jacob Jacobi", same: false },
];
