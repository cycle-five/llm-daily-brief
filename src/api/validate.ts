import { z } from "zod";
import { LedgerError } from "../core/errors";

export function parseInput<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
	const result = schema.safeParse(value);
	if (!result.success) {
		throw new LedgerError("invalid_input", z.prettifyError(result.error));
	}
	return result.data;
}
