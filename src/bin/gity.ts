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

const program = new Command();

program
  .name('gity')
  .description('AI-powered git commit agent — inspect your repo and create well-written commits')
  .version('0.1.0');

// Default action: show repo status when run inside a git repo
program.action(async () => {
  try {
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

// gity setup — interactive provider setup wizard
program
  .command('setup')
  .description('Run the interactive provider setup wizard')
  .action(handle(runSetup));

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

(async () => {
  await program.parseAsync(process.argv);
})();
