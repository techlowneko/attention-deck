import { randomUUID } from "node:crypto";

export const ATTENTION_STATES = [
  "WORKING",
  "INPUT",
  "APPROVAL",
  "REVIEW",
  "DONE",
  "FAILED",
] as const;

export type AttentionState = (typeof ATTENTION_STATES)[number];
export type Freshness = "fresh" | "stale";
export type AttentionAction = "open" | "approve" | "deny" | "dismiss" | "snooze";
export type ActionStatus = "ready" | "sending" | "unknown";

export const SOURCE_STATES = ["active", "cleared"] as const;
export const OPERATOR_STATES = ["unseen", "seen", "claimed"] as const;
export const PRESENTATION_STATES = ["visible", "snoozed", "dismissed", "recent"] as const;
export const DECISION_STATES = ["none", "available", "sending", "accepted", "rejected", "unknown"] as const;

export type SourceState = (typeof SOURCE_STATES)[number];
export type OperatorState = (typeof OPERATOR_STATES)[number];
export type PresentationState = (typeof PRESENTATION_STATES)[number];
export type DecisionState = (typeof DECISION_STATES)[number];

export interface EmitItem {
  protocol?: "attention/1";
  event_id?: string;
  source: string;
  project: string;
  session?: string;
  state: AttentionState;
  title: string;
  summary: string;
  version?: number;
  sequence?: number;
  priority?: number;
  occurred_at?: string;
  fresh_for_ms?: number;
  available_actions?: AttentionAction[];
  action_status?: ActionStatus;
  source_state?: SourceState;
  decision_state?: DecisionState;
  locator?: {
    type: "https" | "loopback" | "app";
    target: string;
    quality?: "exact" | "best_effort" | "app_only";
  };
}

export interface AttentionItem {
  protocol: "attention/1";
  event_id: string;
  id: string;
  source: string;
  project: string;
  session?: string;
  state: AttentionState;
  title: string;
  summary: string;
  version: number;
  sequence: number;
  priority: number;
  occurred_at: string;
  first_seen_at: string;
  last_seen_at: string;
  fresh_for_ms: number;
  freshness: Freshness;
  generation: number;
  occurrence_count: number;
  source_state: SourceState;
  operator_state: OperatorState;
  presentation_state: PresentationState;
  decision_state: DecisionState;
  available_actions?: AttentionAction[];
  action_status?: ActionStatus;
  locator?: EmitItem["locator"];
  resolved_at?: string;
  snoozed_until?: string;
}

const STATE_WEIGHT: Record<AttentionState, number> = {
  APPROVAL: 600,
  INPUT: 500,
  FAILED: 400,
  REVIEW: 300,
  DONE: 200,
  WORKING: 100,
};

const TEXT_LIMITS = {
  source: 40,
  project: 80,
  session: 160,
  title: 120,
  summary: 600,
} as const;

function text(value: unknown, field: keyof typeof TEXT_LIMITS): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > TEXT_LIMITS[field]) {
    throw new Error(`${field} must be 1-${TEXT_LIMITS[field]} characters`);
  }
  return normalized;
}

function timestamp(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error("occurred_at must be an ISO-8601 timestamp");
  }
  return new Date(value).toISOString();
}

export function validateEmitItem(value: unknown, _now = new Date()): EmitItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("event must be a JSON object");
  }
  const input = value as Record<string, unknown>;
  if (input.protocol !== undefined && input.protocol !== "attention/1") {
    throw new Error("unsupported protocol");
  }
  if (!ATTENTION_STATES.includes(input.state as AttentionState)) {
    throw new Error(`state must be one of ${ATTENTION_STATES.join(", ")}`);
  }
  const parsed: EmitItem = {
    protocol: "attention/1",
    source: text(input.source, "source"),
    project: text(input.project, "project"),
    state: input.state as AttentionState,
    title: text(input.title, "title"),
    summary: text(input.summary, "summary"),
  };
  const occurredAt = timestamp(input.occurred_at);
  if (occurredAt !== undefined) parsed.occurred_at = occurredAt;
  if (input.event_id !== undefined) parsed.event_id = text(input.event_id, "session");
  if (input.session !== undefined) parsed.session = text(input.session, "session");
  if (input.version !== undefined) {
    if (!Number.isSafeInteger(input.version) || (input.version as number) < 1) throw new Error("version must be a positive integer");
    parsed.version = input.version as number;
  }
  if (input.sequence !== undefined) {
    if (!Number.isSafeInteger(input.sequence) || (input.sequence as number) < 0) throw new Error("sequence must be a non-negative integer");
    parsed.sequence = input.sequence as number;
  }
  if (input.priority !== undefined) {
    if (!Number.isInteger(input.priority) || (input.priority as number) < -10 || (input.priority as number) > 10) {
      throw new Error("priority must be an integer from -10 to 10");
    }
    parsed.priority = input.priority as number;
  }
  if (input.fresh_for_ms !== undefined) {
    if (!Number.isInteger(input.fresh_for_ms) || (input.fresh_for_ms as number) < 1000 || (input.fresh_for_ms as number) > 86_400_000) {
      throw new Error("fresh_for_ms must be 1000-86400000");
    }
    parsed.fresh_for_ms = input.fresh_for_ms as number;
  }
  if (input.source_state !== undefined) {
    if (!SOURCE_STATES.includes(input.source_state as SourceState)) {
      throw new Error(`source_state must be one of ${SOURCE_STATES.join(", ")}`);
    }
    parsed.source_state = input.source_state as SourceState;
  }
  if (input.locator !== undefined) {
    throw new Error("generic events cannot declare locators; use a trusted adapter");
  }
  if (input.available_actions !== undefined || input.action_status !== undefined || input.decision_state !== undefined) {
    throw new Error("generic events cannot declare actions; use a trusted adapter");
  }
  return parsed;
}

