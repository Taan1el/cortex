import { App, FileSystemAdapter, Notice, TFile, normalizePath } from "obsidian";
import { dirname, isAbsolute, relative, resolve } from "node:path";

/**
 * Vault-scoped file access for the agent.
 *
 * Everything is clamped to the vault root: any path that resolves outside the
 * vault is rejected before it reaches Obsidian's APIs. The agent is handed the
 * vault's absolute base path as its working directory, so it usually sends
 * absolute paths; we translate those back to vault-relative paths here.
 */
export class VaultFiles {
	readonly root: string;

	constructor(private app: App) {
		const adapter = app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) {
			throw new Error("Cortex needs a desktop vault to reach the file system.");
		}
		this.root = adapter.getBasePath();
	}

	/** Resolve an incoming path to a safe vault-relative path, or throw. */
	private toRelative(input: string): string {
		const abs = isAbsolute(input) ? resolve(input) : resolve(this.root, input);
		const rel = relative(this.root, abs);
		if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
			throw new Error(`Path is outside the vault: ${input}`);
		}
		return normalizePath(rel);
	}

	/** True if the path sits inside the vault. */
	isInside(input: string): boolean {
		try {
			this.toRelative(input);
			return true;
		} catch {
			return false;
		}
	}

	async read(input: string, line: number | null, limit: number | null): Promise<string> {
		const rel = this.toRelative(input);
		const file = this.app.vault.getFileByPath(rel);
		const text = file
			? await this.app.vault.cachedRead(file)
			: await this.app.vault.adapter.read(rel).catch(() => {
					throw new Error(`File not found: ${rel}`);
			  });
		return sliceLines(text, line, limit);
	}

	async write(input: string, content: string): Promise<TFile> {
		const rel = this.toRelative(input);
		const existing = this.app.vault.getFileByPath(rel);
		if (existing instanceof TFile) {
			await this.app.vault.process(existing, () => content);
			return existing;
		}
		const dir = dirname(rel);
		if (dir && dir !== "." && !this.app.vault.getFolderByPath(dir)) {
			await this.app.vault.createFolder(dir).catch(() => undefined);
		}
		return this.app.vault.create(rel, content);
	}

	/** Write + a clickable toast that opens the file. */
	async writeWithNotice(input: string, content: string): Promise<TFile> {
		const file = await this.write(input, content);
		const notice = new Notice(`Cortex wrote ${file.path}`, 5000);
		notice.messageEl.addClass("cortex-notice-link");
		notice.messageEl.addEventListener("click", () => {
			void this.app.workspace.getLeaf(false).openFile(file);
			notice.hide();
		});
		return file;
	}
}

function sliceLines(text: string, line: number | null, limit: number | null): string {
	if (line == null && limit == null) return text;
	const lines = text.split(/\r?\n/);
	const start = Math.max(0, (line ?? 1) - 1);
	const end = limit == null ? lines.length : Math.min(lines.length, start + limit);
	return lines.slice(start, end).join("\n");
}
