import { App, TFile, normalizePath } from "obsidian";

import type { CortexSettings } from "../settings";
import { createEmbeddingProvider } from "../providers";
import type { EmbeddingProvider } from "../providers/types";

export interface RagChunk {
	path: string;
	heading: string;
	text: string;
	vector: number[];
}

export interface RagIndexData {
	model: string;
	dim: number;
	chunks: RagChunk[];
	files: Record<string, number>; // path -> mtime at index time
}

export interface RagHit {
	path: string;
	heading: string;
	text: string;
	score: number;
}

export interface RagProgress {
	done: number;
	total: number;
	phase: "scanning" | "embedding" | "saving" | "idle";
}

const CHUNK_CHARS = 1200;
const CHUNK_OVERLAP = 150;
const EMBED_BATCH = 16;

/**
 * Local semantic index over the vault. Chunks markdown notes, embeds each chunk
 * with the active embedding provider, and keeps the vectors in memory (persisted
 * through the plugin's data file). Search is cosine similarity, top-k.
 */
export class VaultIndex {
	private data: RagIndexData | null = null;
	private building = false;
	private progress: RagProgress = { done: 0, total: 0, phase: "idle" };
	private readonly listeners = new Set<() => void>();

	constructor(
		private app: App,
		private getSettings: () => CortexSettings,
		private persist: (data: RagIndexData | null) => Promise<void>,
	) {}

	load(data: RagIndexData | null): void {
		this.data = data && Array.isArray(data.chunks) ? data : null;
	}

	subscribe(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => void this.listeners.delete(fn);
	}

	private emit(): void {
		for (const fn of this.listeners) fn();
	}

	get status(): { ready: boolean; chunkCount: number; fileCount: number; model: string | null; building: boolean; progress: RagProgress } {
		return {
			ready: !!this.data && this.data.chunks.length > 0,
			chunkCount: this.data?.chunks.length ?? 0,
			fileCount: this.data ? Object.keys(this.data.files).length : 0,
			model: this.data?.model ?? null,
			building: this.building,
			progress: this.progress,
		};
	}

	private embedder(): EmbeddingProvider {
		const settings = this.getSettings();
		const profile = settings.profiles.find((p) => p.id === settings.activeProfileId) ?? settings.profiles[0];
		if (!profile) throw new Error("No agent is configured to provide embeddings.");
		const provider = createEmbeddingProvider(profile, settings);
		if (!provider) {
			throw new Error(`The active agent (${profile.name}) cannot create embeddings. Switch to Ollama, OpenAI, or Gemini for vault search.`);
		}
		return provider;
	}

	/** Full rebuild from scratch. */
	async rebuild(signal: AbortSignal): Promise<void> {
		if (this.building) throw new Error("An index build is already running.");
		this.building = true;
		this.progress = { done: 0, total: 0, phase: "scanning" };
		this.emit();
		try {
			const provider = this.embedder();
			const files = this.markdownFiles();
			const pending: { path: string; heading: string; text: string }[] = [];
			for (const file of files) {
				const body = await this.app.vault.cachedRead(file);
				for (const chunk of chunkNote(body)) {
					pending.push({ path: file.path, heading: chunk.heading, text: chunk.text });
				}
			}
			this.progress = { done: 0, total: pending.length, phase: "embedding" };
			this.emit();

			const chunks: RagChunk[] = [];
			for (let i = 0; i < pending.length; i += EMBED_BATCH) {
				if (signal.aborted) throw new DOMException("Aborted", "AbortError");
				const batch = pending.slice(i, i + EMBED_BATCH);
				const vectors = await provider.embed(batch.map((b) => b.text), signal);
				batch.forEach((b, j) => {
					const vector = vectors[j];
					if (vector) chunks.push({ ...b, vector });
				});
				this.progress = { done: Math.min(i + EMBED_BATCH, pending.length), total: pending.length, phase: "embedding" };
				this.emit();
			}

			const fileMap: Record<string, number> = {};
			for (const file of files) fileMap[file.path] = file.stat.mtime;

			this.data = {
				model: provider.model,
				dim: chunks[0]?.vector.length ?? 0,
				chunks,
				files: fileMap,
			};
			this.progress = { done: pending.length, total: pending.length, phase: "saving" };
			this.emit();
			await this.persist(this.data);
		} finally {
			this.building = false;
			this.progress = { done: 0, total: 0, phase: "idle" };
			this.emit();
		}
	}

