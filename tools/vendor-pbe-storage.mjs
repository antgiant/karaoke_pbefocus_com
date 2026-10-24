// Copies a pinned build of the shared pbefocus.com storage module (pbefocus.com/shared/storage) into assets/vendor/pbe-storage/.
//
//   node tools/vendor-pbe-storage.mjs <path to pbefocus.com/shared/storage>
//
// The app has no build step and works offline, so it carries its own copy instead of loading code from another site at run time.
// VERSION records which source commit the copy came from. Never edit the vendored files by hand: change the source and re-run this.

import { cpSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

const source = resolve(process.argv[2] ?? "");
if (!process.argv[2] || !statSync(source, { throwIfNoEntry: false })?.isDirectory()) {
  console.error("Usage: node tools/vendor-pbe-storage.mjs <path to pbefocus.com/shared/storage>");
  process.exit(1);
}
const dest = resolve(import.meta.dirname, "../assets/vendor/pbe-storage");
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });

const SKIP = new Set(["test", "README.md", "package.json", "node_modules"]);
for (const name of readdirSync(source)) {
  if (SKIP.has(name)) continue;
  cpSync(join(source, name), join(dest, name), { recursive: true });
}

let commit = "unknown";
try {
  commit = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
} catch { /* not a git checkout */ }
writeFileSync(join(dest, "VERSION"), `pbefocus.com/shared/storage @ ${commit}\n`);
console.log(`Vendored pbe-storage from ${source} (${commit})`);
