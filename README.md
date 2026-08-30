# Attention Deck

Attention Deck is a Stream Deck+ inbox for developers running AI coding agents. It shows which task needs you, why it is waiting, and which actions the integration can safely offer.

> **Early alpha:** the generic local event path and physical Stream Deck+ workflow are working. The Codex adapter can initialize, list tasks, and safely model exact request-scoped approvals, but ordinary Codex desktop tasks do not yet publish attention events to the Deck.

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
| Stream Deck+ rendering, selection, details, dismiss, and snooze | Working development prototype; physically tested on Windows |
| Authenticated local event API and CLI | Working development prototype |
| Codex app-server initialization and stored-task inventory | Working local integration |
| Best-effort Codex task deep-link | Implemented; physical qualification still pending |
| Request-scoped Codex APPROVE/DENY | Implemented and unit tested for adapter-owned requests with explicitly advertised decisions; not yet end-to-end release-qualified |
| Passive updates from ordinary Codex desktop work | Planned opt-in notify bridge |
| Persistence, ACTIVE/RECENT views, installer, and signed releases | Planned |
| Claude Code and OpenClaw adapters | Planned |

## How the device works

Place **Attention Key** on all eight keys and **Attention Dial** on all four dials.

- Top keys 1–4 show the highest-priority items. Pressing a card selects it; selection never mutates work.
- Bottom keys are OPEN, APPROVE, DENY-or-DISMISS, and SNOOZE.
- Dial 1 selects items, Dial 2 pages the explanation, Dial 3 selects valid actions, and Dial 4 is reserved for queue views and health.
- APPROVE and DENY require a 750 ms hold and remain disabled unless a trusted adapter owns the exact live request.

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

The next provider milestone is an opt-in completion/notify bridge so ordinary Codex desktop work can update the Deck. For desktop-owned approval prompts, opening the exact Codex task remains the safe fallback unless OpenAI provides a supported shared Windows transport.

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

1. Persist unresolved items and first-seen age atomically.
2. Add the opt-in Codex desktop completion/notify bridge.
3. Finish ACTIVE and RECENT views and exact OPEN qualification.
4. Run a disposable-repository Codex approval qualification pass.
5. Add installer/profile tooling, screenshots, and signed releases.
6. Add Claude Code and OpenClaw adapters behind the same capability model.

## Contributing

Issues and focused pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before proposing a provider adapter or a change to the action security model.

Attention Deck is available under the [MIT License](LICENSE). See [ACKNOWLEDGMENTS.md](ACKNOWLEDGMENTS.md) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for project influences and bundled dependency notices.

## Project status and independence

Attention Deck is early-stage software and is not affiliated with or endorsed by OpenAI or Elgato. Codex, OpenAI, Elgato, and Stream Deck are trademarks of their respective owners.
