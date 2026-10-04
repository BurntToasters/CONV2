// Guards scripts that run `git reset --hard` / `git clean -fd` against silently losing work.
const { execFileSync } = require('node:child_process');
const readline = require('node:readline');

const CONFIRM_WORD = 'DISCARD';

const git = (cwd, args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const lines = (text) => text.split('\n').filter((line) => line.trim().length > 0);

function branchExists(cwd, branch) {
  try {
    git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/** What a hard reset + clean would destroy: uncommitted/untracked files and unpushed commits. */
function assessDiscard(cwd, targetBranch) {
  const dirty = lines(git(cwd, ['status', '--porcelain', '--untracked-files=all']));
  const refs = ['HEAD'];
  if (targetBranch && branchExists(cwd, targetBranch)) refs.push(`refs/heads/${targetBranch}`);
  const unpushed = lines(git(cwd, ['rev-list', '--oneline', ...refs, '--not', '--remotes']));
  return { dirty, unpushed };
}

function decide(risk, { yes, interactive }) {
  if (risk.dirty.length === 0 && risk.unpushed.length === 0) return 'proceed';
  if (yes) return 'proceed';
  return interactive ? 'ask' : 'refuse';
}

const isConfirmation = (answer) => String(answer).trim() === CONFIRM_WORD;

function describeRisk(risk) {
  const out = [];
  if (risk.dirty.length > 0) {
    out.push(`Uncommitted or untracked files that will be deleted (${risk.dirty.length}):`);
    out.push(...risk.dirty.slice(0, 20).map((line) => `  ${line}`));
    if (risk.dirty.length > 20) out.push(`  ...and ${risk.dirty.length - 20} more`);
  }
  if (risk.unpushed.length > 0) {
    out.push(`Commits not on any remote that will be dropped (${risk.unpushed.length}):`);
    out.push(...risk.unpushed.slice(0, 10).map((line) => `  ${line}`));
  }
  return out.join('\n');
}

const ask = (question) =>
  new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });

/** Exits the process unless nothing is at risk or the user explicitly confirms. */
async function confirmDiscardOrExit(cwd, targetBranch, label) {
  const risk = assessDiscard(cwd, targetBranch);
  const yes = process.argv.includes('--yes') || process.env.CONV2_SYNC_YES === '1';
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const decision = decide(risk, { yes, interactive });
  if (decision === 'proceed') return;

  console.error(`${label} will discard local work:\n${describeRisk(risk)}`);
  if (decision === 'ask' && isConfirmation(await ask(`Type ${CONFIRM_WORD} to continue: `))) {
    return;
  }
  console.error(
    decision === 'ask'
      ? 'Aborted; nothing was changed.'
      : `Refusing to continue non-interactively. Re-run with --yes or CONV2_SYNC_YES=1.`
  );
  process.exit(1);
}

module.exports = { assessDiscard, decide, isConfirmation, confirmDiscardOrExit, CONFIRM_WORD };
