# gity

AI-powered git commit agent CLI. Inspect your uncommitted changes, group them into logical commits, and create well-written messages — all from the terminal.

## Features

- **Multi-provider LLM**: Ollama, LM Studio, Claude API, Gemini API (pluggable)
- **Smart commit grouping**: Automatically groups related changes into logical commits
- **Conventional Commits**: Generates `feat:`, `fix:`, `docs:`, `refactor:` messages with imperative subjects
- **Safety-first**: Never pushes, forces, or discards work. Read-only bash allowlist. Symlink-aware file access.
- **Dry-run mode**: Preview commit plans without touching git

## Install

```bash
npm i -g gity
```

Or build from source:

```bash
git clone <repo>
cd gity
npm install
npm run build
npm link
```

## Quick Start

### 1. Configure a provider

```bash
gity setup
```

Or add a provider manually:

```bash
gity provider add my-ollama --type ollama --model llama3.2
```

### 2. Inspect your repo

```bash
gity
```

Shows repo name, branch, and changed/untracked file counts.

### 3. Create commits

```bash
gity run
```

The agent inspects your changes, groups them, and asks for confirmation before committing.

### 4. Dry-run (no changes)

```bash
gity run --dry-run
```

Shows what commits would be created without touching git.

## Commands

| Command | Description |
|---|---|
| `gity` | Show repo status (default action) |
| `gity --version` | Print version |
| `gity --help` | Show help |
| `gity setup` | Interactive provider setup wizard |
| `gity provider list` | List configured providers |
| `gity provider add <name> [options]` | Add a provider profile |
| `gity provider remove <name>` | Remove a provider profile |
| `gity provider use <name>` | Set default provider |
| `gity provider test [name]` | Test a provider connection |
| `gity config show` | Show config (secrets masked) |
| `gity config path` | Print config file path |
| `gity run [options]` | Run the commit agent |
| `gity run --dry-run` | Preview commits without changes |
| `gity run --yes` | Skip confirmation prompts |
| `gity run --no-pull` | Skip pulling after commits |
| `gity run --provider <name>` | Override provider for this run |
| `gity run --model <name>` | Override model for this run |

## Configuration

Config is stored at `~/.config/gity/config.json` (created with `0600` permissions).

API keys come from environment variables:

| Provider | Env Var |
|---|---|
| Ollama | (none — local) |
| LM Studio | (none — local) |
| Claude | `ANTHROPIC_API_KEY` |
| Gemini | `GEMINI_API_KEY` |

### Example config

```json
{
  "providers": {
    "default": "ollama-local",
    "ollama-local": {
      "type": "ollama",
      "model": "llama3.2",
      "baseUrl": "http://localhost:11434"
    },
    "claude": {
      "type": "claude",
      "model": "claude-sonnet-4-20250514",
      "apiKeyEnv": "ANTHROPIC_API_KEY"
    }
  }
}
```

## Safety

- Commands run via `execFile` with argument arrays — never interpolated strings
- **Never** pushes, forces, resets, checks out, rebases, or deletes branches
- `bash` tool only allows read-only commands: `ls`, `cat`, `head`, `tail`, `wc`, `file`, `pwd`, `tree`
- Rejects pipes, redirects, `;`, `&&`, and subshells
- Symlinks are resolved and checked to stay within the repo root
- Large outputs are truncated with `[truncated]` markers
- Secrets (`.env*`, `*.pem`, `*.key`, `id_rsa*`) are never staged
- Agent iterations capped at 15 (configurable)

## Development

```bash
npm install
npm run build        # Bundle to dist/gity.cjs
npm run dev          # Watch mode with tsx
npm run typecheck    # TypeScript type check
npm test             # Run vitest tests
```

## License

MIT
