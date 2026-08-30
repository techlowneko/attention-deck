import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  ATTENTION_STATES,
  DECISION_STATES,
  OPERATOR_STATES,
  PRESENTATION_STATES,
  SOURCE_STATES,
  compareAttention,
  isNeedsMe,
  materializeItem,
  refreshFreshness,
  refreshPresentation,
  type ActionStatus,
  type AttentionAction,
  type AttentionItem,
  type AttentionState,
  type DecisionState,
  type EmitItem,
  type OperatorState,
  type PresentationState,
  type SourceState,
} from "./protocol.js";
import { defaultPersistencePath, JsonFilePersistence, MAX_STATE_FILE_BYTES } from "./persistence.js";

export class ConflictError extends Error {}
export class NotFoundError extends Error {}
export class CapacityError extends Error {}
export class PersistenceCompatibilityError extends Error {}

export interface StoreLimits {
  items: number;
  deliveries: number;
  history: number;
}

export const DEFAULT_STORE_LIMITS: Readonly<StoreLimits> = Object.freeze({
  items: 512,
  deliveries: 2_048,
  history: 256,
});

export interface AttentionStoreOptions {
  persistencePath?: string | null;
  limits?: Partial<StoreLimits>;
}

export interface Snapshot {
  protocol: "attention/1";
  cursor: number;
  generated_at: string;
  /** Backward-compatible NEEDS ME queue. */
  items: AttentionItem[];
  /** All current source-active items, including locally snoozed/dismissed items. */
  active: AttentionItem[];
  /** Bounded cleared, completed, and locally dismissed generations, newest first. */
  recent: AttentionItem[];
}

interface DeliveryRecord {
  fingerprint: string;
  item: AttentionItem;
}

interface PersistedStoreState {
  schema: "attention-deck/store/1";
  cursor: number;
  saved_at: string;
  items: AttentionItem[];
  deliveries: Array<{ event_id: string; fingerprint: string; item: AttentionItem }>;
  history: AttentionItem[];
}

interface InternalState {
  cursor: number;
  items: AttentionItem[];
  deliveries: Array<[string, DeliveryRecord]>;
  history: AttentionItem[];
}

const ACTIONS: readonly AttentionAction[] = ["open", "approve", "deny", "dismiss", "snooze"];
const ACTION_STATUSES: readonly ActionStatus[] = ["ready", "sending", "unknown"];
const LOCATOR_TYPES = ["https", "loopback", "app"] as const;
const LOCATOR_QUALITIES = ["exact", "best_effort", "app_only"] as const;
const MAX_PERSISTED_DELIVERIES = 512;

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function storedString(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= maximum ? normalized : undefined;
}

function storedTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}

function fingerprint(value: EmitItem): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function integer(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum ? value as number : undefined;
}

function cloneItem(item: AttentionItem): AttentionItem {
  return {
    ...item,
    ...(item.available_actions ? { available_actions: [...item.available_actions] } : {}),
    ...(item.locator ? { locator: { ...item.locator } } : {}),
  };
}

/** Persisted cards are evidence, never a restored provider action grant. */
function revokeRestoredAuthority(item: AttentionItem): AttentionItem {
  const restored = cloneItem(item);
  const hadProviderDecision = restored.available_actions?.some((action) => action === "approve" || action === "deny")
    || restored.decision_state === "available"
    || restored.decision_state === "sending";
  if (!hadProviderDecision) return restored;
  restored.available_actions = restored.available_actions?.filter((action) => action !== "approve" && action !== "deny") ?? [];
  restored.action_status = "unknown";
  restored.decision_state = "unknown";
  return restored;
}

function inferredDecisionState(actions: AttentionAction[] | undefined, status: ActionStatus | undefined): DecisionState {
  if (status === "sending") return "sending";
  if (status === "unknown") return "unknown";
  if (status === "ready" && actions?.some((action) => action === "approve" || action === "deny")) return "available";
  return "none";
}

