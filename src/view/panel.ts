import { ItemView, Menu, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type CortexPlugin from "../main";
import type { EffortLevel } from "../settings";
import type { EngineState, PanelItem } from "../types";

export const CORTEX_VIEW = "cortex-view";

interface QuickAction {
	icon: string;
	label: string;
	prompt: string;
}

const QUICK_ACTIONS: QuickAction[] = [
	{ icon: "sparkles", label: "Summarize", prompt: "Summarize the note I'm currently viewing in a few clear bullet points." },
	{ icon: "link", label: "Find links", prompt: "Suggest related notes or topics I could link to from the note I'm viewing, using [[wikilinks]]." },
	{ icon: "tag", label: "Tag this", prompt: "Suggest a handful of relevant #tags for the note I'm currently viewing." },
	{ icon: "check-square", label: "To-dos", prompt: "Pull any action items out of the note I'm viewing as a checklist." },
	{ icon: "book-open", label: "Explain", prompt: "Explain the note I'm currently viewing in simple terms." },
	{ icon: "pencil", label: "Rewrite note", prompt: "Rewrite the active note to be clearer, keeping my voice. Ask before replacing it." },
];

export class CortexView extends ItemView {
	private unsubscribe: (() => void) | null = null;
	private messagesEl!: HTMLElement;
	private statusDotEl!: HTMLElement;
	private statusLabelEl!: HTMLElement;
	private chipsEl!: HTMLElement;
	private savedRowEl!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private effortPillEl!: HTMLButtonElement;
	private sendBtnEl!: HTMLButtonElement;

	constructor(leaf: WorkspaceLeaf, private plugin: CortexPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return CORTEX_VIEW;
	}
	getDisplayText(): string {
		return "Cortex";
	}
	getIcon(): string {
		return "brain";
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("cortex-root");
		this.buildHeader(root);
		this.messagesEl = root.createDiv({ cls: "cortex-messages" });
		this.buildComposer(root);

		this.unsubscribe = this.plugin.engine.subscribe(() => this.render());
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.refreshContext()));
		this.registerEvent(this.app.workspace.on("file-open", () => this.refreshContext()));

		if (this.plugin.engine.snapshot().status.kind === "idle") {
			void this.plugin.engine.start(this.plugin.activeProfile());
		}
		this.refreshContext();
		this.render();
	}

	async onClose(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = null;
	}

	// Chrome

	private buildHeader(root: HTMLElement): void {
		const header = root.createDiv({ cls: "cortex-header" });
		const brand = header.createDiv({ cls: "cortex-brand" });
		const mark = brand.createSpan({ cls: "cortex-mark" });
		setIcon(mark, "brain");
		const titles = brand.createDiv({ cls: "cortex-titles" });
		titles.createDiv({ cls: "cortex-title", text: "Cortex" });
		const status = titles.createEl("button", { cls: "cortex-status", attr: { "aria-label": "Switch agent" } });
		this.statusDotEl = status.createSpan({ cls: "cortex-status-dot" });
		this.statusLabelEl = status.createSpan({ cls: "cortex-status-label" });
		const chevron = status.createSpan({ cls: "cortex-status-chevron" });
		setIcon(chevron, "chevron-down");
		status.addEventListener("click", () => this.openAgentMenu(status));

	}

	private buildComposer(root: HTMLElement): void {
		const composer = root.createDiv({ cls: "cortex-composer" });
		this.savedRowEl = composer.createDiv({ cls: "cortex-saved-row" });
		this.chipsEl = composer.createDiv({ cls: "cortex-chips" });

		const card = composer.createDiv({ cls: "cortex-input-card" });
		this.inputEl = card.createEl("textarea", {
			cls: "cortex-input",
			attr: { placeholder: "Ask anything about your notes...", rows: "2" },
		});
		this.inputEl.addEventListener("input", () => this.updateSendState());
		this.inputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				this.submit();
			}
		});

		const row = card.createDiv({ cls: "cortex-input-row" });
		this.effortPillEl = row.createEl("button", { cls: "cortex-effort-pill", attr: { "aria-label": "Reasoning effort" } });
		this.effortPillEl.setText(`effort: ${this.plugin.settings.effort}`);
		this.effortPillEl.addEventListener("click", () => this.openEffortMenu(this.effortPillEl));
		this.sendBtnEl = row.createEl("button", { cls: "cortex-send-btn", attr: { "aria-label": "Send" } });
		setIcon(this.sendBtnEl, "arrow-up");
		this.sendBtnEl.addEventListener("click", () => this.submit());
		this.updateSendState();

		this.renderSavedPrompts();
	}

	private renderSavedPrompts(): void {
		this.savedRowEl.empty();
		for (const sp of this.plugin.settings.savedPrompts) {
			if (!sp.name.trim() || !sp.prompt.trim()) continue;
			const btn = this.savedRowEl.createEl("button", { cls: "cortex-saved-pill", text: sp.name });
			btn.addEventListener("click", () => {
				this.inputEl.value = "";
				this.updateSendState();
				void this.plugin.engine.send(sp.prompt).catch((err: unknown) => new Notice((err as Error).message));
			});
		}
		this.savedRowEl.toggleClass("is-hidden", this.savedRowEl.childElementCount === 0);
	}

	private openAgentMenu(anchor: HTMLElement): void {
		const menu = new Menu();
		for (const profile of this.plugin.settings.profiles) {
			menu.addItem((item) =>
				item
					.setTitle(profile.name)
					.setChecked(profile.id === this.plugin.settings.activeProfileId)
					.onClick(async () => {
						const alreadyActive = profile.id === this.plugin.settings.activeProfileId;
						this.plugin.settings.activeProfileId = profile.id;
						await this.plugin.saveSettings();
						if (!alreadyActive || this.plugin.engine.snapshot().status.kind !== "ready") {
							void this.plugin.engine.start(profile);
						}
					}),
			);
		}
		const rect = anchor.getBoundingClientRect();
		menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
	}

	private openEffortMenu(anchor: HTMLElement): void {
		const menu = new Menu();
		const levels: EffortLevel[] = ["minimal", "low", "medium", "high"];
		for (const level of levels) {
			menu.addItem((item) =>
				item
					.setTitle(level)
					.setChecked(this.plugin.settings.effort === level)
					.onClick(async () => {
						this.plugin.settings.effort = level;
						await this.plugin.saveSettings();
						this.effortPillEl.setText(`effort: ${level}`);
					}),
			);
		}
		const rect = anchor.getBoundingClientRect();
		menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
	}

	private refreshContext(): void {
		this.chipsEl.empty();
		const file = this.app.workspace.getActiveFile();
		if (file && this.plugin.settings.autoInjectActiveNote) {
			const chip = this.chipsEl.createSpan({ cls: "cortex-chip cortex-chip-active" });
			const icon = chip.createSpan({ cls: "cortex-chip-icon" });
			setIcon(icon, "file-text");
			chip.createSpan({ text: file.name });
		}
	}

	private updateSendState(): void {
		this.sendBtnEl.toggleClass("is-active", this.inputEl.value.trim().length > 0);
	}

	private submit(): void {
		const text = this.inputEl.value.trim();
		if (!text) return;
		this.inputEl.value = "";
		this.updateSendState();
		void this.plugin.engine.send(text).catch((err: unknown) => new Notice((err as Error).message));
	}

	// Render

	private render(): void {
		const state = this.plugin.engine.snapshot();
		this.renderStatus(state);
		this.messagesEl.empty();

		if (state.items.length === 0 && !state.busy) {
			this.renderEmpty();
			return;
		}
		for (const item of state.items) this.renderItem(item);
		if (state.busy) {
			const thinking = this.messagesEl.createDiv({ cls: "cortex-msg cortex-msg-assistant" });
			const avatar = thinking.createSpan({ cls: "cortex-avatar" });
			setIcon(avatar, "brain");
			const dots = thinking.createDiv({ cls: "cortex-typing" });
			for (let i = 0; i < 3; i++) dots.createSpan({ cls: "cortex-typing-dot" });
		}
		this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
	}

	private renderStatus(state: EngineState): void {
		const kind = state.status.kind;
		this.statusDotEl.className = `cortex-status-dot cortex-status-${kind}`;
		const label =
			kind === "ready" ? (state.model ? `ready · ${state.model}` : "ready")
			: kind === "connecting" ? "starting..."
			: kind === "error" ? `failed: ${state.status.message}`
			: "not started";
		this.statusLabelEl.setText(label);
	}

	private renderEmpty(): void {
		const empty = this.messagesEl.createDiv({ cls: "cortex-empty" });
		const markWrap = empty.createDiv({ cls: "cortex-empty-mark-wrap" });
		const mark = markWrap.createDiv({ cls: "cortex-empty-mark" });
		setIcon(mark, "brain");
		markWrap.createDiv({ cls: "cortex-empty-ring" });

		empty.createDiv({ cls: "cortex-empty-title", text: "Hey, I'm Cortex" });
		empty.createDiv({
			cls: "cortex-empty-text",
			text: this.plugin.settings.autoInjectActiveNote
				? "I can read the open note. Ask me anything, or try one of these:"
				: "Ask me anything. Open-note context is off.",
		});

		const grid = empty.createDiv({ cls: "cortex-quick-grid" });
		for (const action of QUICK_ACTIONS) {
			const btn = grid.createEl("button", { cls: "cortex-quick" });
			const icon = btn.createSpan({ cls: "cortex-quick-icon" });
			setIcon(icon, action.icon);
			btn.createSpan({ text: action.label });
			btn.addEventListener("click", () => void this.plugin.engine.send(action.prompt).catch((err: unknown) => new Notice((err as Error).message)));
		}
	}

	private renderItem(item: PanelItem): void {
		if (item.kind === "message") {
			this.renderMessage(item);
		} else if (item.kind === "tool") {
			this.renderTool(item);
		} else {
			this.renderAsk(item);
		}
	}

	private renderMessage(item: Extract<PanelItem, { kind: "message" }>): void {
		if (item.from === "user") {
			const row = this.messagesEl.createDiv({ cls: "cortex-msg cortex-msg-user" });
			row.createDiv({ cls: "cortex-bubble", text: item.text });
			return;
		}
		const row = this.messagesEl.createDiv({ cls: `cortex-msg cortex-msg-${item.from}` });
		const avatar = row.createSpan({ cls: "cortex-avatar" });
		setIcon(avatar, "brain");
		row.createDiv({ cls: "cortex-msg-body", text: item.text });
	}

	private renderTool(item: Extract<PanelItem, { kind: "tool" }>): void {
		const row = this.messagesEl.createDiv({ cls: "cortex-tool" });
		const avatar = row.createSpan({ cls: "cortex-avatar cortex-avatar-tool" });
		setIcon(avatar, "search");
		const card = row.createDiv({ cls: "cortex-tool-card" });
		const head = card.createDiv({ cls: "cortex-tool-head" });
		head.createSpan({ cls: "cortex-tool-name", text: item.title });
		const statusIcon = head.createSpan({ cls: `cortex-tool-state cortex-tool-${item.status}` });
		setIcon(statusIcon, item.status === "done" ? "check" : item.status === "failed" ? "x" : "loader");
		if (item.locations.length) {
			const locs = card.createDiv({ cls: "cortex-tool-locations" });
			for (const path of item.locations) {
				const line = locs.createDiv({ cls: "cortex-tool-loc" });
				const icon = line.createSpan({ cls: "cortex-tool-loc-icon" });
				setIcon(icon, "file-text");
				line.createSpan({ text: path });
			}
		}
	}

	private renderAsk(item: Extract<PanelItem, { kind: "ask" }>): void {
		const row = this.messagesEl.createDiv({ cls: "cortex-ask" });
		const avatar = row.createSpan({ cls: "cortex-avatar cortex-avatar-warn" });
		setIcon(avatar, "shield");
		const card = row.createDiv({ cls: "cortex-ask-card" });
		card.createDiv({ cls: "cortex-ask-label", text: "Permission needed" });
		card.createDiv({ cls: "cortex-ask-title", text: item.title });
		if (item.detail) card.createDiv({ cls: "cortex-ask-detail", text: item.detail });

		if (item.decision) {
			card.createDiv({ cls: "cortex-ask-decided", text: "Decided." });
			return;
		}
		const actions = card.createDiv({ cls: "cortex-ask-actions" });
		for (const option of item.options) {
			const btn = actions.createEl("button", {
				cls: option.primary ? "cortex-ask-btn cortex-ask-btn-primary" : "cortex-ask-btn",
				text: option.label,
			});
			btn.addEventListener("click", () => this.plugin.engine.decide(item.id, option.id));
		}
	}
}

