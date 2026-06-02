import { Decoration, type DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
import { StateEffect, StateField } from "@codemirror/state";
import { Prec } from "@codemirror/state";

import type { CortexSettings } from "../settings";

/** Provider Cortex hands to the editor: turn left-context into a continuation. */
export interface CompletionFn {
	(prefix: string, suffix: string, signal: AbortSignal): Promise<string>;
}

interface Suggestion {
	text: string;
	from: number;
}

const setSuggestion = StateEffect.define<Suggestion | null>();

const suggestionField = StateField.define<Suggestion | null>({
	create() {
		return null;
	},
	update(value, tr) {
		for (const e of tr.effects) {
			if (e.is(setSuggestion)) return e.value;
		}
		// Any document change invalidates a pending suggestion unless it set a new one.
		if (tr.docChanged) return null;
		return value;
	},
});

class GhostWidget extends WidgetType {
	constructor(private text: string) {
		super();
	}
	eq(other: GhostWidget): boolean {
		return other.text === this.text;
	}
	toDOM(): HTMLElement {
		const span = document.createElement("span");
		span.className = "cortex-ghost-text";
		// Render only the first line inline; show a hint if multi-line.
		const lines = this.text.split("\n");
		span.textContent = lines[0] ?? "";
		if (lines.length > 1) {
			const more = document.createElement("span");
			more.className = "cortex-ghost-more";
			more.textContent = " ⏎…";
			span.appendChild(more);
		}
		return span;
	}
}

const ghostDecorations = StateField.define<DecorationSet>({
	create() {
		return Decoration.none;
	},
	update(deco, tr) {
		const sug = tr.state.field(suggestionField);
		if (!sug || !sug.text) return Decoration.none;
		const widget = Decoration.widget({ widget: new GhostWidget(sug.text), side: 1 });
		return Decoration.set([widget.range(sug.from)]);
	},
	provide: (f) => EditorView.decorations.from(f),
});

/** Build the editor extension. `getSettings` and `complete` are injected by the plugin. */
export function cortexAutocomplete(getSettings: () => CortexSettings, complete: CompletionFn) {
	let timer: number | null = null;
	let abort: AbortController | null = null;

	const cancelPending = () => {
		if (timer != null) {
			window.clearTimeout(timer);
			timer = null;
		}
		abort?.abort();
		abort = null;
	};

	const requester = ViewPlugin.fromClass(
		class {
			constructor(private view: EditorView) {}

			update(u: ViewUpdate) {
				if (!u.docChanged && !u.selectionSet) return;
				const settings = getSettings();
				if (!settings.autocompleteEnabled) {
					cancelPending();
					return;
				}
				// Only react to user typing, not programmatic inserts (e.g. accepting).
				if (!u.docChanged) {
					if (u.selectionSet) this.clear();
					return;
				}
				this.schedule(settings.autocompleteDebounceMs);
			}

			private clear() {
				cancelPending();
				if (this.view.state.field(suggestionField)) {
					this.view.dispatch({ effects: setSuggestion.of(null) });
				}
			}

			private schedule(debounceMs: number) {
				cancelPending();
				timer = window.setTimeout(() => void this.run(), Math.max(150, debounceMs));
			}

			private async run() {
				const view = this.view;
				const pos = view.state.selection.main.head;
				if (view.state.selection.main.empty === false) return;
				const doc = view.state.doc;
				const prefix = doc.sliceString(Math.max(0, pos - 2000), pos);
				const suffix = doc.sliceString(pos, Math.min(doc.length, pos + 500));
				// Don't fire mid-word with no whitespace context, or on empty docs.
				if (!prefix.trim()) return;
				abort = new AbortController();
				try {
					const completion = await complete(prefix, suffix, abort.signal);
					const clean = trimCompletion(completion);
					if (!clean) return;
					// Position may have moved; only show if cursor is still at pos.
					if (view.state.selection.main.head !== pos) return;
					view.dispatch({ effects: setSuggestion.of({ text: clean, from: pos }) });
				} catch {
					/* aborted or provider error — stay silent inline */
				}
			}

			destroy() {
				cancelPending();
			}
		},
	);

	// Tab accepts the suggestion, Escape dismisses it. High precedence so we win over defaults.
	const keymap = Prec.highest(
		EditorView.domEventHandlers({
			keydown: (event, view) => {
				const sug = view.state.field(suggestionField, false);
				if (!sug || !sug.text) return false;
				if (event.key === "Tab") {
					event.preventDefault();
					view.dispatch({
						changes: { from: sug.from, insert: sug.text },
						selection: { anchor: sug.from + sug.text.length },
						effects: setSuggestion.of(null),
					});
					return true;
				}
				if (event.key === "Escape") {
					event.preventDefault();
					view.dispatch({ effects: setSuggestion.of(null) });
					return true;
				}
				return false;
			},
		}),
	);

	return [suggestionField, ghostDecorations, requester, keymap];
}

function trimCompletion(text: string): string {
	let out = text.replace(/^```[a-z]*\n?/i, "").replace(/```$/i, "");
	// Models sometimes echo a leading space or quote the continuation; keep it lean.
	out = out.replace(/^\s*\n/, "");
	// Cap to a sentence/few lines so ghost text stays unobtrusive.
	const lines = out.split("\n").slice(0, 4).join("\n");
	return lines.trimEnd();
}
