import type { ChatMessage, ChatOptions, ChatProvider, EmbeddingProvider, ProviderContext } from "./types";
import { openStream, readSse } from "./http";

interface OpenAiDelta {
	choices?: { delta?: { content?: string } }[];
}

export class OpenAiProvider implements ChatProvider, EmbeddingProvider {
	readonly id = "openai";
	readonly model: string;
	private readonly apiKey: string;
	private readonly baseUrl: string;

	constructor(ctx: ProviderContext) {
		this.apiKey = ctx.apiKey;
		this.model = ctx.profile.model?.trim() || "gpt-4o-mini";
		this.baseUrl = (ctx.profile.baseUrl?.trim() || "https://api.openai.com/v1").replace(/\/+$/, "");
	}

	async ready(): Promise<void> {
		if (!this.apiKey) throw new Error("Add your OpenAI API key in Cortex settings.");
	}

	async stream(messages: ChatMessage[], opts: ChatOptions, onChunk: (delta: string) => void): Promise<string> {
		const res = await openStream({
			url: `${this.baseUrl}/chat/completions`,
			headers: { Authorization: `Bearer ${this.apiKey}` },
			body: { model: this.model, messages, stream: true },
			signal: opts.signal,
		});
		let full = "";
		for await (const data of readSse(res)) {
			if (data === "[DONE]") break;
			let chunk: OpenAiDelta;
			try {
				chunk = JSON.parse(data) as OpenAiDelta;
			} catch {
				continue;
			}
			const delta = chunk.choices?.[0]?.delta?.content;
			if (delta) {
				full += delta;
				onChunk(delta);
			}
		}
		return full;
	}

	async embed(texts: string[], signal: AbortSignal): Promise<number[][]> {
		const res = await fetch(`${this.baseUrl}/embeddings`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
			body: JSON.stringify({ model: "text-embedding-3-small", input: texts }),
			signal,
		});
		if (!res.ok) throw new Error(`OpenAI embeddings HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
		const json = (await res.json()) as { data?: { embedding: number[] }[] };
		return (json.data ?? []).map((d) => d.embedding);
	}
}
