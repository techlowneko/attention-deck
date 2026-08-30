import assert from "node:assert/strict";
import test from "node:test";
import { actionKey, keyCard } from "../src/render.js";
import type { AttentionItem } from "../src/protocol.js";

function decodeSvg(value: string): string {
  const prefix = "data:image/svg+xml;base64,";
  assert.ok(value.startsWith(prefix));
  return Buffer.from(value.slice(prefix.length), "base64").toString("utf8");
}

test("key artwork uses an explicit base64 SVG data URI", () => {
  const item: AttentionItem = {
    protocol: "attention/1",
    event_id: "render-1",
    id: "test:render",
    source: "cli",
    project: "Lifecycle Test",
    session: "render",
    state: "INPUT",
    title: "Verify key labels",
    summary: "Dynamic key artwork should replace the manifest placeholder.",
    version: 2,
    sequence: 1,
    priority: 0,
    occurred_at: "2026-08-30T11:55:27.314Z",
    first_seen_at: "2026-08-30T11:32:50.254Z",
    last_seen_at: "2026-08-30T11:55:27.314Z",
    fresh_for_ms: 300_000,
    freshness: "fresh",
    generation: 1,
    occurrence_count: 2,
    source_state: "active",
    operator_state: "unseen",
    presentation_state: "visible",
    decision_state: "none",
  };
  const card = decodeSvg(keyCard(item, true, new Date("2026-08-30T11:56:00.000Z")));
  assert.match(card, /Lifecycle T/);
  assert.match(card, /INPUT/);
  const enabled = decodeSvg(actionKey("SNOOZE", true, "#58c4dd", "15M"));
  assert.match(enabled, /SNOOZE/);
  assert.match(enabled, /15M · READY/);
  assert.match(enabled, /stroke-width="6"/);
  const disabled = decodeSvg(actionKey("APPROVE", false));
  assert.doesNotMatch(disabled, /READY/);
  assert.match(disabled, /stroke-width="2"/);
});
