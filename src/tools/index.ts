import type { ToolSpec } from '../types.js';
import { bashTool } from './bash.js';
import { gitTools } from './git.js';
import { grepTool } from './grep.js';
import type { Tool, ToolContext, ToolResult } from './tool.js';

export type { Tool, ToolContext, ToolResult } from './tool.js';

/** Every tool gity knows about. */
export const ALL_TOOLS: readonly Tool[] = [...gitTools, grepTool, bashTool];

/** Read-only tools safe for analysis / dry-run (status, diff, log, grep, bash). */
export const READ_ONLY_TOOLS: readonly Tool[] = ALL_TOOLS.filter((t) => !t.mutating);

export function getTool(name: string, tools: readonly Tool[] = ALL_TOOLS): Tool | undefined {
  return tools.find((t) => t.name === name);
}

/** Provider-facing specs (name, description, JSON Schema). */
export function toToolSpecs(tools: readonly Tool[] = ALL_TOOLS): ToolSpec[] {
  return tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
}

/** Look up a tool by name, validate args and run it. Unknown tools yield an error result. */
export async function runTool(
  name: string,
  rawArgs: unknown,
  ctx: ToolContext,
  tools: readonly Tool[] = ALL_TOOLS,
): Promise<ToolResult> {
  const tool = getTool(name, tools);
  if (!tool) {
    return {
      ok: false,
      output: `Unknown tool: ${name}. Available: ${tools.map((t) => t.name).join(', ')}`,
      truncated: false,
    };
  }
  return tool.execute(rawArgs, ctx);
}
