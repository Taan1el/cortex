# Cortex Local

Cortex Local is a small Obsidian side panel for working with notes using a local AI model.

The main idea is simple:

- open a note
- ask Cortex Local about it
- use one-click actions like **Summarize** or **Improve writing**
- approve edits before Cortex changes the file

It is Ollama-first, so you can use it without an API key.

> Status: early local plugin. It is not in the Obsidian community plugin store yet.
> Name note: there is already a community plugin called **Cortex Chat**, so this project uses **Cortex Local** and the plugin id `cortex-local`.

## What it can do

- Chat about the note you have open.
- Improve or rewrite the active note after asking you first.
- Use saved prompt buttons for common tasks.
- Import a ChatGPT `conversations.json` export into Markdown notes.
- Optionally connect ACP-compatible agents like Claude Code or Codex.

## Install manually

Download or build these three files:

- `main.js`
- `manifest.json`
- `styles.css`

Create this folder inside your vault:

```text
<your-vault>/.obsidian/plugins/cortex-local/
```

Put the three files there, then open Obsidian:

1. Settings
2. Community plugins
3. Turn off Restricted mode if needed
4. Enable **Cortex Local**
5. Reload Obsidian if the brain icon does not appear

## Set up Ollama

Cortex Local works best with Ollama running locally.

Install Ollama, then run:

```bash
ollama pull llama3.2
ollama serve
```

Check your model:

```bash
ollama list
```

Default Cortex Local settings:

```text
Address: http://127.0.0.1:11434
Model: llama3.2:latest
```

## Use Cortex Local

Click the brain icon in the left ribbon, or use the command palette:

```text
Cortex Local: Open Cortex Local
```

Try:

- "Summarize this note"
- "Explain this simply"
- "Improve the active note's clarity"

For note edits, Cortex Local shows a permission card before replacing the file. Pick **Apply edit** or **Keep original**.

## Privacy and permissions

Local Ollama requests stay on your machine.

If you add an external ACP agent, that agent may use its own CLI, account, or API. Be careful with private notes. Cortex keeps open-note context off for external agents unless you enable it.

File access is clamped to the Obsidian vault. Writes ask before changing a file unless you turn on auto-save behavior in settings.

Do not put API keys in Cortex settings. Use your operating system environment instead.

## Import ChatGPT history

Cortex Local can import ChatGPT exports:

1. Export your ChatGPT data from ChatGPT settings.
2. Unzip the export.
3. In Obsidian, run:

```text
Cortex Local: Import ChatGPT export
```

Pick `conversations.json`.

By default, notes go into:

```text
ChatGPT/
```

Each conversation becomes one Markdown note.

Related standalone tool:

- [chatgpt-to-obsidian](https://github.com/Taan1el/chatgpt-to-obsidian)

## Build from source

```bash
npm install
npm run build
```

The build writes `main.js` in the project root.

For manual install, copy:

```text
main.js
manifest.json
styles.css
```

into:

```text
<your-vault>/.obsidian/plugins/cortex-local/
```

## Troubleshooting

If Cortex Local says Ollama is not available:

```bash
ollama serve
ollama list
```

If the plugin does not show in Obsidian:

- check the folder name is exactly `cortex-local`
- check `manifest.json` is in that folder
- reload Obsidian

If note edits feel risky, leave write approval on. Cortex Local will ask before replacing the current note.
