// Core shared types for Cortex. Authored for this project.

export type ConnectionStatus =
	| { kind: "idle" }
	| { kind: "connecting" }
	| { kind: "ready"; sessionId: string }
	| { kind: "error"; message: string };

/** A single rendered item in the conversation stream. */
export type PanelItem =
	| { kind: "message"; id: string; from: "user" | "assistant" | "thinking"; text: string }
	| {
			kind: "tool";
			id: string;
			callId: string;
			title: string;
			status: ToolStatus;
			locations: string[];
	  }
	| {
			kind: "ask";
			id: string;
			title: string;
			detail: string | null;
			options: AskOption[];
			decision: string | null;
	  };

export type ToolStatus = "pending" | "running" | "done" | "failed";

export interface AskOption {
	id: string;
	label: string;
	primary: boolean;
}

/** Snapshot of everything the view needs to render. */
export interface EngineState {
	status: ConnectionStatus;
	items: PanelItem[];
	busy: boolean;
	model: string | null;
}
