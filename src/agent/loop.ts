import { READ_ONLY_TOOLS, runTool, toToolSpecs, type Tool, type ToolResult } from '../tools/index.js';
import type { Message, Provider, ToolCall } from '../types.js';

/** Hard cap on agent loop iterations (per PLAN.md safety rules). */
export const DEFAULT_MAX_ITERATIONS = 15;

/** Default wall-clock time guard for an agent run (5 minutes). */
export const DEFAULT_MAX_DURATION_MS = 5 * 60 * 1000;

/** Default total message character budget across the conversation (~60k tokens). */
export const DEFAULT_MAX_TOTAL_CHARS = 240_000;

export type AgentStopReason =
  | 'completed'
  | 'max_iterations'
  | 'max_tokens'
  | 'timeout'
  | 'aborted'
  | 'error';

export interface AgentToolTrace {
  iteration: number;
  call: ToolCall;
  result: ToolResult;
  durationMs: number;
}

export interface AgentLoopOptions {
  provider: Provider;
  system: string;
  userPrompt: string;
  repoRoot: string;
  /** Optional prior conversation messages to continue from. */
  initialMessages?: readonly Message[];
  /** Tools exposed to the model and dispatcher. Defaults to READ_ONLY_TOOLS. */
  tools?: readonly Tool[];
  /** Maximum LLM turns before stopping (default 15, clamped to 1..50). */
  maxIterations?: number;
  /** Maximum wall-clock time in ms before aborting (default 5 min). */
  maxDurationMs?: number;
  /** Maximum total characters across conversation messages before stopping. */
  maxTotalChars?: number;
  /** Per-tool output character cap (defaults to tool safety default of 20k). */
  maxToolOutputChars?: number;
  signal?: AbortSignal;
  onToolCall?: (call: ToolCall, iteration: number) => void;
  onToolResult?: (call: ToolCall, result: ToolResult, durationMs: number) => void;
}

export interface AgentLoopResult {
  /** Final (or latest) assistant text output. */
  text: string;
  /** Full conversation transcript. */
  messages: Message[];
  /** Executed tool calls in order. */
  toolTraces: AgentToolTrace[];
  /** Number of LLM turns executed. */
  iterations: number;
  /** Why the loop terminated. */
  stopReason: AgentStopReason;
}

function countMessageChars(system: string, messages: readonly Message[]): number {
  let total = system.length;
  for (const m of messages) {
    total += m.content.length;
    if (m.role === 'assistant' && m.toolCalls) {
      for (const tc of m.toolCalls) {
        total += tc.name.length + JSON.stringify(tc.args).length;
      }
    }
  }
  return total;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

/**
 * Execute the tool-calling agent loop with iteration, token/char, and time guards.
 */
export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const tools = options.tools ?? READ_ONLY_TOOLS;
  const toolSpecs = toToolSpecs(tools);
  const maxIterations = Math.max(1, Math.min(options.maxIterations ?? DEFAULT_MAX_ITERATIONS, 50));
  const maxDurationMs = options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
  const maxTotalChars = options.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS;

  const messages: Message[] = [
    ...(options.initialMessages ?? []),
    { role: 'user', content: options.userPrompt },
  ];
  const toolTraces: AgentToolTrace[] = [];
  const startedAt = Date.now();
  let latestText = '';
  let iterations = 0;

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    if (options.signal?.aborted) {
      return { text: latestText, messages, toolTraces, iterations, stopReason: 'aborted' };
    }

    const elapsed = Date.now() - startedAt;
    const remainingMs = maxDurationMs - elapsed;
    if (remainingMs <= 0) {
      return { text: latestText, messages, toolTraces, iterations, stopReason: 'timeout' };
    }

    if (countMessageChars(options.system, messages) > maxTotalChars) {
      return { text: latestText, messages, toolTraces, iterations, stopReason: 'max_tokens' };
    }

    const timeoutSignal = AbortSignal.timeout(remainingMs);
    const stepSignal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;

    let response;
    try {
      iterations = iteration;
      response = await options.provider.chat({
        system: options.system,
        messages,
        tools: toolSpecs,
        signal: stepSignal,
      });
    } catch (err) {
      if (options.signal?.aborted) {
        return { text: latestText, messages, toolTraces, iterations, stopReason: 'aborted' };
      }
      if (timeoutSignal.aborted || isAbortError(err)) {
        return { text: latestText, messages, toolTraces, iterations, stopReason: 'timeout' };
      }
      throw err;
    }

    if (response.text.trim().length > 0) {
      latestText = response.text.trim();
    }

    messages.push({
      role: 'assistant',
      content: response.text,
      ...(response.toolCalls.length > 0 ? { toolCalls: response.toolCalls } : {}),
    });

    if (response.stopReason === 'error') {
      return { text: latestText, messages, toolTraces, iterations, stopReason: 'error' };
    }

    if (response.toolCalls.length === 0) {
      const stopReason: AgentStopReason = response.stopReason === 'max_tokens' ? 'max_tokens' : 'completed';
      return { text: latestText, messages, toolTraces, iterations, stopReason };
    }

    for (const call of response.toolCalls) {
      options.onToolCall?.(call, iteration);
      const callStart = Date.now();
      const result = await runTool(
        call.name,
        call.args,
        {
          repoRoot: options.repoRoot,
          maxOutputChars: options.maxToolOutputChars,
          signal: stepSignal,
        },
        tools,
      );
      const durationMs = Date.now() - callStart;
      options.onToolResult?.(call, result, durationMs);
      toolTraces.push({ iteration, call, result, durationMs });
      messages.push({
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: result.output,
        isError: !result.ok,
      });
    }
  }

  return {
    text: latestText,
    messages,
    toolTraces,
    iterations,
    stopReason: 'max_iterations',
  };
}

