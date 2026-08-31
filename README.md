# Attention Deck

Attention Deck turns your Stream Deck+ into a local inbox for AI coding agents. When a task finishes, fails, or needs your attention, it appears on the deck so you can respond without repeatedly checking agent windows.

> **Early alpha:** the main notification and navigation workflow works and has been tested on a physical Stream Deck+ on Windows. Installation is still developer-oriented, and some Codex actions need more real-world testing before release.

## What it does

Attention Deck helps answer four questions at a glance:

1. Which task needs me?
2. Why is it waiting?
3. How long has it been waiting?
4. What can I safely do next?

It is most useful when you run several agent tasks at once and want to keep working while they run in the background.

```text
Codex or another local tool
  -> sends an attention update
  -> Attention Deck organizes it
  -> the Stream Deck+ shows a card
  -> you open, snooze, dismiss, approve, or deny it
```

## What works today

The current Windows prototype can:

- show local task notifications on a Stream Deck+;
- rank and select the tasks that need you most;
- show active and recently handled tasks;
- open supported tasks, snooze them, or dismiss them locally;
- keep the local inbox after a restart;
- show a review card when an ordinary Codex turn finishes, using an optional Codex hook; and
- receive carefully limited approval requests from Codex tasks started through its own connection.

Still in progress:

- testing sleep and wake behavior;
- fully qualifying exact task opening and live Codex approvals;
- creating a friendly installer and signed releases; and
- adding Claude Code and OpenClaw integrations.

## How the Stream Deck+ is arranged

Add **Attention Key** to all eight keys and **Attention Dial** to all four dials.

- **Top four keys:** show the highest-priority cards. Press one to select it.
- **Bottom four keys:** OPEN, APPROVE, DENY or DISMISS, and SNOOZE.
- **Dial 1:** move between cards.
- **Dial 2:** read more of the explanation.
- **Dial 3:** choose an available action or snooze duration.
- **Dial 4:** switch between NEEDS ME, ACTIVE, and RECENT. Press it to return to NEEDS ME.

Selecting or opening a card does not mark the task complete. Approval and denial require a 750 ms hold and only appear when Attention Deck can verify the exact live request.

## Try the development version

You will need:

- Windows 10 or later;
- Stream Deck software 7.0 or later;
- a Stream Deck+;
- Node.js 20 or later; and
- Codex CLI with `app-server` support if you want to try the Codex adapter.

Install the project, run its checks, build it, and link it to Stream Deck:

```powershell
npm ci
npm run check
npm test
npm run build
npm run validate
npx streamdeck link com.preflightstack.attention-deck.sdPlugin
npx streamdeck restart com.preflightstack.attention-deck
```

After placing the eight keys and four dials in a Stream Deck+ profile, create a test card:

```powershell
npm run attention -- emit --project "Demo" --state INPUT --title "Choose an option" --summary "This is a local Attention Deck test." --session "readme-demo"
```

The development service listens only on `127.0.0.1:17893`. It creates a private authentication token in the current Windows user's local application-data directory; the token is not stored in this repository.

## Get completion cards from Codex

Attention Deck includes an optional Codex `Stop` hook. When a main Codex turn finishes, the hook creates a display-only **REVIEW** card.

Build and link the plugin first. Then merge [the Windows hook definition](integrations/codex/hooks.windows.json) into `%USERPROFILE%\.codex\hooks.json`. If the file does not exist, you can copy the example as-is. Open `/hooks` in Codex afterward to review and trust the new hook.

The hook does not copy your prompts, transcript, assistant response, or approval permissions. See the [Codex hook guide](docs/codex-hook.md) for complete setup, testing, and removal instructions.

## An important Codex limitation

Attention Deck can show completion notifications from normal Codex desktop tasks, but it usually cannot approve requests owned by the Codex desktop app. Those requests belong to a private Codex connection.

In that situation, Attention Deck directs you back to Codex instead of guessing. APPROVE and DENY are enabled only when the plugin receives and still owns the exact live request through its own Codex connection.

## How it stays safe

- Communication stays on your computer and requires a private token.
- Ordinary notification senders cannot add commands, approval buttons, or arbitrary links.
- Every action is checked again at the moment you press it.
- Changed, expired, or disconnected requests are locked instead of retried automatically.
- Snoozing or dismissing a card changes only your local inbox; it does not pretend the agent finished.

Read [SECURITY.md](SECURITY.md) for the full trust model and [DATA_HANDLING.md](DATA_HANDLING.md) for details about local data and privacy.

## Technical documentation

The README intentionally keeps the overview simple. Deeper design details live here:

- [Runtime workflow](docs/workflow.md)
- [Event protocol](docs/protocol.md)
- [Product requirements](docs/PRD.md)
- [Technical research](docs/research.md)

At a high level, local tools send authenticated updates to a small local service. That service validates, organizes, and saves the inbox. The Stream Deck plugin reads the inbox and displays only the actions that are safe for the selected card.

## Roadmap

1. Finish sleep/wake, exact OPEN, and live Codex approval testing.
2. Add installer and profile tooling, screenshots, and signed releases.
3. Add more agent integrations behind the same safety model.

## Contributing and license

Issues and focused pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before proposing a provider integration or changing the action security model.

Attention Deck is available under the [MIT License](LICENSE). See [ACKNOWLEDGMENTS.md](ACKNOWLEDGMENTS.md) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for project influences and bundled dependency notices.

Attention Deck is not affiliated with or endorsed by OpenAI or Elgato. Codex, OpenAI, Elgato, and Stream Deck are trademarks of their respective owners.
