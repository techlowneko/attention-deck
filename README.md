# Attention Deck

Attention Deck is a Stream Deck+ inbox for developers running AI coding agents. It shows which task needs you, why it is waiting, and which actions the integration can safely offer.

> **Early alpha:** the generic local event path and physical Stream Deck+ NEEDS ME workflow are working. Bounded lifecycle state, restart-safe local persistence, selectable snooze, local dismiss, recurrence wake, NEEDS ME / ACTIVE / RECENT navigation, and the opt-in Codex completion hook are automated-test and device qualified on Windows. Sleep/wake, exact OPEN, and live provider-action qualification remain.

**Stop checking agent windows. Let blocked work come to you.**

## Who it is for

Attention Deck is for developers and technical operators who run several local agent tasks at once and want to keep working without repeatedly scanning Codex, terminals, or dashboards.

It is most useful when:

- agents work unattended for minutes at a time;
- approvals, questions, failures, and reviews can stall that work;
- you already use a Stream Deck+ as an always-visible secondary surface;
- you want local integrations with explicit safety boundaries rather than a remote control service.

If you run one short task at a time, switching back to its window is probably simpler.

## Why use it

Agent sessions can run independently, but they still stop for human decisions. Repeatedly checking every window creates unnecessary context switches; checking too late leaves useful work blocked.

Attention Deck is designed to provide four answers from desk distance:

1. Which task needs me?
2. Why is it waiting?
3. How long has it waited?
4. What safe action is available now?

## What works today

| Capability | Status |
| --- | --- |
| Stream Deck+ NEEDS ME rendering, selection, details, local dismiss, and five-minute snooze | Working development prototype; physically tested on Windows |
| Authenticated local event API and CLI | Working development prototype |
| Codex app-server initialization and stored-task inventory | Working local integration |
| Best-effort Codex task deep-link | Implemented; physical qualification still pending |
| Request-scoped Codex APPROVE/DENY | Implemented and unit tested for adapter-owned requests with explicitly advertised decisions; not yet end-to-end release-qualified |
| Passive updates from ordinary Codex work | Opt-in Stop hook implemented, automated-test qualified, and physically qualified on Windows with a disposable CLI turn |
| Orthogonal lifecycle state, generation/count tracking, restart-safe local state, bounded RECENT history, selectable snooze, and ACTIVE/RECENT views | Automated-test and physical device qualified on Windows; sleep/wake qualification pending |
| Installer and signed releases | Planned |
| Claude Code and OpenClaw adapters | Planned |

## How the device works

Place **Attention Key** on all eight keys and **Attention Dial** on all four dials.

- Top keys 1–4 show the highest-priority items. Pressing a card selects it; selection never mutates work.
- Bottom keys are OPEN, APPROVE, DENY-or-DISMISS, and SNOOZE.
- Dial 1 selects items, Dial 2 pages the explanation, Dial 3 selects valid actions and snooze duration, and Dial 4 rotates NEEDS ME / ACTIVE / RECENT; pressing Dial 4 returns home to NEEDS ME.
- APPROVE and DENY require a 750 ms hold and remain disabled unless a trusted adapter owns the exact live request.

### Lifecycle and views

The lifecycle increment keeps four concerns separate:

- normalized task **state** records working, input, approval, review, done, or failed;
- **source state** records whether the source still considers that item active or has authoritatively cleared it;
- **operator state** records whether this user has not seen, seen, or claimed the item;
- **presentation state** records whether the local card is visible, snoozed, dismissed, or recent;
- **decision state** tracks whether a request-scoped provider decision is absent, available, sending, accepted, rejected, or of unknown outcome.

A stable item may have multiple generations and repeated occurrences. A newer version wakes a snoozed or locally dismissed item when it again needs attention. An authoritative provider clear is different from local dismiss: clear says the source no longer needs a person, while dismiss only removes the current generation from this user's inbox.

The increment also adds a restart-safe local snapshot and bounded RECENT history. It does not persist provider approval grants across restart; a trusted adapter must reconnect and re-establish current capabilities before APPROVE or DENY can reappear.

## Development quick start

Current requirements:

