import { LedgerError } from "../core/errors";
import type { ErrorBody, ErrorCode } from "./schemas";

export const ERROR_STATUS: Record<ErrorCode, number> = {
	unauthorized: 401,
	invalid_input: 400,
	not_found: 404,
	rate_limited: 429,
	upstream_unavailable: 503,
};

export function toErrorBody(error: unknown): { status: number; body: ErrorBody } {
	if (error instanceof LedgerError) {
		return {
			status: ERROR_STATUS[error.code],
			body: { error: { code: error.code, message: error.message } },
		};
	}
	console.error("unhandled error", error);
	return {
		status: ERROR_STATUS.upstream_unavailable,
		body: { error: { code: "upstream_unavailable", message: "internal error; retry later" } },
	};
}

export function errorResponse(error: unknown): Response {
	const { status, body } = toErrorBody(error);
	return Response.json(body, { status });
}
