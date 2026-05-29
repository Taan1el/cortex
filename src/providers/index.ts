import type { AgentProfile, CortexSettings } from "../settings";
import type { ChatProvider, EmbeddingProvider, ProviderContext } from "./types";
import { OllamaProvider } from "./ollama";
import { OpenAiProvider } from "./openai";
import { AnthropicProvider } from "./anthropic";
import { GeminiProvider } from "./gemini";

function context(profile: AgentProfile, settings: CortexSettings): ProviderContext {
	const kind = profile.provider ?? "acp";
	return { profile, apiKey: settings.apiKeys[kind]?.trim() ?? "" };
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
