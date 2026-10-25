# Context Bridge

> **Bridge the context gap between your codebase and AI coding tools.**

Context Bridge is a lightweight MCP (Model Context Protocol) server that builds a persistent semantic knowledge graph of your codebase. It enables AI assistants to query complex codebases with sub-millisecond latency, eliminating the need to re-read files every session.

## Why?

AI coding tools are powerful but suffer from a **context gap**:
- They re-read the same files in every session
- They lack deep understanding of your architecture
- They can't learn from your coding conventions
- 23 minutes of developer focus are lost per context switch

Context Bridge solves this by indexing your codebase into a local knowledge graph that persists across sessions.

## Features

- **Semantic Code Search** — Query code with natural language
- **Persistent Knowledge Graph** — SQLite-based, survives restarts
- **Sub-millisecond Queries** — FTS5 + precomputed embeddings
- **MCP Protocol** — Works with Claude Code, Cursor, and any MCP client
- **Auto-indexing** — Watches files and updates the index automatically
- **Zero Cloud** — Everything runs locally

## Quick Start

```bash
# Clone and install locally
git clone https://github.com/hussain-alsaibai/context-bridge.git
cd context-bridge && npm install

# Initialize in your project
cd your-project
node /path/to/context-bridge/src/server.js init

# Start the MCP server
node /path/to/context-bridge/src/server.js serve

# Or use with Claude Code
claude mcp add context-bridge -- node /path/to/context-bridge/src/server.js serve
```

> **Note:** the unscoped npm name `context-bridge` is owned by an unrelated
> third-party package, so `npm install -g context-bridge` installs that package
> instead of this one. Use the clone-and-install steps above until an official
> npm release under a scoped name is available.

## Configuration

Create `.context-bridge.json` in your project root:

```json
{
  "include": ["src/**/*.{js,ts,jsx,tsx}", "lib/**/*.py"],
  "exclude": ["node_modules/**", "dist/**", "*.test.js"],
  "dbPath": ".context-bridge/db.sqlite",
  "watch": true,
  "maxFileSizeKB": 500
}
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `search_code` | Search code with natural language or regex |
| `get_symbol` | Get full context of a function/class/variable |
| `get_dependencies` | Show what a file depends on |
| `get_callers` | Find all callers of a function |
| `summarize_module` | Get a high-level summary of a module |

## Architecture

```
┌─────────────────┐     ┌──────────────┐     ┌────────────────┐
│  Claude Code    │────▶│ Context      │────▶│ SQLite + FTS5  │
│  Cursor         │     │ Bridge MCP   │     │ Knowledge Graph│
│  Other MCP      │◀────│ Server       │◀────│ (persistent)   │
│  Clients        │     │              │     │                │
└─────────────────┘     └──────────────┘     └────────────────┘
                               │
                               ▼
                        ┌──────────────┐
                        │ File Watcher │
                        │ (auto-index) │
                        └──────────────┘
```

## License

MIT
