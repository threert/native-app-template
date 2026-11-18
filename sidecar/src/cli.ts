// `scene`: the app's command line, for the coding agent working in scene/ (and for people). Talks to the running
// sidecar over HTTP (its port is in .build/server.json).
//
//   scene check [--no-types]    build + type-check the scene, have the app run it for a second; exit 1 on a problem
//   scene shot [file.png]       save what the view shows as a PNG (default .build/shots/…); prints the path
//                  [--window]   the whole window: the view with the app's panels over it
//   scene logs [-n 50]          the scene's recent console lines and runtime errors
//   scene state                 the build, the app, the agent (JSON)
//   scene send '<json>'         a host-channel message for the scene (`host.on(t, ...)` in scene code)
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SERVER_FILE } from "./paths.ts";

const [command = "help", ...args] = process.argv.slice(2);

function port(): number {
  try { return JSON.parse(readFileSync(SERVER_FILE, "utf8")).port; } catch {
    console.error("The app is not running (no sidecar): start it, then try again.");
    process.exit(2);
  }
}

async function call(path: string, body?: unknown): Promise<any> {
  const response = await fetch(`http://127.0.0.1:${port()}${path}`, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }).catch(() => {
    console.error("The app is not running (the sidecar did not answer): start it, then try again.");
    process.exit(2);
  });
  const json = await response.json();
  if (!response.ok) { console.error(json.error ?? response.statusText); process.exit(1); }
  return json;
}

const where = (p: { file?: string; line?: number; column?: number }) => p.file ? `${p.file}${p.line ? `:${p.line}${p.column ? `:${p.column}` : ""}` : ""} ` : "";

switch (command) {
  case "check": {
    const r = await call("/api/check", { types: !args.includes("--no-types") });
    if (!r.build.ok) {
      console.log(`✗ the scene does not build:`);
      for (const p of r.build.problems) console.log(`  ${where(p)}${p.message}`);
    } else console.log(`✓ built in ${r.build.ms} ms`);
    if (r.types) {
      if (r.types.length) { console.log(`✗ ${r.types.length} type error${r.types.length > 1 ? "s" : ""}:`); for (const p of r.types.slice(0, 30)) console.log(`  ${where(p)}${p.message}`); }
      else console.log("✓ types check");
    }
    if (r.build.ok) {
      if (r.app === "running") console.log("✓ the app runs this build");
      else if (r.app === "not connected") console.log("· the app is not open: not run (build and types only)");
      else console.log(`✗ the app did not run it (${r.app})`);
    }
    for (const e of r.errors) console.log(`✗ [${e.where}] ${e.message}`);
    for (const l of r.logs) console.log(`  console.${l.level}: ${l.text}`);
    if (r.stats) {
      const s = r.stats;
      const slow = s.scriptMs > 8 ? "  (the frame script is slow: it shares the render thread, keep it under a few ms)" : "";
      console.log(`· ${Math.round(s.fps)} fps, GPU ${Number(s.gpuMs).toFixed(1)} ms, frame script ${Number(s.scriptMs).toFixed(1)} ms${slow}`);
    }
    console.log(r.ok ? "OK" : "FAILED");
    process.exit(r.ok ? 0 : 1);
  }
  case "shot": {
    const file = args.find(a => !a.startsWith("-"));
    const r = args.includes("--window")
      ? await call("/api/app", { t: "app.shot", path: resolve(file ?? `shot-window-${Date.now()}.png`) })
      : await call("/api/shot", file ? { path: resolve(file) } : {});
    console.log(`${r.path} (${r.width}x${r.height})`);
    break;
  }
  case "logs": {
    const n = args.includes("-n") ? Number(args[args.indexOf("-n") + 1]) : 50;
    const r = await call(`/api/logs?n=${n}`);
    for (const l of r.logs) console.log(`${l.level.padEnd(5)} ${l.text}`);
    for (const e of r.errors) console.log(`error [${e.where}] ${e.message}`);
    break;
  }
  case "state": console.log(JSON.stringify(await call("/api/state"), null, 2)); break;
  case "send": {
    const text = args.join(" ");
    let message: unknown;
    try { message = JSON.parse(text); } catch { console.error("scene send takes a JSON message: scene send '{\"t\":\"my.message\"}'"); process.exit(1); }
    console.log(JSON.stringify(await call("/api/send", Array.isArray(message) ? { messages: message } : { message })));
    break;
  }
  default:
    console.log(readFileSync(import.meta.path, "utf8").split("\n").filter(l => l.startsWith("//")).map(l => l.slice(3)).join("\n"));
}