/** Strictly validates persisted metadata while supplying additive lifecycle defaults for schema-0 data. */
function parseStoredItem(value: unknown): AttentionItem | undefined {
  const input = object(value);
  if (!input || input.protocol !== "attention/1") return undefined;
  const eventId = storedString(input.event_id, 160);
  const id = storedString(input.id, 240);
  const source = storedString(input.source, 40);
  const project = storedString(input.project, 80);
  const state = ATTENTION_STATES.includes(input.state as AttentionState) ? input.state as AttentionState : undefined;
  const title = storedString(input.title, 120);
  const summary = storedString(input.summary, 600);
  const version = integer(input.version, 1);
  const sequence = integer(input.sequence, 0);
  const priority = integer(input.priority, -10, 10);
  const occurredAt = storedTimestamp(input.occurred_at);
  const firstSeenAt = storedTimestamp(input.first_seen_at);
  const lastSeenAt = storedTimestamp(input.last_seen_at);
  const freshForMs = integer(input.fresh_for_ms, 1_000, 86_400_000);
  if (!eventId || !id || !source || !project || !state || !title || !summary || version === undefined || sequence === undefined
    || priority === undefined || !occurredAt || !firstSeenAt || !lastSeenAt || freshForMs === undefined) return undefined;

  const session = input.session === undefined ? undefined : storedString(input.session, 160);
  if (input.session !== undefined && !session) return undefined;
  const resolvedAt = input.resolved_at === undefined ? undefined : storedTimestamp(input.resolved_at);
  const snoozedUntil = input.snoozed_until === undefined ? undefined : storedTimestamp(input.snoozed_until);
  if (input.resolved_at !== undefined && !resolvedAt) return undefined;
  if (input.snoozed_until !== undefined && !snoozedUntil) return undefined;

  let actions: AttentionAction[] | undefined;
  if (input.available_actions !== undefined) {
    if (!Array.isArray(input.available_actions) || input.available_actions.length > ACTIONS.length) return undefined;
    actions = [];
    for (const action of input.available_actions) {
      if (!ACTIONS.includes(action as AttentionAction) || actions.includes(action as AttentionAction)) return undefined;
      actions.push(action as AttentionAction);
    }
  }
  const actionStatus = input.action_status === undefined
    ? undefined
    : ACTION_STATUSES.includes(input.action_status as ActionStatus) ? input.action_status as ActionStatus : undefined;
  if (input.action_status !== undefined && !actionStatus) return undefined;

  let locator: AttentionItem["locator"];
  if (input.locator !== undefined) {
    const candidate = object(input.locator);
    const locatorType = candidate && LOCATOR_TYPES.includes(candidate.type as (typeof LOCATOR_TYPES)[number])
      ? candidate.type as (typeof LOCATOR_TYPES)[number] : undefined;
    const target = candidate ? storedString(candidate.target, 2_048) : undefined;
    const quality = candidate?.quality === undefined
      ? undefined
      : LOCATOR_QUALITIES.includes(candidate.quality as (typeof LOCATOR_QUALITIES)[number])
        ? candidate.quality as (typeof LOCATOR_QUALITIES)[number] : undefined;
    if (!locatorType || !target || (candidate?.quality !== undefined && !quality)) return undefined;
    locator = { type: locatorType, target, ...(quality ? { quality } : {}) };
  }

  if (input.freshness !== undefined && input.freshness !== "fresh" && input.freshness !== "stale") return undefined;
  const explicitSource = SOURCE_STATES.includes(input.source_state as SourceState) ? input.source_state as SourceState : undefined;
  if (input.source_state !== undefined && !explicitSource) return undefined;
  const sourceState: SourceState = resolvedAt || state === "DONE" ? "cleared" : explicitSource ?? "active";
  const explicitOperator = OPERATOR_STATES.includes(input.operator_state as OperatorState) ? input.operator_state as OperatorState : undefined;
  if (input.operator_state !== undefined && !explicitOperator) return undefined;
  const operatorState: OperatorState = explicitOperator ?? "unseen";
  const defaultPresentation: PresentationState = sourceState === "cleared" ? "recent" : snoozedUntil ? "snoozed" : "visible";
  const explicitPresentation = PRESENTATION_STATES.includes(input.presentation_state as PresentationState)
    ? input.presentation_state as PresentationState : undefined;
  if (input.presentation_state !== undefined && !explicitPresentation) return undefined;
  const presentationState: PresentationState = explicitPresentation ?? defaultPresentation;
  const explicitDecision = DECISION_STATES.includes(input.decision_state as DecisionState) ? input.decision_state as DecisionState : undefined;
  if (input.decision_state !== undefined && !explicitDecision) return undefined;
  const decisionState: DecisionState = explicitDecision ?? inferredDecisionState(actions, actionStatus);
  const generation = input.generation === undefined ? 1 : integer(input.generation, 1);
  const occurrenceCount = input.occurrence_count === undefined ? 1 : integer(input.occurrence_count, 1);
  if (generation === undefined || occurrenceCount === undefined) return undefined;

  const item: AttentionItem = {
    protocol: "attention/1",
    event_id: eventId,
    id,
    source,
    project,
    state,
    title,
    summary,
    version,
    sequence,
    priority,
    occurred_at: occurredAt,
    first_seen_at: firstSeenAt,
    last_seen_at: lastSeenAt,
    fresh_for_ms: freshForMs,
    freshness: input.freshness === "stale" ? "stale" : "fresh",
    generation,
    occurrence_count: occurrenceCount,
    source_state: sourceState,
    operator_state: operatorState,
    presentation_state: sourceState === "cleared" ? "recent" : presentationState,
    decision_state: sourceState === "cleared" && (decisionState === "available" || decisionState === "sending") ? "unknown" : decisionState,
  };
  if (session) item.session = session;
  if (sourceState === "active" && actions) item.available_actions = actions;
  if (sourceState === "active" && actionStatus) item.action_status = actionStatus;
  if (locator) item.locator = locator;
  if (sourceState === "cleared") item.resolved_at = resolvedAt ?? lastSeenAt;
  if (snoozedUntil && sourceState === "active" && presentationState === "snoozed") item.snoozed_until = snoozedUntil;
  return item;
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  return integer(value, 1, 100_000) ?? fallback;
}

