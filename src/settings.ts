import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type CortexPlugin from "./main";

export type ProviderKind = "acp" | "ollama" | "openai" | "anthropic" | "gemini";

export interface AgentProfile {
	id: string;
	name: string;
	provider?: ProviderKind;
	command: string;
	args: string[];
	env: Record<string, string>;
	ollamaBaseUrl?: string;
	ollamaModel?: string;
	model?: string;
	baseUrl?: string;
}

export interface SavedPrompt {
	id: string;
	name: string;
	prompt: string;
}

export type EffortLevel = "minimal" | "low" | "medium" | "high";

export interface CortexSettings {
	profiles: AgentProfile[];
	activeProfileId: string;
	apiKeys: Record<string, string>;
	autoApproveReads: boolean;
	autoApproveWrites: boolean;
	autoInjectActiveNote: boolean;
	effort: EffortLevel;
	savedPrompts: SavedPrompt[];
	importFolder: string;
	debugLogging: boolean;
	ragUseInChat: boolean;
	ragTopK: number;
	ragExcludeFolder: string;
}

export const CLOUD_DEFAULT_MODELS: Record<string, string> = {
	openai: "gpt-4o-mini",
	anthropic: "claude-3-5-haiku-latest",
	gemini: "gemini-2.0-flash",
};

export const PROFILE_TEMPLATES: Record<string, Omit<AgentProfile, "id" | "env">> = {
	"ollama-local": {
		name: "Ollama Local",
		provider: "ollama",
		command: "",
		args: [],
		ollamaBaseUrl: "http://127.0.0.1:11434",
		ollamaModel: "llama3.2:latest",
	},
	openai: { name: "OpenAI", provider: "openai", command: "", args: [], model: "gpt-4o-mini" },
	anthropic: { name: "Anthropic Claude", provider: "anthropic", command: "", args: [], model: "claude-3-5-haiku-latest" },
	"gemini-api": { name: "Google Gemini", provider: "gemini", command: "", args: [], model: "gemini-2.0-flash" },
	"claude-code": { name: "Claude Code", provider: "acp", command: "npx", args: ["-y", "@zed-industries/claude-code-acp"] },
	codex: { name: "OpenAI Codex", provider: "acp", command: "npx", args: ["-y", "@zed-industries/codex-acp"] },
	gemini: { name: "Gemini CLI", provider: "acp", command: "npx", args: ["-y", "@google/gemini-cli", "--experimental-acp"] },
	custom: { name: "Custom ACP agent", provider: "acp", command: "", args: [] },
};

export const DEFAULT_SETTINGS: CortexSettings = {
	profiles: [
		{ id: "claude-code", name: "Claude Code", command: "npx", args: ["-y", "@zed-industries/claude-code-acp"], env: {} },
		{
			id: "ollama-local",
			name: "Ollama Local",
			provider: "ollama",
			command: "",
			args: [],
			env: {},
			ollamaBaseUrl: "http://127.0.0.1:11434",
			ollamaModel: "llama3.2:latest",
		},
	],
	activeProfileId: "ollama-local",
	apiKeys: {},
	autoApproveReads: true,
	autoApproveWrites: false,
	autoInjectActiveNote: false,
	effort: "medium",
	savedPrompts: [
		{ id: "explain", name: "Explain simply", prompt: "Explain the note I'm currently viewing in simple terms." },
		{ id: "improve", name: "Improve writing", prompt: "Improve the active note's clarity and flow, keeping my voice. Ask before replacing the file." },
	],
	importFolder: "ChatGPT",
	debugLogging: false,
	ragUseInChat: false,
	ragTopK: 5,
	ragExcludeFolder: "",
};

