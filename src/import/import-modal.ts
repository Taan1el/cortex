import { App, Modal, Notice, Setting, TFile, normalizePath } from "obsidian";
import { convertChatGptExport } from "./convert";

export class ChatGptImportModal extends Modal {
	private file: File | null = null;
	private folder: string;

	constructor(app: App, defaultFolder: string) {
		super(app);
		this.folder = defaultFolder || "ChatGPT";
	}

	onOpen(): void {
		this.titleEl.setText("Import ChatGPT export");
		const { contentEl } = this;

		contentEl.createEl("p", {
			cls: "setting-item-description",
			text: "Pick the conversations.json from your ChatGPT data export (Settings → Data controls → Export). Each conversation becomes a note.",
		});

		const fileInput = contentEl.createEl("input", { attr: { type: "file", accept: ".json,application/json" } });
		fileInput.addEventListener("change", () => {
			this.file = fileInput.files?.[0] ?? null;
		});

		new Setting(contentEl)
			.setName("Destination folder")
			.setDesc("Folder in your vault where the notes are created.")
			.addText((t) => t.setValue(this.folder).onChange((v) => (this.folder = v.trim())));

		const status = contentEl.createEl("p", { cls: "setting-item-description" });

		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) =>
				b.setButtonText("Import").setCta().onClick(async () => {
					if (!this.file) {
						new Notice("Pick a conversations.json file first.");
						return;
					}
					b.setDisabled(true);
					status.setText("Importing…");
					try {
						const count = await this.run(this.file);
						new Notice(`Imported ${count} conversation(s) into ${normalizePath(this.folder || "ChatGPT")}/`);
						this.close();
					} catch (err) {
						status.setText(`Import failed: ${(err as Error).message}`);
						b.setDisabled(false);
					}
				}),
			);
	}

	private async run(file: File): Promise<number> {
		const raw: unknown = JSON.parse(await file.text());
		const notes = convertChatGptExport(raw);

		const folder = normalizePath(this.folder || "ChatGPT");
		if (folder && folder !== "/" && !this.app.vault.getFolderByPath(folder)) {
			await this.app.vault.createFolder(folder).catch(() => undefined);
		}

		let written = 0;
		for (const note of notes) {
			const path = normalizePath(`${folder}/${note.filename}`);
			const existing = this.app.vault.getFileByPath(path);
			if (existing instanceof TFile) {
				await this.app.vault.process(existing, () => note.content);
			} else {
				await this.app.vault.create(path, note.content);
			}
			written++;
		}
		return written;
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
