import { build } from "esbuild";

await build({
  entryPoints: ["./src/plugin.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: false,
  outfile: "./com.preflightstack.attention-deck.sdPlugin/bin/plugin.js",
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
