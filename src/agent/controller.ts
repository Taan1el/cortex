import { Buffer } from "node:buffer";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import process from "node:process";
import { Readable, Writable } from "node:stream";
import { App, MarkdownView, requestUrl } from "obsidian";
import * as acp from "@agentclientprotocol/sdk";

import type { ConnectionStatus, EngineState, PanelItem, ToolStatus } from "../types";
import type { AgentProfile, CortexSettings } from "../settings";
import { VaultFiles } from "../vault/files";

type Listener = () => void;
type OllamaRole = "system" | "user" | "assistant";

interface OllamaMessage {
	role: OllamaRole;
	content: string;
}

interface OllamaChatResponse {
	message?: {
		role?: string;
		content?: string;
	};
	error?: string;
}

export class CortexEngine {
	private status: ConnectionStatus = { kind: "idle" };
	private items: PanelItem[] = [];
	private busy = false;
	private model: string | null = null;

	private proc: ChildProcessWithoutNullStreams | null = null;
	private conn: acp.ClientSideConnection | null = null;
	private sessionId: string | null = null;
	private firstTurn = true;
	private activeProfile: AgentProfile | null = null;

	private readonly asks = new Map<string, (r: acp.RequestPermissionResponse) => void>();
	private readonly localAsks = new Map<string, (optionId: string) => void>();
	private readonly listeners = new Set<Listener>();
	private readonly files: VaultFiles;

	constructor(private app: App, private getSettings: () => CortexSettings) {
		this.files = new VaultFiles(app);
	}

	subscribe(fn: Listener): () => void {
		this.listeners.add(fn);
		return () => void this.listeners.delete(fn);
	}

	snapshot(): EngineState {
		return { status: this.status, items: this.items, busy: this.busy, model: this.model };
	}

	private emit(): void {
		for (const fn of this.listeners) fn();
	}

	async start(profile: AgentProfile): Promise<void> {
		await this.stop();
		this.status = { kind: "connecting" };
		this.activeProfile = profile;
		this.emit();

		try {
			if ((profile.provider ?? "acp") === "ollama") {
				await this.startOllama(profile);
				return;
			}
			await this.startAcp(profile);
		} catch (err) {
			this.status = { kind: "error", message: (err as Error).message };
			this.emit();
		}
	}

