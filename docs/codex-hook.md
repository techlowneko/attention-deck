# Codex completion hook

Attention Deck uses Codex's documented `Stop` lifecycle hook for passive completion cards. The hook runs only after explicit user configuration and trust review. It receives one JSON object on standard input and returns `{}` so it never asks Codex to continue, stop, or change a decision.

Official reference: [OpenAI Codex hooks](https://learn.chatgpt.com/codex/hooks).

## What the bridge publishes

For a valid main-thread `Stop` event where `stop_hook_active` is false, the bridge publishes one generic event:

- `state`: `REVIEW`;
- `source`: `codex`;
- `project`: only the bounded final component of `cwd`;
- `session`: a SHA-256-derived stable session identity;
- `event_id`: a SHA-256-derived session-and-turn delivery identity;
- `title`: `Codex turn ready`;
- `summary`: `Open Codex to review.`

It ignores the transcript path, assistant message, model, permission mode, and all unrecognized input fields. The public broker rejects locators and provider actions, so this path cannot produce OPEN, APPROVE, or DENY.

## Windows development setup

1. Install dependencies, build, link, and restart the Stream Deck plugin as described in the README.
2. If `%USERPROFILE%\.codex\hooks.json` does not exist, copy `integrations\codex\hooks.windows.json` there. If it exists, merge only the example's `Stop` matcher group into its existing `hooks.Stop` array.
3. Open `/hooks` in Codex, inspect the exact command, and trust it.
4. Complete a disposable Codex turn and confirm that one REVIEW card appears on Attention Deck.

The example expects `node` on `PATH` and the linked or installed plugin at:

```text
%APPDATA%\Elgato\StreamDeck\Plugins\com.preflightstack.attention-deck.sdPlugin\bin\codex-stop-hook.cjs
```

The hook is asynchronous, has a three-second process limit, and gives its one loopback request a 750 ms timeout. Broker, token, JSON, and network failures are swallowed so they cannot block Codex completion. Set `ATTENTION_DECK_HOOK_DEBUG=1` only for local troubleshooting; diagnostics contain only a bounded error message, never hook input or the bearer token.

## Remove the integration

Remove only the Attention Deck matcher group from `%USERPROFILE%\.codex\hooks.json`, or delete that file if it contains nothing else. Then reopen Codex. Removing the hook does not delete Attention Deck's local inbox history; see `DATA_HANDLING.md` for the separate state-removal steps.
