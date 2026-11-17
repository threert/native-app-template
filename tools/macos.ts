// Builds the app: the Rust core (the engine inside), the Xcode project (xcodegen) and the app itself.
//   bun tools/macos.ts [--run] [--no-core] [--debug]
// Needs: Rust (rustup; the engine pins its toolchain), Xcode 16+, xcodegen (brew install xcodegen), Bun.
import { $ } from "bun";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
if (!existsSync(join(root, "engine/renderer/Cargo.toml"))) {
  console.error("engine/ is empty: run `git submodule update --init` first");
  process.exit(1);
}
if (!existsSync(join(root, "sidecar/node_modules"))) await $`bun install`.cwd(join(root, "sidecar"));
if (!args.includes("--no-core")) {
  console.log("core: cargo build --release (the first build takes a few minutes)");
  await $`cargo build --release`.cwd(join(root, "core")).env({ ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` });
}
await $`xcodegen generate --quiet`.cwd(join(root, "macos"));
const configuration = args.includes("--debug") ? "Debug" : "Release";
const build = await $`xcodebuild -project ThreeRTApp.xcodeproj -scheme ThreeRTApp -configuration ${configuration} -derivedDataPath ${join(root, ".build/xcode")} build`
  .cwd(join(root, "macos")).quiet().nothrow();
if (build.exitCode !== 0) {
  const text = build.stdout.toString() + build.stderr.toString();
  console.error(text.split("\n").filter(line => /error:|BUILD FAILED/.test(line)).slice(0, 40).join("\n"));
  process.exit(1);
}
const app = join(root, `.build/xcode/Build/Products/${configuration}/ThreeRT App.app`);
console.log(app);
if (args.includes("--run")) await $`open -n ${app}`;
