// The sidecar's door: one HTTP and WebSocket server on the loopback. Every request carries the token the sidecar made
// at start (the app gets it with the port on the sidecar's first line of output, the `scene` command line from
// .build/server.json); a request from a web page (it has an Origin) is refused: the agent runs commands as the user.
//
//   WS   /app?token=…                 the app: JSON messages both ways (the table in docs/ARCHITECTURE.md)
//   GET  /api/state | /api/logs       POST /api/check | /api/shot | /api/send | /api/app     the `scene` command line
//        (header `Authorization: Bearer <token>`)
import type { ServerWebSocket } from "bun";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Handler } from "./agent/types.ts";
import { APP_FILE, BUILD, SCENE, SERVER_FILE } from "./paths.ts";
import { SceneBuilds, type Build, type LogLine, type Problem } from "./scene.ts";

type Json = Record<string, unknown>;
type Socket = ServerWebSocket<{ role: string }>;

export interface CheckReport {
  ok: boolean;
  build: { ok: boolean; problems: Problem[]; ms: number };
  types?: Problem[];
  app: "running" | "failed" | "not connected" | "timeout";
  errors: { where: string; message: string }[];
  logs: LogLine[];
  /** The view's statistics after the check's second of frames. */
  stats?: Json | null;
}

/** scene/app.json's "panel": the agent panel's words for this app (title, intro, placeholder, suggestions). */
function panelText(): Json {
  try { return JSON.parse(readFileSync(APP_FILE, "utf8")).panel ?? {}; } catch { return {}; }
}

export class Server {
  readonly project = SCENE;
  /** What every request must carry. */
  readonly token = randomBytes(24).toString("hex");
  readonly scene: SceneBuilds;
  readonly handlers = new Map<string, Handler>();
  readonly stateParts: (() => Json)[] = [];
  private readonly sockets = new Set<Socket>();
  private server!: ReturnType<typeof Bun.serve>;
  private stateTimer: ReturnType<typeof setTimeout> | undefined;
  private pending = new Map<number, (answer: Json) => void>();
  private nextRequest = 1;
  /** The view's last statistics (once a second): fps, gpuMs, scriptMs, scale, spp, bounces, width, height. */
  stats: Json | null = null;

  constructor() {
    this.scene = new SceneBuilds({
      built: build => {
        if (build.ok) this.broadcast({ t: "scene.built", seq: build.seq, bundle: build.bundle });
        this.stateChanged();
      },
      files: paths => {
        this.broadcast({ t: "scene.files", paths });
        if (paths.includes("app.json")) this.stateChanged();
      },
    });
    this.stateParts.push(() => ({ scene: { build: this.buildState(this.scene.last), loaded: this.scene.loaded } }));
    this.stateParts.push(() => ({ panel: panelText() }));
    this.on("runtime.reloaded", m => { this.scene.reloaded(String(m.bundle ?? "")); this.stateChanged(); });
    this.on("runtime.error", m => this.scene.error({ where: String(m.where ?? "?"), message: String(m.message ?? ""), at: Date.now(), ...(m.bundle ? { bundle: String(m.bundle) } : {}) }));
    this.on("runtime.logs", m => this.scene.log(((m.lines as Json[]) ?? []).map(l => ({ level: String(l.level ?? "log"), text: String(l.text ?? ""), at: Date.now() }))));
    this.on("runtime.stats", m => { this.stats = (m.stats as Json) ?? null; });
    this.on("answer", m => { const done = this.pending.get(Number(m.id)); if (done) { this.pending.delete(Number(m.id)); done(m); } });
    this.on("scene.build", async () => { await this.scene.build(); });
  }

  /** The parts of the build the app shows. */
  private buildState(build: Build | undefined): Json | null {
    return build ? { seq: build.seq, ok: build.ok, bundle: build.bundle ?? null, problems: build.problems, ms: build.ms } : null;
  }

  on(type: string, handler: Handler): void { this.handlers.set(type, handler); }

  /** A few lines about the scene for the agent's prompt. */
  context(): string {
    const lines: string[] = [];
    const build = this.scene.last;
    if (build && !build.ok) lines.push(`The last build failed:\n${build.problems.slice(0, 5).map(p => `  ${p.file ?? ""}${p.line ? `:${p.line}` : ""} ${p.message}`).join("\n")}`);
    const recent = this.scene.errors.filter(e => Date.now() - e.at < 120_000).slice(-3);
    if (recent.length) lines.push(`Recent runtime errors:\n${recent.map(e => `  [${e.where}] ${e.message.split("\n")[0]}`).join("\n")}`);
    return lines.join("\n");
  }

  state(): Json {
    return Object.assign({ t: "state" }, ...this.stateParts.map(part => part()));
  }

  stateChanged(): void {
    clearTimeout(this.stateTimer);
    this.stateTimer = setTimeout(() => this.broadcast(this.state()), 30);
  }

  broadcast(message: Json): void {
    const text = JSON.stringify(message);
    for (const socket of this.sockets) socket.send(text);
  }

  get appConnected(): boolean { return this.sockets.size > 0; }

