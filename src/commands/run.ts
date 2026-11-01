import { DEFAULT_MAX_ITERATIONS, runAgentLoop, type AgentLoopResult } from '../agent/loop.js';
import { buildAnalysisUserPrompt, READ_ONLY_SYSTEM_PROMPT } from '../agent/prompt.js';
import { loadConfig, resolveProvider } from '../config.js';
import { createProvider, type Provider } from '../providers/index.js';
import { READ_ONLY_TOOLS } from '../tools/index.js';
import type { ToolCall } from '../types.js';
import { findRepoRootAsync, getRepoStatusAsync } from '../util/repo.js';

export interface RunOptions {
  dryRun?: boolean;
  provider?: string;
  model?: string;
  maxIterations?: number | string;
  verbose?: boolean;
  /** Optional overrides used by tests. */
  repoRoot?: string;
  configPath?: string;
  providerInstance?: Provider;
}

function formatToolArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return '';
  const summary = entries.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ');
  return summary.length > 80 ? `${summary.slice(0, 77)}...` : summary;
}

function parseMaxIterations(raw: number | string | undefined): number {
  if (raw === undefined) return DEFAULT_MAX_ITERATIONS;
  const n = typeof raw === 'number' ? raw : Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1 || n > 50) {
    throw new Error(`Invalid --max-iterations "${String(raw)}": must be an integer between 1 and 50.`);
  }
  return n;
}

/**
 * Run the read-only commit analysis agent and print the proposed commit plan.
 */
export async function runAgent(opts: RunOptions = {}): Promise<AgentLoopResult | null> {
  const repoRoot = opts.repoRoot ?? (await findRepoRootAsync());
  if (!repoRoot) {
    throw new Error('Not inside a git repository. Run `gity` from a directory containing a `.git` folder.');
  }

  const maxIterations = parseMaxIterations(opts.maxIterations);
  const status = await getRepoStatusAsync(repoRoot);

  if (status.changedCount === 0 && status.untrackedCount === 0) {
    console.log(`Working tree is clean (${status.repoName} @ ${status.branch || 'detached HEAD'}) — nothing to commit.`);
    return null;
  }

  let provider = opts.providerInstance;
  if (!provider) {
    const config = await loadConfig(opts.configPath);
    const resolved = resolveProvider(config, opts.provider);
    const profile = opts.model ? { ...resolved.profile, model: opts.model.trim() } : resolved.profile;
    provider = createProvider(profile);
  }

  console.log(
    `Analyzing ${status.repoName} (${status.branch || 'detached HEAD'}: ${status.summary}) using ${provider.name} [dry-run]...`,
  );

  const result = await runAgentLoop({
    provider,
    system: READ_ONLY_SYSTEM_PROMPT,
    userPrompt: buildAnalysisUserPrompt(status),
    repoRoot,
    tools: READ_ONLY_TOOLS,
    maxIterations,
    onToolCall(call: ToolCall, iteration: number) {
      const argText = formatToolArgs(call.args);
      const callDesc = argText ? `${call.name}(${argText})` : `${call.name}()`;
      if (opts.verbose) {
        console.log(`  [step ${iteration}] -> ${callDesc}`);
      } else {
        console.log(`  -> ${callDesc}`);
      }
    },
    onToolResult(call, toolResult, durationMs) {
      if (opts.verbose) {
        const statusLabel = toolResult.ok ? 'ok' : 'error';
        const truncLabel = toolResult.truncated ? ', truncated' : '';
        console.log(`  <- ${call.name} [${statusLabel}, ${durationMs}ms${truncLabel}]`);
      }
    },
  });

  console.log();
  if (result.text) {
    console.log(result.text);
  } else {
    console.log('(No commit plan returned by the model.)');
  }

  if (result.stopReason !== 'completed') {
    console.error(`\nWarning: Agent stopped with reason "${result.stopReason}" after ${result.iterations} iteration(s).`);
    if (!result.text || result.stopReason === 'error') {
      process.exitCode = 1;
    }
  }

  return result;
}

