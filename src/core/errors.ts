import type { ErrorCode } from "../api/schemas";

export class LedgerError extends Error {
	readonly code: ErrorCode;

	constructor(code: ErrorCode, message: string) {
		super(message);
		this.name = "LedgerError";
		this.code = code;
	}
}
