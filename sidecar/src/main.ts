// The sidecar: builds the scene on every change, bridges the coding agent, and serves the `scene` command line.
// The app starts it (`bun sidecar/src/main.ts --with-parent`), reads `{"port": N}` from its first line of output and
// connects to ws://127.0.0.1:N/app. `--with-parent`: the sidecar ends when its stdin closes (the app is gone).
import { installAgent, installCli } from "./agent/index.ts";
import { Server } from "./server.ts";

const server = new Server();
const port = await server.listen();
installCli();
installAgent(server);
await server.scene.build();
server.scene.watch();
console.log(JSON.stringify({ port }));

if (process.argv.includes("--with-parent")) {
  process.stdin.on("end", () => process.exit(0));
  process.stdin.on("close", () => process.exit(0));
  process.stdin.resume();
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => process.exit(0));
