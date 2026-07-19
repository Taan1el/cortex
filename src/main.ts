import { Notice, Plugin, WorkspaceLeaf } from "obsidian";

import { CortexSettingTab, DEFAULT_SETTINGS, type AgentProfile, type CortexSettings } from "./settings";
import { CortexEngine } from "./agent/controller";
import { CortexView, CORTEX_VIEW } from "./view/panel";
import { ChatGptImportModal } from "./import/import-modal";
import { VaultIndex, type RagIndexData } from "./vault/rag";
import { cortexAutocomplete } from "./editor/autocomplete";

const INDEX_FILE = "cortex-index.json";

export default class CortexPlugin extends Plugin {
	settings!: CortexSettings;
	engine!: CortexEngine;
	index!: VaultIndex;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.index = new VaultIndex(this.app, () => this.settings, (data) => this.saveIndex(data));
		this.index.load(await this.loadIndex());
		this.engine = new CortexEngine(this.app, () => this.settings, this.index);

		this.registerView(CORTEX_VIEW, (leaf) => new CortexView(leaf, this));

		this.addRibbonIcon("brain", "Open Cortex Local", () => void this.openPanel());
		this.addCommand({ id: "open", name: "Open Cortex Local", callback: () => void this.openPanel() });
		this.addCommand({ id: "start", name: "Start the assistant", callback: () => void this.engine.start(this.activeProfile()) });
		this.addCommand({ id: "stop", name: "Stop the assistant", callback: () => void this.engine.stop() });
		this.addCommand({ id: "cancel", name: "Stop the current reply", callback: () => void this.engine.cancel() });
		this.addCommand({
			id: "import-chatgpt",
			name: "Import ChatGPT export",
			callback: () => new ChatGptImportModal(this.app, this.settings.importFolder).open(),
		});

		this.registerEditorExtension(
			cortexAutocomplete(
				() => this.settings,
				(prefix, suffix, signal) => this.engine.complete(prefix, suffix, signal),
			),
		);

		this.addCommand({
			id: "toggle-autocomplete",
			name: "Toggle inline autocomplete",
			callback: () => void this.toggleAutocomplete(),
		});

		this.addSettingTab(new CortexSettingTab(this.app, this));
	}

	async toggleAutocomplete(): Promise<void> {
		this.settings.autocompleteEnabled = !this.settings.autocompleteEnabled;
		await this.saveSettings();
		new Notice(`Cortex autocomplete ${this.settings.autocompleteEnabled ? "on" : "off"}.`);
	}

	onunload(): void {
		void this.engine?.stop();
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as Partial<CortexSettings>);
		let settingsChanged = false;
		if (!this.settings.apiKeys) this.settings.apiKeys = {};
		if (typeof this.settings.ragTopK !== "number") this.settings.ragTopK = DEFAULT_SETTINGS.ragTopK;
		if (typeof this.settings.ragUseInChat !== "boolean") this.settings.ragUseInChat = DEFAULT_SETTINGS.ragUseInChat;
		if (typeof this.settings.ragExcludeFolder !== "string") this.settings.ragExcludeFolder = DEFAULT_SETTINGS.ragExcludeFolder;
		if (typeof this.settings.autocompleteEnabled !== "boolean") this.settings.autocompleteEnabled = DEFAULT_SETTINGS.autocompleteEnabled;
		if (typeof this.settings.autocompleteDebounceMs !== "number") this.settings.autocompleteDebounceMs = DEFAULT_SETTINGS.autocompleteDebounceMs;
		if (typeof this.settings.webSearchEnabled !== "boolean") this.settings.webSearchEnabled = DEFAULT_SETTINGS.webSearchEnabled;
		if (typeof this.settings.webSearchMaxResults !== "number") this.settings.webSearchMaxResults = DEFAULT_SETTINGS.webSearchMaxResults;
		const legacyOllamaId = ["ollama", "team"].join("-");
		for (const profile of this.settings.profiles) {
			if (profile.id === legacyOllamaId) profile.id = "ollama-local";
			if (
				profile.command === "npx" &&
				profile.args.includes("@google/gemini-cli") &&
				profile.args.includes("--skip-trust")
			) {
				profile.args = profile.args.filter((arg) => arg !== "--skip-trust");
				settingsChanged = true;
			}
		}
		if (this.settings.activeProfileId === legacyOllamaId) {
			this.settings.activeProfileId = "ollama-local";
		}
		for (const profile of DEFAULT_SETTINGS.profiles) {
			if (!this.settings.profiles.some((p) => p.id === profile.id)) {
				this.settings.profiles.push(JSON.parse(JSON.stringify(profile)) as AgentProfile);
			}
		}
		if (settingsChanged) await this.saveSettings();
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	private indexPath(): string {
		return `${this.manifest.dir}/${INDEX_FILE}`;
	}

	private async loadIndex(): Promise<RagIndexData | null> {
		try {
			const path = this.indexPath();
			if (!(await this.app.vault.adapter.exists(path))) return null;
			return JSON.parse(await this.app.vault.adapter.read(path)) as RagIndexData;
		} catch {
			return null;
		}
	}

	private async saveIndex(data: RagIndexData | null): Promise<void> {
		const path = this.indexPath();
		if (!data) {
			if (await this.app.vault.adapter.exists(path)) await this.app.vault.adapter.remove(path);
			return;
		}
		await this.app.vault.adapter.write(path, JSON.stringify(data));
	}

	activeProfile(): AgentProfile {
		const found = this.settings.profiles.find((p) => p.id === this.settings.activeProfileId);
		const profile = found ?? this.settings.profiles[0];
		if (!profile) throw new Error("No agent is configured.");
		return profile;
	}

	async openPanel(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(CORTEX_VIEW);
		let leaf: WorkspaceLeaf | null = existing[0] ?? null;
		if (!leaf) {
			leaf = this.app.workspace.getRightLeaf(false);
			await leaf?.setViewState({ type: CORTEX_VIEW, active: true });
		}
		if (leaf) await this.app.workspace.revealLeaf(leaf);
	}
}
