# Security / contribution notes

- Do not commit API keys, `.env`, Hermes home paths with secrets, or personal transcripts.
- `plugin.js` must remain plain ESM with only `@hermes/plugin-sdk`, `react`, and `react/jsx-runtime` imports.
- Folder name when installed must stay `voice-hud` (matches `export default.id`).
