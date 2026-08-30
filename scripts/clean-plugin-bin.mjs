import { readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const binDirectory = join(workspace, "com.preflightstack.attention-deck.sdPlugin", "bin");
const preserved = new Set(["launcher.cjs", "package.json"]);

for (const entry of await readdir(binDirectory, { withFileTypes: true })) {
  if (preserved.has(entry.name)) continue;
  await rm(join(binDirectory, entry.name), { recursive: entry.isDirectory(), force: true });
}
