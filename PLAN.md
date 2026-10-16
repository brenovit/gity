# Gity — Project Plan

## Overview
AI-powered git commit agent (Node.js + TypeScript CLI). Installable globally on macOS. Running `gity` inside a git repo starts an LLM agent that inspects uncommitted changes, groups them into logical units, creates well-written commits, and then pulls from the remote.

## LLM Backends (Pluggable)
- Ollama
- LM Studio
- Claude API
- Gemini API

## Tech Stack
- Node.js >= 20, TypeScript 5.x (`"strict": true`, `"noUncheckedIndexedAccess": true`)
- ESM (`"type": "module"`, `"module": "NodeNext"`)
- `tsup` for bundling (`src/bin/gity.ts` → `dist/gity.js` with shebang)
- `tsx` for dev (`npm run dev -- <args>`)
- `commander` (CLI), `@clack/prompts` (interactive setup), `zod` (validation)
- Native `fetch` for HTTP — no agent frameworks
- `vitest` for tests

## Dependencies (Minimal)
- `commander` — CLI argument parsing
- `@clack/prompts` — interactive setup wizard
- `zod` — config and tool-argument validation (derive TS types with `z.infer`)
- Native `fetch` — HTTP requests to LLM providers
- `vitest` — testing

## Architecture
```
gity/
  package.json
  tsconfig.json
  tsup.config.ts
  vitest.config.ts
  src/
    bin/gity.ts            # entry, commander setup
    types.ts               # shared types: Message, ToolCall, ToolSpec, ChatResult...
    commands/              # run.ts, setup.ts, provider.ts, config.ts
    agent/
      loop.ts              # generic tool-calling loop (max iterations, token/time guard)
      prompt.ts            # system prompt
    providers/
      index.ts             # factory + Provider interface
      ollama.ts            # POST /api/chat (tools supported)
      lmstudio.ts          # OpenAI-compatible /v1/chat/completions
      claude.ts            # Anthropic Messages API w/ tool_use
      gemini.ts            # generateContent w/ functionDeclarations
    tools/
      index.ts             # tool registry + dispatcher
      git.ts               # git_status, git_diff, git_add, git_commit, git_log, git_pull
      grep.ts              # search repo content
      bash.ts              # restricted shell (read-only allowlist)
    config.ts              # zod schema, load/save/validate
    util/                  # logger.ts, spawn.ts, repo.ts
  test/
```

## Core Types
```ts
type Role = "user" | "assistant" | "tool";

interface ToolCall { id: string; name: string; args: unknown }

type Message =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string; isError?: boolean };

interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema from zod
}

interface ChatResult {
  text: string;
  toolCalls: ToolCall[];
  stopReason: "end" | "tool_use" | "max_tokens" | "error";
}

interface Provider {
  name: string;
  chat(input: { system: string; messages: Message[]; tools?: ToolSpec[]; signal?: AbortSignal }): Promise<ChatResult>;
}
```

## Safety Rules
- Always run commands with `execFile`/`spawn` using argument arrays in the repo's cwd
- Never interpolate model output into a shell string
- Never push, force, reset --hard, clean, checkout --, rebase, branch -D, or anything that discards work
- `bash` tool: allowlist of read-only commands only (`ls`, `cat`, `head`, `tail`, `wc`, `file`, `pwd`, `tree`)
- Reject pipes, redirects, `;`, `&&`, and subshells
- File reads stay inside the repo root (resolve symlinks, then check)
- Truncate large outputs and large diffs (e.g. 20k chars) with a "[truncated]" marker
- Skip secrets: never stage `.env*`, `*.pem`, `*.key`, or id_rsa-like files
- Hard cap on agent iterations (default 15)

## Stages

### Stage 1: Skeleton + repo awareness (no LLM) ✅
- Project scaffold with TypeScript toolchain; `npm run build && npm link` works
- `gity` in a git repo prints: repo name, branch, number of changed/untracked files
- `gity --version`, `gity --help`
- `gity` outside a git repo prints a friendly error and exits 1

### Stage 2: Config + provider management (no agent yet)
- Zod config schema with defaults; `Config` type inferred from it
- `gity setup`: interactive wizard (choose provider, base URL/model/API key env var, test connection)
- `gity provider list | add | remove | use <name> | test [name]`
- `gity config show` (mask secrets) / `gity config path`
- Support multiple named provider profiles with one marked as default
- Defaults: Ollama `http://localhost:11434`, LM Studio `http://localhost:1234/v1`

### Stage 3: Provider adapters (plain chat only)
- Implement all four adapters behind the `Provider` interface, non-streaming first
- Validate raw provider responses with zod (or narrow from `unknown`), no unchecked casts
- `gity provider test` sends a tiny prompt and prints the reply plus latency
- Tool-call smoke test per adapter (fake `get_time` tool)

### Stage 4: Tools
- Implement `git.ts`, `grep.ts`, `bash.ts` tools with zod schemas and safety rules
- Tools return structured, size-limited results
- `gity tools:debug <tool> '<json args>'` (hidden dev command)
- Vitest unit tests for safety guards (path escape, symlink escape, forbidden commands, secret files)

### Stage 5: Agent loop, read-only analysis
- Implement the loop and system prompt. Agent uses only read tools (status, diff, grep, log, bash)
- `gity --dry-run` makes the agent analyze changes and print a commit plan (groups of files, proposed messages) without touching git

### Stage 6: Committing
- Enable `git_add` (specific paths only, never `-A` blindly) and `git_commit`
- Default flow: show plan, ask for confirmation (`y/n/edit`), then commit
- Flags: `--yes` to skip confirmation, `--dry-run` still available
- Conventional Commits format, imperative subject <= 72 chars
- Verify with `git_status` after each commit

### Stage 7: Pull
- After commits, run `git pull --rebase --autostash` (configurable strategy)
- Flag `--no-pull` to skip
- On conflicts: stop, report clearly, leave repo in safe state

### Stage 8: Polish
- Streaming output / spinner with live tool-call logging (`-v` for verbose)
- `--provider <name>` and `--model <name>` per-run overrides
- Timeouts (via `AbortSignal`), retries with backoff for network errors
- Per-repo `.gityrc` overrides (provider, commit style, ignore patterns)
- `gity doctor` command

## Definition of Done (per stage)
- `npm run typecheck`, `npm test`, and `npm run build` all pass cleanly
- Runs without errors on macOS with Node 20+
- No unused code from later stages
- Brief README section updated
