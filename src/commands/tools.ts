import { ALL_TOOLS, getTool, runTool } from '../tools/index.js';
import { findRepoRootAsync } from '../util/repo.js';

export interface ToolsDebugOptions {
  json?: boolean;
  schema?: boolean;
}

/**
 * `gity tools:debug [tool] [json-args]` — hidden dev command.
 * Without a tool name, lists tools. With --schema, prints the tool's JSON Schema.
 */
export async function toolsDebug(name: string | undefined, rawJson: string | undefined, opts: ToolsDebugOptions): Promise<void> {
  if (name === undefined) {
    for (const t of ALL_TOOLS) {
      console.log(`  ${t.name.padEnd(12)} ${t.mutating ? '[mutating] ' : ''}${t.description}`);
    }
    return;
  }

  if (opts.schema) {
    const tool = getTool(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    console.log(JSON.stringify(tool.parameters, null, 2));
    return;
  }

  let args: unknown = {};
  if (rawJson !== undefined && rawJson.trim() !== '') {
    try {
      args = JSON.parse(rawJson);
    } catch (error) {
      throw new Error(`Invalid JSON args: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const repoRoot = await findRepoRootAsync();
  if (!repoRoot) throw new Error('Not inside a git repository.');

  const started = Date.now();
  const result = await runTool(name, args, { repoRoot });
  const ms = Date.now() - started;

  if (opts.json) {
    console.log(JSON.stringify({ ...result, ms }, null, 2));
  } else {
    console.log(`[${result.ok ? 'ok' : 'error'}] ${name} (${ms} ms)${result.truncated ? ' [truncated]' : ''}`);
    console.log(result.output);
  }
  if (!result.ok) process.exitCode = 1;
}
