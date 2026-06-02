import type { ChatMessage, ChatOptions, ChatProvider, EmbeddingProvider, ProviderContext } from "./types";
import { openStream, readSse } from "./http";

interface GeminiChunk {
	candidates?: { content?: { parts?: { text?: string }[] } }[];
	error?: { message?: string };
}

export class GeminiProvider implements ChatProvider, EmbeddingProvider {
	readonly id = "gemini";
	readonly model: string;
	private readonly apiKey: string;
	private readonly baseUrl: string;

	constructor(ctx: ProviderContext) {
		this.apiKey = ctx.apiKey;
		this.model = ctx.profile.model?.trim() || "gemini-2.0-flash";
		this.baseUrl = (ctx.profile.baseUrl?.trim() || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
	}

	async ready(): Promise<void> {
		if (!this.apiKey) throw new Error("Set GEMINI_API_KEY or GOOGLE_API_KEY in your operating system environment.");
	}

	async stream(messages: ChatMessage[], opts: ChatOptions, onChunk: (delta: string) => void): Promise<string> {
		const systemText = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
		const contents = messages
			.filter((m) => m.role !== "system")
			.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
		const url = `${this.baseUrl}/models/${encodeURIComponent(this.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(this.apiKey)}`;
		const res = await openStream({
			url,
			headers: {},
			body: {
				contents,
				systemInstruction: systemText ? { parts: [{ text: systemText }] } : undefined,
			},
			signal: opts.signal,
		});
		let full = "";
		for await (const data of readSse(res)) {
			let chunk: GeminiChunk;
			try {
				chunk = JSON.parse(data) as GeminiChunk;
			} catch {
				continue;
			}
			if (chunk.error) throw new Error(chunk.error.message || "Gemini error");
			const delta = chunk.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
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
			const url = `${this.baseUrl}/models/text-embedding-004:embedContent?key=${encodeURIComponent(this.apiKey)}`;
			const res = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ content: { parts: [{ text }] } }),
				signal,
			});
			if (!res.ok) throw new Error(`Gemini embeddings HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
			const json = (await res.json()) as { embedding?: { values?: number[] } };
			if (!json.embedding?.values) throw new Error("Gemini returned no embedding.");
			out.push(json.embedding.values);
		}
		return out;
	}
}