export class CortexSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: CortexPlugin) {
		super(app, plugin);
	}

	private save = () => this.plugin.saveSettings();

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName("Agent").setHeading();

		new Setting(containerEl)
			.setName("Active agent")
			.setDesc("Which agent new chats start with.")
			.addDropdown((dd) => {
				for (const p of this.plugin.settings.profiles) dd.addOption(p.id, p.name);
				dd.setValue(this.plugin.settings.activeProfileId);
				dd.onChange(async (v) => {
					this.plugin.settings.activeProfileId = v;
					await this.save();
					this.display();
				});
			});

		let pick = "claude-code";
		new Setting(containerEl)
			.setName("Add an agent")
			.addDropdown((dd) => {
				for (const [id, t] of Object.entries(PROFILE_TEMPLATES)) dd.addOption(id, t.name);
				dd.onChange((v) => (pick = v));
			})
			.addButton((b) =>
				b.setButtonText("Add").setCta().onClick(async () => {
					const t = PROFILE_TEMPLATES[pick];
					if (!t) return;
					this.plugin.settings.profiles.push({ ...t, id: crypto.randomUUID(), args: [...t.args], env: {} });
					await this.save();
					this.display();
				}),
			);

		for (const profile of this.plugin.settings.profiles) this.renderProfile(containerEl, profile);

		this.renderVaultSearch(containerEl);

		new Setting(containerEl).setName("Notes & permissions").setHeading();

		new Setting(containerEl)
			.setName("Send the note I'm viewing")
			.setDesc("For Ollama Local this is always local. For external ACP agents, turn this on only for notes you are comfortable sending to that agent.")
			.addToggle((t) => t.setValue(this.plugin.settings.autoInjectActiveNote).onChange(async (v) => { this.plugin.settings.autoInjectActiveNote = v; await this.save(); }));

		new Setting(containerEl)
			.setName("Reasoning effort")
			.setDesc("How hard the assistant thinks by default. You can also change this from the chat panel.")
			.addDropdown((dd) => {
				dd.addOption("minimal", "Minimal").addOption("low", "Low").addOption("medium", "Medium").addOption("high", "High");
				dd.setValue(this.plugin.settings.effort);
				dd.onChange(async (v) => { this.plugin.settings.effort = v as EffortLevel; await this.save(); });
			});

		new Setting(containerEl)
			.setName("Let it read without asking")
			.setDesc("Skip the prompt when the assistant reads notes inside your vault.")
			.addToggle((t) => t.setValue(this.plugin.settings.autoApproveReads).onChange(async (v) => { this.plugin.settings.autoApproveReads = v; await this.save(); }));

		new Setting(containerEl)
			.setName("Let it save without asking")
			.setDesc("Off by default. When off, every change to a file asks you first.")
			.addToggle((t) => t.setValue(this.plugin.settings.autoApproveWrites).onChange(async (v) => { this.plugin.settings.autoApproveWrites = v; await this.save(); }));

		new Setting(containerEl).setName("Saved prompts").setHeading();
		new Setting(containerEl)
			.setDesc("Buttons in the panel. Clicking one sends it immediately.")
			.addButton((b) => b.setButtonText("Add prompt").setCta().onClick(async () => {
				this.plugin.settings.savedPrompts.push({ id: crypto.randomUUID(), name: "New prompt", prompt: "" });
				await this.save();
				this.display();
			}));

		for (const sp of this.plugin.settings.savedPrompts) {
			new Setting(containerEl)
				.addText((t) => t.setPlaceholder("Button label").setValue(sp.name).onChange(async (v) => { sp.name = v; await this.save(); }))
				.addTextArea((t) => { t.setPlaceholder("Prompt text").setValue(sp.prompt).onChange(async (v) => { sp.prompt = v; await this.save(); }); t.inputEl.rows = 2; })
				.addExtraButton((b) => b.setIcon("trash").setTooltip("Remove").onClick(async () => {
					this.plugin.settings.savedPrompts = this.plugin.settings.savedPrompts.filter((p) => p.id !== sp.id);
					await this.save();
					this.display();
				}));
		}

		new Setting(containerEl).setName("ChatGPT import").setHeading();
		new Setting(containerEl)
			.setName("Import folder")
			.setDesc("Where imported ChatGPT conversations are saved in your vault.")
			.addText((t) => t.setValue(this.plugin.settings.importFolder).onChange(async (v) => { this.plugin.settings.importFolder = v.trim() || "ChatGPT"; await this.save(); }));

		new Setting(containerEl).setName("Advanced").setHeading();
		new Setting(containerEl)
			.setName("Debug logging")
			.setDesc("Print agent traffic to the developer console. Only for troubleshooting.")
			.addToggle((t) => t.setValue(this.plugin.settings.debugLogging).onChange(async (v) => { this.plugin.settings.debugLogging = v; await this.save(); }));
	}

	private renderVaultSearch(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Vault search (RAG)").setHeading();

		const index = this.plugin.index;
		const status = index.status;
		const statusText = status.building
			? `Building... ${status.progress.done}/${status.progress.total}`
			: status.ready
				? `Indexed ${status.chunkCount} chunks from ${status.fileCount} notes (model: ${status.model})`
				: "Not built yet";

		new Setting(containerEl)
			.setName("Index status")
			.setDesc(statusText)
			.addButton((b) =>
				b.setButtonText(status.ready ? "Rebuild" : "Build index").setCta().setDisabled(status.building).onClick(async () => {
					const controller = new AbortController();
					new Notice("Cortex: building vault index...");
					try {
						await index.rebuild(controller.signal);
						new Notice("Cortex: vault index ready.");
					} catch (err) {
						new Notice(`Cortex index failed: ${(err as Error).message}`);
					}
					this.display();
				}),
			)
			.addButton((b) =>
				b.setButtonText("Update").setDisabled(status.building || !status.ready).onClick(async () => {
					const controller = new AbortController();
					new Notice("Cortex: updating vault index...");
					try {
						await index.refresh(controller.signal);
						new Notice("Cortex: vault index updated.");
					} catch (err) {
						new Notice(`Cortex update failed: ${(err as Error).message}`);
					}
					this.display();
				}),
			)
			.addExtraButton((b) =>
				b.setIcon("trash").setTooltip("Clear index").setDisabled(status.building || !status.ready).onClick(async () => {
					await index.clear();
					this.display();
				}),
			);

		new Setting(containerEl)
			.setName("Use vault search in chat")
			.setDesc("Before answering, find the most relevant notes across your whole vault and feed them to the assistant. Needs an embedding-capable agent (Ollama, OpenAI, or Gemini).")
			.addToggle((t) => t.setValue(this.plugin.settings.ragUseInChat).onChange(async (v) => { this.plugin.settings.ragUseInChat = v; await this.save(); }));

		new Setting(containerEl)
			.setName("Notes to retrieve")
			.setDesc("How many note chunks to pull in per question.")
			.addSlider((s) => s.setLimits(1, 12, 1).setValue(this.plugin.settings.ragTopK).setDynamicTooltip().onChange(async (v) => { this.plugin.settings.ragTopK = v; await this.save(); }));

		new Setting(containerEl)
			.setName("Exclude folder")
			.setDesc("Skip this folder when indexing (e.g. a private or archive folder). Leave blank to index everything.")
			.addText((t) => t.setValue(this.plugin.settings.ragExcludeFolder).onChange(async (v) => { this.plugin.settings.ragExcludeFolder = v.trim(); await this.save(); }));
	}

	private renderProfile(containerEl: HTMLElement, profile: AgentProfile): void {
		const wrap = containerEl.createDiv({ cls: "cortex-profile" });
		new Setting(wrap).setName(profile.name).setHeading();

		new Setting(wrap).setName("Name").addText((t) => t.setValue(profile.name).onChange(async (v) => { profile.name = v.trim() || profile.name; await this.save(); }));
		if ((profile.provider ?? "acp") === "ollama") {
			new Setting(wrap)
				.setName("Ollama address")
				.setDesc("Default local Ollama server. Keep this unless you run Ollama somewhere else.")
				.addText((t) => t.setValue(profile.ollamaBaseUrl ?? "http://127.0.0.1:11434").onChange(async (v) => {
					profile.ollamaBaseUrl = v.trim() || "http://127.0.0.1:11434";
					await this.save();
				}));
			new Setting(wrap)
				.setName("Model")
				.setDesc("Must appear in `ollama list`. Default: llama3.2:latest.")
				.addText((t) => t.setValue(profile.ollamaModel ?? "llama3.2:latest").onChange(async (v) => {
					profile.ollamaModel = v.trim() || "llama3.2:latest";
					await this.save();
				}));
		} else {
			new Setting(wrap).setName("Command").addText((t) => t.setValue(profile.command).onChange(async (v) => { profile.command = v; await this.save(); }));
			new Setting(wrap).setName("Arguments").setDesc("Space-separated.").addText((t) => t.setValue(profile.args.join(" ")).onChange(async (v) => { profile.args = v.split(/\s+/).filter(Boolean); await this.save(); }));
			new Setting(wrap)
				.setName("Environment")
				.setDesc("Use your operating system environment for API keys. Cortex does not store secrets in plugin settings.");
		}

		const onlyOne = this.plugin.settings.profiles.length === 1;
		const isActive = profile.id === this.plugin.settings.activeProfileId;
		new Setting(wrap).addButton((b) => b.setButtonText("Delete").setWarning().setDisabled(onlyOne || isActive).onClick(async () => {
			this.plugin.settings.profiles = this.plugin.settings.profiles.filter((p) => p.id !== profile.id);
			await this.save();
			this.display();
		}));
	}
}
