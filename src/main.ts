import { Plugin, WorkspaceLeaf } from "obsidian";

import { CortexSettingTab, DEFAULT_SETTINGS, type AgentProfile, type CortexSettings } from "./settings";
import { CortexEngine } from "./agent/controller";
import { CortexView, CORTEX_VIEW } from "./view/panel";
import { ChatGptImportModal } from "./import/import-modal";

export default class CortexPlugin extends Plugin {
	settings!: CortexSettings;
	engine!: CortexEngine;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.engine = new CortexEngine(this.app, () => this.settings);

		this.registerView(CORTEX_VIEW, (leaf) => new CortexView(leaf, this));

		this.addRibbonIcon("brain", "Open Cortex", () => void this.openPanel());
		this.addCommand({ id: "open", name: "Open Cortex", callback: () => void this.openPanel() });
		this.addCommand({ id: "start", name: "Start the assistant", callback: () => void this.engine.start(this.activeProfile()) });
		this.addCommand({ id: "stop", name: "Stop the assistant", callback: () => void this.engine.stop() });
		this.addCommand({ id: "cancel", name: "Stop the current reply", callback: () => void this.engine.cancel() });
		this.addCommand({
			id: "import-chatgpt",
			name: "Import ChatGPT export",
			callback: () => new ChatGptImportModal(this.app, this.settings.importFolder).open(),
		});

		this.addSettingTab(new CortexSettingTab(this.app, this));
	}

	onunload(): void {
		void this.engine?.stop();
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as Partial<CortexSettings>);
		const legacyOllamaId = ["ollama", "team"].join("-");
		for (const profile of this.settings.profiles) {
			if (profile.id === legacyOllamaId) profile.id = "ollama-local";
		}
		if (this.settings.activeProfileId === legacyOllamaId) {
			this.settings.activeProfileId = "ollama-local";
		}
		for (const profile of DEFAULT_SETTINGS.profiles) {
			if (!this.settings.profiles.some((p) => p.id === profile.id)) {
				this.settings.profiles.push(JSON.parse(JSON.stringify(profile)) as AgentProfile);
			}
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
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
