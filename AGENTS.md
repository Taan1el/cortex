# AGENTS.md

## Purpose

`cortex` is an Obsidian plugin for an AI workspace inside a local vault. It connects to agent profiles, reads/writes vault files through Obsidian APIs, and includes ChatGPT export import support.

## Stack

- TypeScript
- Obsidian plugin API
- esbuild
- `@agentclientprotocol/sdk`

## Common Commands

```powershell
npm run build
npm run dev
npm audit --audit-level=moderate
```

## Project Structure

- `src/main.ts`: plugin entry point and commands.
- `src/agent/`: agent connection/controller logic.
- `src/view/`: UI panel code.
- `src/vault/`: vault file access helpers.
- `src/import/`: ChatGPT export conversion/import logic.
- `main.js`, `styles.css`, `manifest.json`: built Obsidian plugin output.

## Coding Rules

- Keep vault path handling defensive; never allow file access outside the vault root.
- Treat missing agent configuration as a user-facing state, not a crash path.
- Do not commit API keys or agent secrets.
- Keep generated `main.js` in sync after source changes by running `npm run build`.

## Maintenance Checks

- Run `npm run build` after TypeScript or UI changes.
- Run `npm audit --audit-level=moderate` for dependency changes.
- Check installed plugin output under `<vault>/.obsidian/plugins/cortex` only as deployment output, not source of truth.