	/** Incremental update: re-embed only new/changed files, drop deleted ones. */
	async refresh(signal: AbortSignal): Promise<void> {
		if (!this.data) {
			await this.rebuild(signal);
			return;
		}
		if (this.building) throw new Error("An index build is already running.");
		this.building = true;
		this.progress = { done: 0, total: 0, phase: "scanning" };
		this.emit();
		try {
			const provider = this.embedder();
			if (provider.model !== this.data.model) {
				// Embedding model changed — vectors are incomparable, rebuild.
				this.building = false;
				await this.rebuild(signal);
				return;
			}
			const files = this.markdownFiles();
			const current = new Map(files.map((f) => [f.path, f]));
			const changed: TFile[] = [];
			for (const file of files) {
				if (this.data.files[file.path] !== file.stat.mtime) changed.push(file);
			}
			const deleted = Object.keys(this.data.files).filter((p) => !current.has(p));

			// Drop chunks for changed + deleted files.
			const stale = new Set([...changed.map((f) => f.path), ...deleted]);
			let chunks = this.data.chunks.filter((c) => !stale.has(c.path));

			const pending: { path: string; heading: string; text: string }[] = [];
			for (const file of changed) {
				const body = await this.app.vault.cachedRead(file);
				for (const chunk of chunkNote(body)) {
					pending.push({ path: file.path, heading: chunk.heading, text: chunk.text });
				}
			}
			this.progress = { done: 0, total: pending.length, phase: "embedding" };
			this.emit();

			for (let i = 0; i < pending.length; i += EMBED_BATCH) {
				if (signal.aborted) throw new DOMException("Aborted", "AbortError");
				const batch = pending.slice(i, i + EMBED_BATCH);
				const vectors = await provider.embed(batch.map((b) => b.text), signal);
				batch.forEach((b, j) => {
					const vector = vectors[j];
					if (vector) chunks.push({ ...b, vector });
				});
				this.progress = { done: Math.min(i + EMBED_BATCH, pending.length), total: pending.length, phase: "embedding" };
				this.emit();
			}

			const fileMap: Record<string, number> = {};
			for (const file of files) fileMap[file.path] = file.stat.mtime;

			this.data = { model: provider.model, dim: chunks[0]?.vector.length ?? this.data.dim, chunks, files: fileMap };
			this.progress = { done: pending.length, total: pending.length, phase: "saving" };
			this.emit();
			await this.persist(this.data);
		} finally {
			this.building = false;
			this.progress = { done: 0, total: 0, phase: "idle" };
			this.emit();
		}
	}

	async clear(): Promise<void> {
		this.data = null;
		await this.persist(null);
		this.emit();
	}

	/** Top-k semantic search. Embeds the query, returns the closest chunks. */
	async search(query: string, k: number, signal: AbortSignal): Promise<RagHit[]> {
		if (!this.data || this.data.chunks.length === 0) {
			throw new Error("The vault index is empty. Build it from the Cortex panel first.");
		}
		const provider = this.embedder();
		const [queryVec] = await provider.embed([query], signal);
		if (!queryVec) throw new Error("Could not embed the search query.");
		const scored = this.data.chunks.map((c) => ({
			path: c.path,
			heading: c.heading,
			text: c.text,
			score: cosine(queryVec, c.vector),
		}));
		scored.sort((a, b) => b.score - a.score);
		return scored.slice(0, k);
	}

	private markdownFiles(): TFile[] {
		const folder = this.getSettings().ragExcludeFolder.trim();
		const exclude = folder ? normalizePath(folder) : "";
		return this.app.vault
			.getMarkdownFiles()
			.filter((f) => !exclude || !f.path.startsWith(`${exclude}/`));
	}
}

interface NoteChunk {
	heading: string;
	text: string;
}

/** Split a note on headings, then hard-wrap long sections with overlap. */
export function chunkNote(body: string): NoteChunk[] {
	const stripped = body.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
	if (!stripped) return [];

	const sections: { heading: string; lines: string[] }[] = [{ heading: "", lines: [] }];
	for (const line of stripped.split(/\r?\n/)) {
		const h = line.match(/^(#{1,6})\s+(.*)$/);
		if (h) {
			sections.push({ heading: h[2]?.trim() ?? "", lines: [] });
		} else {
			sections[sections.length - 1]!.lines.push(line);
		}
	}

	const out: NoteChunk[] = [];
	for (const section of sections) {
		const text = section.lines.join("\n").trim();
		if (!text) continue;
		if (text.length <= CHUNK_CHARS) {
			out.push({ heading: section.heading, text });
			continue;
		}
		let start = 0;
		while (start < text.length) {
			const end = Math.min(text.length, start + CHUNK_CHARS);
			out.push({ heading: section.heading, text: text.slice(start, end).trim() });
			if (end >= text.length) break;
			start = end - CHUNK_OVERLAP;
		}
	}
	return out.filter((c) => c.text.length > 20);
}

function cosine(a: number[], b: number[]): number {
	let dot = 0;
	let na = 0;
	let nb = 0;
	const len = Math.min(a.length, b.length);
	for (let i = 0; i < len; i++) {
		dot += a[i]! * b[i]!;
		na += a[i]! * a[i]!;
		nb += b[i]! * b[i]!;
	}
	if (na === 0 || nb === 0) return 0;
	return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
