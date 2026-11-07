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

The agent inspects your changes, prints a proposed commit plan, and prompts for confirmation (`y` to commit, `n` to abort, or `edit` to modify the plan/messages). Once confirmed, it stages specific file paths (`git_add`), creates each commit in Conventional Commits format (`<= 72` char imperative subject), verifies the repository with `git_status` after each commit, and pulls from the remote (`git pull --rebase --autostash` by default; if a conflict occurs, it aborts the in-progress rebase/merge and leaves the repo in a safe state with your local commits intact).

Skip confirmation and commit immediately with `--yes`, or skip pulling with `--no-pull`:

```bash
gity run --yes
gity run --no-pull
gity run --pull-strategy ff-only
```

### 4. Dry-run (no changes)

```bash
gity --dry-run
# or
gity run --dry-run
```

Shows what commits would be created (grouped files and Conventional Commit messages) using read-only tools without touching git.

## Commands

| Command | Description |
|---|---|
| `gity` | Show repo status (default action) |
| `gity --dry-run` | Analyze changes and print a commit plan without touching git |
| `gity --version` | Print version |
| `gity --help` | Show help |
| `gity setup` | Interactive provider setup wizard |
| `gity provider list` | List configured providers |
| `gity provider add <name> -t <type> -m <model>` | Add a profile (`--base-url`, `--api-key-env`, `--default`, `--force`) |
| `gity provider show <name>` | Show a provider profile |
| `gity provider remove <name>` | Remove a provider profile |
| `gity provider use <name>` | Set default provider |
| `gity provider test [name]` | Test provider connectivity and chat reply latency |
| `gity config show` | Show config (secrets masked) |
| `gity config path` | Print config file path |
| `gity run [options]` | Run the commit agent |
| `gity run --dry-run` | Preview commits without changes |
| `gity run --yes` | Skip confirmation prompts |
| `gity run --no-pull` | Skip pulling after commits |
| `gity run --pull-strategy <strategy>` | Pull strategy (`rebase-autostash`, `rebase`, `ff-only`, `merge`, `none`) |
| `gity run --provider <name>` | Override provider for this run |
| `gity run --model <name>` | Override model for this run |
| `gity run --max-iterations <n>` | Cap agent tool-calling turns (default 15) |
| `gity run -v, --verbose` | Show tool call timing and status |

## Configuration

Config is stored at `~/.config/gity/config.json` (file `0600`, directory `0700`).
Override with `$GITY_CONFIG` or `$XDG_CONFIG_HOME`. An invalid config file is reported as an error, never silently reset.

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

## Agent Tools

The agent can call these tools (all run in the repo root, output capped at 20k chars):

| Tool | Kind | Description |
|---|---|---|
| `git_status` | read | Porcelain status; secret files flagged |
| `git_diff` | read | Unified diff (`staged`, `paths`, `stat`, `context`); secrets excluded |
| `git_log` | read | Recent commits (`limit`, `paths`) |
| `grep` | read | `git grep` over tracked + untracked files; secrets excluded |
| `bash` | read | `ls`, `cat`, `head`, `tail`, `wc`, `file`, `pwd`, `tree` only |
| `git_add` | mutating | Stage explicit files (no dirs, `.`, globs or secrets) |
| `git_commit` | mutating | Commit staged changes; refuses if a secret is staged |
| `git_pull` | mutating | `git pull --rebase --autostash` |

## Development

```bash
npm install
npm run build        # Bundle to dist/gity.cjs
npm run dev          # Watch mode with tsx
npm run typecheck    # TypeScript type check
npm test             # Run vitest tests
```

Hidden dev command to invoke tools directly:

```bash
gity tools:debug                                   # list tools
gity tools:debug git_diff --schema                 # print JSON Schema
gity tools:debug git_log '{"limit":3}'             # run a tool
gity tools:debug bash '{"command":"ls src"}' --json
```

## License

MIT
