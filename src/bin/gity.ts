import { Command } from 'commander';
import { findRepoRootAsync, getRepoStatusAsync } from '../util/repo.js';
import { runSetup } from '../commands/setup.js';
import {
  providerList,
  providerAdd,
  providerRemove,
  providerUse,
  providerTest,
  providerShow,
  providerConfigShow,
  providerConfigPath,
} from '../commands/provider.js';

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

// gity setup — interactive provider setup wizard
program
  .command('setup')
  .description('Run the interactive provider setup wizard')
  .action(runSetup);

// gity provider — provider management
const providerCmd = program.command('provider');
providerCmd.description('Manage provider profiles');

providerCmd
  .command('list')
  .description('List all configured provider profiles')
  .action(providerList);

providerCmd
  .command('show <name>')
  .description('Show details for a specific provider')
  .action(providerShow);

providerCmd
  .command('add <name> [type]')
  .description('Add a new provider profile')
  .option('--model <model>', 'Model name')
  .option('--baseUrl <url>', 'Base URL')
  .option('--apiKeyEnv <env>', 'Environment variable name for API key')
  .action(async (name: string, typeStr?: string, opts?: { model?: string; baseUrl?: string; apiKeyEnv?: string }) => {
    await providerAdd({
      name,
      type: typeStr ?? 'ollama',
      model: opts?.model,
      baseUrl: opts?.baseUrl,
      apiKeyEnv: opts?.apiKeyEnv,
    });
  });

providerCmd
  .command('remove <name>')
  .description('Remove a provider profile')
  .action(providerRemove);

providerCmd
  .command('use <name>')
  .description('Set a provider as the default')
  .action(providerUse);

providerCmd
  .command('test [name]')
  .description('Test a provider connection')
  .action(providerTest);

// gity config — config management
const configCmd = program.command('config');
configCmd.description('Manage gity configuration');

configCmd
  .command('show')
  .description('Show current config (secrets masked)')
  .action(providerConfigShow);

configCmd
  .command('path')
  .description('Print the config file path')
  .action(providerConfigPath);

(async () => {
  await program.parseAsync(process.argv);
})();