function deriveDecisionState(input: EmitItem): DecisionState {
  if (input.decision_state !== undefined) return input.decision_state;
  if (input.action_status === "sending") return "sending";
  if (input.action_status === "unknown") return "unknown";
  if (input.action_status === "ready" && input.available_actions?.some((action) => action === "approve" || action === "deny")) {
    return "available";
  }
  return "none";
}

export function materializeItem(input: EmitItem, existing: AttentionItem | undefined, now = new Date()): AttentionItem {
  const eventId = input.event_id ?? randomUUID();
  const stableId = input.session ? `${input.source}:${input.session}` : eventId;
  const sourceState = input.source_state ?? (input.state === "DONE" ? "cleared" : "active");
  const derivedDecision = deriveDecisionState(input);
  const decisionState: DecisionState = sourceState === "cleared" && (derivedDecision === "available" || derivedDecision === "sending")
    ? "unknown"
    : derivedDecision;
  const reactivated = existing !== undefined && (existing.source_state === "cleared" || existing.presentation_state === "dismissed");
  const firstSeenAt = existing && !reactivated ? existing.first_seen_at : now.toISOString();
  const item: AttentionItem = {
    protocol: "attention/1",
    event_id: eventId,
    id: stableId,
    source: input.source,
    project: input.project,
    state: input.state,
    title: input.title,
    summary: input.summary,
    version: input.version ?? ((existing?.version ?? 0) + 1),
    sequence: input.sequence ?? ((existing?.sequence ?? -1) + 1),
    priority: input.priority ?? 0,
    occurred_at: input.occurred_at ?? now.toISOString(),
    first_seen_at: firstSeenAt,
    last_seen_at: now.toISOString(),
    fresh_for_ms: input.fresh_for_ms ?? 300_000,
    freshness: "fresh",
    generation: existing ? existing.generation + (reactivated ? 1 : 0) : 1,
    occurrence_count: (existing?.occurrence_count ?? 0) + 1,
    source_state: sourceState,
    operator_state: "unseen",
    presentation_state: sourceState === "cleared" ? "recent" : "visible",
    decision_state: decisionState,
  };
  if (input.session !== undefined) item.session = input.session;
  if (input.locator !== undefined) item.locator = input.locator;
  if (sourceState === "active" && input.available_actions !== undefined) item.available_actions = [...input.available_actions];
  if (sourceState === "active" && input.action_status !== undefined) item.action_status = input.action_status;
  if (sourceState === "cleared") item.resolved_at = now.toISOString();
  return item;
}

export function refreshFreshness(item: AttentionItem, now = new Date()): AttentionItem {
  const stale = now.getTime() - Date.parse(item.last_seen_at) > item.fresh_for_ms;
  return { ...item, freshness: stale ? "stale" : "fresh" };
}

export function refreshPresentation(item: AttentionItem, now = new Date()): AttentionItem {
  if (item.presentation_state !== "snoozed" || !item.snoozed_until || Date.parse(item.snoozed_until) > now.getTime()) {
    return item;
  }
  const { snoozed_until: _expired, ...rest } = item;
  return { ...rest, presentation_state: "visible" };
}

export function compareAttention(a: AttentionItem, b: AttentionItem): number {
  const weight = (item: AttentionItem) => STATE_WEIGHT[item.state] + item.priority;
  return weight(b) - weight(a) || Date.parse(a.first_seen_at) - Date.parse(b.first_seen_at) || a.id.localeCompare(b.id);
}

export function isNeedsMe(item: AttentionItem, now = new Date()): boolean {
  if (item.source_state !== "active" || item.resolved_at) return false;
  const presented = refreshPresentation(item, now);
  if (presented.presentation_state !== "visible") return false;
  return ["APPROVAL", "INPUT", "FAILED", "REVIEW"].includes(item.state);
}
