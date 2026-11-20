// The sidecar: builds the scene on every change, bridges the coding agent, and serves the `scene` command line.
// The app starts it (`bun sidecar/src/main.ts --with-parent`), reads `{"port": N, "token": T}` from its first line of
// output and connects to ws://127.0.0.1:N/app?token=T. `--with-parent`: the sidecar ends when its stdin closes (the
// app is gone). Started by hand, the app connects to it with RT_APP_SIDECAR set to that URL.
import { installAgent, installCli } from "./agent/index.ts";
import { Server } from "./server.ts";

const server = new Server();
const port = await server.listen();
installCli();
installAgent(server);
await server.scene.build();
server.scene.watch();
console.log(JSON.stringify({ port, token: server.token }));

if (process.argv.includes("--with-parent")) {
  process.stdin.on("end", () => process.exit(0));
  process.stdin.on("close", () => process.exit(0));
  process.stdin.resume();
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => process.exit(0));
