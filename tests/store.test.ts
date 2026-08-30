import assert from "node:assert/strict";
import test from "node:test";
import { validateEmitItem } from "../src/protocol.js";
import { AttentionStore, ConflictError } from "../src/store.js";

const base = {
  source: "test",
  project: "Relay",
  session: "one",
  state: "APPROVAL",
  title: "Install dependency",
  summary: "Install sharp",
  event_id: "delivery-1",
  version: 1,
  sequence: 1,
} as const;

test("deduplicates identical deliveries and rejects conflicting reuse", () => {
  const store = new AttentionStore();
  const parsed = validateEmitItem(base);
  assert.equal(store.upsert(parsed).id, "test:one");
  assert.equal(store.upsert(parsed).id, "test:one");
  assert.throws(() => store.upsert(validateEmitItem({ ...base, summary: "different" })), ConflictError);
  assert.equal(store.snapshot().items.length, 1);
});

test("keeps delivery idempotency after a newer item version arrives", () => {
  const store = new AttentionStore();
  const first = validateEmitItem(base);
  store.upsert(first);
  store.upsert(validateEmitItem({ ...base, event_id: "delivery-2", version: 2, sequence: 2, summary: "new version" }));
  assert.equal(store.upsert(first).version, 1);
  assert.equal(store.snapshot().items[0]?.version, 2);
});

test("rejects stale item versions and orders by resume value then age", () => {
  const store = new AttentionStore();
  store.upsert(validateEmitItem(base), new Date("2026-08-29T20:00:00Z"));
  assert.throws(() => store.upsert(validateEmitItem({ ...base, event_id: "delivery-2", sequence: 2 })), ConflictError);
  store.upsert(validateEmitItem({ ...base, event_id: "delivery-3", version: 2, sequence: 2, state: "FAILED" }));
  store.upsert(validateEmitItem({ ...base, event_id: "delivery-4", source: "other", session: "two", state: "INPUT" }));
  assert.deepEqual(store.snapshot().items.map((item) => item.state), ["INPUT", "FAILED"]);
});

test("requires exact version for dismiss and hides resolved items", () => {
  const store = new AttentionStore();
  const item = store.upsert(validateEmitItem(base));
  assert.throws(() => store.resolve(item.id, 99), ConflictError);
  store.resolve(item.id, item.version);
  assert.equal(store.snapshot().items.length, 0);
});

test("marks expired producers stale without hiding their item", () => {
  const store = new AttentionStore();
  store.upsert(validateEmitItem({ ...base, fresh_for_ms: 1000 }), new Date("2026-08-29T20:00:00Z"));
  const item = store.snapshot(new Date("2026-08-29T20:00:02Z")).items[0];
  assert.equal(item?.freshness, "stale");
});

test("generic emitters cannot declare OPEN locators", () => {
  assert.throws(() => validateEmitItem({ ...base, locator: { type: "https", target: "https://example.com" } }), /trusted adapter/);
});
