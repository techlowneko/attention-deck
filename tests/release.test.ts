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

test("Codex hook example is portable, opt-in, and points at the bundled display-only bridge", async () => {
  const config = JSON.parse(await readFile("integrations/codex/hooks.windows.json", "utf8")) as {
    hooks?: { Stop?: Array<{ hooks?: Array<Record<string, unknown>> }> };
  };
  const handler = config.hooks?.Stop?.[0]?.hooks?.[0];
  assert.equal(handler?.type, "command");
  assert.equal(handler?.async, true);
  assert.equal(handler?.timeout, 3);
  assert.match(String(handler?.commandWindows), /%APPDATA%.*codex-stop-hook\.cjs/iu);
  assert.doesNotMatch(JSON.stringify(config), /C:\\Users\\/iu);
});
