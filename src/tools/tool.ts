import { z } from 'zod';
import { DEFAULT_MAX_OUTPUT_CHARS, ToolSafetyError, truncate } from './safety.js';

export interface ToolContext {
  /** Absolute path to the git repository root; every tool runs here. */
  repoRoot: string;
  /** Max characters of output returned to the model (default 20k). */
  maxOutputChars?: number;
  /** Optional `.gityrc` ignore patterns to exclude from staging and analysis. */
  ignorePatterns?: readonly string[];
  /** Optional `.gityrc` commit style (`conventional`, `freeform`, or custom). */
  commitStyle?: string;
  signal?: AbortSignal;
}

/** Structured, size-limited result of a tool invocation. */
export interface ToolResult {
  ok: boolean;
  output: string;
  truncated: boolean;
}

/** What a tool implementation returns; throwing is equivalent to `{ ok: false }`. */
export interface ToolOutput {
  ok?: boolean;
  output: string;
}

export interface ToolDef<S extends z.ZodType> {
  name: string;
  description: string;
  schema: S;
  /** True if the tool changes the repository (index, commits, working tree). */
  mutating: boolean;
  run(args: z.output<S>, ctx: ToolContext): Promise<ToolOutput>;
}

/** Type-erased tool: validates raw (model-provided) args before running. */
export interface Tool {
  name: string;
  description: string;
  mutating: boolean;
  /** JSON Schema of the arguments. */
  parameters: Record<string, unknown>;
  execute(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult>;
}

function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
  return rest;
}

function finish(ok: boolean, output: string, ctx: ToolContext): ToolResult {
  const { text, truncated } = truncate(output, ctx.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS);
  return { ok, output: text, truncated };
}

export function defineTool<S extends z.ZodType>(def: ToolDef<S>): Tool {
  return {
    name: def.name,
    description: def.description,
    mutating: def.mutating,
    parameters: toJsonSchema(def.schema),
    async execute(rawArgs, ctx) {
      const parsed = def.schema.safeParse(rawArgs ?? {});
      if (!parsed.success) {
        return finish(false, `Invalid arguments for ${def.name}:\n${z.prettifyError(parsed.error)}`, ctx);
      }
      try {
        const result = await def.run(parsed.data, ctx);
        return finish(result.ok ?? true, result.output, ctx);
      } catch (error) {
        const prefix = error instanceof ToolSafetyError ? 'Blocked' : 'Error';
        const message = error instanceof Error ? error.message : String(error);
        return finish(false, `${prefix}: ${message}`, ctx);
      }
    },
  };
}
