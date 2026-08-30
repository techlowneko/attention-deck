import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import {
  MAX_CODEX_HOOK_BYTES,
  codexStopEvent,
  dispatchCodexStopHook,
  readCodexHookInput,
} from "../src/codex-stop-hook.js";
import { validateEmitItem, type EmitItem } from "../src/protocol.js";
import { AttentionStore } from "../src/store.js";

const stop = {
  session_id: "019d-session",
  turn_id: "019d-turn",
  cwd: "C:\\work\\attention-deck",
  hook_event_name: "Stop",
  stop_hook_active: false,
  model: "gpt-test",
  last_assistant_message: "Built the feature.",
};

test("maps a Codex Stop hook to a deterministic display-only review event", () => {
  const first = codexStopEvent(stop);
  const retry = codexStopEvent({ ...stop });
  assert.deepEqual(retry, first);
  assert.equal(first?.source, "codex");
  assert.equal(first?.project, "attention-deck");
  assert.match(first?.session ?? "", /^codex-session:[a-f0-9]{64}$/u);
  assert.equal(first?.state, "REVIEW");
  assert.equal(first?.summary, "Open Codex to review.");
  assert.match(first?.event_id ?? "", /^codex-stop:[a-f0-9]{64}$/u);
  assert.equal(first?.available_actions, undefined);
  assert.equal(first?.locator, undefined);
});

test("does not copy assistant text, transcripts, or injected capabilities", () => {
  const event = codexStopEvent({
    ...stop,
    last_assistant_message: "Bearer very-secret",
    transcript_path: "C:\\private\\transcript.jsonl",
    available_actions: ["approve"],
    locator: { type: "app", target: "evil://target" },
    event_id: "attacker-controlled",
    source_state: "cleared",
  });
  assert.ok(event);
  assert.equal(event.summary, "Open Codex to review.");
  assert.doesNotMatch(JSON.stringify(event), /very-secret|transcript|approve|evil|attacker-controlled/iu);
});

test("ignores malformed and unsupported hook events", () => {
  assert.equal(codexStopEvent(null), undefined);
  assert.equal(codexStopEvent({ ...stop, hook_event_name: "SessionEnd" }), undefined);
  assert.equal(codexStopEvent({ ...stop, stop_hook_active: true }), undefined);
  assert.equal(codexStopEvent({ ...stop, stop_hook_active: undefined }), undefined);
  assert.equal(codexStopEvent({ ...stop, session_id: "" }), undefined);
  assert.equal(codexStopEvent({ ...stop, turn_id: "x".repeat(161) }), undefined);
});

test("dispatch uses only the generic emit client", async () => {
  const events: EmitItem[] = [];
  const sent = await dispatchCodexStopHook(stop, {
    client: { emit: async (event) => { events.push(event); } },
  });
  assert.equal(sent, true);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.state, "REVIEW");
});

test("a newer Codex turn wakes a locally dismissed session without duplicating retries", () => {
  const store = new AttentionStore();
  const firstEvent = codexStopEvent(stop)!;
  const first = store.upsert(validateEmitItem(firstEvent));
  store.dismiss(first.id, first.version);
  store.upsert(validateEmitItem(firstEvent));
  assert.equal(store.snapshot().items.length, 0);
  assert.equal(store.get(first.id)?.occurrence_count, 1);

  const secondEvent = codexStopEvent({ ...stop, turn_id: "019d-turn-2" })!;
  const second = store.upsert(validateEmitItem(secondEvent));
  assert.equal(second.presentation_state, "visible");
  assert.equal(second.generation, 2);
  assert.equal(second.occurrence_count, 2);
  assert.equal(store.snapshot().items.length, 1);
});

test("stdin reader accepts bounded JSON and rejects oversized input", async () => {
  assert.deepEqual(await readCodexHookInput(Readable.from([JSON.stringify(stop)])), stop);
  await assert.rejects(
    () => readCodexHookInput(Readable.from(["x".repeat(MAX_CODEX_HOOK_BYTES + 1)])),
    /size limit/u,
  );
  await assert.rejects(
    () => readCodexHookInput(Readable.from([Buffer.from([0xff, 0xfe, 0xfd])])),
    /encoded data/iu,
  );
});
