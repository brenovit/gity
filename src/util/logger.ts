import * as p from '@clack/prompts';

export interface ProgressLoggerOptions {
  verbose?: boolean;
  /** Override TTY detection (defaults to `Boolean(process.stdout.isTTY)`). */
  isTTY?: boolean;
  /** Customspinner factory for testing. */
  createSpinner?: () => {
    start: (msg?: string) => void;
    stop: (msg?: string, code?: number) => void;
    message: (msg?: string) => void;
  };
  /** Custom line writer (defaults to `console.log`). */
  logLine?: (line: string) => void;
  /** Custom raw chunk writer for streaming text (defaults to `process.stdout.write`). */
  writeChunk?: (chunk: string) => void;
}

export interface ProgressLogger {
  startPhase(label: string): void;
  updateMessage(label: string): void;
  logToolCall(callDesc: string, iteration: number): void;
  logToolResult(toolName: string, ok: boolean, durationMs: number, truncated: boolean): void;
  onTextDelta(delta: string): void;
  finishPhase(finalText: string): void;
}

/**
 * Create a live progress logger that shows an interactive spinner in TTY mode
 * (when not `--verbose`), logs tool calls live, and supports streaming text output.
 */
export function createProgressLogger(options: ProgressLoggerOptions = {}): ProgressLogger {
  const verbose = Boolean(options.verbose);
  const isTTY = options.isTTY ?? Boolean(process.stdout.isTTY);
  const logLine = options.logLine ?? ((line: string) => console.log(line));
  const writeChunk = options.writeChunk ?? ((chunk: string) => process.stdout.write(chunk));
  const useSpinner = isTTY && !verbose;
  const spinner = useSpinner ? (options.createSpinner ?? (() => p.spinner()))() : null;

  let spinnerActive = false;
  let streamedChars = 0;

  const stopSpinner = (msg?: string) => {
    if (spinner && spinnerActive) {
      spinner.stop(msg);
      spinnerActive = false;
    }
  };

  return {
    startPhase(label: string): void {
      streamedChars = 0;
      if (spinner) {
        spinner.start(label);
        spinnerActive = true;
      } else {
        logLine(label);
      }
    },

    updateMessage(label: string): void {
      if (spinner && spinnerActive) {
        spinner.message(label);
      }
    },

    logToolCall(callDesc: string, iteration: number): void {
      if (spinner && spinnerActive) {
        spinner.message(`Running ${callDesc}`);
      }
      if (verbose) {
        logLine(`  [step ${iteration}] -> ${callDesc}`);
      } else {
        logLine(`  -> ${callDesc}`);
      }
    },

    logToolResult(toolName: string, ok: boolean, durationMs: number, truncated: boolean): void {
      if (verbose) {
        const statusLabel = ok ? 'ok' : 'error';
        const truncLabel = truncated ? ', truncated' : '';
        logLine(`  <- ${toolName} [${statusLabel}, ${durationMs}ms${truncLabel}]`);
      }
    },

    onTextDelta(delta: string): void {
      if (!delta) return;
      if (useSpinner) {
        if (spinnerActive) {
          stopSpinner('Done.');
          logLine('');
        }
        streamedChars += delta.length;
        writeChunk(delta);
      }
    },

    finishPhase(finalText: string): void {
      if (spinnerActive) {
        stopSpinner('Done.');
      }
      if (streamedChars > 0) {
        writeChunk('\n');
        streamedChars = 0;
        return;
      }
      logLine('');
      if (finalText) {
        logLine(finalText);
      }
    },
  };
}

