# Attention Protocol v1 Draft

The public emit API is intentionally display-only. Trusted adapters run inside the broker process and may add validated locators and action capabilities that generic callers cannot declare.

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

States are `WORKING`, `INPUT`, `APPROVAL`, `REVIEW`, `DONE`, and `FAILED`.

Identity and ordering:

- `event_id` identifies one delivery. Identical retries are harmless; different content with the same ID is a conflict.
- `source + session` is the stable queue item identity when session is present.
- `version` must increase when the logical request changes.
- `sequence` must increase within a producer stream.
- Producer timestamps are display data. Broker receipt time controls first-seen and freshness.

Limits are enforced for every string and the complete body. Generic events cannot contain commands, callbacks, provider approval actions, or arbitrary custom-scheme locators.

## Snapshot

`GET /v1/snapshot` returns the ordered unsnoozed NEEDS ME queue with broker-owned `first_seen_at`, `last_seen_at`, `freshness`, current `version`, and cursor.

## Local actions

```text
POST /v1/items/{id}/actions/dismiss  { "version": 3 }
POST /v1/items/{id}/actions/snooze   { "version": 3, "duration_ms": 300000 }
```

The exact version is mandatory. An update between display and press returns `409 Conflict` and performs no action.

## Provider action extension

Trusted adapters attach `available_actions` only to broker-owned items. The public HTTP broker deliberately exposes no provider-approval route. A physical APPROVE or DENY hold dispatches inside the plugin process directly to the trusted adapter.

The Codex adapter advertises only the intersection of decisions explicitly offered in `availableDecisions` and the actions Attention Deck supports. Network approval never exposes APPROVE in the current release. Each provider mutation is bound to:

- one app-server connection epoch and opaque JSON-RPC request ID;
- item ID and exact version;
- exact Codex `threadId + turnId + itemId`;
- one physical attempt ID and one reply reservation.

The adapter revalidates the same live request before writing one response. `serverRequest/resolved` revokes the grant, while `item/completed` is authoritative for execution outcome. A transport loss after dispatch produces `action_status: unknown`; unknown outcomes are never retried automatically.
