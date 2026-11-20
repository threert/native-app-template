// The scene's sources and builds: scene/ is watched, every change is bundled (bundle.ts) and the app is told to run
// the new bundle. What the app reports back (the bundle it runs, runtime errors, the scene's console) is kept here, so
// the coding agent's `scene check` can say whether its change built, type-checks and runs.
import { existsSync, readdirSync, rmSync, watch } from "node:fs";
import { join, relative } from "node:path";
import { bundleScene, type Problem } from "./bundle.ts";
import { BUILD, BUN, ENTRY, ROOT, SCENE } from "./paths.ts";

export type { Problem } from "./bundle.ts";

export interface Build {
  /** One more for every build, failed or not. */
  seq: number;
  ok: boolean;
  /** The bundle the app runs for this build (ok only). */
  bundle?: string;
  problems: Problem[];
  ms: number;
  at: number;
}

export interface LogLine { level: string; text: string; at: number }
export interface RuntimeError { where: string; message: string; at: number; seq?: number }

export interface SceneEvents {
  /** A build finished (the app runs `build.bundle` when it is ok). */
  built(build: Build): void;
  /** Files of scene/ changed on disk, relative to it. */
  files(paths: string[]): void;
}

/** The build number in a bundle's name (`.build/scene/scene-12.js`). */
const seqOf = (bundle: string): number | undefined => {
  const n = Number(/scene-(\d+)\.js$/.exec(bundle)?.[1]);
  return n || undefined;
};

const IGNORED = /(^|\/)(node_modules|\.git|\.DS_Store)(\/|$)/;

export class SceneBuilds {
  last: Build | undefined;
  /** The last build the app said it runs. */
  loaded = 0;
  errors: RuntimeError[] = [];
  logs: LogLine[] = [];
  private seq = 0;
  private running: Promise<Build> | undefined;
  private again = false;
  private waiters: { seq: number; resolve: (result: { loaded: boolean; error?: RuntimeError }) => void }[] = [];

  constructor(private readonly events: SceneEvents) {
    // Numbers go on from the bundles already there: a sidecar started again must not reuse one the app has run.
    const dir = join(BUILD, "scene");
    if (existsSync(dir)) for (const name of readdirSync(dir)) this.seq = Math.max(this.seq, seqOf(name) ?? 0);
  }

  /** Watches scene/ and builds on every change (debounced). */
  watch(): void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const changed = new Set<string>();
    watch(SCENE, { recursive: true }, (_event, name) => {
      if (!name || IGNORED.test(name)) return;
      changed.add(String(name));
      clearTimeout(timer);
      timer = setTimeout(() => {
        const paths = [...changed];
        changed.clear();
        this.events.files(paths);
        // Everything but notes is the scene: code, shaders, models, textures (setup loads them again on a reload).
        if (paths.some(path => !/\.(md|txt)$/i.test(path))) void this.build();
      }, 120);
    });
  }

  /** Builds now; a build asked for while one runs makes one more after it. Resolves with the newest build. */
  build(): Promise<Build> {
    if (this.running) {
      this.again = true;
      return this.running.then(() => this.running ?? this.last!);
    }
    this.running = (async () => {
      let build: Build;
      do {
        this.again = false;
        const seq = ++this.seq;
        const out = join(BUILD, "scene", `scene-${seq}.js`);
        const result = await bundleScene(ENTRY, out);
        build = result.ok
          ? { seq, ok: true, bundle: result.out, problems: [], ms: Math.round(result.ms), at: Date.now() }
          : { seq, ok: false, problems: result.problems.map(p => ({ ...p, file: p.file ? relative(SCENE, p.file) : undefined })), ms: Math.round(result.ms), at: Date.now() };
        this.last = build;
        this.prune(seq);
        this.events.built(build);
      } while (this.again);
      this.running = undefined;
      return build;
    })();
    return this.running;
  }

  /** Deletes old bundles: those before the one the app runs, keeping a few (the app may be loading one of them). */
  private prune(seq: number): void {
    const dir = join(BUILD, "scene");
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const n = seqOf(name);
      if (n && n < seq - 3 && n < this.loaded) rmSync(join(dir, name), { force: true });
    }
  }

  // ----- what the app reports (by bundle: the view answers for the newest of the builds it was sent) -----

  reloaded(bundle: string): void {
    const seq = seqOf(bundle);
    if (!seq) return;
    this.loaded = Math.max(this.loaded, seq);
    for (const w of this.waiters.filter(w => w.seq <= seq)) w.resolve({ loaded: true });
    this.waiters = this.waiters.filter(w => w.seq > seq);
  }

  error(error: RuntimeError & { bundle?: string }): void {
    if (error.bundle) { error.seq = seqOf(error.bundle); delete error.bundle; }
    this.errors.push(error);
    if (this.errors.length > 100) this.errors.splice(0, this.errors.length - 100);
    if (error.where === "reload" && error.seq !== undefined) {
      // (Builds before it that the view skipped for it failed with it.)
      const failed = error.seq;
      for (const w of this.waiters.filter(w => w.seq <= failed)) w.resolve({ loaded: false, error });
      this.waiters = this.waiters.filter(w => w.seq > failed);
    }
  }

  log(lines: LogLine[]): void {
    this.logs.push(...lines);
    if (this.logs.length > 500) this.logs.splice(0, this.logs.length - 500);
  }

  /** Resolves when the app runs build `seq` or says it could not (or after `ms`). */
  waitLoaded(seq: number, ms: number): Promise<{ loaded: boolean; error?: RuntimeError; timeout?: boolean }> {
    if (this.loaded >= seq) return Promise.resolve({ loaded: true });
    return new Promise(resolve => {
      const waiter = { seq, resolve: (r: { loaded: boolean; error?: RuntimeError }) => { clearTimeout(timer); resolve(r); } };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter(w => w !== waiter);
        resolve({ loaded: false, timeout: true });
      }, ms);
      this.waiters.push(waiter);
    });
  }

  /** The TypeScript compiler on the scene (scene/tsconfig.json). */
  async typecheck(): Promise<Problem[]> {
    const tsc = join(import.meta.dir, "../node_modules/typescript/bin/tsc");
    const child = Bun.spawn([BUN, tsc, "--noEmit", "--pretty", "false", "-p", join(SCENE, "tsconfig.json")], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    const [out] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    const problems: Problem[] = [];
    for (const line of out.split("\n")) {
      const m = /^(.+?)\((\d+),(\d+)\): error (TS\d+: .*)$/.exec(line.trim());
      if (m) problems.push({ file: relative(SCENE, join(ROOT, m[1]!)), line: Number(m[2]), column: Number(m[3]), message: m[4]! });
      else if (/error TS\d+/.test(line)) problems.push({ message: line.trim() });
    }
    return problems;
  }
}
