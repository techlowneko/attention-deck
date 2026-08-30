import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { CodexJsonLinePeer, JsonlFramer, type CodexAppServerClient, type JsonRpcId } from "../src/codex-app-server.js";
import { CodexAttentionAdapter } from "../src/codex-adapter.js";
import { AttentionStore } from "../src/store.js";

test("JSONL peer correlates client requests and preserves server request ids", async () => {
  const writes: string[] = [];
  const peer = new CodexJsonLinePeer((line) => writes.push(line));
  const resultPromise = peer.request("initialize", { clientInfo: { name: "test" } });
  const sent = JSON.parse(writes[0]!) as { id: number };
  peer.ingestLine(JSON.stringify({ id: sent.id, result: { platformOs: "windows" } }));
  assert.deepEqual(await resultPromise, { platformOs: "windows" });

  let requestId: JsonRpcId | undefined;
  peer.on("serverRequest", (request: { id: JsonRpcId }) => { requestId = request.id; });
  peer.ingestLine(JSON.stringify({ method: "item/commandExecution/requestApproval", id: "approve-7", params: { threadId: "t" } }));
  assert.equal(requestId, "approve-7");
  peer.respond(requestId!, { decision: "decline" });
  assert.deepEqual(JSON.parse(writes.at(-1)!), { id: "approve-7", result: { decision: "decline" } });
});

test("JSONL framer preserves partial lines and rejects oversized frames", () => {
  const framer = new JsonlFramer(32);
  assert.deepEqual(framer.push('{"id":1'), []);
  assert.deepEqual(framer.push(',"result":{}}\r\n'), ['{"id":1,"result":{}}']);
  assert.throws(() => framer.push("x".repeat(33)), /size limit/);
});

class FakeCodexClient extends EventEmitter {
  readonly connectionEpoch = "connection-1";
  readonly responses: Array<{ id: JsonRpcId; result: unknown }> = [];
  async start(): Promise<void> {}
  async listThreads(): Promise<[]> { return []; }
  respond(id: JsonRpcId, result: unknown): void { this.responses.push({ id, result }); }
  respondError(id: JsonRpcId, code: number, message: string): void { this.responses.push({ id, result: { error: { code, message } } }); }
  close(): void {}
}

test("Codex adapter exposes only exact live requests and clears them on resolution", async () => {
  const fake = new FakeCodexClient();
  const store = new AttentionStore();
  const adapter = new CodexAttentionAdapter(store, { client: fake as unknown as CodexAppServerClient, pollMs: 60_000 });
  await adapter.start();
  fake.emit("serverRequest", {
    method: "item/commandExecution/requestApproval",
    id: 42,
    params: {
      threadId: "thread-a",
      turnId: "turn-a",
      itemId: "item-a",
      command: "npm test",
      cwd: "C:\\work\\relay",
      availableDecisions: ["accept", "decline", "acceptForSession"],
    },
  });
  const item = store.snapshot().items[0];
  assert.ok(item);
  assert.deepEqual(item.available_actions, ["approve", "deny", "snooze"]);
  const sending = await adapter.execute(item, "approve", "attempt-000000000001");
  assert.equal(sending.action_status, "sending");
  assert.deepEqual(fake.responses, [{ id: 42, result: { decision: "accept" } }]);
  await assert.rejects(() => adapter.execute(sending, "approve", "attempt-000000000002"), /no longer pending/);
  fake.emit("notification", { method: "serverRequest/resolved", params: { threadId: "thread-a", requestId: 42 } });
  assert.equal(store.snapshot().items.length, 0);
  assert.equal(store.snapshot().recent[0]?.decision_state, "accepted");
  assert.equal(store.snapshot().recent[0]?.source_state, "cleared");
  adapter.close();
});

test("Codex adapter retains failed clear ownership and reports degraded persistence", async () => {
  class FailingClearStore extends AttentionStore {
    override clear(): never { throw new Error("disk unavailable"); }
  }
  const fake = new FakeCodexClient();
  const store = new FailingClearStore({ persistencePath: null });
  const errors: unknown[] = [];
  const adapter = new CodexAttentionAdapter(store, {
    client: fake as unknown as CodexAppServerClient,
    pollMs: 60_000,
    onError: (error) => errors.push(error),
  });
  await adapter.start();
  fake.emit("serverRequest", {
    method: "item/commandExecution/requestApproval",
    id: 99,
    params: {
      threadId: "thread-persistence",
      turnId: "turn-persistence",
      itemId: "item-persistence",
      availableDecisions: ["accept", "decline"],
    },
  });
  const item = store.snapshot().items[0]!;
  await adapter.execute(item, "approve", "attempt-persistence-0001");
  const resolved = { method: "serverRequest/resolved", params: { threadId: "thread-persistence", requestId: 99 } };
  fake.emit("notification", resolved);
  fake.emit("notification", resolved);
  assert.equal(errors.length, 2);
  assert.equal(store.get(item.id)?.source_state, "active");
  assert.equal(store.get(item.id)?.decision_state, "sending");
  adapter.close();
});

test("Codex adapter fails closed for missing decisions, network approval, and malformed requests", async () => {
  const fake = new FakeCodexClient();
  const store = new AttentionStore();
  const adapter = new CodexAttentionAdapter(store, { client: fake as unknown as CodexAppServerClient, pollMs: 60_000 });
  await adapter.start();

  fake.emit("serverRequest", {
    method: "item/commandExecution/requestApproval",
    id: 7,
    params: { threadId: "thread-b", turnId: "turn-b", itemId: "item-b", command: "npm publish" },
  });
  assert.deepEqual(store.snapshot().items[0]?.available_actions, ["snooze"]);

  fake.emit("serverRequest", {
    method: "item/commandExecution/requestApproval",
    id: 8,
    params: {
      threadId: "thread-c",
      turnId: "turn-c",
      itemId: "item-c",
      availableDecisions: ["accept", "decline"],
      networkApprovalContext: { host: "registry.example", protocol: "https", port: 443 },
    },
  });
  const network = store.snapshot().items.find((item) => item.session?.includes("thread-c"));
  assert.deepEqual(network?.available_actions, ["deny", "snooze"]);
  assert.match(network?.summary ?? "", /https.*registry\.example.*443/);

  fake.emit("serverRequest", {
    method: "item/fileChange/requestApproval",
    id: "bad-request",
    params: { threadId: "thread-d", turnId: "turn-d" },
  });
  assert.deepEqual(fake.responses.at(-1), {
    id: "bad-request",
    result: { error: { code: -32602, message: "Approval request is missing required identifiers" } },
  });
  adapter.close();
});
