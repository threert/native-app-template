// The coding agent's bridge: the app's chat panel on one side, Claude Code or Codex as an ACP agent
// (https://agentclientprotocol.com) on the other, working in scene/.
//
//   app → sidecar   agent.select {agent}  agent.prompt {text}  agent.cancel {}
//                   agent.permission {id, optionId}  agent.new {}  agent.history {}
//   sidecar → app   state.agent  agent.item {item}  agent.delta {id, text}
//                   agent.turn {turn, status, stopReason?, ms?}  agent.history {items}
//
// There is one session for each agent. The messages carry the selected agent's session; the other one keeps its
// transcript, and `agent.history` is sent again when the selection changes.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUN, ENGINE, ROOT } from "../paths.ts";
import { AGENTS, cliBin, type AgentSpec } from "./adapters.ts";
import { makeScope } from "./policy.ts";
import { AgentSession } from "./session.ts";
import type { AgentHost, AgentId, AgentInfo, AgentState } from "./types.ts";

export type { AgentHost, AgentId, AgentInfo, AgentState, AgentStatus, Item } from "./types.ts";

export interface BridgeOptions {
  agents?: Record<AgentId, AgentSpec>;
  /** Folders outside the scene the agent may read (the engine's sources and docs). */
  readAlso?: string[];
}

const IDS: AgentId[] = ["claude", "codex"];

export class AgentBridge {
  selected: AgentId = "claude";
  private chosen = false;
  private readonly agents: Record<AgentId, AgentSpec>;
  private readonly readAlso: string[];
  private infos: Record<AgentId, AgentInfo>;
  private sessions = new Map<AgentId, AgentSession>();
  private detecting: Promise<void>;

  constructor(private readonly host: AgentHost, options: BridgeOptions = {}) {
    this.agents = options.agents ?? AGENTS;
    this.readAlso = options.readAlso ?? [ENGINE];
    this.infos = Object.fromEntries(IDS.map(id => [id, { id, name: this.agents[id].name, installed: false }])) as Record<AgentId, AgentInfo>;
    host.stateParts.push(() => ({ agent: this.state() }));
    host.on("agent.select", message => this.select(message.agent));
    host.on("agent.prompt", (message, reply) => this.prompt(String(message.text ?? ""), reply));
    host.on("agent.cancel", () => this.session()?.cancel());
    host.on("agent.permission", (message, reply) => {
      if (!this.session()?.answer(String(message.id), String(message.optionId))) reply({ t: "error", message: `no open permission ${String(message.id)} with option ${String(message.optionId)}` });
    });
    host.on("agent.new", () => this.fresh());
    host.on("agent.history", (_message, reply) => reply(this.history()));
    this.detecting = this.detect();
  }

  /** Looks for the agents' command-line tools; the state follows. */
  async detect(): Promise<void> {
    await Promise.all(IDS.map(async id => {
      try { this.infos[id] = await this.agents[id].detect(); } catch (error) { this.infos[id] = { id, name: this.agents[id].name, installed: false, note: String(error instanceof Error ? error.message : error) }; }
    }));
    if (!this.chosen && !this.infos.claude.installed && this.infos.codex.installed) this.selected = "codex";
    this.host.stateChanged();
  }

  state(): AgentState {
    const session = this.session();
    return {
      selected: this.selected, agents: IDS.map(id => this.infos[id]), status: session?.status ?? "idle",
      ...(session?.error ? { error: session.error } : {}), turn: session?.turn ?? 0,
    };
  }

  private session(): AgentSession | undefined { return this.sessions.get(this.selected); }
  private history() { return { t: "agent.history", items: this.session()?.transcript.items ?? [] }; }

  private open(id: AgentId): AgentSession {
    const known = this.sessions.get(id);
    if (known) return known;
    // The agent may write the scene, read the scene, the engine and the repository, and run `scene ...`.
    const scope = makeScope(this.host.project, ROOT, this.readAlso, join(cliBin(), "scene"));
    const mine = () => this.sessions.get(id) === session && this.selected === id;
    const session: AgentSession = new AgentSession(this.agents[id], scope, {
      item: item => { if (mine()) this.host.broadcast({ t: "agent.item", item }); },
      delta: (itemId, text) => { if (mine()) this.host.broadcast({ t: "agent.delta", id: itemId, text }); },
      turn: (turn, status, stopReason, ms) => {
        if (mine()) this.host.broadcast({ t: "agent.turn", turn, status, ...(stopReason !== undefined ? { stopReason } : {}), ...(ms !== undefined ? { ms } : {}) });
      },
      changed: () => { if (mine()) this.host.stateChanged(); },
    });
    this.sessions.set(id, session);
    return session;
  }

  private select(agent: unknown): void {
    if (agent !== "claude" && agent !== "codex") throw new Error(`no agent ${String(agent)}`);
    this.chosen = true;
    if (agent === this.selected) return;
    this.selected = agent;
    this.host.stateChanged();
    this.host.broadcast(this.history());
  }

  private async prompt(text: string, reply: (message: Record<string, unknown>) => void): Promise<void> {
    if (!text.trim()) { reply({ t: "error", message: "The prompt is empty" }); return; }
    await this.detecting;
    if (!this.infos[this.selected].installed) { reply({ t: "error", message: this.infos[this.selected].note ?? `${this.agents[this.selected].name} is not installed` }); return; }
    const session = this.open(this.selected);
    if (session.busy) { reply({ t: "error", message: `${session.spec.name} is still working: cancel the turn or wait for it` }); return; }
    // The turn reports through the events; the message is answered at once.
    void session.prompt(text, preamble(this.host)).catch(error => console.error("agent:", error));
  }

  /** `agent.new`: the selected agent starts over with an empty transcript. */
  private fresh(): void {
    const session = this.sessions.get(this.selected);
    this.sessions.delete(this.selected);
    session?.dispose();
    this.host.stateChanged();
    this.host.broadcast(this.history());
  }

  /** Ends every session and its process. */
  dispose(): void {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    for (const session of sessions) session.dispose();
  }
}

/** The block in front of every prompt: where the agent is and how the scene is doing. The guide is scene/AGENTS.md. */
function preamble(host: AgentHost): string {
  const lines = [
    `You are editing a ThreeRT scene in ${host.project} (your working directory), shown live in the app beside you: every saved file is rebuilt and reloaded within a second.`,
    host.context(),
    "On your first turn read AGENTS.md in this folder. Finish every change by running `scene check` and fix what it reports; `scene shot` saves what the view shows as a PNG you can look at.",
  ].filter(Boolean);
  return `<app>\n${lines.join("\n")}\n</app>\n\n`;
}

/** Registers the bridge on the server. The agents' processes end with the sidecar. */
export function installAgent(host: AgentHost, options: BridgeOptions = {}): AgentBridge {
  const bridge = new AgentBridge(host, options);
  process.on("exit", () => bridge.dispose());
  return bridge;
}

const quoted = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

/** Writes the `scene` launcher into .build/bin, the first folder of the agents' PATH. Returns its path. */
export function installCli(): string {
  const dir = cliBin(), path = join(dir, "scene");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, `#!/bin/sh
# The app's command line for the coding agent (scene/AGENTS.md). Written by the sidecar when it starts.
RT_APP_ROOT=${quoted(ROOT)} exec ${quoted(BUN)} ${quoted(join(import.meta.dir, "../cli.ts"))} "$@"
`);
  chmodSync(path, 0o755);
  return path;
}
