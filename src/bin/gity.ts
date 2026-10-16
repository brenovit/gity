import { Command } from 'commander';
import { findRepoRootAsync, getRepoStatusAsync } from '../util/repo.js';

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

// Show help when no args provided
program.addHelpText('before', '  Usage:\n');
program.addHelpText('before', '    gity\n');
program.addHelpText('before', '  Options:\n');

(async () => {
  await program.parseAsync(process.argv);
})();
