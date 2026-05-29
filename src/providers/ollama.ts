import { requestUrl } from "obsidian";

import type { ChatMessage, ChatOptions, ChatProvider, EmbeddingProvider, ProviderContext } from "./types";
import { openStream, readLines } from "./http";

interface OllamaChatChunk {
	message?: { content?: string };
	error?: string;
	done?: boolean;
}

export class OllamaProvider implements ChatProvider, EmbeddingProvider {
	readonly id = "ollama";
	readonly model: string;
	private readonly baseUrl: string;

	constructor(ctx: ProviderContext) {
		this.baseUrl = cleanBaseUrl(ctx.profile.ollamaBaseUrl);
		this.model = ctx.profile.ollamaModel?.trim() || "llama3.2:latest";
	}

	async ready(): Promise<void> {
		try {
			await requestUrl({ url: `${this.baseUrl}/api/tags`, method: "GET" });
		} catch (err) {
			throw new Error(ollamaError(err));
		}
	}

	async stream(messages: ChatMessage[], opts: ChatOptions, onChunk: (delta: string) => void): Promise<string> {
		const res = await openStream({
			url: `${this.baseUrl}/api/chat`,
			headers: {},
			body: { model: this.model, messages, stream: true },
			signal: opts.signal,
		});
		let full = "";
		for await (const line of readLines(res)) {
			let chunk: OllamaChatChunk;
			try {
				chunk = JSON.parse(line) as OllamaChatChunk;
			} catch {
				continue;
			}
			if (chunk.error) throw new Error(chunk.error);
			const delta = chunk.message?.content;
			if (delta) {
				full += delta;
				onChunk(delta);
			}
		}
		return full;
	}

	async embed(texts: string[], signal: AbortSignal): Promise<number[][]> {
		const out: number[][] = [];
		for (const text of texts) {
			if (signal.aborted) throw new DOMException("Aborted", "AbortError");
			const res = await requestUrl({
				url: `${this.baseUrl}/api/embeddings`,
				method: "POST",
				contentType: "application/json",
				body: JSON.stringify({ model: this.model, prompt: text }),
			});
			const json = res.json as { embedding?: number[]; error?: string };
			if (json.error) throw new Error(json.error);
			if (!json.embedding) throw new Error("Ollama returned no embedding.");
			out.push(json.embedding);
		}
		return out;
	}
}

export function cleanBaseUrl(value: string | undefined): string {
	return (value?.trim() || "http://127.0.0.1:11434").replace(/\/+$/, "");
}

export function ollamaError(err: unknown): string {
	const message = (err as Error).message || String(err);
	return [
		"Cortex could not reach Ollama.",
		"",
		"Check that Ollama is running locally:",
		"`ollama serve`",
		"",
		"Check that the selected model is installed:",
		"`ollama list`",
		"`ollama pull llama3.2`",
		"",
		`Error: ${message}`,
	].join("\n");
}