	private async startAcp(profile: AgentProfile): Promise<void> {
		const proc = spawn(profile.command, profile.args, {
			cwd: this.files.root,
			env: { ...process.env, ...profile.env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.proc = proc;
		proc.stderr.on("data", (chunk: Buffer) => {
			if (this.getSettings().debugLogging) console.debug("[cortex:agent]", chunk.toString());
		});
		proc.on("exit", () => {
			if (this.status.kind !== "error") this.status = { kind: "idle" };
			this.proc = null;
			this.conn = null;
			this.emit();
		});
		proc.on("error", (err) => {
			this.status = { kind: "error", message: err.message };
			this.emit();
		});

		const stream = acp.ndJsonStream(
			Writable.toWeb(proc.stdin) as unknown as WritableStream<Uint8Array>,
			Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>,
		);
		this.conn = new acp.ClientSideConnection(() => this.makeClient(), stream);

		await this.conn.initialize({
			protocolVersion: acp.PROTOCOL_VERSION,
			clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
		});
		const session = await this.conn.newSession({ cwd: this.files.root, mcpServers: [] });
		this.sessionId = session.sessionId;
		this.model = shortName(profile.name);
		this.firstTurn = true;
		this.status = { kind: "ready", sessionId: session.sessionId };
		this.emit();
	}

	private async startOllama(profile: AgentProfile): Promise<void> {
		const baseUrl = cleanBaseUrl(profile.ollamaBaseUrl);
		const model = profile.ollamaModel?.trim() || "llama3.2:latest";
		await requestUrl({ url: `${baseUrl}/api/tags`, method: "GET" });
		this.sessionId = `ollama-${rid()}`;
		this.model = `ollama:${model}`;
		this.firstTurn = true;
		this.status = { kind: "ready", sessionId: this.sessionId };
		this.emit();
	}

	async stop(): Promise<void> {
		try {
			this.proc?.kill();
		} catch {
			/* already gone */
		}
		for (const resolve of this.asks.values()) resolve({ outcome: { outcome: "cancelled" } });
		this.asks.clear();
		for (const resolve of this.localAsks.values()) resolve("deny");
		this.localAsks.clear();
		this.proc = null;
		this.conn = null;
		this.sessionId = null;
		this.activeProfile = null;
		this.busy = false;
		this.items = [];
		this.status = { kind: "idle" };
		this.emit();
	}

	async send(text: string): Promise<void> {
		if (this.status.kind !== "ready" || this.sessionId == null) {
			throw new Error("Cortex is not connected to an agent yet.");
		}
		const profile = this.activeProfile;
		if (profile && (profile.provider ?? "acp") === "ollama") {
			await this.sendOllama(text, profile);
			return;
		}
		await this.sendAcp(text);
	}

	private async sendAcp(text: string): Promise<void> {
		if (!this.conn || this.sessionId == null) {
			throw new Error("Cortex is not connected to an ACP agent yet.");
		}
		const settings = this.getSettings();
		this.items.push({ kind: "message", id: rid(), from: "user", text });
		this.busy = true;
		this.emit();

		const blocks: acp.ContentBlock[] = [];
		if (this.firstTurn) {
			blocks.push({ type: "text", text: this.intro() });
			this.firstTurn = false;
		}
		const context = await this.buildContext(settings);
		if (context) blocks.push({ type: "text", text: context });
		blocks.push({ type: "text", text });

		try {
			await this.conn.prompt({ sessionId: this.sessionId, prompt: blocks });
		} catch (err) {
			this.items.push({ kind: "message", id: rid(), from: "assistant", text: `Warning: ${(err as Error).message}` });
		} finally {
			this.busy = false;
			this.emit();
		}
	}

	private async sendOllama(text: string, profile: AgentProfile): Promise<void> {
		const settings = this.getSettings();
		this.items.push({ kind: "message", id: rid(), from: "user", text });
		this.busy = true;
		this.emit();

		const context = await this.buildContext(settings);
		try {
			if (isEditCurrentNoteRequest(text)) {
				await this.runOllamaNoteEdit(text, profile);
				return;
			}
			const answer = await this.askOllama(profile, [
				system("You are Cortex, a local Obsidian assistant. Answer simply and directly. Keep replies short unless the user asks for detail."),
				user([
					"User request:",
					text,
					"",
					"Vault context:",
					context ?? "No extra context.",
				].join("\n")),
			]);
			this.items.push({ kind: "message", id: rid(), from: "assistant", text: answer });
		} catch (err) {
			this.items.push({ kind: "message", id: rid(), from: "assistant", text: ollamaError(err) });
		} finally {
			this.busy = false;
			this.emit();
		}
	}

	private async runOllamaNoteEdit(text: string, profile: AgentProfile): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!file) {
			this.items.push({ kind: "message", id: rid(), from: "assistant", text: "Open a note first, then ask me to improve or rewrite it." });
			return;
		}
		const original = await this.app.vault.cachedRead(file);
		const revisedRaw = await this.askOllama(profile, [
			system("You are Cortex, a local Obsidian note editor. Rewrite the active note according to the user request. Preserve meaning, frontmatter, headings, links, tags, and facts. Output only the complete revised Markdown note. No explanation."),
			user([
				"User request:",
				text,
				"",
				`Current file: ${file.path}`,
				"",
				"Current note:",
				"```markdown",
				original,
				"```",
				"",
				"Return only the full revised Markdown note.",
			].join("\n")),
		]);
		const revised = cleanRevisedMarkdown(revisedRaw);
		if (!revised.trim() || revised.trim() === original.trim()) {
			this.items.push({ kind: "message", id: rid(), from: "assistant", text: "I could not produce a useful edit. I left the note unchanged." });
			return;
		}

		const decision = await this.requestLocalWriteApproval(file.path, revised);
		if (decision !== "allow") {
			this.items.push({ kind: "message", id: rid(), from: "assistant", text: "Okay. I left the note unchanged." });
			return;
		}
		await this.files.writeWithNotice(file.path, revised);
		this.items.push({ kind: "message", id: rid(), from: "assistant", text: `Updated ${file.path}` });
	}

	private requestLocalWriteApproval(path: string, preview?: string, title = "Apply this edit to the current note?"): Promise<string> {
		return new Promise((resolve) => {
			const id = rid();
			this.localAsks.set(id, resolve);
			this.items.push({
				kind: "ask",
				id,
				title,
				detail: preview ? `${path}\n\nPreview:\n${previewForApproval(preview)}` : path,
				options: [
					{ id: "allow", label: "Apply edit", primary: true },
					{ id: "deny", label: "Keep original", primary: false },
				],
				decision: null,
			});
			this.emit();
		});
	}

	private async askOllama(profile: AgentProfile, messages: OllamaMessage[]): Promise<string> {
		const baseUrl = cleanBaseUrl(profile.ollamaBaseUrl);
		const model = profile.ollamaModel?.trim() || "llama3.2:latest";
		const response = await requestUrl({
			url: `${baseUrl}/api/chat`,
			method: "POST",
			contentType: "application/json",
			body: JSON.stringify({ model, messages, stream: false }),
		});
		const json = response.json as Partial<OllamaChatResponse>;
		if (json.error) throw new Error(json.error);
		return json.message?.content?.trim() || "(No response from Ollama.)";
	}

	async cancel(): Promise<void> {
		if (this.status.kind === "ready" && this.conn && this.sessionId != null) {
			await this.conn.cancel({ sessionId: this.sessionId });
		}
	}

	decide(askId: string, optionId: string): void {
		const item = this.items.find((i): i is Extract<PanelItem, { kind: "ask" }> => i.kind === "ask" && i.id === askId);
		if (!item) return;
		item.decision = optionId;
		const localResolve = this.localAsks.get(askId);
		if (localResolve) {
			this.localAsks.delete(askId);
			localResolve(optionId);
			this.emit();
			return;
		}
		const resolve = this.asks.get(askId);
		if (!resolve) return;
		this.asks.delete(askId);
		resolve({ outcome: { outcome: "selected", optionId } });
		this.emit();
	}

	private makeClient(): acp.Client {
		return {
			requestPermission: (req) => this.handlePermission(req),
			sessionUpdate: (notif) => {
				this.applyUpdate(notif);
				return Promise.resolve();
			},
			readTextFile: async (req) => ({
				content: await this.files.read(req.path, req.line ?? null, req.limit ?? null),
			}),
			writeTextFile: async (req) => {
				if (!this.getSettings().autoApproveWrites) {
					const decision = await this.requestLocalWriteApproval(req.path, req.content, "Allow this agent to write a note?");
					if (decision !== "allow") throw new Error("User cancelled file write.");
				}
				await this.files.writeWithNotice(req.path, req.content);
				return {};
			},
		};
	}

	private handlePermission(req: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
		const auto = this.autoDecide(req);
		if (auto) return Promise.resolve(auto);

		return new Promise((resolve) => {
			const id = rid();
			this.asks.set(id, resolve);
			this.items.push({
				kind: "ask",
				id,
				title: req.toolCall?.title ?? "Cortex wants permission",
				detail: locationText(req.toolCall),
				options: req.options.map((o) => ({
					id: o.optionId,
					label: o.name,
					primary: o.kind === "allow_once" || o.kind === "allow_always",
				})),
				decision: null,
			});
			this.emit();
		});
	}

	private autoDecide(req: acp.RequestPermissionRequest): acp.RequestPermissionResponse | null {
		const settings = this.getSettings();
		const allow = req.options.find((o) => o.kind === "allow_once" || o.kind === "allow_always");
		if (!allow) return null;
		const kind = req.toolCall?.kind;
		if (settings.autoApproveReads && kind === "read") {
			return { outcome: { outcome: "selected", optionId: allow.optionId } };
		}
		if (settings.autoApproveWrites && kind === "edit") {
			const locations = req.toolCall?.locations ?? [];
			if (locations.every((l) => this.files.isInside(l.path))) {
				return { outcome: { outcome: "selected", optionId: allow.optionId } };
			}
		}
		return null;
	}

	private applyUpdate(notif: acp.SessionNotification): void {
		const u = notif.update;
		switch (u.sessionUpdate) {
			case "agent_message_chunk":
				this.appendChunk("assistant", u.content);
				break;
			case "agent_thought_chunk":
				this.appendChunk("thinking", u.content);
				break;
			case "user_message_chunk":
				this.appendChunk("user", u.content);
				break;
			case "tool_call":
				this.items.push({
					kind: "tool",
					id: rid(),
					callId: u.toolCallId,
					title: u.title,
					status: mapToolStatus(u.status),
					locations: (u.locations ?? []).map((l) => l.path),
				});
				break;
			case "tool_call_update": {
				const tool = this.items.find(
					(i): i is Extract<PanelItem, { kind: "tool" }> => i.kind === "tool" && i.callId === u.toolCallId,
				);
				if (tool) {
					if (u.status) tool.status = mapToolStatus(u.status);
					if (u.title) tool.title = u.title;
					if (u.locations) tool.locations = u.locations.map((l) => l.path);
				}
				break;
			}
			default:
				return;
		}
		this.emit();
	}

	private appendChunk(from: "user" | "assistant" | "thinking", content: acp.ContentBlock): void {
		const text = content.type === "text" ? content.text : `[${content.type}]`;
		const last = this.items[this.items.length - 1];
		if (last && last.kind === "message" && last.from === from) {
			last.text += text;
		} else {
			this.items.push({ kind: "message", id: rid(), from, text });
		}
	}

	private intro(): string {
		return [
			"You are talking to a user inside Obsidian, a Markdown note-taking app.",
			`Their vault of notes lives at \`${this.files.root}\`. File requests you make read and write inside it.`,
			"Replies show in a narrow side panel next to their notes. Keep answers focused.",
		].join("\n");
	}

	private async buildContext(settings: CortexSettings): Promise<string | null> {
		const lines: string[] = [];
		const file = this.app.workspace.getActiveFile();
		if (file) {
			lines.push(`[Context] The user is viewing: ${file.path}`);
			if (settings.autoInjectActiveNote || (this.activeProfile?.provider ?? "acp") === "ollama") {
				const body = await this.app.vault.cachedRead(file);
				lines.push("", "Current note contents:", "```markdown", body, "```");
			}
		} else {
			lines.push("[Context] No note is currently open.");
		}
		const selection = this.app.workspace.getActiveViewOfType(MarkdownView)?.editor?.getSelection();
		if (selection && selection.trim()) {
			lines.push("", "Selected text:", "```", selection, "```");
		}
		lines.push("", `Preferred reasoning effort: ${settings.effort} (use minimal thinking for trivial asks, more for hard ones).`);
		return lines.join("\n");
	}
}

function rid(): string {
	return crypto.randomUUID();
}

function mapToolStatus(status: acp.ToolCallStatus | undefined): ToolStatus {
	switch (status) {
		case "completed":
			return "done";
		case "failed":
			return "failed";
		case "in_progress":
			return "running";
		default:
			return "pending";
	}
}

function locationText(toolCall: acp.ToolCallUpdate | undefined): string | null {
	const locations = toolCall?.locations ?? [];
	if (locations.length === 0) return null;
	return locations.map((l) => l.path).join(", ");
}

function shortName(name: string): string {
	return name.split(/\s+/)[0]?.toLowerCase() ?? name;
}

function cleanBaseUrl(value: string | undefined): string {
	return (value?.trim() || "http://127.0.0.1:11434").replace(/\/+$/, "");
}

function system(content: string): OllamaMessage {
	return { role: "system", content };
}

function user(content: string): OllamaMessage {
	return { role: "user", content };
}

function ollamaError(err: unknown): string {
	const message = (err as Error).message || String(err);
	return [
		"Cortex could not answer.",
		"",
		"Check that Ollama is running locally:",
		"`ollama serve`",
		"",
		"Check that the selected model is installed:",
		"`ollama list`",
		"`ollama pull llama3.2`",
		"",
		`Error: ${message}`,
	].join("\n");
}

function isEditCurrentNoteRequest(text: string): boolean {
	const t = text.toLowerCase();
	const hasEditVerb = /\b(edit|rewrite|revise|improve|polish|clean up|fix|clarify)\b/.test(t);
	const hasNoteTarget = /\b(note|file|markdown|active note|current note)\b/.test(t);
	const asksToSave = /\b(save|update|replace|write back|edit the active note)\b/.test(t);
	return hasEditVerb && (hasNoteTarget || asksToSave);
}

function cleanRevisedMarkdown(text: string): string {
	let out = text.trim();
	const fenced = out.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i);
	if (fenced?.[1]) out = fenced[1].trim();
	out = out.replace(/^Here is (?:the )?(?:revised|improved).*?:\s*/i, "").trim();
	return out.endsWith("\n") ? out : `${out}\n`;
}

function previewForApproval(markdown: string): string {
	const trimmed = markdown.trim();
	if (trimmed.length <= 1200) return trimmed;
	return `${trimmed.slice(0, 1200).trimEnd()}\n\n...preview truncated...`;
}
