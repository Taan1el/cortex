import type { ChatMessage, ChatOptions, ChatProvider, ProviderContext } from "./types";
import { openStream, readSse } from "./http";

interface AnthropicEvent {
	type?: string;
	delta?: { text?: string };
	error?: { message?: string };
}

export class AnthropicProvider implements ChatProvider {
	readonly id = "anthropic";
	readonly model: string;
	private readonly apiKey: string;
	private readonly baseUrl: string;

	constructor(ctx: ProviderContext) {
		this.apiKey = ctx.apiKey;
		this.model = ctx.profile.model?.trim() || "claude-3-5-haiku-latest";
		this.baseUrl = (ctx.profile.baseUrl?.trim() || "https://api.anthropic.com/v1").replace(/\/+$/, "");
	}

	async ready(): Promise<void> {
		if (!this.apiKey) throw new Error("Add your Anthropic API key in Cortex settings.");
	}

	async stream(messages: ChatMessage[], opts: ChatOptions, onChunk: (delta: string) => void): Promise<string> {
		const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
		const turns = messages
			.filter((m) => m.role !== "system")
			.map((m) => ({ role: m.role, content: m.content }));
		const res = await openStream({
			url: `${this.baseUrl}/messages`,
			headers: {
				"x-api-key": this.apiKey,
				"anthropic-version": "2023-06-01",
				"anthropic-dangerous-direct-browser-access": "true",
			},
			body: { model: this.model, max_tokens: 4096, system: system || undefined, messages: turns, stream: true },
			signal: opts.signal,
		});
		let full = "";
		for await (const data of readSse(res)) {
			let event: AnthropicEvent;
			try {
				event = JSON.parse(data) as AnthropicEvent;
			} catch {
				continue;
			}
			if (event.error) throw new Error(event.error.message || "Anthropic error");
			if (event.type === "content_block_delta" && event.delta?.text) {
				full += event.delta.text;
				onChunk(event.delta.text);
			}
		}
		return full;
	}
}
