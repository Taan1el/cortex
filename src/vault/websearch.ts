import { requestUrl } from "obsidian";

export interface WebResult {
	title: string;
	url: string;
	snippet: string;
}

/**
 * Lightweight web search via DuckDuckGo's HTML endpoint. We use Obsidian's
 * requestUrl (no CORS limits) and parse the static HTML — no API key needed.
 * This is best-effort: if the markup shifts or the request fails, we return [].
 */
export async function webSearch(query: string, limit = 5): Promise<WebResult[]> {
	const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
	const res = await requestUrl({
		url,
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
		},
		body: `q=${encodeURIComponent(query)}`,
	});
	return parseDuckDuckGo(res.text, limit);
}

export function parseDuckDuckGo(html: string, limit: number): WebResult[] {
	const results: WebResult[] = [];
	// Each result lives in <a class="result__a" href="...">title</a> with a
	// sibling <a class="result__snippet">snippet</a>.
	const linkRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
	const snippetRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

	const snippets: string[] = [];
	let sm: RegExpExecArray | null;
	while ((sm = snippetRe.exec(html)) !== null) snippets.push(stripHtml(sm[1] ?? ""));

	let lm: RegExpExecArray | null;
	let i = 0;
	while ((lm = linkRe.exec(html)) !== null && results.length < limit) {
		const rawHref = lm[1] ?? "";
		const url = decodeDuckUrl(rawHref);
		const title = stripHtml(lm[2] ?? "");
		if (!url || !title) {
			i++;
			continue;
		}
		results.push({ title, url, snippet: snippets[i] ?? "" });
		i++;
	}
	return results;
}

/** DuckDuckGo wraps targets as /l/?uddg=<encoded>. Unwrap to the real URL. */
function decodeDuckUrl(href: string): string {
	try {
		const full = href.startsWith("http") ? href : `https://duckduckgo.com${href}`;
		const u = new URL(full);
		const target = u.searchParams.get("uddg");
		return target ? decodeURIComponent(target) : full;
	} catch {
		return href;
	}
}

function stripHtml(s: string): string {
	return s
		.replace(/<[^>]+>/g, "")
		.replace(/&amp;/g, "&")
		.replace(/&quot;/g, '"')
		.replace(/&#x27;/g, "'")
		.replace(/&#39;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Heuristic: does this message look like a factual lookup that benefits from
 * the web? We keep it conservative so casual chat doesn't trigger searches.
 */
export function looksLikeWebQuery(text: string): boolean {
	const t = text.toLowerCase().trim();
	if (t.length < 8) return false;
	// Explicit asks.
	if (/\b(search|google|look up|find online|latest|current|news|today|recent|price of|weather)\b/.test(t)) return true;
	// Questions about external facts (years, people, definitions) — but not about "my notes/vault".
	if (/\b(my notes?|my vault|this note|the note|current note)\b/.test(t)) return false;
	if (/^(who|what|when|where|which|how much|how many)\b/.test(t) && t.includes("?")) return true;
	return false;
}

export function formatWebContext(query: string, results: WebResult[]): string {
	const lines = [`Web search results for "${query}":`];
	results.forEach((r, idx) => {
		lines.push("", `${idx + 1}. ${r.title}`, `   ${r.url}`, r.snippet ? `   ${r.snippet}` : "");
	});
	lines.push("", "Use these to answer, and cite the source URLs you relied on.");
	return lines.join("\n");
}
