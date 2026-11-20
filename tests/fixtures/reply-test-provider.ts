/**
 * The outside service the pi-herdr-ding tests talk to: a pi provider that answers every
 * request with one line, so a turn can run to its end with no network. The reply is
 * immediate; the tests only need pi's settled turn.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";

const api = "reply-test";

const replyModel = {
	id: "reply",
	name: "reply",
	reasoning: false,
	input: ["text"] as ("text" | "image")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 4096,
};

const assistantReply = (requested: Model<Api>): AssistantMessage => ({
	role: "assistant",
	content: [{ type: "text", text: "answered" }],
	api: requested.api,
	provider: requested.provider,
	model: requested.id,
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: Date.now(),
});

export default function replyTestProvider(pi: ExtensionAPI): void {
	const streamSimple = (requested: Model<Api>, _context: unknown, _options?: SimpleStreamOptions) => {
		const reply = assistantReply(requested);
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push({ type: "start", partial: reply });
			stream.push({ type: "text_start", contentIndex: 0, partial: reply });
			stream.push({ type: "text_delta", contentIndex: 0, delta: "answered", partial: reply });
			stream.push({ type: "text_end", contentIndex: 0, content: "answered", partial: reply });
			stream.push({ type: "done", reason: "stop", message: reply });
		});
		return stream;
	};

	pi.registerProvider("reply-test", {
		name: "Reply test provider",
		api,
		apiKey: "test-key",
		baseUrl: "http://localhost:0",
		models: [replyModel],
		streamSimple,
	});
}
