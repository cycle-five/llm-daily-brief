import { LedgerError } from "../core/errors";

export async function enforceRateLimit(limiter: RateLimit, userId: string): Promise<void> {
	const { success } = await limiter.limit({ key: userId });
	if (!success) {
		throw new LedgerError("rate_limited", "too many claim/check requests; slow down");
	}
}
