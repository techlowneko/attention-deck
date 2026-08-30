# Contributing

Thanks for helping improve Attention Deck.

## Before starting

- Open an issue before a large feature, new provider adapter, protocol change, or security-model change.
- Keep pull requests focused and explain the user-visible behavior and trust boundary.
- Do not include tokens, task transcripts, personal filesystem paths, generated plugin packages, or local logs.
- Do not add provider actions based only on inferred status. Mutations require an exact provider-native request and fail-closed revalidation.

## Development

Requirements are Node.js 20+ and, for device testing, Stream Deck software 7.0+ on Windows.

```powershell
npm ci
npm run check
npm test
npm run build
npm run validate
```

For physical development:

```powershell
npx streamdeck link com.preflightstack.attention-deck.sdPlugin
npx streamdeck restart com.preflightstack.attention-deck
```

## Pull requests

- Add or update tests for behavior changes.
- Update the PRD, workflow, or protocol when a capability boundary changes.
- State whether the change was tested in automation, the Stream Deck simulator, or physical hardware.
- Preserve unrelated user work and avoid broad mechanical rewrites.
- Keep public examples free of personal identifiers and private project content.

By contributing, you agree that your contribution may be distributed under the repository's license.
