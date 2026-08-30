# Local Data Handling

Attention Deck is designed as a local, single-user development tool. It does not provide a hosted service, telemetry pipeline, or public network listener.

## Data processed

The broker may receive and display:

- project and task labels;
- short attention titles and summaries;
- event identifiers, versions, timestamps, and priority;
- provider-native thread, turn, item, and request identifiers;
- bounded Codex reason or command previews after basic credential-pattern redaction.

This information can still be sensitive. Task names, paths, commands, and summaries may reveal private project or customer context. Treat the Stream Deck display and authenticated broker snapshot as private workstation surfaces.

## Storage and retention

- Attention items are currently held in memory and are lost when the plugin restarts.
- The random broker token persists in the current Windows user's local application-data directory.
- Startup diagnostics are local, size-bounded, and redact common bearer-token, query-secret, and user-profile patterns. Logs are excluded from source control and release packages.
- Codex task transcripts are not copied into the repository or persisted by Attention Deck.

## Network behavior

- The broker binds to `127.0.0.1` only.
- Attention Deck does not send telemetry or task content to a service operated by this project.
- The separately installed Codex CLI may communicate with OpenAI under its own authentication and policies; Attention Deck communicates with its local app-server process.

## Local clients

Anyone who can read the broker token can read the current attention snapshot, emit events, and dismiss or snooze local queue items. Provider APPROVE/DENY actions are not exposed by the HTTP broker; they stay inside the trusted plugin/adapter process.

Do not share the token, expose the broker to a LAN or public interface, or include real task data in bug reports.
