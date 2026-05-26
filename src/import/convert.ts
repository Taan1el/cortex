// Converts a ChatGPT data export (conversations.json) into Obsidian notes.
// Pure logic — no Obsidian dependencies — so it stays easy to test.

export interface ConvertedNote {
	filename: string;
	content: string;
}

interface ChatMessage {
	author?: { role?: string };
	content?: {
		content_type?: string;
		parts?: unknown[];
		text?: string;
		language?: string;
		result?: string;
	};
	create_time?: number | null;
	metadata?: { is_visually_hidden_from_conversation?: boolean; model_slug?: string };
}

interface MappingNode {
	message?: ChatMessage | null;
	parent?: string | null;
}

interface Conversation {
	title?: string;
	create_time?: number | null;
	update_time?: number | null;
	id?: string;
	current_node?: string | null;
	mapping?: Record<string, MappingNode>;
}

export function convertChatGptExport(raw: unknown): ConvertedNote[] {
	const conversations = pickConversations(raw);
	if (!conversations) {
		throw new Error("That doesn't look like a ChatGPT export (expected an array of conversations).");
	}

	const used = new Set<string>();
	const notes: ConvertedNote[] = [];

	for (const convo of conversations) {
		const messages = activeBranch(convo).filter(isVisible);
		if (messages.length === 0) continue;

		const created = convo.create_time ?? null;
		const updated = convo.update_time ?? null;
		const title = convo.title?.trim() || "Untitled";
		const model = messages.find((m) => m.author?.role === "assistant")?.metadata?.model_slug ?? "";

		const frontmatter = [
			"---",
			`title: ${yaml(title)}`,
			"source: ChatGPT",
			created ? `created: ${ymd(created)}` : null,
			updated ? `updated: ${ymd(updated)}` : null,
			model ? `model: ${yaml(model)}` : null,
			convo.id ? `chatgpt_id: ${yaml(convo.id)}` : null,
			"tags: [chatgpt]",
			"---",
			"",
		].filter((x): x is string => x !== null).join("\n");

		const body: string[] = [`# ${title}`, ""];
		for (const m of messages) {
			const text = extract(m);
			if (!text.trim()) continue;
			const who = m.author?.role === "user" ? "You" : "ChatGPT";
			const when = ymdhm(m.create_time ?? null);
			body.push(`> **${who}**${when ? ` · ${when}` : ""}`, "", text, "");
		}
		const content = frontmatter + "\n" + body.join("\n").trim() + "\n";

		const stem = `${created ? ymd(created) + " " : ""}${safeName(title)}`;
		let name = stem;
		let n = 2;
		while (used.has(name.toLowerCase())) name = `${stem} (${n++})`;
		used.add(name.toLowerCase());

		notes.push({ filename: `${name}.md`, content });
	}

	return notes;
}

function pickConversations(raw: unknown): Conversation[] | null {
	if (Array.isArray(raw)) return raw as Conversation[];
	const wrapped = (raw as { conversations?: unknown })?.conversations;
	return Array.isArray(wrapped) ? (wrapped as Conversation[]) : null;
}

/** Follow current_node up the parent chain — the answers the user actually kept. */
function activeBranch(convo: Conversation): ChatMessage[] {
	const mapping = convo.mapping ?? {};
	const out: ChatMessage[] = [];
	let id = convo.current_node ?? null;
	const seen = new Set<string>();
	while (id && !seen.has(id)) {
		const node = mapping[id];
		if (!node) break;
		seen.add(id);
		if (node.message) out.push(node.message);
		id = node.parent ?? null;
	}
	out.reverse();
	return out;
}

function isVisible(m: ChatMessage): boolean {
	const role = m?.author?.role;
	if (role !== "user" && role !== "assistant") return false;
	if (m.metadata?.is_visually_hidden_from_conversation) return false;
	return true;
}

function extract(m: ChatMessage): string {
	const c = m?.content;
	if (!c) return "";
	const type = c.content_type;
	if (type === "text") {
		return (c.parts ?? []).filter((p): p is string => typeof p === "string").join("\n").trim();
	}
	if (type === "multimodal_text") {
		const out: string[] = [];
		for (const p of c.parts ?? []) {
			if (typeof p === "string") out.push(p);
			else if (p && typeof p === "object") out.push("`[" + ((p as { content_type?: string }).content_type ?? "attachment") + "]`");
		}
		return out.join("\n").trim();
	}
	if (type === "code") {
		const lang = c.language && c.language !== "unknown" ? c.language : "";
		return "```" + lang + "\n" + (c.text ?? "") + "\n```";
	}
	if (type === "execution_output") return "```\n" + (c.text ?? "") + "\n```";
	if (type === "tether_quote" || type === "tether_browsing_display") {
		const t = c.text ?? c.result ?? "";
		return t ? "> " + String(t).replace(/\n/g, "\n> ") : "";
	}
	if (Array.isArray(c.parts)) return c.parts.filter((p): p is string => typeof p === "string").join("\n").trim();
	if (typeof c.text === "string") return c.text.trim();
	return "";
}

function ymd(ts: number): string {
	return new Date(ts * 1000).toISOString().slice(0, 10);
}
function ymdhm(ts: number | null): string {
	if (!ts) return "";
	return new Date(ts * 1000).toISOString().slice(0, 16).replace("T", " ");
}
function safeName(name: string): string {
	const cleaned = (name || "Untitled").replace(/[<>:"/\\|?*]/g, "").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "").slice(0, 100);
	return cleaned || "Untitled";
}
function yaml(s: string): string {
	return JSON.stringify(String(s ?? ""));
}
