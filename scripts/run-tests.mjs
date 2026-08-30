import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const testsDirectory = fileURLToPath(new URL("../.test-dist/tests/", import.meta.url));
const testFiles = (await readdir(testsDirectory, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith(".test.js"))
  .map((entry) => new URL(`../.test-dist/tests/${entry.name}`, import.meta.url))
  .sort((left, right) => left.href.localeCompare(right.href))
  .map(fileURLToPath);

if (testFiles.length === 0) {
  throw new Error(`No compiled tests found in ${testsDirectory}`);
}

const result = spawnSync(process.execPath, ["--test", ...testFiles], {
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

process.exitCode = result.status ?? 1;
