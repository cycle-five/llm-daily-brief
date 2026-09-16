import { McpServer } from "@modelcontextprotocol/server";
import type { ApiContext } from "./context";
import { toErrorBody } from "./errors";
import { enforceRateLimit } from "./ratelimit";
import {
	CheckInput,
	ClaimInput,
	KeepInput,
	ListToolInput,
	SkipInput,
	StatsToolInput,
} from "./schemas";

export const MCP_SERVER_VERSION = "0.1.0";

export const MCP_TOOL_NAMES = [
	"claim_topic",
	"check_topic",
	"list_topics",
	"skip_topic",
	"keep_topic",
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
				'Returns status "claimed", "possible_repeat" or "repeat". On "repeat", pick a different topic and call again. ' +
				'On "possible_repeat" the topic is recorded but resembles earlier topics: follow next_step and call ' +
				"skip_topic (same topic) or keep_topic (different topic). force=true overrides fuzzy (not exact) matches.",
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
		"skip_topic",
		{
			title: "Skip a repeated topic",
			description:
				'Use after claim_topic returned "possible_repeat" and you judge the topic to be the same as one of its ' +
				"possible_matches. Records a repeat of that match (repeat_of = its entry_id) and turns your new entry " +
				"into an alias of it, so the same phrasing is refused next time. Then choose a different topic.",
			inputSchema: SkipInput,
			// Not destructive: it only converts the caller's own new claim into an alias and records a hit.
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
		},
		async (args) => run(() => api.ledger.skip(api.userId, args)),
	);

	server.registerTool(
		"keep_topic",
		{
			title: "Keep a topic",
			description:
				'Use after claim_topic returned "possible_repeat" and you judge the topic to be different from every ' +
				"possible match. Records that verdict; the topic stays claimed.",
			inputSchema: KeepInput,
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
		},
		async (args) => run(() => api.ledger.keep(api.userId, args)),
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
