import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { validateEmitItem } from "../src/protocol.js";
import { JsonFilePersistence, MAX_STATE_FILE_BYTES } from "../src/persistence.js";
import { AttentionStore, CapacityError, ConflictError, PersistenceCompatibilityError } from "../src/store.js";

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

function temporaryState(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "attention-deck-store-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "state.json");
}

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

test("requires exact version for local dismiss without claiming provider resolution", () => {
  const store = new AttentionStore();
  const item = store.upsert(validateEmitItem(base));
  assert.throws(() => store.resolve(item.id, 99), ConflictError);
  const dismissed = store.resolve(item.id, item.version);
  assert.equal(dismissed.source_state, "active");
  assert.equal(dismissed.presentation_state, "dismissed");
  assert.equal(dismissed.resolved_at, undefined);
  assert.equal(store.snapshot().items.length, 0);
  assert.equal(store.snapshot().active.length, 1);
  assert.equal(store.snapshot().recent.length, 1);
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

test("persists current items, delivery idempotency, cursor, and lifecycle across restart", (t) => {
  const persistencePath = temporaryState(t);
  const firstStore = new AttentionStore({ persistencePath });
  const delivery = validateEmitItem(base, new Date("2026-08-29T20:00:00Z"));
  const first = firstStore.upsert(delivery, new Date("2026-08-29T20:00:00Z"));
  firstStore.snooze(first.id, first.version, 60_000, new Date("2026-08-29T20:00:10Z"));
  const cursor = firstStore.snapshot().cursor;

  const restarted = new AttentionStore({ persistencePath });
  const restored = restarted.get(first.id, new Date("2026-08-29T20:00:20Z"));
  assert.equal(restored?.presentation_state, "snoozed");
  assert.equal(restored?.generation, 1);
  assert.equal(restored?.occurrence_count, 1);
  assert.equal(restarted.snapshot().cursor, cursor);
  assert.equal(restarted.upsert(delivery).event_id, first.event_id);
  assert.equal(restarted.snapshot().cursor, cursor);
});

test("restart restores evidence but revokes provider decision authority", (t) => {
  const persistencePath = temporaryState(t);
  const firstStore = new AttentionStore({ persistencePath });
  const first = firstStore.upsertTrusted({
    ...base,
    available_actions: ["approve", "deny", "snooze"],
    action_status: "ready",
  });
  assert.equal(first.decision_state, "available");

  const restored = new AttentionStore({ persistencePath }).get(first.id);
  assert.deepEqual(restored?.available_actions, ["snooze"]);
  assert.equal(restored?.action_status, "unknown");
  assert.equal(restored?.decision_state, "unknown");
});

test("corrupt persistence fails safe and is replaced by the next atomic save", (t) => {
  const persistencePath = temporaryState(t);
  writeFileSync(persistencePath, "{not valid json", "utf8");
  const store = new AttentionStore({ persistencePath });
  assert.deepEqual(store.snapshot().items, []);
  store.upsert(validateEmitItem(base));

  const parsed = JSON.parse(readFileSync(persistencePath, "utf8")) as { schema: string };
  assert.equal(parsed.schema, "attention-deck/store/1");
  const files = readdirSync(join(persistencePath, ".."));
  assert.equal(files.filter((name) => name.endsWith(".tmp")).length, 0);
  assert.equal(files.filter((name) => name.startsWith("state.json.corrupt-")).length, 1);
  assert.equal(new AttentionStore({ persistencePath }).snapshot().items.length, 1);
});

test("unsupported persisted schemas are read-only and never overwritten", (t) => {
  const persistencePath = temporaryState(t);
  const raw = '{"schema":"attention-deck/store/999","items":[]}';
  writeFileSync(persistencePath, raw, "utf8");
  const store = new AttentionStore({ persistencePath });
  assert.throws(() => store.upsert(validateEmitItem(base)), PersistenceCompatibilityError);
  assert.equal(readFileSync(persistencePath, "utf8"), raw);
});

test("semantically invalid persisted records are read-only and never partially restored", (t) => {
  const persistencePath = temporaryState(t);
  const raw = '{"schema":"attention-deck/store/1","cursor":2,"items":[{"protocol":"attention/1"}]}';
  writeFileSync(persistencePath, raw, "utf8");
  const store = new AttentionStore({ persistencePath });
  assert.deepEqual(store.snapshot().items, []);
  assert.throws(() => store.upsert(validateEmitItem(base)), PersistenceCompatibilityError);
  assert.equal(readFileSync(persistencePath, "utf8"), raw);
});

test("persisted delivery history stays within the loader byte cap", (t) => {
  const persistencePath = temporaryState(t);
  const store = new AttentionStore({ persistencePath });
  const padding = "x".repeat(2_000);
  for (let index = 1; index <= 600; index += 1) {
    store.upsertTrusted({
      source: "trusted",
      project: "P".repeat(80),
      session: "bounded-persistence",
      state: "INPUT",
      title: "T".repeat(120),
      summary: "S".repeat(600),
      event_id: `delivery-${index}`,
      version: index,
      sequence: index,
      locator: { type: "https", target: `https://example.com/${index}/${padding}` },
    });
  }
  assert.ok(statSync(persistencePath).size <= MAX_STATE_FILE_BYTES);
  assert.equal(new AttentionStore({ persistencePath }).snapshot().items[0]?.version, 600);
  assert.throws(
    () => new JsonFilePersistence(join(persistencePath, "..", "oversized.json")).save({ padding: "x".repeat(MAX_STATE_FILE_BYTES) }),
    /8 MiB/,
  );
});

test("cleared trusted events cannot retain live provider capabilities", () => {
  const store = new AttentionStore({ persistencePath: null });
  const cleared = store.upsertTrusted({
    ...base,
    source_state: "cleared",
    available_actions: ["approve", "deny", "snooze"],
    action_status: "ready",
  });
  assert.deepEqual(cleared.available_actions, undefined);
  assert.equal(cleared.action_status, undefined);
  assert.equal(cleared.decision_state, "unknown");
  assert.equal(store.snapshot().items.length, 0);
});

test("trusted adapter items must remain inside the persisted-item bounds", () => {
  const store = new AttentionStore({ persistencePath: null });
  assert.throws(() => store.upsertTrusted({
    ...base,
    locator: { type: "https", target: `https://example.com/${"x".repeat(2_048)}` },
  }), /bounded persisted-item schema/);
});

test("trusted adapter strings are normalized before bounded storage", () => {
  const store = new AttentionStore({ persistencePath: null });
  const item = store.upsertTrusted({ ...base, summary: `${" ".repeat(10_000)}kept` });
  assert.equal(item.summary, "kept");
});

test("authoritative clear strips every live action marker", () => {
  const store = new AttentionStore({ persistencePath: null });
  const active = store.upsertTrusted({
    ...base,
    available_actions: ["approve", "deny", "snooze"],
    action_status: "ready",
  });
  const cleared = store.clear(active.id, active.version);
  assert.deepEqual(cleared.available_actions, []);
  assert.equal(cleared.action_status, undefined);
  assert.equal(cleared.decision_state, "none");
});

test("routine active updates cannot evict meaningful recent history", () => {
  const store = new AttentionStore({ persistencePath: null, limits: { history: 2 } });
  const dismissed = store.upsert(validateEmitItem(base));
  store.dismiss(dismissed.id, dismissed.version);
  store.upsert(validateEmitItem({ ...base, event_id: "reactivate", version: 2, sequence: 2 }));
  for (let version = 3; version <= 20; version += 1) {
    store.upsert(validateEmitItem({ ...base, event_id: `update-${version}`, version, sequence: version }));
  }
  assert.equal(store.snapshot().recent[0]?.presentation_state, "dismissed");
});

test("expired snooze and newer versions wake items without carrying old capabilities", () => {
  const store = new AttentionStore({ persistencePath: null });
  const start = new Date("2026-08-29T20:00:00Z");
  const first = store.upsertTrusted({
    ...base,
    available_actions: ["approve", "deny", "snooze"],
    action_status: "ready",
  }, start);
  store.snooze(first.id, first.version, 60_000, start);
  assert.equal(store.snapshot(new Date("2026-08-29T20:00:30Z")).items.length, 0);
  assert.equal(store.snapshot(new Date("2026-08-29T20:01:01Z")).items[0]?.presentation_state, "visible");

  const second = store.upsertTrusted({
    ...base,
    event_id: "delivery-2",
    version: 2,
    sequence: 2,
    summary: "request changed",
  }, new Date("2026-08-29T20:00:10Z"));
  assert.equal(second.presentation_state, "visible");
  assert.equal(second.snoozed_until, undefined);
  assert.equal(second.available_actions, undefined);
  assert.equal(second.decision_state, "none");
  assert.equal(second.generation, 1);
  assert.equal(second.occurrence_count, 2);
});

test("dismissed or provider-cleared occurrences reactivate as a new generation", () => {
  const store = new AttentionStore({ persistencePath: null });
  const first = store.upsert(validateEmitItem(base));
  const activeUpdate = store.upsert(validateEmitItem({ ...base, event_id: "delivery-2", version: 2, sequence: 2 }));
  assert.equal(activeUpdate.generation, 1);
  assert.equal(activeUpdate.occurrence_count, 2);

  store.dismiss(first.id, activeUpdate.version);
  const afterDismiss = store.upsert(validateEmitItem({ ...base, event_id: "delivery-3", version: 3, sequence: 3 }));
  assert.equal(afterDismiss.generation, 2);
  assert.equal(afterDismiss.presentation_state, "visible");

  const cleared = store.clear(afterDismiss.id, afterDismiss.version, new Date("2026-08-29T20:05:00Z"));
  assert.equal(cleared.source_state, "cleared");
  assert.equal(cleared.presentation_state, "recent");
  assert.ok(cleared.resolved_at);
  assert.deepEqual(cleared.available_actions, []);
  assert.equal(store.snapshot().active.length, 0);

  const reactivated = store.upsert(validateEmitItem({ ...base, event_id: "delivery-4", version: 4, sequence: 4 }));
  assert.equal(reactivated.source_state, "active");
  assert.equal(reactivated.resolved_at, undefined);
  assert.equal(reactivated.generation, 3);
  assert.equal(reactivated.occurrence_count, 4);
});

test("migrates additive lifecycle fields from bounded schema-0 state", (t) => {
  const persistencePath = temporaryState(t);
  const source = new AttentionStore({ persistencePath: null });
  const current = source.upsert(validateEmitItem(base), new Date("2026-08-29T20:00:00Z"));
  const legacy = { ...current } as Partial<typeof current>;
  delete legacy.generation;
  delete legacy.occurrence_count;
  delete legacy.source_state;
  delete legacy.operator_state;
  delete legacy.presentation_state;
  delete legacy.decision_state;
  writeFileSync(persistencePath, JSON.stringify({ schema: "attention-deck/store/0", cursor: 7, items: [legacy] }), "utf8");

  const migrated = new AttentionStore({ persistencePath }).snapshot().items[0];
  assert.equal(migrated?.generation, 1);
  assert.equal(migrated?.occurrence_count, 1);
  assert.equal(migrated?.source_state, "active");
  assert.equal(migrated?.presentation_state, "visible");
});

test("bounds items, deliveries, and recent history without evicting live attention", (t) => {
  const persistencePath = temporaryState(t);
  const store = new AttentionStore({ persistencePath, limits: { items: 3, deliveries: 2, history: 2 } });
  for (let index = 0; index < 6; index += 1) {
    const item = store.upsert(validateEmitItem({
      ...base,
      event_id: `delivery-${index}`,
      session: `session-${index}`,
      version: 1,
      sequence: 1,
    }), new Date(`2026-08-29T20:00:0${index}Z`));
    store.dismiss(item.id, item.version);
  }
  const snapshot = store.snapshot();
  assert.equal(snapshot.active.length, 3);
  assert.ok(snapshot.recent.length <= 2);
  const persisted = JSON.parse(readFileSync(persistencePath, "utf8")) as { items: unknown[]; deliveries: unknown[]; history: unknown[] };
  assert.ok(persisted.items.length <= 3);
  assert.ok(persisted.deliveries.length <= 2);
  assert.ok(persisted.history.length <= 2);

  const full = new AttentionStore({ persistencePath: null, limits: { items: 2 } });
  full.upsert(validateEmitItem({ ...base, event_id: "live-1", session: "live-1" }));
  full.upsert(validateEmitItem({ ...base, event_id: "live-2", session: "live-2" }));
  assert.throws(() => full.upsert(validateEmitItem({ ...base, event_id: "live-3", session: "live-3" })), CapacityError);
  assert.equal(full.snapshot().items.length, 2);
});
