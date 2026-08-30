# Attention Protocol v1 Draft

The public emit API is intentionally display-only. Trusted adapters run inside the broker process and may add validated locators and action capabilities that generic callers cannot declare.

> **Alpha compatibility note:** the expanded lifecycle snapshot is additive and automated-test qualified, but physical restart and reconnect qualification is still pending.

## Emit

`POST /v1/events` with `Authorization: Bearer <local token>` and `Content-Type: application/json`.

```json
{
  "protocol": "attention/1",
  "event_id": "unique-delivery-id",
  "source": "build-script",
  "project": "Website",
  "session": "deploy-42",
  "state": "FAILED",
  "title": "Deployment failed",
  "summary": "Health check returned HTTP 502.",
  "version": 1,
  "sequence": 18,
  "priority": 0,
  "occurred_at": "2026-08-29T20:00:00Z",
  "fresh_for_ms": 300000
}
```

Normalized task states are `WORKING`, `INPUT`, `APPROVAL`, `REVIEW`, `DONE`, and `FAILED`. Source state is independently `active` or `cleared`. `DISCONNECTED` is broker/adapter health, not a source-authored lifecycle result.

Identity and ordering:

- `event_id` identifies one delivery. Identical retries are harmless; different content with the same ID is a conflict.
- `source + session` is the stable queue item identity when session is present.
- `version` must increase when the logical request changes.
- `sequence` must increase within a producer stream.
- Producer timestamps are display data. Broker receipt time controls first-seen and freshness.

Limits are enforced for every string and the complete body. Generic events cannot contain commands, callbacks, provider approval actions, or arbitrary custom-scheme locators.

## Lifecycle projection increment

One persisted item projects four independent dimensions rather than asking a single field to represent provider truth, inbox treatment, display placement, and action progress:

```json
{
  "state": "APPROVAL",
  "source_state": "active",
  "operator_state": "unseen",
  "presentation_state": "visible",
  "decision_state": "available",
  "generation": 4,
  "occurrence_count": 2
}
```

The values above describe the alpha public projection:

- `state`: normalized task classification: `WORKING`, `INPUT`, `APPROVAL`, `REVIEW`, `DONE`, or `FAILED`.
- `source_state`: authoritative lifecycle ownership: `active` or `cleared`.
- `operator_state`: local handling: `unseen`, `seen`, or `claimed`.
- `presentation_state`: local card treatment: `visible`, `snoozed`, `dismissed`, or `recent`.
- `decision_state`: provider action progress: `none`, `available`, `sending`, `accepted`, `rejected`, or `unknown`.
- `generation`: increments when a previously dismissed or provider-cleared episode recurs for one stable item identity.
- `occurrence_count`: counts accepted updates for that stable item; idempotent delivery retries do not add another occurrence.

The broker derives operator/presentation transitions and validates decision transitions; a generic emitter cannot declare provider-decision state. `state` remains the normalized work classification and is deliberately separate from `source_state`.

### Clear, dismiss, and recurrence

An **authoritative clear** is a newer source/adapter transition that the item is no longer active. It sets `source_state: "cleared"` and places the retained generation in recent history.

A **local dismiss** sets `presentation_state: "dismissed"` for the current generation. It removes that generation from NEEDS ME without setting `source_state: "cleared"` or asserting that the provider request completed, failed, was approved, or was denied. A later generation or higher authoritative version may re-enter NEEDS ME.

Repeated delivery of the same event remains idempotent. Each accepted newer provider version increments occurrence count rather than creating a duplicate card and resets local snooze/dismiss treatment. Generation increments only when that update reactivates a dismissed or provider-cleared episode.

## Snapshot

The current endpoint is:

```text
GET /v1/snapshot
```

The endpoint retains `items` as the ordered unsnoozed NEEDS ME queue and adds the collections below. Older snapshot clients can continue reading `items`; the device-view code also treats absent expanded collections as empty.

The increment extends the snapshot with:

- `items`: visible, unsnoozed NEEDS ME items;
- `active`: all current `source_state: "active"` items, including locally snoozed or dismissed items, for reconciliation and the device's ACTIVE projection;
- `recent`: at most 256 retained terminal or locally dismissed generations.

The `active` collection is a lifecycle/reconciliation set, not a claim that every member is currently WORKING. The device derives its ACTIVE presentation from the item's normalized task state and locks decision actions outside NEEDS ME. RECENT is not an event log or transcript archive. Every snapshot includes a cursor so the surface can replace its full local projection after restart, wake, or reconnect.

## Local actions

```text
POST /v1/items/{id}/actions/dismiss  { "version": 3 }
POST /v1/items/{id}/actions/snooze   { "version": 3, "duration_ms": 300000 }
```

The exact version is mandatory. An update between display and press returns `409 Conflict` and performs no action. Snooze duration is bounded to 60 seconds through seven days; the device offers a smaller fixed set of choices. A higher item version or new generation wakes the item immediately.

`dismiss` is operator-local and sets presentation state to dismissed. The increment's store has a separate trusted `clear(id, version)` transition for authoritative source clear. The previous internal use of `resolve` for dismiss is legacy behavior and must not be interpreted as provider resolution.

## Restart-safe persistence increment

The broker atomically persists only the bounded state required to reconstruct the local surface at `%LOCALAPPDATA%\Preflight Stack\Attention Deck\state.json` by default:

- current item identity, source state, generation, occurrence count, version/sequence, and broker timestamps;
- operator snooze/dismiss state and its expiry;
- bounded RECENT outcome metadata;
- no provider request grant, open app-server connection, pending JSON-RPC responder, or automatically retryable action.

The in-memory store is capped at 512 current items, 2,048 delivery-id deduplication records, and 256 recent/history records. The 8 MiB state file keeps at most the newest 512 delivery-id records and trims that subset further if needed. Oversized or malformed JSON is quarantined; unreadable, unquarantinable, or unsupported-schema state makes persistence read-only instead of allowing the next mutation to overwrite it.

On restart, persisted cards are local evidence, not current provider authority. They may render immediately with conservative freshness, but APPROVE/DENY remain unavailable until a trusted adapter reconnects, completes a fresh snapshot, and re-establishes the exact live capability. Unknown provider outcomes remain unknown and are never replayed.

## Provider action extension

Trusted adapters attach `available_actions` only to broker-owned items. The public HTTP broker deliberately exposes no provider-approval route. A physical APPROVE or DENY hold dispatches inside the plugin process directly to the trusted adapter.

The Codex adapter advertises only the intersection of decisions explicitly offered in `availableDecisions` and the actions Attention Deck supports. Network approval never exposes APPROVE in the current release. Each provider mutation is bound to:

- one app-server connection epoch and opaque JSON-RPC request ID;
- item ID and exact version;
- exact Codex `threadId + turnId + itemId`;
- one physical attempt ID and one reply reservation.

The adapter revalidates the same live request before writing one response. `serverRequest/resolved` revokes the grant, while `item/completed` is authoritative for execution outcome. A transport loss after dispatch produces `action_status: unknown`; unknown outcomes are never retried automatically.
