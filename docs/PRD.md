# Attention Deck — Product Requirements Document

Status: public alpha; NEEDS ME, lifecycle persistence, recurrence, dismiss, and three-view navigation physically qualified on Stream Deck+; sleep/wake and live provider qualification pending, 2026-08-30

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
- Keep source truth, local operator choices, device presentation, and provider-decision progress independent.
- Restore local inbox state after restart without restoring expired provider authority.
- OPEN only a trusted adapter locator; never execute emitter-supplied shell text.
- Survive Stream Deck reconnect and system wake without replaying an action.

## Bounded lifecycle model

The lifecycle model keeps the existing normalized task classification alongside four orthogonal lifecycle concerns:

| Concern | Authority | Purpose |
| --- | --- | --- |
| Normalized task state | Generic emitter or trusted adapter | `WORKING`, `INPUT`, `APPROVAL`, `REVIEW`, `DONE`, or `FAILED` |
| Source state | Generic emitter or trusted adapter | Whether the source still considers the item `active` or has authoritatively `cleared` it |
| Operator state | Local Attention Deck user | Whether the current user has not seen, seen, or claimed the item: `unseen`, `seen`, or `claimed` |
| Presentation state | Broker/local inbox | Local card treatment: `visible`, `snoozed`, `dismissed`, or `recent` |
| Decision state | Trusted adapter/action dispatcher | Request-scoped progress: `none`, `available`, `sending`, `accepted`, `rejected`, or `unknown` |

These states do not overwrite one another. Selecting or opening an item changes none of them. Snooze and dismiss never claim that Codex completed or accepted anything. Disconnect or restart revokes decision authority even when the local card remains available for inspection.

Each stable item also tracks:

- a **generation**, advanced when a previously dismissed or provider-cleared episode recurs for the same source/session identity;
- an **occurrence count**, counting accepted updates for that stable item without turning updates into many queue cards;
- the current optimistic-lock version/sequence used to reject stale device actions.

A higher version or new generation wakes an item before its snooze expires. An authoritative clear sets source state to `cleared` and presentation state to `recent`. A local dismiss changes presentation state without setting source state to `cleared`; a later generation may re-enter NEEDS ME.

## Device workflow

### All clear

The strip reads `NOTHING NEEDS YOU` with a small last-sync age. Keys remain nearly black. WORKING and DONE do not occupy NEEDS ME cards.

### Attention

Top row keys 1–4 show the first four items. Pressing selects; it never mutates. Bottom row is contextual:

| Key | Function |
| --- | --- |
| 5 | OPEN when a trusted locator exists |
| 6 | APPROVE when the adapter holds an exact live request |
| 7 | DENY for an exact live request; DISMISS for a generic item |
| 8 | SNOOZE using the selected 5-minute, 15-minute, 1-hour, or tomorrow-at-09:00 preset |

Unsupported actions are blank. State uses a word, glyph, and border; color is supplemental.

The four 200×100 encoder regions are coordinated but independent:

| Dial | Strip region | Rotate | Push/touch |
| --- | --- | --- | --- |
| 1 | Item and queue position | select item | OPEN |
| 2 | Explanation page | page summary | return to page 1 |
| 3 | Available action | select action | execute; APPROVE/DENY require a 750 ms hold |
| 4 | View/health | NEEDS ME / ACTIVE / RECENT | return to NEEDS ME |

### Views

- **NEEDS ME** contains unsnoozed, undismissed attention generations that currently require a person.
- **ACTIVE** exposes the broker's current source-active collection, including locally snoozed or dismissed generations for reconciliation. It is a status surface with OPEN only, not a decision queue.
- **RECENT** contains a bounded history of authoritative clears and local outcomes so a card does not disappear without explanation.

The top four keys and Dial 1 use the selected view. Switching views never mutates an item. A new arrival does not retarget a held physical action.

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

- Orthogonal source/operator/presentation/decision state.
- Atomic restart-safe persistence of current local items, generation/count metadata, snooze/dismiss state, and bounded RECENT history.
- Selectable bounded snooze durations and wake-on-new-version behavior.
- NEEDS ME / ACTIVE / RECENT snapshots and device navigation.
- Server-sent updates rather than polling.
- Trusted locator registry and safe Windows OPEN launcher.
- Codex app-server adapter: stable stdio initialization, thread inventory, approval lifecycle events, best-effort task deep-link, and fail-closed disconnect behavior.

### P2

- Desktop/CLI completion notify bridge.
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
8. Dismiss and snooze enforce the exact current version; dismiss does not claim authoritative completion.
9. A newer version wakes a snoozed or locally dismissed generation.
10. Restart restores bounded local state and history but no provider action grant; wake produces a full refresh and no duplicate action.
11. NEEDS ME contains only visible attention, ACTIVE contains current source-active items, and RECENT stays within its history bound.
12. A malicious local web page cannot mutate the broker.

## Out of scope

Remote exposure, dashboards, metrics graphs, full transcripts, arbitrary quick replies, raw shell launchers, decorative AI summaries, provider logos, sounds by default, general Stream Deck automation, and simultaneous implementation of all providers.

## Release phases

1. Generic vertical slice (current): protocol/store/broker/CLI, device rendering, dismiss/snooze.
2. Bounded lifecycle/persistence increment, three device views, installer/profile, safe locator launcher, daily dogfooding.
3. Codex app-server adapter foundation: thread inventory, exact owned-request correlation, OPEN, and gated request-scoped actions (current).
4. Codex desktop notify bridge and live qualification of a disposable approval turn.
5. Claude Code, then OpenClaw.
6. Packaging, screenshots/demo, security review, and v0.1 OSS release.
