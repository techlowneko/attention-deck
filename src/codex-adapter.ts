import { basename } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { AttentionAction, AttentionItem, EmitItem } from "./protocol.js";
import { AttentionStore, ConflictError } from "./store.js";
import {
  CodexAppServerClient,
  type CodexThreadSummary,
  type JsonRpcId,
  type RpcNotification,
  type RpcServerRequest,
} from "./codex-app-server.js";

type ProviderAction = Extract<AttentionAction, "approve" | "deny">;

interface PendingApproval {
  requestId: JsonRpcId;
  requestKey: string;
  connectionEpoch: string;
  itemId: string;
  threadId: string;
  turnId: string;
  codexItemId: string;
  promptHash: string;
  state: "pending" | "reply_sent" | "unknown";
  submittedDecision?: "accepted" | "rejected";
  sequence: number;
  base: EmitItem;
}

function stringField(params: Record<string, unknown>, name: string): string | undefined {
  return typeof params[name] === "string" && params[name] ? params[name] as string : undefined;
}

function requestKey(epoch: string, id: JsonRpcId): string {
  return `${epoch}:${typeof id}:${String(id)}`;
}

function shortText(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

function projectLabel(cwd: string | undefined, thread?: CodexThreadSummary): string {
  return thread?.name ? shortText(thread.name, 80) : cwd ? basename(cwd) || "Codex" : "Codex";
}

export interface CodexAdapterOptions {
  client?: CodexAppServerClient;
  pollMs?: number;
  onError?: (error: unknown) => void;
}

export class CodexAttentionAdapter {
  readonly client: CodexAppServerClient;
  readonly #pendingByItem = new Map<string, PendingApproval>();
  readonly #pendingByRequest = new Map<string, PendingApproval>();
  readonly #threads = new Map<string, CodexThreadSummary>();
  readonly #attempts = new Map<string, number>();
  #poll?: NodeJS.Timeout;
  #connected = false;

  constructor(readonly store: AttentionStore, readonly options: CodexAdapterOptions = {}) {
    this.client = options.client ?? new CodexAppServerClient();
    this.client.on("serverRequest", (request: RpcServerRequest) => this.#onServerRequest(request));
    this.client.on("notification", (notification: RpcNotification) => this.#onNotification(notification));
    this.client.on("disconnected", () => this.#onDisconnected());
  }

  get connected(): boolean {
    return this.#connected;
  }

  async start(): Promise<void> {
    await this.client.start();
    this.#connected = true;
    await this.syncThreads();
    this.#poll = setInterval(() => void this.syncThreads().catch(() => this.#onDisconnected()), this.options.pollMs ?? 5_000);
    this.#poll.unref();
  }

  async syncThreads(): Promise<CodexThreadSummary[]> {
    const threads = await this.client.listThreads();
    this.#threads.clear();
    for (const thread of threads) this.#threads.set(thread.id, thread);
    return threads;
  }

  async execute(item: AttentionItem, action: ProviderAction, attemptId: string): Promise<AttentionItem> {
    this.#rememberAttempt(attemptId);
    const pending = this.#pendingByItem.get(item.id);
    if (!this.#connected || !pending || pending.connectionEpoch !== this.client.connectionEpoch) {
      throw new ConflictError("Codex request is no longer connected");
    }
    if (pending.state !== "pending" || item.action_status !== "ready") {
      throw new ConflictError("Codex request is no longer pending");
    }
    const current = this.store.get(item.id);
    if (!current || current.source_state !== "active" || current.version !== item.version || current.freshness === "stale" || !current.available_actions?.includes(action)) {
      throw new ConflictError("Codex request changed; refresh before acting");
    }

    pending.state = "reply_sent";
    pending.submittedDecision = action === "approve" ? "accepted" : "rejected";
    pending.sequence += 1;
    const sending = this.store.upsertTrusted({
      ...pending.base,
      event_id: `${pending.requestKey}:${pending.sequence}`,
      version: current.version + 1,
      sequence: pending.sequence,
      title: action === "approve" ? "Sending approval" : "Sending denial",
      available_actions: [],
      action_status: "sending",
    });
    try {
      this.client.respond(pending.requestId, { decision: action === "approve" ? "accept" : "decline" });
    } catch (error) {
      pending.state = "unknown";
      return this.#markUnknown(pending, error instanceof Error ? error.message : "transport failure");
    }
    return sending;
  }

  close(): void {
    if (this.#poll) clearInterval(this.#poll);
    this.client.close();
  }

  #onServerRequest(request: RpcServerRequest): void {
    if (request.method !== "item/commandExecution/requestApproval" && request.method !== "item/fileChange/requestApproval") {
      this.client.respondError(request.id, -32601, "Attention Deck does not support this server request");
      return;
    }
    const threadId = stringField(request.params, "threadId");
    const turnId = stringField(request.params, "turnId");
    const codexItemId = stringField(request.params, "itemId");
    if (!threadId || !turnId || !codexItemId) {
      this.client.respondError(request.id, -32602, "Approval request is missing required identifiers");
      return;
    }
    const key = requestKey(this.client.connectionEpoch, request.id);
    if (this.#pendingByRequest.has(key)) return;
    const session = `${threadId}:${turnId}:${codexItemId}:${key}`;
    const stableId = `codex:${session}`;
    const command = stringField(request.params, "command");
    const reason = stringField(request.params, "reason");
    const cwd = stringField(request.params, "cwd");
    const networkContext = request.params.networkApprovalContext && typeof request.params.networkApprovalContext === "object" && !Array.isArray(request.params.networkApprovalContext)
      ? request.params.networkApprovalContext as Record<string, unknown>
      : undefined;
    const network = Boolean(networkContext);
    const kind = network ? "Network access" : request.method.includes("fileChange") ? "File changes" : "Command execution";
    const networkHost = networkContext ? stringField(networkContext, "host") : undefined;
    const networkProtocol = networkContext ? stringField(networkContext, "protocol") : undefined;
    const networkPort = networkContext && (typeof networkContext.port === "number" || typeof networkContext.port === "string")
      ? String(networkContext.port)
      : undefined;
    const networkScope = network
      ? [networkProtocol, networkHost, networkPort].filter(Boolean).join(" · ") || "Managed network destination"
      : undefined;
    const summary = shortText(redactSensitive(networkScope ? `${networkScope}${reason ? ` — ${reason}` : ""}` : reason ?? command ?? `${kind} needs a decision in Codex.`), 600);
    const advertised = Array.isArray(request.params.availableDecisions)
      ? new Set(request.params.availableDecisions.filter((value): value is string => typeof value === "string"))
      : undefined;
    const providerActions: AttentionAction[] = [];
    if (!network && advertised?.has("accept")) providerActions.push("approve");
    if (advertised?.has("decline")) providerActions.push("deny");
    providerActions.push("snooze");
    const base: EmitItem = {
      source: "codex",
      project: projectLabel(cwd, this.#threads.get(threadId)),
      session,
      state: "APPROVAL",
      title: kind,
      summary,
      priority: 5,
      fresh_for_ms: 60_000,
      available_actions: providerActions,
      action_status: "ready",
      locator: { type: "app", target: `codex://threads/${encodeURIComponent(threadId)}`, quality: "best_effort" },
    };
    const pending: PendingApproval = {
      requestId: request.id,
      requestKey: key,
      connectionEpoch: this.client.connectionEpoch,
      itemId: stableId,
      threadId,
      turnId,
      codexItemId,
      promptHash: createHash("sha256").update(JSON.stringify(request.params)).digest("hex"),
      state: "pending",
      sequence: 1,
      base,
    };
    this.#pendingByItem.set(stableId, pending);
    this.#pendingByRequest.set(key, pending);
    this.store.upsertTrusted({ ...base, event_id: `${key}:1`, version: 1, sequence: 1 });
  }

  #onNotification(notification: RpcNotification): void {
    if (notification.method === "serverRequest/resolved") {
      const threadId = stringField(notification.params, "threadId");
      const id = notification.params.requestId;
      if ((typeof id === "string" || typeof id === "number")) {
        const pending = this.#pendingByRequest.get(requestKey(this.client.connectionEpoch, id));
        if (pending && (!threadId || pending.threadId === threadId)) this.#finish(pending);
      }
      return;
    }
    if (notification.method === "item/completed") {
      const threadId = stringField(notification.params, "threadId");
      const turnId = stringField(notification.params, "turnId");
      const item = notification.params.item;
      const itemId = item && typeof item === "object" ? stringField(item as Record<string, unknown>, "id") : undefined;
      if (!threadId || !turnId || !itemId) return;
      for (const pending of this.#pendingByItem.values()) {
        if (pending.threadId === threadId && pending.turnId === turnId && pending.codexItemId === itemId) this.#finish(pending);
      }
    }
  }

  #finish(pending: PendingApproval): void {
    const item = this.store.get(pending.itemId);
    if (item && !item.resolved_at) {
      try {
        this.store.clear(item.id, item.version, new Date(), pending.submittedDecision);
      } catch (error) {
        if (!(error instanceof ConflictError)) {
          pending.state = "unknown";
          this.options.onError?.(error);
          return;
        }
        /* A newer authoritative event won the race. */
      }
    }
    this.#pendingByItem.delete(pending.itemId);
    this.#pendingByRequest.delete(pending.requestKey);
  }

  #onDisconnected(): void {
    if (!this.#connected) return;
    this.#connected = false;
    for (const pending of this.#pendingByItem.values()) {
      pending.state = "unknown";
      this.#markUnknown(pending, "Codex connection was lost before confirmation");
    }
    this.#pendingByItem.clear();
    this.#pendingByRequest.clear();
  }

  #markUnknown(pending: PendingApproval, reason: string): AttentionItem {
    pending.sequence += 1;
    const current = this.store.get(pending.itemId);
    return this.store.upsertTrusted({
      ...pending.base,
      event_id: `${pending.requestKey}:${pending.sequence}:${randomUUID()}`,
      version: (current?.version ?? 0) + 1,
      sequence: pending.sequence,
      state: "FAILED",
      title: "Check Codex",
      summary: shortText(reason, 600),
      available_actions: ["snooze"],
      action_status: "unknown",
    });
  }

  #rememberAttempt(attemptId: string): void {
    const now = Date.now();
    for (const [id, seenAt] of this.#attempts) {
      if (now - seenAt > 10 * 60_000) this.#attempts.delete(id);
    }
    if (this.#attempts.has(attemptId)) throw new ConflictError("physical action was already submitted");
    while (this.#attempts.size >= 2_048) this.#attempts.delete(this.#attempts.keys().next().value as string);
    this.#attempts.set(attemptId, now);
  }
}

function redactSensitive(value: string): string {
  return value
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/([?&](?:token|key|secret|signature)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, "$1[REDACTED]@");
}
