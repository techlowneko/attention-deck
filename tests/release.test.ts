import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("release manifest disables debugging and includes dependency notices", async () => {
  const manifest = JSON.parse(await readFile("com.preflightstack.attention-deck.sdPlugin/manifest.json", "utf8")) as {
    Nodejs?: { Debug?: string };
  };
  assert.equal(manifest.Nodejs?.Debug, undefined);
  const notices = await readFile("com.preflightstack.attention-deck.sdPlugin/THIRD_PARTY_NOTICES.txt", "utf8");
  assert.match(notices, /@elgato\/streamdeck/);
  assert.match(notices, /Copyright \(c\) Corsair Memory Inc\./);
});

test("release bundle configuration does not emit source maps", async () => {
  const buildConfig = await readFile("esbuild.config.mjs", "utf8");
  assert.match(buildConfig, /sourcemap:\s*false/);
  assert.doesNotMatch(buildConfig, /sourcemap:\s*true/);
});

test("plugin build uses an explicit generated-bin cleanup step", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { scripts?: { build?: string } };
  assert.match(packageJson.scripts?.build ?? "", /clean-plugin-bin\.mjs/);
});
