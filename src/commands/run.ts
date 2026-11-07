import * as p from '@clack/prompts';
import { DEFAULT_MAX_ITERATIONS, runAgentLoop, type AgentLoopResult } from '../agent/loop.js';
import {
  buildAnalysisUserPrompt,
  buildCommitSystemPrompt,
  buildCommitUserPrompt,
  buildReadOnlySystemPrompt,
} from '../agent/prompt.js';
import {
  DEFAULT_COMMIT_STYLE,
  DEFAULT_PULL_STRATEGY,
  loadConfig,
  loadRepoConfig,
  parsePullStrategy,
  resolveProvider,
  type Config,
  type PullStrategy,
} from '../config.js';
import { createProvider, type Provider } from '../providers/index.js';
import { executeGitPull, runGit } from '../tools/git.js';
import { COMMIT_TOOLS, READ_ONLY_TOOLS, runTool, type ToolResult } from '../tools/index.js';
import { isIgnoredPath, isSecretPath } from '../tools/safety.js';
import type { ToolCall } from '../types.js';
import { createProgressLogger } from '../util/logger.js';
import { findRepoRootAsync, getRepoStatusAsync } from '../util/repo.js';

export type PlanDecision =
  | { action: 'yes' }
  | { action: 'no' }
  | { action: 'edit'; plan: string };

export type ConfirmPlanFn = (plan: string) => Promise<PlanDecision> | PlanDecision;

export interface RunOptions {
  dryRun?: boolean;
  yes?: boolean;
  /** Commander sets `pull: false` when `--no-pull` is passed (defaults to `true`). */
  pull?: boolean;
  /** Explicit flag to skip pulling after commits. */
  noPull?: boolean;
  /** Pull strategy override (`rebase-autostash`, `rebase`, `ff-only`, `merge`, `none`). */
  pullStrategy?: PullStrategy | string;
  provider?: string;
  model?: string;
  maxIterations?: number | string;
  verbose?: boolean;
  /** Optional overrides used by tests. */
  repoRoot?: string;
  configPath?: string;
  providerInstance?: Provider;
  confirmPlan?: ConfirmPlanFn;
  isTTY?: boolean;
}

