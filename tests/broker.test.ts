import assert from "node:assert/strict";
import test from "node:test";
import { startBroker } from "../src/broker.js";

test("broker rejects unauthenticated mutations and accepts authenticated events", async (context) => {
  const broker = await startBroker({ port: 0, token: "x".repeat(32) });
  context.after(() => broker.close());
  const url = `http://127.0.0.1:${broker.port}`;
  const event = { source: "test", project: "Relay", state: "INPUT", title: "Choose", summary: "A or B" };
  const denied = await fetch(`${url}/v1/events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(event) });
  assert.equal(denied.status, 401);
  const accepted = await fetch(`${url}/v1/events`, {
    method: "POST",
    headers: { authorization: `Bearer ${broker.token}`, "content-type": "application/json" },
    body: JSON.stringify(event),
  });
  assert.equal(accepted.status, 202);
  assert.equal(broker.store.snapshot().items.length, 1);
});

test("broker action requires the current item version", async (context) => {
  const broker = await startBroker({ port: 0, token: "y".repeat(32) });
  context.after(() => broker.close());
  const item = broker.store.upsert({ source: "test", project: "Relay", state: "INPUT", title: "Choose", summary: "A or B" });
  const response = await fetch(`http://127.0.0.1:${broker.port}/v1/items/${encodeURIComponent(item.id)}/actions/dismiss`, {
    method: "POST",
    headers: { authorization: `Bearer ${broker.token}`, "content-type": "application/json" },
    body: JSON.stringify({ version: item.version + 1 }),
  });
  assert.equal(response.status, 409);
  assert.equal(broker.store.snapshot().items.length, 1);
});

test("public broker never exposes provider approval actions", async (context) => {
  const storeItem = {
    source: "codex",
    project: "Relay",
    session: "approval-1",
    state: "APPROVAL" as const,
    title: "Command execution",
    summary: "npm test",
    available_actions: ["approve", "deny", "snooze"] as const,
    action_status: "ready" as const,
  };
  const broker = await startBroker({
    port: 0,
    token: "z".repeat(32),
  });
  context.after(() => broker.close());
  const item = broker.store.upsertTrusted({ ...storeItem, available_actions: [...storeItem.available_actions] });
  const base = `http://127.0.0.1:${broker.port}/v1/items/${encodeURIComponent(item.id)}/actions/approve`;
  const headers = { authorization: `Bearer ${broker.token}`, "content-type": "application/json" };
  const denied = await fetch(base, {
    method: "POST",
    headers,
    body: JSON.stringify({ version: item.version, attempt_id: "attempt-000000000001" }),
  });
  assert.equal(denied.status, 404);
});

test("broker dismissal is local-only and the item remains visible in lifecycle views", async (context) => {
  const broker = await startBroker({ port: 0, token: "d".repeat(32) });
  context.after(() => broker.close());
  const item = broker.store.upsert({ source: "test", project: "Relay", state: "INPUT", title: "Choose", summary: "A or B" });
  const response = await fetch(`http://127.0.0.1:${broker.port}/v1/items/${encodeURIComponent(item.id)}/actions/dismiss`, {
    method: "POST",
    headers: { authorization: `Bearer ${broker.token}`, "content-type": "application/json" },
    body: JSON.stringify({ version: item.version }),
  });
  assert.equal(response.status, 200);
  const snapshot = broker.store.snapshot();
  assert.equal(snapshot.items.length, 0);
  assert.equal(snapshot.active.length, 1);
  assert.equal(snapshot.active[0]?.source_state, "active");
  assert.equal(snapshot.active[0]?.presentation_state, "dismissed");
  assert.equal(snapshot.recent.length, 1);
});

test("broker accepts bounded snoozes through tomorrow but rejects longer delays", async (context) => {
  const broker = await startBroker({ port: 0, token: "s".repeat(32) });
  context.after(() => broker.close());
  const headers = { authorization: `Bearer ${broker.token}`, "content-type": "application/json" };
  const first = broker.store.upsert({ source: "test", project: "Relay", session: "one", state: "INPUT", title: "Choose", summary: "A or B" });
  const accepted = await fetch(`http://127.0.0.1:${broker.port}/v1/items/${encodeURIComponent(first.id)}/actions/snooze`, {
    method: "POST",
    headers,
    body: JSON.stringify({ version: first.version, duration_ms: 604_800_000 }),
  });
  assert.equal(accepted.status, 200);

  const second = broker.store.upsert({ source: "test", project: "Relay", session: "two", state: "INPUT", title: "Choose again", summary: "A or B" });
  const rejected = await fetch(`http://127.0.0.1:${broker.port}/v1/items/${encodeURIComponent(second.id)}/actions/snooze`, {
    method: "POST",
    headers,
    body: JSON.stringify({ version: second.version, duration_ms: 604_800_001 }),
  });
  assert.equal(rejected.status, 400);
  assert.equal(broker.store.get(second.id)?.presentation_state, "visible");
});
