# Technical Research

Research date: 2026-08-29, refreshed 2026-08-30. Primary sources were preferred.

## Decision summary

The official SDK supports the proposed Stream Deck+ surface. The fastest one-PC architecture is a TypeScript plugin with an embedded loopback broker, based on the architecture demonstrated by `agentsd` and `yolodeck`. A shared coordinator renders all visible action instances. The broker remains an interface so it can later become a separate service.

## Elgato findings

- Stream Deck+ provides 8 keys, 4 encoders, and an 800×100 strip. Each encoder owns one 200×100 strip region; a visually unified strip requires four coordinated tiles.
- Key images can be SVG or raster. Display updates should stay below ten per second.
- Encoder actions receive rotate/down/up and touch events; long touch is distinguishable.
- Property Inspectors are HTML webviews. They are useful for setup, not for the core queue.
- `onSystemDidWakeUp` and `onWillAppear` support full refresh after wake/reconnect.
- The SDK URL opener supports web URLs, not arbitrary custom schemes. Provider deep links therefore require a validated local launcher.
- Official development tooling supports create/link/dev/validate/pack and packaged `.streamDeckPlugin` installers.

Sources: [manifest](https://docs.elgato.com/streamdeck/sdk/references/manifest/), [keys](https://docs.elgato.com/streamdeck/sdk/guides/keys/), [dials](https://docs.elgato.com/streamdeck/sdk/guides/dials/), [touch layouts](https://docs.elgato.com/streamdeck/sdk/references/touch-strip-layout/), [system lifecycle](https://docs.elgato.com/streamdeck/sdk/guides/system/), [CLI](https://docs.elgato.com/streamdeck/cli/intro/).

## Codex findings

Official OpenAI documentation now describes `codex app-server` as the supported rich-client interface for authentication, conversation history, approvals, and streamed events. It exposes:

- stored thread listing and reading;
- `thread/status/changed`, including `activeFlags: ["waitingOnApproval"]`;
- turn and item lifecycle events;
- request-scoped command and file-change approval messages containing `threadId`, `turnId`, and `itemId`;
- `serverRequest/resolved` confirmation.

That is a clean adapter boundary for turns owned by the connection. A dated Windows compatibility test generated types from the installed Codex CLI, completed `initialize`/`initialized`, and confirmed that tasks owned by the separate desktop process appeared `notLoaded` to a new stdio app-server. Windows daemon lifecycle was unavailable in the tested build. The plugin therefore cannot receive or answer desktop-owned approval requests through a second app-server process.

The installed schema confirmed command/file approval responses use `{ decision: "accept" | "decline" | ... }` and `serverRequest/resolved` contains the opaque request ID. The hardware implementation exposes only one-shot `accept` and `decline`; it deliberately excludes session-wide and policy-amendment decisions.

Source: [Codex app-server](https://developers.openai.com/codex/app-server).

## Open-source inspiration and reuse

| Project | License | Useful pattern | Decision |
| --- | --- | --- | --- |
| [Elgato SDK](https://github.com/elgatosf/streamdeck) and [samples](https://github.com/elgatosf/streamdeck-plugin-samples) | MIT | current TypeScript SDK, layouts, packaging | direct foundation |
| [agentsd](https://github.com/paultyng/agentsd) | MIT | plugin-hosted HTTP listener, attention queue, Claude hooks | adapt architecture, preserve notices if code is copied |
| [yolodeck](https://github.com/cruftbox/yolodeck) | MIT | Windows loopback auth, PID/stale cleanup, permission races | strongest Windows reference |
| [Codex Control](https://github.com/emollick/codex-stream-deck) | MIT | bounded JSONL framer, direct Windows process launch, app-server smoke test, `codex://threads/<id>`, opt-in notify bridge | inspected; adapted architectural patterns, no source/assets copied verbatim |
| [OpenAI Codex plugin app-server client](https://github.com/openai/codex-plugin-cc/blob/main/plugins/codex/scripts/lib/app-server.mjs) | Apache-2.0 | request IDs, pending map, initialization and exit cleanup | protocol/lifecycle reference |
| [AgentDeck](https://github.com/puritysb/AgentDeck) | MIT | daemon/surface separation and normalized runtimes | future multi-surface reference |
| [Herdeck](https://github.com/vaclavik-xyz/herdeck) | inspect before reuse | socket snapshots and reconnect | interaction reference |
| [Codex Deck](https://github.com/dazer1234/codex-stream-deck) | MIT | UI and uncertain/stale state | do not depend on undocumented Chrome internals |
| Yeetdeck | commercial/no public source found | exact terminal/tmux jump concept | inspiration only; no code/assets |

No proprietary code or visual assets are used by the current implementation.

## Important cuts

- Do not build four provider adapters at once.
- Do not screen-scrape terminals.
- Do not treat four strip tiles as one native canvas.
- Do not accept action callbacks or commands from the generic API.
- Do not put DONE/WORKING sessions in the attention queue.
- Do not imply a second app-server connection can act on desktop-owned requests.
- Do not create APPROVE/DENY from `waitingOnApproval`; only a live server-initiated request is actionable.
