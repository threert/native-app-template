// Where things are: the one place the sidecar, the `scene` command line and tools/ take paths from. The app starts the
// sidecar with RT_APP_ROOT set to the repository (or the app's resources).
import { join, resolve } from "node:path";

export const ROOT = process.env.RT_APP_ROOT ?? resolve(import.meta.dir, "../..");
/** The scene's sources: what the coding agent works on (its working directory and the only folder it may write). */
export const SCENE = join(ROOT, "scene");
/** The scene's entry (the app, `scene check` and tools/still.ts build this file and what it imports). */
export const ENTRY = join(SCENE, "main.game.ts");
/** The app's own words (the agent panel's title, intro, placeholder and suggestions): a fork changes them here. */
export const APP_FILE = join(SCENE, "app.json");
export const ENGINE = join(ROOT, "engine");
/** Build products, the agents' adapters and the `scene` launcher (gitignored). */
export const BUILD = process.env.RT_APP_BUILD ?? join(ROOT, ".build");
export const BIN = join(BUILD, "bin");
/** Where the sidecar listens and its token (`{port, pid, token}`, readable by the user only), for the `scene`
 *  command line. */
export const SERVER_FILE = join(BUILD, "server.json");
/** The Bun that runs the sidecar: it also runs the agents' adapters and the command line. */
export const BUN = process.execPath;
