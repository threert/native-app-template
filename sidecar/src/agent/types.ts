// What the coding agent's bridge says to the app. The chat panel (macos/App/AgentPanel.swift) is written against these
// shapes.
export type AgentId = "claude" | "codex";
export type AgentStatus = "idle" | "starting" | "working" | "waiting" | "error";
export type ItemKind = "user" | "text" | "thought" | "tool" | "plan" | "permission" | "notice" | "error";
export type ToolKind = "read" | "edit" | "execute" | "search" | "fetch" | "think" | "other";
export type ItemStatus = "pending" | "running" | "done" | "failed";

/** One entry of the transcript. `agent.item` upserts it by `id`. */
export interface Item {
  /** Unique in its session; items keep the order of their first appearance. */
  id: string;
  turn: number;
  kind: ItemKind;
  text?: string;
  title?: string;
  toolKind?: ToolKind;
  status?: ItemStatus;
  /** Relative to the scene folder, for a tool that works on one file. */
  path?: string;
  diff?: { path: string; added: number; removed: number };
  /** The choices of a permission item. */
  options?: { id: string; label: string; kind: string }[];
  /** The steps of a plan item. */
  entries?: { text: string; status: string }[];
  done?: boolean;
}

export interface AgentInfo { id: AgentId; name: string; installed: boolean; version?: string; note?: string }

/** The `agent` part of the `state` message. */
export interface AgentState {
  selected: AgentId;
  agents: AgentInfo[];
  status: AgentStatus;
  error?: string;
  turn: number;
}

type Json = Record<string, unknown>;
export type Handler = (message: Json, reply: (message: Json) => void) => void | Promise<void>;

/** The part of the sidecar's server the bridge uses (`Server` has all of it). */
export interface AgentHost {
  /** The folder the agent works in. */
  readonly project: string;
  /** A few lines about the scene right now (its last build, its runtime errors), put in front of every prompt. */
  context(): string;
  readonly stateParts: (() => Json)[];
  on(type: string, handler: Handler): void;
  broadcast(message: Json): void;
  stateChanged(): void;
}
