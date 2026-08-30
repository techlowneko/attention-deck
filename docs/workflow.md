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
  -> update broker-owned first-seen and freshness state
  -> rank NEEDS ME queue
  -> render eight keys and four encoder regions
```

## Human action flow

```text
select item
  -> read WHY on strip
  -> OPEN, LATER, or adapter capability
  -> capture item ID + exact version
  -> broker revalidates a local dismiss/snooze OR plugin dispatches once to a trusted adapter
  -> adapter revalidates native pending request
  -> succeeded / failed / outcome unknown
  -> refresh entire surface
```

Generic actions are broker-owned `dismiss` and `snooze`. Codex `approve` and `deny` are provider-owned, require a single-use physical attempt ID, and are accepted only for a fresh action capability on the exact current item version.

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
- ordinary desktop task attention needs a separate opt-in completion/notify bridge;
- the plugin never guesses an approval from persisted history or aggregate status.

## Physical test script

1. Start Stream Deck and install/link the development plugin.
2. Place Attention Key in all eight key positions and Attention Encoder in all four encoder positions.
3. Confirm the ALL CLEAR state.
4. Run the demo CLI emit command from the README.
5. Confirm an INPUT card appears and the explanation is readable.
6. Emit APPROVAL, FAILED, REVIEW, and a fifth overflow fixture; confirm ordering and Dial 1 navigation.
7. Press a top-row card; verify it only selects.
8. Snooze from key 8; verify it disappears for five minutes.
9. Emit a newer version for the same source/session; verify it returns immediately.
10. Dismiss using the current version; rapid-repeat and stale-version attempts must fail safely.
11. Stop updates beyond `fresh_for_ms`; verify STALE appears.
12. Restart Stream Deck and wake Windows; verify full refresh and no action replay.
