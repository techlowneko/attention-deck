import { dispatchCodexStopHook, readCodexHookInput } from "./codex-stop-hook.js";

async function main(): Promise<void> {
  try {
    await dispatchCodexStopHook(await readCodexHookInput());
  } catch (error) {
    if (process.env.ATTENTION_DECK_HOOK_DEBUG === "1") {
      const message = error instanceof Error ? error.message : "unknown hook failure";
      process.stderr.write(`Attention Deck Codex hook: ${message.slice(0, 500)}\n`);
    }
  }

  // Stop hooks require JSON on stdout. The bridge is observational and never
  // changes whether Codex stops or continues.
  process.stdout.write("{}\n");
}

void main();
