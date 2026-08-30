# Attention Deck — Product Requirements Document

Status: working vertical slice with Codex adapter foundation, 2026-08-30

## Decision

Build a Stream Deck+ inbox for software that is blocked on a person. The first release is one self-contained Stream Deck plugin with an embedded, authenticated loopback broker and a small generic CLI. It proves the entire physical workflow before provider-specific integrations add complexity.

The first real provider adapter is Codex app-server because OpenAI documents thread status, streamed events, and request-scoped approval messages. Direct APPROVE/DENY is enabled only for a server request received by the adapter's own connection and correlated to its exact JSON-RPC request ID plus `threadId + turnId + itemId`. A second Windows stdio app-server cannot attach to the desktop app's private stdio connection, so desktop-owned approvals are never reconstructed from thread status.

## Problem

People running several agents repeatedly scan windows to discover whether any agent needs input. Most scans find nothing. When an agent is blocked, the delay wastes both compute time and human momentum.

## Product promise

At desk distance, answer:

1. Who needs me?
2. Why?
3. How long have they waited?
4. What safe action can I take now?

The primary metric is avoided context switches per working day. Secondary metrics are median time-to-response for blocked work and the fraction of items resolved from the Deck.

## Target user and environment

- One developer on Windows with one Stream Deck+.
- Multiple local or reachable agent sessions.
- The current test target is Stream Deck 7.0.3 with its bundled Node 20 runtime. The release target will move to the current Elgato baseline after an explicit app update and compatibility test.
- No remote broker, public port, or arbitrary command execution in v0.1.

## MVP jobs

- Show an ALL CLEAR state when nothing needs attention.
- Accept a generic local event and display it within two seconds.
- Rank blocked work, select any queued item, and show a bounded explanation.
- Display staleness honestly.
- Dismiss or snooze a generic event from hardware.
- OPEN only a trusted adapter locator; never execute emitter-supplied shell text.
- Survive Stream Deck reconnect and system wake without replaying an action.

## Device workflow

### All clear

The strip reads `NOTHING NEEDS YOU` with a small last-sync age. Keys remain nearly black. WORKING and DONE do not occupy attention cards.

### Attention

Top row keys 1–4 show the first four items. Pressing selects; it never mutates. Bottom row is contextual:

| Key | Function |
| --- | --- |
| 5 | OPEN when a trusted locator exists |
| 6 | APPROVE when the adapter holds an exact live request |
| 7 | DENY for an exact live request; DISMISS for a generic item |
| 8 | SNOOZE (five-minute broker snooze) |

Unsupported actions are blank. State uses a word, glyph, and border; color is supplemental.

The four 200×100 encoder regions are coordinated but independent:

| Dial | Strip region | Rotate | Push/touch |
| --- | --- | --- | --- |
| 1 | Item and queue position | select item | OPEN |
| 2 | Explanation page | page summary | return to page 1 |
| 3 | Available action | select action | execute; APPROVE/DENY require a 750 ms hold |
| 4 | View/health | reserved for NEEDS ME / ACTIVE / RECENT | return to NEEDS ME |

## Priority

Default ordering is `APPROVAL > INPUT > FAILED > REVIEW`; within a state, explicit priority then oldest first. This favors resuming blocked work. The PRD handoff proposed FAILED first; dogfooding will decide whether severity should override resume value. DONE appears only in RECENT and WORKING only in the idle aggregate.

## Functional requirements

### P0

- Authenticated `127.0.0.1` JSON API.
- Strict bounded event validation, delivery deduplication, monotonic item version/sequence.
- Fresh/stale computation from broker receipt time.
- Snapshot, emit, dismiss, and snooze operations.
- Shared device coordinator for eight key and four encoder instances.
- Stream Deck+ profile/install instructions and automated core tests.

### P1

- Atomic persistence of unresolved items and first-seen age.
- Server-sent updates rather than polling.
- Trusted locator registry and safe Windows OPEN launcher.
- Codex app-server adapter: stable stdio initialization, thread inventory, approval lifecycle events, best-effort task deep-link, and fail-closed disconnect behavior.

### P2

- Desktop/CLI completion notify bridge and bounded persistence.
- Claude Code hooks adapter.
- OpenClaw adapter and an explicit remote-broker threat model.

## Safety requirements

- Generic emitters are display-only; they cannot declare approval callbacks, executable paths, or shell commands.
- Local mutations are bound to item ID and exact version. Provider mutations are additionally bound to the app-server connection epoch, opaque request ID, native thread/turn/item tuple, freshness, advertised decision, and one physical attempt ID.
- Adapter revalidates the provider-native request immediately before execution.
- Stale/disconnected items retain OPEN where safe but lose mutations.
- Only one action can reserve an item version. Unknown outcomes are never automatically retried.
- Browser origins, non-loopback Host headers, oversized bodies, and non-JSON mutation requests are rejected.

## Success criteria for v0.1

1. Empty plugin shows the ALL CLEAR state.
2. CLI event appears on the physical Deck in two seconds or less.
3. Five fixtures sort correctly; Dial 1 reaches the overflow item.
4. Selecting a top key changes context without executing an action.
5. Long summaries page cleanly in 200×100 regions.
6. Unsupported provider actions never appear.
7. A stale event is visibly stale and cannot mutate a provider.
8. Dismiss and snooze enforce the exact current version.
9. Restart/wake produces a full refresh and no duplicate action.
10. A malicious local web page cannot mutate the broker.

## Out of scope

Remote exposure, dashboards, metrics graphs, full transcripts, arbitrary quick replies, raw shell launchers, decorative AI summaries, provider logos, sounds by default, general Stream Deck automation, and simultaneous implementation of all providers.

## Release phases

1. Generic vertical slice (current): protocol/store/broker/CLI, device rendering, dismiss/snooze.
2. Persistence, installer/profile, safe locator launcher, daily dogfooding.
3. Codex app-server adapter foundation: thread inventory, exact owned-request correlation, OPEN, and gated request-scoped actions (current).
4. Codex desktop notify bridge, persistence, and ACTIVE/RECENT views; live qualification of a disposable approval turn.
5. Claude Code, then OpenClaw.
6. Packaging, screenshots/demo, security review, and v0.1 OSS release.
