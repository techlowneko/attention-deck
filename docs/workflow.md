# Product and Runtime Workflow

## Delivery workflow

```text
Research gate
  -> generic protocol fixtures
  -> broker/store tests
  -> Stream Deck simulator/dev mode
  -> physical Deck+ smoke test
  -> stale/reconnect/adversarial tests
  -> first provider adapter
```

Each provider capability is promoted separately: `STATUS`, `OPEN`, `APPROVE`, `DENY`. A provider name in the UI does not imply action support.

## Runtime event flow

```text
generic CLI or trusted adapter
  -> POST /v1/events on 127.0.0.1
  -> authenticate and validate bounded JSON
  -> deduplicate delivery; reject old version/sequence
  -> update source state, generation/occurrence, and broker-owned freshness
  -> preserve or wake local operator treatment according to version/generation
  -> derive NEEDS ME / ACTIVE / RECENT presentation
  -> atomically persist the bounded local projection
  -> render eight keys and four encoder regions
```

## Human action flow

```text
select item in NEEDS ME / ACTIVE / RECENT
  -> read WHY on strip
  -> OPEN, LATER, or adapter capability
  -> capture item ID + exact version
  -> broker revalidates a local dismiss/snooze OR plugin dispatches once to a trusted adapter
  -> adapter revalidates native pending request
  -> succeeded / failed / outcome unknown
  -> record local outcome without rewriting provider truth
  -> refresh entire surface and select the next eligible item
```

Generic actions are broker-owned `dismiss` and `snooze`. Codex `approve` and `deny` are provider-owned, require a single-use physical attempt ID, and are accepted only for a fresh action capability on the exact current item version.

### Local dismiss versus authoritative clear

```text
DISMISS
  -> hide only this local attention generation
  -> set presentation_state = dismissed
  -> keep source_state = active
  -> retain a bounded RECENT explanation

newer version or new generation
  -> clear local dismiss/snooze for that episode
  -> return immediately if it still needs a person

authoritative provider clear
  -> set source_state = cleared and presentation_state = recent
  -> revoke the exact decision capability
  -> retain a bounded RECENT generation
```

Selecting or opening an item never marks it complete. A card leaves NEEDS ME only because of an explicit local operator action or newer authoritative source state.

### Snooze

The HTTP/CLI path accepts durations from 60 seconds through seven days, with a five-minute default. The lifecycle increment offers device presets of 5 minutes, 15 minutes, 1 hour, and tomorrow at 09:00, while retaining these rules:

- snooze affects only the current generation;
- expiry returns the item only if it still needs a person;
- a higher version or new generation wakes it early;
- snooze never changes provider state or decision outcome.

### Restart and reconnect

```text
start broker
  -> load and validate bounded local state
  -> discard invalid/expired records and enforce history limits
  -> render restored cards conservatively
  -> reconnect trusted adapter and request a fresh provider snapshot
  -> replace/reconcile source truth
  -> enable provider actions only from newly established capabilities
```

Persistence never restores an app-server request responder or replays APPROVE/DENY. Disconnect and restart lock provider mutations until current authority is independently re-established.

### Device views

- `NEEDS ME`: unsnoozed, undismissed attention generations, ranked by resume value then age.
- `ACTIVE`: the current source-active collection used for status/reconciliation; it can include locally snoozed or dismissed attention generations, and the device exposes OPEN only.
- `RECENT`: bounded authoritative clears and local outcomes for explanation and recovery, not a permanent activity log.

Dial 4 selects the view and returns to NEEDS ME on push. Changing views starts selection at the first item; view changes and new arrivals do not retarget an action already being held.

## Codex adapter workflow

Codex is integrated through `codex app-server`, not terminal or screen scraping:

```text
initialize
  -> initialized
  -> thread/list for read-only inventory
  -> listen for server requests on this owned connection
  -> correlate requestApproval(connection epoch, request ID, threadId, turnId, itemId)
  -> attention item upsert
  -> hold APPROVE/DENY for 750 ms
  -> atomically reserve and reply once
  -> wait for serverRequest/resolved or item/completed
```

`thread/status/changed.activeFlags = ["waitingOnApproval"]` is only a hint and never creates an actionable approval. On disconnect, every grant from that connection is revoked; a reply whose outcome is unknown is not retried. The adapter uses `codex://threads/<id>` as a best-effort task deep-link, pending a physical qualification pass on the installed Stream Deck version.

### Windows ownership boundary

The Codex desktop app runs its own app-server child over private stdio. Windows has no supported shared app-server daemon, and a second stdio process lists desktop tasks as `notLoaded`. Therefore:

- the adapter may list stored tasks but cannot subscribe to the desktop process's pending server requests;
- APPROVE/DENY is available only for turns initiated through this adapter connection;
- ordinary desktop task completion uses a separate opt-in, display-only `Stop` hook;
- the plugin never guesses an approval from persisted history or aggregate status.

### Codex completion hook workflow

```text
Codex main turn reaches Stop
  -> hook receives bounded JSON on stdin
  -> require stop_hook_active = false and exact session/turn IDs
  -> hash native IDs and discard transcript/message/permission fields
  -> authenticated generic REVIEW emit to 127.0.0.1
  -> deterministic retry deduplication
  -> local dismiss or snooze only
```

The bridge always returns `{}` and fails open if the broker is unavailable. Because it uses the generic event route, it cannot attach a locator or provider decision capability. A Stop hook therefore never makes APPROVE or DENY appear for a desktop-owned turn.

## Physical test script

1. Start Stream Deck and install/link the development plugin.
2. Place Attention Key in all eight key positions and Attention Encoder in all four encoder positions.
3. Confirm the ALL CLEAR state.
4. Run the demo CLI emit command from the README.
5. Confirm an INPUT card appears and the explanation is readable.
6. Emit APPROVAL, FAILED, REVIEW, and a fifth overflow fixture; confirm ordering and Dial 1 navigation.
7. Press a top-row card; verify it only selects.
8. Select more than one offered snooze duration; verify each is bounded and local.
9. Emit a newer version for the same source/session; verify snooze/dismiss is cleared for the new generation and the card returns immediately.
10. Dismiss using the current version; verify source state is unchanged, RECENT explains the local outcome, and rapid-repeat/stale-version attempts fail safely.
11. Emit an authoritative clear; verify the item leaves ACTIVE and appears in RECENT rather than following the local dismiss path.
12. Stop updates beyond `fresh_for_ms`; verify STALE appears and provider mutations lock.
13. Restart the plugin; verify local items, ages, operator treatment, and bounded RECENT restore, while provider action grants do not.
14. Wake Windows and reconnect Codex; verify full reconciliation and no action replay.
