import { EventEmitter } from "node:events";
import {
  compareAttention,
  isNeedsMe,
  materializeItem,
  refreshFreshness,
  type AttentionItem,
  type EmitItem,
} from "./protocol.js";

export class ConflictError extends Error {}
export class NotFoundError extends Error {}

export interface Snapshot {
  protocol: "attention/1";
  cursor: number;
  generated_at: string;
  items: AttentionItem[];
}

export class AttentionStore extends EventEmitter {
  readonly #items = new Map<string, AttentionItem>();
  readonly #deliveries = new Map<string, { fingerprint: string; item: AttentionItem }>();
  #cursor = 0;

  upsert(input: EmitItem, now = new Date()): AttentionItem {
    return this.#upsert(input, now);
  }

  upsertTrusted(input: EmitItem, now = new Date()): AttentionItem {
    return this.#upsert(input, now);
  }

  #upsert(input: EmitItem, now: Date): AttentionItem {
    const deliveryId = input.event_id;
    const fingerprint = JSON.stringify(input);
    if (deliveryId && this.#deliveries.has(deliveryId)) {
      const delivery = this.#deliveries.get(deliveryId)!;
      if (delivery.fingerprint !== fingerprint) throw new ConflictError("event_id was already used with different content");
      return refreshFreshness(delivery.item, now);
    }

    const lookupId = input.session ? `${input.source}:${input.session}` : deliveryId;
    const existing = lookupId ? this.#items.get(lookupId) : undefined;
    if (existing && input.version !== undefined && input.version <= existing.version) {
      throw new ConflictError(`item version must be greater than ${existing.version}`);
    }
    if (existing && input.sequence !== undefined && input.sequence <= existing.sequence) {
      throw new ConflictError(`sequence must be greater than ${existing.sequence}`);
    }
    const item = materializeItem(input, existing, now);
    if (existing?.snoozed_until && item.version === existing.version) item.snoozed_until = existing.snoozed_until;
    this.#items.set(item.id, item);
    this.#deliveries.set(item.event_id, { fingerprint, item });
    this.#changed();
    return item;
  }

  get(id: string, now = new Date()): AttentionItem | undefined {
    const item = this.#items.get(id);
    return item ? refreshFreshness(item, now) : undefined;
  }

  resolve(id: string, expectedVersion: number, now = new Date()): AttentionItem {
    const existing = this.#items.get(id);
    if (!existing) throw new NotFoundError("item not found");
    if (existing.version !== expectedVersion) throw new ConflictError("item changed; refresh before acting");
    if (existing.resolved_at) return existing;
    const resolved = { ...existing, resolved_at: now.toISOString(), version: existing.version + 1 };
    this.#items.set(id, resolved);
    this.#changed();
    return resolved;
  }

  snooze(id: string, expectedVersion: number, durationMs: number, now = new Date()): AttentionItem {
    const existing = this.#items.get(id);
    if (!existing) throw new NotFoundError("item not found");
    if (existing.version !== expectedVersion) throw new ConflictError("item changed; refresh before acting");
    const snoozed = { ...existing, snoozed_until: new Date(now.getTime() + durationMs).toISOString() };
    this.#items.set(id, snoozed);
    this.#changed();
    return snoozed;
  }

  snapshot(now = new Date()): Snapshot {
    return {
      protocol: "attention/1",
      cursor: this.#cursor,
      generated_at: now.toISOString(),
      items: [...this.#items.values()].map((item) => refreshFreshness(item, now)).filter((item) => isNeedsMe(item, now)).sort(compareAttention),
    };
  }

  #changed(): void {
    this.#cursor += 1;
    this.emit("changed", this.#cursor);
  }
}
