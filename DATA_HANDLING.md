# Local Data Handling

Attention Deck is designed as a local, single-user development tool. It does not provide a hosted service, telemetry pipeline, or public network listener.

## Data processed

The broker may receive and display:

- project and task labels;
- short attention titles and summaries;
- event identifiers, versions, timestamps, and priority;
- lifecycle generation and occurrence counts;
- local snooze/dismiss treatment and bounded recent outcomes;
- provider-native thread, turn, item, and request identifiers;
- bounded Codex reason or command previews after basic credential-pattern redaction.
- for the opt-in Codex completion hook, a folder-only project label plus hashed session and turn identities; the hook discards the assistant message, prompt, transcript path, model, permission mode, and full working path.

This information can still be sensitive. Task names, paths, commands, and summaries may reveal private project or customer context. Treat the Stream Deck display and authenticated broker snapshot as private workstation surfaces.

## Storage and retention

- The lifecycle store writes a restart-safe local snapshot to `%LOCALAPPDATA%\Preflight Stack\Attention Deck\state.json` by default. It contains current item metadata, source/operator/presentation/decision state, generation/count information, snooze expiry, and bounded RECENT outcomes. It is not a transcript archive.
- In memory, the store is capped at 512 current items, 2,048 delivery-id deduplication records, and 256 RECENT/history records. The state file retains at most the newest 512 delivery-id records and is additionally byte-bounded.
- State files are limited to 8 MiB. Oversized or malformed JSON is quarantined before a replacement can be written. If the file is unreadable, cannot be quarantined, or uses an unsupported schema, persistence becomes read-only so a new mutation cannot silently overwrite it.
- Provider action grants, open app-server responders, and retryable APPROVE/DENY operations are never restored from disk. Reconnection and a fresh trusted-adapter snapshot are required before provider mutations are enabled.
- The random broker token persists at `%LOCALAPPDATA%\AttentionDeck\auth-token` for the current Windows user.
- Startup diagnostics are local, size-bounded, and redact common bearer-token, query-secret, and user-profile patterns. Logs are excluded from source control and release packages.
- Codex task transcripts and completed assistant messages are not copied into the repository or persisted by the completion hook.

## Network behavior

- The broker binds to `127.0.0.1` only.
- Attention Deck does not send telemetry or task content to a service operated by this project.
- The separately installed Codex app or CLI may communicate with OpenAI under its own authentication and policies; Attention Deck communicates only with a local app-server process and its opt-in local completion hook.

## Local clients

Anyone who can read the broker token can read the current attention snapshot, emit events, and dismiss or snooze local queue items. Provider APPROVE/DENY actions are not exposed by the HTTP broker; they stay inside the trusted plugin/adapter process.

Local dismiss and snooze are presentation choices. They do not alter the provider's authoritative task state. A newer version may wake the same item and appear again.

After Attention Deck is stopped, deleting `state.json` clears its restart snapshot and bounded history. Deleting the separate `auth-token` file revokes the old local bearer token; the next start creates a new one.

Do not share the token, expose the broker to a LAN or public interface, or include real task data in bug reports.
