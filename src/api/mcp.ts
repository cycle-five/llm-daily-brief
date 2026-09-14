import { McpServer } from "@modelcontextprotocol/server";
import type { ApiContext } from "./context";
import { toErrorBody } from "./errors";
import { enforceRateLimit } from "./ratelimit";
import {
	CheckInput,
	ClaimInput,
	ForgetInput,
	type ForgetResult,
	ListToolInput,
	StatsToolInput,
} from "./schemas";

export const MCP_SERVER_VERSION = "0.1.0";

export const MCP_TOOL_NAMES = [
	"claim_topic",
	"check_topic",
	"list_topics",
	"forget_topic",
	"topic_stats",
] as const;

interface ToolResult {
	[key: string]: unknown;
	content: Array<{ type: "text"; text: string }>;
	structuredContent: Record<string, unknown>;
	isError?: boolean;
}

async function run(action: () => Promise<Record<string, unknown>>): Promise<ToolResult> {
	try {
		const result = await action();
		return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
	} catch (error) {
		const { body } = toErrorBody(error);
		return {
			isError: true,
			content: [{ type: "text", text: `${body.error.code}: ${body.error.message}` }],
			structuredContent: body,
		};
	}
}

export function buildMcpServer(api: ApiContext): McpServer {
	const server = new McpServer({ name: "topic-ledger", version: MCP_SERVER_VERSION });

	server.registerTool(
		"claim_topic",
		{
			title: "Claim a topic",
			description:
				"Record a topic for this category unless it repeats one already used. " +
				'Returns status "claimed" or "repeat". On "repeat", pick a different topic and call again. ' +
				"If a claimed result lists possible_matches you judge to be the same topic, call forget_topic " +
				"on the new entry and pick again. force=true overrides fuzzy (not exact) matches.",
			inputSchema: ClaimInput,
			annotations: { readOnlyHint: false, idempotentHint: false },
		},
		async (args) =>
			run(async () => {
				await enforceRateLimit(api.limiter, api.userId);
				return api.ledger.claim(api.userId, args);
			}),
	);

	server.registerTool(
		"check_topic",
		{
			title: "Check a topic",
			description: "Report whether a topic would be a repeat, without recording anything.",
			inputSchema: CheckInput,
			annotations: { readOnlyHint: true },
		},
		async (args) =>
			run(async () => {
				await enforceRateLimit(api.limiter, api.userId);
				return api.ledger.check(api.userId, args);
			}),
	);

	server.registerTool(
		"list_topics",
		{
			title: "List topics",
			description:
				"List recently claimed topics, newest first. Useful for avoiding repeats up front.",
			inputSchema: ListToolInput,
			annotations: { readOnlyHint: true },
		},
		async (args) => run(() => api.ledger.list(api.userId, args)),
	);

	server.registerTool(
		"forget_topic",
		{
			title: "Forget a topic",
			description: "Delete a claimed topic and its repeat history.",
			inputSchema: ForgetInput,
			annotations: { readOnlyHint: false, destructiveHint: true },
		},
		async (args) =>
			run(async () => {
				await api.ledger.forget(api.userId, args.entry_id);
				const result: ForgetResult = { forgotten: args.entry_id };
				return result;
			}),
	);

	server.registerTool(
		"topic_stats",
		{
			title: "Repeat statistics",
			description:
				'Most-repeated topics. scope "me" shows your entries with the phrasings that were blocked; ' +
				'scope "global" shows anonymous counts across all users.',
			inputSchema: StatsToolInput,
			annotations: { readOnlyHint: true },
		},
		async (args) => run(() => api.ledger.stats(api.userId, args, api.globalMinUsers)),
	);

	return server;
}
