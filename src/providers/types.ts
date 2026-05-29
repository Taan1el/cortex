import type { AgentProfile, EffortLevel, ProviderKind } from "../settings";

export type { ProviderKind };

export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

export interface ChatOptions {
	signal: AbortSignal;
	effort: EffortLevel;
}

export interface ChatProvider {
	readonly id: string;
	readonly model: string;
	ready(): Promise<void>;
	stream(messages: ChatMessage[], opts: ChatOptions, onChunk: (delta: string) => void): Promise<string>;
}

export interface EmbeddingProvider {
	readonly id: string;
	readonly model: string;
	embed(texts: string[], signal: AbortSignal): Promise<number[][]>;
}

export interface ProviderContext {
	profile: AgentProfile;
	apiKey: string;
}

export function isChatKind(kind: ProviderKind | undefined): boolean {
	return kind === "ollama" || kind === "openai" || kind === "anthropic" || kind === "gemini";
}