  /** A request for the app; resolves with its answer, or null after `ms`. */
  ask(message: Json, ms = 20_000): Promise<Json | null> {
    if (!this.appConnected) return Promise.resolve(null);
    const id = this.nextRequest++;
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve(null); }, ms);
      this.pending.set(id, answer => { clearTimeout(timer); resolve(answer); });
      this.broadcast({ ...message, id });
    });
  }

  private async handle(message: Json, reply: (m: Json) => void): Promise<void> {
    const handler = this.handlers.get(String(message.t));
    if (!handler) { reply({ t: "error", message: `unknown message ${String(message.t)}` }); return; }
    try { await handler(message, reply); } catch (error) { reply({ t: "error", message: String(error instanceof Error ? error.message : error) }); }
  }

  /** `scene check`: builds, type-checks, and has the app run the build for a moment. */
  async check(options: { types?: boolean } = {}): Promise<CheckReport> {
    const build = await this.scene.build();
    const report: CheckReport = { ok: false, build: { ok: build.ok, problems: build.problems, ms: build.ms }, app: "not connected", errors: [], logs: [] };
    const types = options.types === false ? Promise.resolve(undefined) : this.scene.typecheck();
    if (build.ok && this.appConnected) {
      const since = Date.now();
      const loaded = await this.scene.waitLoaded(build.seq, 20_000);
      if (loaded.loaded) {
        // A second of frames: what the scene's setup and frame script throw shows up here.
        await new Promise(done => setTimeout(done, 1200));
        report.app = "running";
      } else report.app = loaded.timeout ? "timeout" : "failed";
      report.errors = this.scene.errors.filter(e => e.at >= since).map(({ where, message }) => ({ where, message }));
      report.logs = this.scene.logs.filter(l => l.at >= since && /error|warn/.test(l.level)).slice(-20);
    }
    report.types = await types;
    report.stats = this.stats;
    report.ok = build.ok && !(report.types?.length) && report.errors.length === 0 && (report.app === "running" || report.app === "not connected");
    return report;
  }

  /** Listens on the loopback; `file` gets the port and the token for the command line. */
  async listen(file = SERVER_FILE): Promise<number> {
    this.server = Bun.serve<{ role: string }, never>({
      hostname: "127.0.0.1",
      port: Number(process.env.RT_APP_PORT ?? 0),
      fetch: async (request, server) => {
        const url = new URL(request.url);
        if (request.headers.has("origin")) return new Response("forbidden", { status: 403 });
        const token = url.searchParams.get("token") ?? request.headers.get("authorization")?.replace(/^Bearer /, "");
        if (token !== this.token) return new Response("forbidden", { status: 403 });
        if (url.pathname === "/app") {
          return server.upgrade(request, { data: { role: "app" } }) ? undefined : new Response("upgrade failed", { status: 400 });
        }
        try { return await this.api(url, request); } catch (error) {
          return Response.json({ error: String(error instanceof Error ? error.message : error) }, { status: 500 });
        }
      },
      websocket: {
        open: socket => { this.sockets.add(socket); socket.send(JSON.stringify(this.state())); },
        close: socket => { this.sockets.delete(socket); },
        message: (socket, data) => {
          let message: Json;
          try { message = JSON.parse(String(data)); } catch { return; }
          void this.handle(message, reply => socket.send(JSON.stringify(reply)));
        },
      },
    });
    const port = this.server.port!;
    mkdirSync(dirname(file), { recursive: true });
    rmSync(file, { force: true });  // (made anew: `mode` applies to a new file only)
    writeFileSync(file, JSON.stringify({ port, pid: process.pid, token: this.token }) + "\n", { mode: 0o600 });
    return port;
  }

  private async api(url: URL, request: Request): Promise<Response> {
    let body: Json = {};
    if (request.method === "POST") {
      const text = await request.text();
      try { body = text.trim() ? JSON.parse(text) : {}; } catch { return Response.json({ error: `the body is not JSON: ${text.slice(0, 200)}` }, { status: 400 }); }
    }
    switch (url.pathname) {
      case "/api/state": return Response.json({ ...this.state(), app: this.appConnected, stats: this.stats });
      case "/api/check": return Response.json(await this.check({ types: body.types !== false }));
      case "/api/logs": return Response.json({ logs: this.scene.logs.slice(-Number(url.searchParams.get("n") ?? 50)), errors: this.scene.errors.slice(-10) });
      case "/api/shot": {
        const path = typeof body.path === "string" ? body.path : join(BUILD, "shots", `shot-${Date.now()}.png`);
        mkdirSync(dirname(path), { recursive: true });
        const answer = await this.ask({ t: "app.snapshot", path, wait: Number(body.wait ?? 1) });
        return answer ? Response.json(answer) : Response.json({ error: "the app is not running (or did not answer)" }, { status: 503 });
      }
      case "/api/send": {
        if (!this.appConnected) return Response.json({ error: "the app is not running" }, { status: 503 });
        const messages = Array.isArray(body.messages) ? body.messages : [body.message ?? body];
        this.broadcast({ t: "app.send", messages });
        return Response.json({ sent: messages.length });
      }
      case "/api/app": {
        if (typeof body.t !== "string" || !body.t.startsWith("app.")) return Response.json({ error: "a request for the app needs a type: {\"t\": \"app.…\", ...}" }, { status: 400 });
        // A request for the app (tests drive the window with them: `scene app`, Model.swift's "for tests" section).
        const answer = await this.ask(body);
        return answer ? Response.json(answer) : Response.json({ error: "the app is not running (or did not answer)" }, { status: 503 });
      }
      default: return new Response("not found", { status: 404 });
    }
  }
}
