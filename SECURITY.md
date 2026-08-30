# Security Policy

Attention Deck is an early alpha. The `main` branch is the only supported development line until versioned releases begin.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability involving authentication, provider actions, command execution, unsafe locators, or secret exposure.

Use GitHub's private vulnerability reporting for this repository:

<https://github.com/techlowneko/attention-deck/security/advisories/new>

Include the affected version or commit, reproduction steps, expected impact, and any suggested mitigation. Do not include real tokens, private task content, personal paths, or credentials.

## Trust boundaries

- The broker is designed for one user and binds to `127.0.0.1` only.
- A bearer token is required for snapshots and mutations.
- Generic events are display-only and cannot declare commands, provider callbacks, approval actions, or arbitrary locators.
- The opt-in Codex completion hook is a generic emitter, not a trusted provider adapter. It hashes native identifiers, discards transcript and message content, and cannot grant OPEN, APPROVE, or DENY.
- Provider actions are accepted only from in-process trusted adapters and are bound to exact native request identifiers.
- Stale, changed, disconnected, or outcome-unknown items fail closed.
- Attention Deck is not designed for public internet or LAN exposure.

## Sensitive local files

The authentication token, logs, generated packages, runtime state, and local Codex task data must never be committed. If a report requires diagnostics, redact usernames, task content, repository paths, environment variables, and tokens first.
