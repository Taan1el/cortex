import { requestUrl } from "obsidian";
import { spawn } from "node:child_process";
import process from "node:process";

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
		if (await this.ping()) return;
		// Not running — try to start `ollama serve` ourselves, then wait for it.
		const started = await this.tryAutoStart();
		if (started && (await this.waitForServer(8000))) return;
		try {
			await requestUrl({ url: `${this.baseUrl}/api/tags`, method: "GET" });
		} catch (err) {
			throw new Error(ollamaError(err));
		}
	}

	private async ping(): Promise<boolean> {
		try {
			await requestUrl({ url: `${this.baseUrl}/api/tags`, method: "GET" });
			return true;
		} catch {
			return false;
		}
	}

	/** Only auto-start a local Ollama. Remote hosts are the user's responsibility. */
	private async tryAutoStart(): Promise<boolean> {
		if (!isLocalUrl(this.baseUrl)) return false;
		try {
			const child = spawn("ollama", ["serve"], {
				detached: true,
				stdio: "ignore",
				env: { ...process.env },
			});
			child.unref();
			return true;
		} catch {
			return false;
		}
	}

	private async waitForServer(timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			await delay(400);
			if (await this.ping()) return true;
		}
		return false;
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

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLocalUrl(url: string): boolean {
	try {
		const host = new URL(url).hostname;
		return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "0.0.0.0";
	} catch {
		return false;
	}
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
