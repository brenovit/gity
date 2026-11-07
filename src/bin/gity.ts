import { Command } from 'commander';
import { findRepoRootAsync, getRepoStatusAsync } from '../util/repo.js';
import { runSetup } from '../commands/setup.js';
import {
  providerAdd,
  providerList,
  providerRemove,
  providerShow,
  providerTest,
  providerUse,
  type ProviderAddOptions,
} from '../commands/provider.js';
import { configPath, configShow } from '../commands/config.js';
import { runDoctor } from '../commands/doctor.js';
import { runAgent, type RunOptions } from '../commands/run.js';
import { toolsDebug, type ToolsDebugOptions } from '../commands/tools.js';

const program = new Command();

program
  .name('gity')
  .description('AI-powered git commit agent — inspect your repo and create well-written commits')
  .version('0.1.0')
  .option('-d, --dry-run', 'Analyze changes and print a commit plan without touching git')
  .option('-y, --yes', 'Skip confirmation prompts and commit immediately')
  .option('--no-pull', 'Skip pulling from the remote after committing')
  .option('--pull-strategy <strategy>', 'Pull strategy: rebase-autostash | rebase | ff-only | merge | none')
  .option('-p, --provider <name>', 'Provider profile to use for this run')
  .option('-m, --model <model>', 'Model override for this run')
  .option('--max-iterations <n>', 'Maximum agent tool-calling iterations (default 15)')
  .option('-v, --verbose', 'Show detailed tool call timing and status');

// Default action: run agent when --dry-run, --yes, --provider, or --model is passed; otherwise show repo status
program.action(async (opts: RunOptions) => {
  try {
    if (opts.dryRun || opts.yes || opts.provider || opts.model) {
      await runAgent(opts);
      return;
    }

    const root = await findRepoRootAsync();
    if (!root) {
      console.error('Error: Not inside a git repository.');
      console.error('Run `gity` from a directory containing a `.git` folder.');
      process.exit(1);
    }

    const status = await getRepoStatusAsync(root);

    console.log();
    console.log(`  Repo:    ${status.repoName}`);
    console.log(`  Branch:  ${status.branch || '(none / detached HEAD)'}`);
    console.log(`  Changed: ${status.changedCount}`);
    console.log(`  Untracked: ${status.untrackedCount}`);
    console.log(`  ${status.summary}`);
    console.log();
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
});

/** Wrap an action so errors print as a single friendly line and exit 1. */
function handle<A extends unknown[]>(fn: (...args: A) => Promise<void> | void): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try {
      await fn(...args);
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  };
}

// gity run — run the commit agent
program
  .command('run')
  .description('Analyze uncommitted changes, confirm plan, create commits, and pull from remote')
  .option('-d, --dry-run', 'Analyze changes and print a commit plan without touching git')
  .option('-y, --yes', 'Skip confirmation prompts and commit immediately')
  .option('--no-pull', 'Skip pulling from the remote after committing')
  .option('--pull-strategy <strategy>', 'Pull strategy: rebase-autostash | rebase | ff-only | merge | none')
  .option('-p, --provider <name>', 'Provider profile to use for this run')
  .option('-m, --model <model>', 'Model override for this run')
  .option('--max-iterations <n>', 'Maximum agent tool-calling iterations (default 15)')
  .option('-v, --verbose', 'Show detailed tool call timing and status')
  .action(
    handle((opts: RunOptions) => {
      const rootOpts = program.opts<RunOptions>();
      return runAgent({
        ...rootOpts,
        ...opts,
        pull: rootOpts.pull !== false && opts.pull !== false,
      }).then(() => undefined);
    }),
  );

// gity setup — interactive provider setup wizard
program
  .command('setup')
  .description('Run the interactive provider setup wizard')
  .action(handle(runSetup));

// gity doctor — diagnostic checks
program
  .command('doctor')
  .description('Check Node.js, git, repo, config, .gityrc, and provider connectivity')
  .option('-p, --provider <name>', 'Provider profile to check')
  .action(
    handle((opts: { provider?: string }) => {
      const rootOpts = program.opts<{ provider?: string }>();
      return runDoctor({ provider: opts.provider ?? rootOpts.provider }).then(() => undefined);
    }),
  );

// gity provider — provider management
const providerCmd = program.command('provider').description('Manage provider profiles');

providerCmd
  .command('list')
  .alias('ls')
  .description('List all configured provider profiles')
  .action(handle(providerList));

providerCmd
  .command('show <name>')
  .description('Show details for a specific provider')
  .action(handle(providerShow));

providerCmd
  .command('add <name>')
  .description('Add a provider profile')
  .requiredOption('-t, --type <type>', 'provider type: ollama | lmstudio | claude | gemini')
  .requiredOption('-m, --model <model>', 'model name')
  .option('--base-url <url>', 'base URL (defaults per provider type)')
  .option('--api-key-env <name>', 'env var holding the API key (claude/gemini)')
  .option('--default', 'make this the default provider')
  .option('-f, --force', 'overwrite an existing profile with the same name')
  .action(handle((name: string, opts: ProviderAddOptions) => providerAdd(name, opts)));

providerCmd
  .command('remove <name>')
  .alias('rm')
  .description('Remove a provider profile')
  .action(handle(providerRemove));

providerCmd
  .command('use <name>')
  .description('Set the default provider')
  .action(handle(providerUse));

providerCmd
  .command('test [name]')
  .description('Check connectivity/auth for a provider (default provider if omitted)')
  .action(handle(providerTest));

// gity config — config inspection
const configCmd = program.command('config').description('Inspect gity configuration');

configCmd
  .command('show')
  .description('Show current config (secrets masked)')
  .action(handle(configShow));

configCmd
  .command('path')
  .description('Print the config file path')
  .action(handle(configPath));

// gity tools:debug — hidden dev command to invoke a tool directly
program
  .command('tools:debug [tool] [json]', { hidden: true })
  .description('Run a tool directly with JSON args (lists tools when no name is given)')
  .option('--json', 'print the raw structured result')
  .option('--schema', "print the tool's JSON Schema instead of running it")
  .action(
    handle((tool: string | undefined, json: string | undefined, opts: ToolsDebugOptions) => toolsDebug(tool, json, opts)),
  );

(async () => {
  await program.parseAsync(process.argv);
})();