function isRecent(item: AttentionItem): boolean {
  return item.source_state === "cleared" || item.presentation_state === "dismissed" || item.state === "DONE";
}

function isNodeTestProcess(): boolean {
  return typeof process.env.NODE_TEST_CONTEXT === "string";
}

export class AttentionStore extends EventEmitter {
  readonly #items = new Map<string, AttentionItem>();
  readonly #deliveries = new Map<string, DeliveryRecord>();
  #history: AttentionItem[] = [];
  #cursor = 0;
  readonly #limits: StoreLimits;
  readonly #persistence: JsonFilePersistence | undefined;
  #persistenceWriteBlocked: string | undefined;

  constructor(options: AttentionStoreOptions = {}) {
    super();
    this.#limits = {
      items: normalizeLimit(options.limits?.items, DEFAULT_STORE_LIMITS.items),
      deliveries: normalizeLimit(options.limits?.deliveries, DEFAULT_STORE_LIMITS.deliveries),
      history: normalizeLimit(options.limits?.history, DEFAULT_STORE_LIMITS.history),
    };
    const persistencePath = options.persistencePath === null
      ? null
      : options.persistencePath !== undefined
        ? options.persistencePath
        : isNodeTestProcess() ? null : defaultPersistencePath();
    this.#persistence = persistencePath === null ? undefined : new JsonFilePersistence(persistencePath);
    const loaded = this.#persistence?.load();
    if (loaded?.status === "loaded" && !this.#load(loaded.value)) {
      this.#persistenceWriteBlocked = "persisted state has an unsupported or invalid schema";
    } else if (loaded?.status === "blocked") {
      this.#persistenceWriteBlocked = loaded.reason;
    }
  }

  upsert(input: EmitItem, now = new Date()): AttentionItem {
    return this.#upsert(input, now);
  }

  upsertTrusted(input: EmitItem, now = new Date()): AttentionItem {
    return this.#upsert(input, now);
  }

  #upsert(input: EmitItem, now: Date): AttentionItem {
    const deliveryId = input.event_id;
    const deliveryFingerprint = fingerprint(input);
    if (deliveryId && this.#deliveries.has(deliveryId)) {
      const delivery = this.#deliveries.get(deliveryId)!;
      if (delivery.fingerprint !== deliveryFingerprint) throw new ConflictError("event_id was already used with different content");
      return refreshPresentation(refreshFreshness(cloneItem(delivery.item), now), now);
    }

    const lookupId = input.session ? `${input.source}:${input.session}` : deliveryId;
    const existing = lookupId ? this.#items.get(lookupId) : undefined;
    if (existing && input.version !== undefined && input.version <= existing.version) {
      throw new ConflictError(`item version must be greater than ${existing.version}`);
    }
    if (existing && input.sequence !== undefined && input.sequence <= existing.sequence) {
      throw new ConflictError(`sequence must be greater than ${existing.sequence}`);
    }
    const materialized = materializeItem(input, existing, now);
    const item = parseStoredItem(materialized);
    if (!item) throw new RangeError("trusted item exceeds bounded persisted-item schema");

    return this.#transaction(() => {
      if (!existing) this.#makeItemRoom();
      else if (isRecent(existing)) this.#recordHistory(existing);
      this.#items.set(item.id, item);
      this.#deliveries.set(item.event_id, { fingerprint: deliveryFingerprint, item: cloneItem(item) });
      while (this.#deliveries.size > this.#limits.deliveries) {
        this.#deliveries.delete(this.#deliveries.keys().next().value as string);
      }
      return item;
    });
  }

  get(id: string, now = new Date()): AttentionItem | undefined {
    const item = this.#items.get(id);
    return item ? refreshPresentation(refreshFreshness(cloneItem(item), now), now) : undefined;
  }

  /** Local presentation-only dismissal. It never clears provider source state. */
  dismiss(id: string, expectedVersion: number): AttentionItem {
    const existing = this.#current(id, expectedVersion);
    if (existing.source_state === "cleared") return cloneItem(existing);
    return this.#transaction(() => {
      const { snoozed_until: _snoozedUntil, ...rest } = existing;
      const dismissed: AttentionItem = {
        ...rest,
        operator_state: "seen",
        presentation_state: "dismissed",
      };
      this.#items.set(id, dismissed);
      return dismissed;
    });
  }

  /** Backward-compatible broker alias; provider adapters should call clear(). */
  resolve(id: string, expectedVersion: number): AttentionItem {
    return this.dismiss(id, expectedVersion);
  }

  /** Authoritative provider clear. Local UI actions must not call this method. */
  clear(
    id: string,
    expectedVersion: number,
    now = new Date(),
    decisionOutcome?: Extract<DecisionState, "accepted" | "rejected">,
  ): AttentionItem {
    const existing = this.#current(id, expectedVersion);
    if (existing.source_state === "cleared") return cloneItem(existing);
    return this.#transaction(() => {
      const {
        snoozed_until: _snoozedUntil,
        available_actions: _actions,
        action_status: _actionStatus,
        ...rest
      } = existing;
      const cleared: AttentionItem = {
        ...rest,
        source_state: "cleared",
        presentation_state: "recent",
        decision_state: decisionOutcome ?? "none",
        available_actions: [],
        resolved_at: now.toISOString(),
        last_seen_at: now.toISOString(),
      };
      this.#items.set(id, cleared);
      return cleared;
    });
  }

  snooze(id: string, expectedVersion: number, durationMs: number, now = new Date()): AttentionItem {
    if (!Number.isSafeInteger(durationMs) || durationMs < 60_000 || durationMs > 604_800_000) {
      throw new RangeError("durationMs must be 60000-604800000");
    }
    const existing = this.#current(id, expectedVersion);
    if (existing.source_state !== "active") throw new ConflictError("cleared items cannot be snoozed");
    return this.#transaction(() => {
      const snoozed: AttentionItem = {
        ...existing,
        operator_state: "seen",
        presentation_state: "snoozed",
        snoozed_until: new Date(now.getTime() + durationMs).toISOString(),
      };
      this.#items.set(id, snoozed);
      return snoozed;
    });
  }

  snapshot(now = new Date()): Snapshot {
    const current = [...this.#items.values()].map((item) => refreshPresentation(refreshFreshness(cloneItem(item), now), now));
    const active = current.filter((item) => item.source_state === "active").sort(compareAttention);
    const recentByGeneration = new Map<string, AttentionItem>();
    for (const item of [...this.#history, ...current]) {
      if (!isRecent(item)) continue;
      recentByGeneration.set(`${item.id}:${item.generation}`, refreshFreshness(cloneItem(item), now));
    }
    const recent = [...recentByGeneration.values()]
      .sort((left, right) => Date.parse(right.last_seen_at) - Date.parse(left.last_seen_at) || right.generation - left.generation)
      .slice(0, this.#limits.history);
    return {
      protocol: "attention/1",
      cursor: this.#cursor,
      generated_at: now.toISOString(),
      items: active.filter((item) => isNeedsMe(item, now)),
      active,
      recent,
    };
  }

  #current(id: string, expectedVersion: number): AttentionItem {
    const existing = this.#items.get(id);
    if (!existing) throw new NotFoundError("item not found");
    if (existing.version !== expectedVersion) throw new ConflictError("item changed; refresh before acting");
    return existing;
  }

  #makeItemRoom(): void {
    if (this.#items.size < this.#limits.items) return;
    const evictable = [...this.#items.values()]
      .filter((item) => item.source_state === "cleared" || item.presentation_state === "dismissed" || item.state === "DONE" || item.state === "WORKING")
      .sort((left, right) => Date.parse(left.last_seen_at) - Date.parse(right.last_seen_at))[0];
    if (!evictable) throw new CapacityError("attention item capacity reached; active human-attention items were preserved");
    if (isRecent(evictable)) this.#recordHistory(evictable);
    this.#items.delete(evictable.id);
  }

  #recordHistory(item: AttentionItem): void {
    this.#history.push(cloneItem(item));
    if (this.#history.length > this.#limits.history) {
      this.#history.splice(0, this.#history.length - this.#limits.history);
    }
  }

  #transaction<T>(mutate: () => T): T {
    if (this.#persistenceWriteBlocked) {
      throw new PersistenceCompatibilityError(`persistence is read-only: ${this.#persistenceWriteBlocked}`);
    }
    const previous = this.#capture();
    let result: T;
    try {
      result = mutate();
      this.#cursor += 1;
      this.#persistence?.save(this.#persisted());
    } catch (error) {
      this.#restore(previous);
      throw error;
    }
    try {
      this.emit("changed", this.#cursor);
    } catch {
      // Listener failures must not roll memory back after durable state committed.
    }
    return result;
  }

  #capture(): InternalState {
    return {
      cursor: this.#cursor,
      items: [...this.#items.values()].map(cloneItem),
      deliveries: [...this.#deliveries.entries()].map(([eventId, delivery]) => [eventId, {
        fingerprint: delivery.fingerprint,
        item: cloneItem(delivery.item),
      }]),
      history: this.#history.map(cloneItem),
    };
  }

  #restore(state: InternalState): void {
    this.#cursor = state.cursor;
    this.#items.clear();
    for (const item of state.items) this.#items.set(item.id, cloneItem(item));
    this.#deliveries.clear();
    for (const [eventId, delivery] of state.deliveries) {
      this.#deliveries.set(eventId, { fingerprint: delivery.fingerprint, item: cloneItem(delivery.item) });
    }
    this.#history = state.history.map(cloneItem);
  }

  #persisted(): PersistedStoreState {
    const state: PersistedStoreState = {
      schema: "attention-deck/store/1",
      cursor: this.#cursor,
      saved_at: new Date().toISOString(),
      items: [...this.#items.values()].map(cloneItem),
      deliveries: [],
      history: this.#history.map(cloneItem),
    };
    const baseBytes = Buffer.byteLength(JSON.stringify(state), "utf8") + 1;
    if (baseBytes > MAX_STATE_FILE_BYTES) throw new RangeError("current items and history exceed the persistence byte limit");
    let usedBytes = baseBytes;
    const newest: PersistedStoreState["deliveries"] = [];
    const entries = [...this.#deliveries.entries()];
    for (let index = entries.length - 1; index >= 0 && newest.length < MAX_PERSISTED_DELIVERIES; index -= 1) {
      const [eventId, delivery] = entries[index]!;
      const row = { event_id: eventId, fingerprint: delivery.fingerprint, item: cloneItem(delivery.item) };
      const rowBytes = Buffer.byteLength(JSON.stringify(row), "utf8") + (newest.length > 0 ? 1 : 0);
      if (usedBytes + rowBytes > MAX_STATE_FILE_BYTES) break;
      newest.push(row);
      usedBytes += rowBytes;
    }
    state.deliveries = newest.reverse();
    return state;
  }

  #load(raw: unknown): boolean {
    const input = object(raw);
    if (!input) return false;
    if (input.schema !== undefined && input.schema !== "attention-deck/store/1" && input.schema !== "attention-deck/store/0") return false;
    if (!Array.isArray(input.items)) return false;

    const rawItems = input.items.slice(-this.#limits.items);
    const parsedItems = rawItems.map(parseStoredItem);
    if (parsedItems.some((item) => item === undefined)) return false;

    const parsedDeliveries: Array<[string, DeliveryRecord]> = [];
    if (input.deliveries !== undefined) {
      if (!Array.isArray(input.deliveries)) return false;
      for (const rawDelivery of input.deliveries.slice(-this.#limits.deliveries)) {
        const delivery = object(rawDelivery);
        const eventId = delivery ? storedString(delivery.event_id, 160) : undefined;
        const deliveryFingerprint = delivery ? storedString(delivery.fingerprint, 64) : undefined;
        const item = delivery ? parseStoredItem(delivery.item) : undefined;
        if (!eventId || !deliveryFingerprint || !/^[a-f0-9]{64}$/u.test(deliveryFingerprint) || !item) return false;
        parsedDeliveries.push([eventId, { fingerprint: deliveryFingerprint, item: revokeRestoredAuthority(item) }]);
      }
    }

    let parsedHistory: AttentionItem[] = [];
    if (input.history !== undefined) {
      if (!Array.isArray(input.history)) return false;
      const candidates = input.history.slice(-this.#limits.history).map(parseStoredItem);
      if (candidates.some((item) => item === undefined)) return false;
      parsedHistory = candidates.map((item) => revokeRestoredAuthority(item!));
    }

    for (const item of parsedItems) this.#items.set(item!.id, revokeRestoredAuthority(item!));
    for (const [eventId, delivery] of parsedDeliveries) this.#deliveries.set(eventId, delivery);
    this.#history = parsedHistory;
    this.#cursor = integer(input.cursor, 0) ?? 0;
    return true;
  }
}