export function formatToolArgs(args: Record<string, unknown>): string {
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

/** Check if the repository has at least one non-secret, non-ignored changed or untracked file. */
async function hasCommittableChanges(repoRoot: string, ignorePatterns?: readonly string[]): Promise<boolean> {
  const r = await runGit({ repoRoot }, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (r.code !== 0) return false;
  const lines = r.stdout.split('\n').filter((l) => l.length > 0 && !l.startsWith('##'));
  return lines.some((line) => {
    const path = line.slice(3).split(' -> ').pop() ?? '';
    return path.length > 0 && !isSecretPath(path) && !isIgnoredPath(path, ignorePatterns);
  });
}

/** Check if the repository has at least one configured git remote. */
async function hasRemote(repoRoot: string): Promise<boolean> {
  const r = await runGit({ repoRoot }, ['remote']);
  return r.code === 0 && r.stdout.trim().length > 0;
}

export interface PromptDriver {
  select: typeof p.select;
  text: typeof p.text;
  isCancel: typeof p.isCancel;
}

/** Interactive y/n/edit confirmation prompt for the proposed commit plan. */
export async function promptPlanConfirmation(
  plan: string,
  prompts: PromptDriver = p,
): Promise<PlanDecision> {
  const choice = await prompts.select({
    message: 'Proceed with this commit plan? (y/n/edit)',
    options: [
      { value: 'yes' as const, label: 'Yes — create commits (y)' },
      { value: 'edit' as const, label: 'Edit — modify plan or commit messages (edit)' },
      { value: 'no' as const, label: 'No — abort without committing (n)' },
    ],
  });

  if (prompts.isCancel(choice) || choice === 'no') {
    return { action: 'no' };
  }

  if (choice === 'edit') {
    const edited = await prompts.text({
      message: 'Enter updated commit plan or instructions for the agent:',
      placeholder: 'e.g. feat(cli): add interactive commit confirmation',
      defaultValue: plan,
      validate: (value) => {
        if (!value || value.trim().length === 0) {
          return 'Edited plan or instructions cannot be empty';
        }
        return undefined;
      },
    });

    if (prompts.isCancel(edited)) {
      return { action: 'no' };
    }

    return { action: 'edit', plan: edited.trim() };
  }

  return { action: 'yes' };
}

/**
 * Run the commit agent: analyze changes, display the commit plan, optionally confirm (y/n/edit), and commit.
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

  const repoConfig = await loadRepoConfig(repoRoot);
  const ignorePatterns = repoConfig.ignore;
  const commitStyle = repoConfig.commitStyle ?? DEFAULT_COMMIT_STYLE;

  let config: Config | undefined;
  let provider = opts.providerInstance;
  if (!provider) {
    config = await loadConfig(opts.configPath);
    const providerName = opts.provider ?? repoConfig.provider;
    const resolved = resolveProvider(config, providerName);
    const modelOverride = opts.model?.trim() || repoConfig.model;
    const profile = modelOverride ? { ...resolved.profile, model: modelOverride } : resolved.profile;
    provider = createProvider(profile);
  } else if (opts.configPath) {
    config = await loadConfig(opts.configPath);
  }

  const pullStrategy: PullStrategy = opts.pullStrategy
    ? parsePullStrategy(String(opts.pullStrategy))
    : (repoConfig.pullStrategy ?? config?.pullStrategy ?? DEFAULT_PULL_STRATEGY);
  const shouldPull = opts.noPull !== true && opts.pull !== false && pullStrategy !== 'none';

  const progress = createProgressLogger({
    verbose: opts.verbose,
    isTTY: opts.isTTY ?? false,
  });

  const logToolCall = (call: ToolCall, iteration: number): void => {
    const argText = formatToolArgs(call.args);
    const callDesc = argText ? `${call.name}(${argText})` : `${call.name}()`;
    progress.logToolCall(callDesc, iteration);
  };

  const logToolResult = (call: ToolCall, toolResult: ToolResult, durationMs: number): void => {
    progress.logToolResult(call.name, toolResult.ok, durationMs, toolResult.truncated);
  };

  const modeLabel = opts.dryRun ? ' [dry-run]' : '';
  progress.startPhase(
    `Analyzing ${status.repoName} (${status.branch || 'detached HEAD'}: ${status.summary}) using ${provider.name}${modeLabel}...`,
  );

  const planResult = await runAgentLoop({
    provider,
    system: buildReadOnlySystemPrompt({ commitStyle, ignorePatterns }),
    userPrompt: buildAnalysisUserPrompt(status),
    repoRoot,
    tools: READ_ONLY_TOOLS,
    maxIterations,
    ignorePatterns,
    commitStyle,
    onToolCall: logToolCall,
    onToolResult: logToolResult,
    onTextDelta: (delta) => progress.onTextDelta(delta),
  });

  progress.finishPhase(planResult.text || '(No commit plan returned by the model.)');

  if (planResult.stopReason !== 'completed') {
    console.error(
      `\nWarning: Agent stopped with reason "${planResult.stopReason}" after ${planResult.iterations} iteration(s).`,
    );
    if (!planResult.text || planResult.stopReason === 'error') {
      process.exitCode = 1;
    }
    return planResult;
  }

  if (opts.dryRun) {
    return planResult;
  }

  if (!planResult.text) {
    process.exitCode = 1;
    return planResult;
  }

  if (!(await hasCommittableChanges(repoRoot, ignorePatterns))) {
    return planResult;
  }

  let editedPlan: string | undefined;
  if (!opts.yes) {
    const confirmFn = opts.confirmPlan ?? promptPlanConfirmation;
    const decision = await confirmFn(planResult.text);
    if (decision.action === 'no') {
      console.log('\nAborted — no commits created.');
      return planResult;
    }
    if (decision.action === 'edit') {
      editedPlan = decision.plan;
    }
  }

  progress.startPhase('\nCreating commits...');
  const commitResult = await runAgentLoop({
    provider,
    system: buildCommitSystemPrompt({ commitStyle, ignorePatterns }),
    initialMessages: planResult.messages,
    userPrompt: buildCommitUserPrompt(editedPlan, commitStyle),
    repoRoot,
    tools: COMMIT_TOOLS,
    maxIterations,
    ignorePatterns,
    commitStyle,
    onToolCall: logToolCall,
    onToolResult: logToolResult,
    onTextDelta: (delta) => progress.onTextDelta(delta),
  });

  // Ensure git_status verification runs after the final commit if the model omitted it.
  let lastCommitIdx = -1;
  let lastStatusIdx = -1;
  for (let i = 0; i < commitResult.toolTraces.length; i++) {
    const trace = commitResult.toolTraces[i];
    if (!trace) continue;
    if (trace.call.name === 'git_commit' && trace.result.ok) {
      lastCommitIdx = i;
    } else if (trace.call.name === 'git_status') {
      lastStatusIdx = i;
    }
  }

  if (lastCommitIdx !== -1 && lastStatusIdx < lastCommitIdx) {
    const verifyCall: ToolCall = { id: 'post_commit_verify', name: 'git_status', args: {} };
    logToolCall(verifyCall, commitResult.iterations);
    const verifyStart = Date.now();
    const verifyResult = await runTool('git_status', {}, { repoRoot, ignorePatterns, commitStyle }, COMMIT_TOOLS);
    const verifyDuration = Date.now() - verifyStart;
    logToolResult(verifyCall, verifyResult, verifyDuration);
    commitResult.toolTraces.push({
      iteration: commitResult.iterations,
      call: verifyCall,
      result: verifyResult,
      durationMs: verifyDuration,
    });
  }

  if (commitResult.text) {
    progress.finishPhase(commitResult.text);
  }

  if (commitResult.stopReason !== 'completed') {
    console.error(
      `\nWarning: Agent stopped with reason "${commitResult.stopReason}" after ${commitResult.iterations} commit iteration(s).`,
    );
    if (commitResult.stopReason === 'error') {
      process.exitCode = 1;
      return {
        text: commitResult.text || planResult.text,
        messages: commitResult.messages,
        toolTraces: [...planResult.toolTraces, ...commitResult.toolTraces],
        iterations: planResult.iterations + commitResult.iterations,
        stopReason: commitResult.stopReason,
      };
    }
  }

  if (shouldPull && lastCommitIdx !== -1 && (await hasRemote(repoRoot))) {
    console.log(`\nPulling from remote (strategy: ${pullStrategy})...`);
    const pullCall: ToolCall = {
      id: 'post_commit_pull',
      name: 'git_pull',
      args: { strategy: pullStrategy },
    };
    logToolCall(pullCall, commitResult.iterations);
    const pullStart = Date.now();
    const pullOutcome = await executeGitPull({ repoRoot }, pullStrategy);
    const pullDuration = Date.now() - pullStart;
    const pullToolResult: ToolResult = {
      ok: pullOutcome.ok,
      output: pullOutcome.output,
      truncated: false,
    };
    logToolResult(pullCall, pullToolResult, pullDuration);
    commitResult.toolTraces.push({
      iteration: commitResult.iterations,
      call: pullCall,
      result: pullToolResult,
      durationMs: pullDuration,
    });

    if (!pullOutcome.ok) {
      console.error(`\nError: ${pullOutcome.output}`);
      process.exitCode = 1;
      return {
        text: commitResult.text || planResult.text,
        messages: commitResult.messages,
        toolTraces: [...planResult.toolTraces, ...commitResult.toolTraces],
        iterations: planResult.iterations + commitResult.iterations,
        stopReason: 'error',
      };
    }

    console.log(pullOutcome.output);
  }

  return {
    text: commitResult.text || planResult.text,
    messages: commitResult.messages,
    toolTraces: [...planResult.toolTraces, ...commitResult.toolTraces],
    iterations: planResult.iterations + commitResult.iterations,
    stopReason: commitResult.stopReason,
  };
}
