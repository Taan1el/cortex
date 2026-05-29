// Obsidian's requestUrl() buffers the whole response and cannot stream tokens.
// Cloud chat needs incremental deltas, so the streaming paths use fetch() and
// read the body as it arrives. Non-streaming calls elsewhere still use requestUrl.

export interface StreamRequest {
	url: string;
	headers: Record<string, string>;
	body: unknown;
	signal: AbortSignal;
}

export async function openStream(req: StreamRequest): Promise<Response> {
	const res = await fetch(req.url, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...req.headers },
		body: JSON.stringify(req.body),
		signal: req.signal,
	});
	if (!res.ok || !res.body) {
		const detail = await safeBody(res);
		throw new Error(`HTTP ${res.status} ${res.statusText}${detail ? `: ${detail}` : ""}`);
	}
	return res;
}

export async function* readLines(res: Response): AsyncGenerator<string> {
	const reader = res.body!.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let nl: number;
			while ((nl = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, nl).replace(/\r$/, "");
				buffer = buffer.slice(nl + 1);
				if (line) yield line;
			}
		}
		const tail = buffer.trim();
		if (tail) yield tail;
	} finally {
		reader.releaseLock();
	}
}

export async function* readSse(res: Response): AsyncGenerator<string> {
	for await (const line of readLines(res)) {
		if (line.startsWith("data:")) {
			yield line.slice(5).trim();
		}
	}
}

async function safeBody(res: Response): Promise<string> {
	try {
		const text = await res.text();
		return text.slice(0, 500);
	} catch {
		return "";
	}
}