- Windows 10 or later
- Stream Deck software 7.0 or later
- Stream Deck+
- Node.js 20 or later
- Codex CLI with `app-server` support for the optional Codex adapter

```powershell
npm ci
npm run check
npm test
npm run build
npm run validate
npx streamdeck link com.preflightstack.attention-deck.sdPlugin
npx streamdeck restart com.preflightstack.attention-deck
```

Place the twelve actions in a Stream Deck+ profile, then emit a local test item:

```powershell
npm run attention -- emit --project "Demo" --state INPUT --title "Choose an option" --summary "This is a local Attention Deck test." --session "readme-demo"
```

The development broker listens on `127.0.0.1:17893`. Its bearer token is generated in the current Windows user's local application-data directory and is not stored in this repository.

### Opt in to Codex completion cards

Attention Deck includes a display-only Codex `Stop` hook. When a main Codex turn finishes, the hook posts one `REVIEW` card through the same authenticated generic event API. It hashes native session and turn identifiers, keeps only the final folder name as the project label, and does not copy prompts, transcripts, the assistant message, locators, or approval capabilities.

Build and link the plugin first, then merge [the Windows hook definition](integrations/codex/hooks.windows.json) into `%USERPROFILE%\.codex\hooks.json`. If that file does not exist, copy the example as-is. Codex requires non-managed hooks to be reviewed and trusted; open `/hooks` in Codex after adding it. See [the Codex hook guide](docs/codex-hook.md) for setup, testing, and removal.

## Architecture

```text
generic CLI or trusted provider adapter
  -> authenticated loopback broker
  -> bounded, versioned attention queue
  -> shared Stream Deck+ surface coordinator
  -> select, inspect, open, snooze, or capability-gated action
```

Generic events are display-only. They cannot supply commands, callbacks, approval capabilities, or arbitrary locators. Provider actions exist only inside trusted adapters and must match the current item version and provider-native request.

See [the protocol](docs/protocol.md), [runtime workflow](docs/workflow.md), [PRD](docs/PRD.md), and [technical research](docs/research.md).

## Codex integration and limitation

Attention Deck uses the documented `codex app-server` protocol rather than terminal or screen scraping.

On Windows, Codex desktop owns a private stdio app-server connection. A second process can list stored tasks, but it cannot receive or answer approval requests owned by the desktop connection. Attention Deck therefore never creates an actionable approval from a `waitingOnApproval` status hint. Direct actions are enabled only for an exact server request received on the adapter's own connection.

Ordinary Codex completion now uses the documented, opt-in `Stop` lifecycle hook. The hook is notification-only and never reconstructs desktop-owned approvals. For desktop-owned approval prompts, opening the exact Codex task remains the safe fallback unless OpenAI provides a supported shared Windows transport.

## Security model

- The broker binds only to `127.0.0.1` and requires a random bearer token.
- Browser origins and unexpected Host headers are rejected.
- Request bodies and text fields are bounded.
- Generic emitters cannot create provider actions or launch targets.
- Mutations require the exact current item version.
- Provider actions use one physical attempt ID and one reply reservation.
- Disconnects revoke provider capabilities; unknown outcomes are never retried automatically.

See [SECURITY.md](SECURITY.md) for reporting and trust boundaries.

See [DATA_HANDLING.md](DATA_HANDLING.md) for the local data and privacy model.

## Roadmap

1. Finish sleep/wake qualification for the physically tested lifecycle/persistence, recurrence, selectable-snooze, and three-view workflow.
2. Finish exact OPEN qualification.
3. Run a disposable-repository Codex approval qualification pass.
4. Add installer/profile tooling, screenshots, and signed releases.
5. Add Claude Code and OpenClaw adapters behind the same capability model.

## Contributing

Issues and focused pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before proposing a provider adapter or a change to the action security model.

Attention Deck is available under the [MIT License](LICENSE). See [ACKNOWLEDGMENTS.md](ACKNOWLEDGMENTS.md) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for project influences and bundled dependency notices.

## Project status and independence

Attention Deck is early-stage software and is not affiliated with or endorsed by OpenAI or Elgato. Codex, OpenAI, Elgato, and Stream Deck are trademarks of their respective owners.
