// The sidecar's door: only requests with its token get in, and none from a web page.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const build = mkdtempSync(join(tmpdir(), "rt-app-server-"));
let server: import("../src/server.ts").Server;
let base = "";

beforeAll(async () => {
  const { Server } = await import("../src/server.ts");  // (its scene is the repository's; nothing here builds it)
  server = new Server();
  base = `http://127.0.0.1:${await server.listen(join(build, "server.json"))}`;
});
afterAll(() => rmSync(build, { recursive: true, force: true }));

describe("server", () => {
  test("writes its port and token for the command line, readable by the user only", () => {
    const file = join(build, "server.json");
    const written = JSON.parse(readFileSync(file, "utf8"));
    expect(written.token).toBe(server.token);
    expect(statSync(file).mode & 0o077).toBe(0);
  });
  test("refuses a request without the token, or with another", async () => {
    expect((await fetch(`${base}/api/state`)).status).toBe(403);
    expect((await fetch(`${base}/api/state`, { headers: { authorization: "Bearer nope" } })).status).toBe(403);
  });
  test("refuses a request from a web page, token or not", async () => {
    const headers = { authorization: `Bearer ${server.token}`, origin: "https://example.com" };
    expect((await fetch(`${base}/api/state`, { headers })).status).toBe(403);
  });
  test("answers the command line", async () => {
    const r = await fetch(`${base}/api/state`, { headers: { authorization: `Bearer ${server.token}` } });
    expect(r.status).toBe(200);
    expect((await r.json()).t).toBe("state");
  });
  test("passes only app.* requests to the app", async () => {
    const r = await fetch(`${base}/api/app`, { method: "POST", headers: { authorization: `Bearer ${server.token}` }, body: JSON.stringify({ t: "agent.permission" }) });
    expect(r.status).toBe(400);
  });
  test("lets the app's socket in with the token only", async () => {
    const opened = (url: string) => new Promise<boolean>(resolve => {
      const ws = new WebSocket(url);
      ws.onopen = () => { ws.close(); resolve(true); };
      ws.onerror = () => resolve(false);
    });
    expect(await opened(`${base.replace("http", "ws")}/app`)).toBe(false);
    expect(await opened(`${base.replace("http", "ws")}/app?token=${server.token}`)).toBe(true);
  });
});
