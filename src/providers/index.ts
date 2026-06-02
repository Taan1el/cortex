import type { AgentProfile, CortexSettings } from "../settings";
import type { ChatProvider, EmbeddingProvider, ProviderContext } from "./types";
import { OllamaProvider } from "./ollama";
import { OpenAiProvider } from "./openai";
import { AnthropicProvider } from "./anthropic";
import { GeminiProvider } from "./gemini";
import process from "node:process";

const PROVIDER_ENV_KEYS: Record<string, string[]> = {
	openai: ["OPENAI_API_KEY"],
	anthropic: ["ANTHROPIC_API_KEY"],
	gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
};

function context(profile: AgentProfile, settings: CortexSettings): ProviderContext {
	const kind = profile.provider ?? "acp";
	return { profile, apiKey: envApiKey(kind) || settings.apiKeys[kind]?.trim() || "" };
}

function envApiKey(kind: string): string {
	for (const key of PROVIDER_ENV_KEYS[kind] ?? []) {
		const value = process.env[key]?.trim();
		if (value) return value;
	}
	return "";
}

export function createChatProvider(profile: AgentProfile, settings: CortexSettings): ChatProvider {
	const ctx = context(profile, settings);
	switch (profile.provider) {
		case "openai":
			return new OpenAiProvider(ctx);
		case "anthropic":
			return new AnthropicProvider(ctx);
		case "gemini":
			return new GeminiProvider(ctx);
		case "ollama":
		default:
			return new OllamaProvider(ctx);
	}
}

export function createEmbeddingProvider(profile: AgentProfile, settings: CortexSettings): EmbeddingProvider | null {
	const ctx = context(profile, settings);
	switch (profile.provider) {
		case "openai":
			return new OpenAiProvider(ctx);
		case "gemini":
			return new GeminiProvider(ctx);
		case "ollama":
			return new OllamaProvider(ctx);
		default:
			return null;
	}
}
