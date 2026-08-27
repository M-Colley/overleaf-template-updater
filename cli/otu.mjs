#!/usr/bin/env node
/* otu — Overleaf Template Updater, git edition.
 *
 * The Chrome extension replaces template *files*. This does something the
 * extension fundamentally cannot: a real three-way merge, so template changes
 * and your own edits to the same file are reconciled instead of one clobbering
 * the other.
 *
 * The trick is a vendor branch. We keep an orphan branch `otu/template` holding
 * nothing but pristine upstream snapshots -- one commit per template release --
 * and graft it into your project's history once with `merge -s ours`. From then
 * on, `git merge otu/template` gives git exactly what it needs:
 *
 *     base   = the template release you started from
 *     ours   = your paper, as you have edited it
 *     theirs = the new template release
 *
 * So a template change to a line you never touched applies silently, a change
 * to a line you did touch raises a normal conflict, and your prose is never at
 * risk of being overwritten by a file-level copy.
 *
 * Requires Overleaf git access (a paid feature) — Account Settings → Git
 * integration → generate a token, then use it as the password when git prompts.
 *
 *   otu init   --project <overleaf-project-id> --template <git-url> [--dir <path>]
 *   otu status
 *   otu update [--dry-run]
 *   otu push
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const STATE = '.otu.json';
const TEMPLATE_BRANCH = 'otu/template';

/* --------------------------------------------------------------- utilities */

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
};

function die(msg) {
  console.error(C.red('error: ') + msg);
  process.exit(1);
}

/** Run git, returning trimmed stdout. Throws on non-zero exit. */
function git(args, { cwd = process.cwd(), quiet = true } = {}) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    })?.trim() ?? '';
  } catch (err) {
    const detail = (err.stderr || err.stdout || err.message).toString().trim();
    throw new Error(`git ${args.join(' ')}\n${detail}`);
  }
}

/** Run git for its exit code only. */
function gitOk(args, cwd = process.cwd()) {
  return spawnSync('git', args, { cwd, stdio: 'ignore' }).status === 0;
}

function loadState(dir) {
  const p = join(dir, STATE);
  if (!existsSync(p)) {
    die(`no ${STATE} here. Run "otu init" first, or cd into the project directory.`);
  }
  return JSON.parse(readFileSync(p, 'utf8'));
}

function saveState(dir, state) {
  writeFileSync(join(dir, STATE), JSON.stringify(state, null, 2) + '\n');
}

/** Add a pattern to this clone's local excludes (never committed, never pushed). */
function excludeLocally(dir, pattern) {
  const gitDir = git(['rev-parse', '--git-dir'], { cwd: dir });
  const p = join(dir, gitDir, 'info', 'exclude');
  mkdirSync(join(dir, gitDir, 'info'), { recursive: true });
  const existing = existsSync(p) ? readFileSync(p, 'utf8') : '';
  if (existing.split('\n').some((l) => l.trim() === pattern)) return;
  writeFileSync(p, existing.replace(/\n*$/, '\n') + pattern + '\n');
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

/* -------------------------------------------------------------------- init */

function cmdInit(args) {
  const project = args.project;
  const template = args.template;
  if (!project) die('--project <overleaf-project-id-or-git-url> is required');
  if (!template) die('--template <git-url> is required');

  // A bare 24-hex id is an Overleaf project; anything else is already a git
  // location (useful for self-hosted instances, and for testing against a
  // local repo).
  const projectUrl = /^[0-9a-f]{24}$/i.test(project)
    ? `https://git.overleaf.com/${project}`
    : project;

  const dir = resolve(args.dir || project.replace(/^.*\//, ''));

  if (existsSync(join(dir, STATE))) die(`${dir} is already initialised.`);

  if (!existsSync(join(dir, '.git'))) {
    console.log(`Cloning Overleaf project ${C.dim(projectUrl)}`);
    console.log(C.dim('  (username = your Overleaf email, password = your Git token)'));
    mkdirSync(dir, { recursive: true });
    git(['clone', projectUrl, dir], { cwd: process.cwd(), quiet: false });
  } else {
    console.log(`Using existing repository at ${dir}`);
  }

  const mainBranch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir });

  // Fetch the template into a dedicated remote so its history stays separate.
  console.log(`Fetching template ${C.dim(template)}`);
  if (!gitOk(['remote', 'get-url', 'otu-template'], dir)) {
    git(['remote', 'add', 'otu-template', template], { cwd: dir });
  } else {
    git(['remote', 'set-url', 'otu-template', template], { cwd: dir });
  }
  git(['fetch', 'otu-template', '--tags'], { cwd: dir, quiet: false });

  const ref = args['template-ref'] || resolveLatestRef(dir);
  const sha = git(['rev-parse', ref + '^{commit}'], { cwd: dir });
  console.log(`Pinning template baseline at ${C.bold(ref)} ${C.dim(sha.slice(0, 8))}`);

  // Vendor branch: an orphan branch holding only pristine template snapshots.
  git(['branch', '-f', TEMPLATE_BRANCH, sha], { cwd: dir });

  // Graft it into the project's history WITHOUT touching any working file:
  // -s ours keeps our tree exactly as-is while recording the template commit as
  // a parent, which is what makes every later merge a true three-way merge.
  console.log('Grafting template baseline into project history…');
  git(['merge', '-s', 'ours', '--allow-unrelated-histories', '--no-edit',
       '-m', `otu: record template baseline ${ref}`, TEMPLATE_BRANCH], { cwd: dir });

  // Keep our state file out of the project itself. .git/info/exclude is local
  // to this clone, so .otu.json never gets committed and never turns up as a
  // stray file inside the user's Overleaf project.
  excludeLocally(dir, STATE);

  saveState(dir, {
    project: projectUrl,
    template,
    templateRef: ref,
    templateSha: sha,
    mainBranch,
    initialised: new Date().toISOString(),
  });

  console.log(C.green('\n✓ Initialised.'));
  console.log(`  Project:  ${dir}`);
  console.log(`  Baseline: ${ref}`);
  console.log(`\nNext: ${C.bold('otu status')} to see whether the template has moved on.`);
}

/** Newest semver-ish tag on the template remote, else its default HEAD. */
function resolveLatestRef(dir) {
  let tags = [];
  try {
    tags = git(['tag', '--list', '--sort=-v:refname'], { cwd: dir })
      .split('\n').map((s) => s.trim()).filter(Boolean);
  } catch { /* no tags */ }
  if (tags.length) return tags[0];
  for (const cand of ['otu-template/main', 'otu-template/master']) {
    if (gitOk(['rev-parse', '--verify', cand], dir)) return cand;
  }
  die('could not work out the template branch; pass --template-ref explicitly.');
}

/* ------------------------------------------------------------------ status */

function cmdStatus(args) {
  const dir = resolve(args.dir || '.');
  const state = loadState(dir);

  git(['fetch', 'otu-template', '--tags'], { cwd: dir });
  const latest = args['template-ref'] || resolveLatestRef(dir);
  const latestSha = git(['rev-parse', latest + '^{commit}'], { cwd: dir });

  console.log(`${C.bold('Project')}   ${state.project}`);
  console.log(`${C.bold('Template')}  ${state.template}`);
  console.log(`${C.bold('Baseline')}  ${state.templateRef} ${C.dim(state.templateSha.slice(0, 8))}`);
  console.log(`${C.bold('Latest')}    ${latest} ${C.dim(latestSha.slice(0, 8))}`);

  if (latestSha === state.templateSha) {
    console.log(C.green('\n✓ Template is up to date.'));
    return;
  }

  const log = git(['log', '--oneline', '--no-decorate',
                   `${state.templateSha}..${latestSha}`], { cwd: dir });
  const files = git(['diff', '--stat', state.templateSha, latestSha], { cwd: dir });

  console.log(C.yellow(`\n▲ ${log.split('\n').filter(Boolean).length} new template commit(s):`));
  console.log(log.split('\n').map((l) => '  ' + l).join('\n'));
  console.log(C.bold('\nFiles the template changed:'));
  console.log(files.split('\n').map((l) => '  ' + l.trim()).join('\n'));
  console.log(`\nRun ${C.bold('otu update')} to three-way merge these into your project.`);
}

/* ------------------------------------------------------------------ update */

function cmdUpdate(args) {
  const dir = resolve(args.dir || '.');
  const state = loadState(dir);
  const dryRun = !!args['dry-run'];

  const dirty = git(['status', '--porcelain'], { cwd: dir });
  if (dirty) {
    die('working tree has uncommitted changes. Commit or stash them first:\n' +
        dirty.split('\n').map((l) => '  ' + l).join('\n'));
  }

  git(['fetch', 'otu-template', '--tags'], { cwd: dir });
  const latest = args['template-ref'] || resolveLatestRef(dir);
  const latestSha = git(['rev-parse', latest + '^{commit}'], { cwd: dir });

  if (latestSha === state.templateSha) {
    console.log(C.green('✓ Already on the latest template; nothing to do.'));
    return;
  }

  if (dryRun) {
    console.log(C.bold(`Would merge template ${state.templateRef} → ${latest}\n`));
    // merge-tree shows the merge result, including conflicts, without touching
    // the working tree or creating any commit.
    const res = spawnSync('git',
      ['merge-tree', '--write-tree', '--name-only',
       git(['rev-parse', 'HEAD'], { cwd: dir }), latestSha],
      { cwd: dir, encoding: 'utf8' });

    if (res.status === 0) {
      console.log(C.green('Clean merge — no conflicts expected.'));
    } else if (/unknown option|usage: git merge-tree/i.test(res.stderr || '')) {
      console.log(C.yellow(
        'This git is too old for a no-op merge preview (needs 2.38+).\n' +
        'Run "otu update" and use "git merge --abort" if you dislike the result.'));
    } else {
      // Output is: tree oid, then the conflicted paths, then a blank line and
      // git's informational messages -- which are not filenames.
      const lines = (res.stdout || '').split('\n').slice(1);
      const blank = lines.findIndex((l) => l.trim() === '');
      const conflicted = (blank === -1 ? lines : lines.slice(0, blank)).filter(Boolean);
      console.log(C.yellow('Conflicts expected in:'));
      conflicted.forEach((f) => console.log('  ' + f));
      console.log(C.dim('\nThese are files the template changed that you also edited.'));
      console.log(C.dim('Everything else merges automatically.'));
    }
    console.log(C.dim('\n(dry run — nothing was changed)'));
    return;
  }

  // Advance the vendor branch to the new release, then merge it in.
  console.log(`Advancing template baseline ${state.templateRef} → ${C.bold(latest)}`);
  git(['branch', '-f', TEMPLATE_BRANCH, latestSha], { cwd: dir });

  console.log('Merging template changes into your project…\n');
  const merge = spawnSync('git',
    ['merge', '--no-edit', '-m', `otu: update template to ${latest}`, TEMPLATE_BRANCH],
    { cwd: dir, stdio: 'inherit' });

  state.templateRef = latest;
  state.templateSha = latestSha;
  state.updated = new Date().toISOString();
  saveState(dir, state);

  if (merge.status === 0) {
    console.log(C.green(`\n✓ Merged cleanly. Review, then: ${C.bold('otu push')}`));
  } else {
    console.log(C.yellow('\n▲ Merge stopped on conflicts.'));
    console.log('  Resolve them, then:');
    console.log(`    ${C.bold('git add -A && git commit')}`);
    console.log(`    ${C.bold('otu push')}`);
    console.log(C.dim('\n  To abandon: git merge --abort'));
    process.exitCode = 1;
  }
}

/* -------------------------------------------------------------------- push */

function cmdPush(args) {
  const dir = resolve(args.dir || '.');
  const state = loadState(dir);
  if (git(['status', '--porcelain'], { cwd: dir })) {
    die('resolve and commit the merge before pushing.');
  }
  console.log('Pushing to Overleaf…');
  git(['push', 'origin', state.mainBranch || 'HEAD'], { cwd: dir, quiet: false });
  console.log(C.green('✓ Pushed. Reload the project in Overleaf to see the changes.'));
}

/* -------------------------------------------------------------------- main */

const USAGE = `
${C.bold('otu')} — update an Overleaf project's LaTeX template with a real 3-way merge

  ${C.bold('otu init')}   --project <id|git-url> --template <git-url> [--dir <path>] [--template-ref <ref>]
  ${C.bold('otu status')} [--dir <path>]
  ${C.bold('otu update')} [--dir <path>] [--dry-run] [--template-ref <ref>]
  ${C.bold('otu push')}   [--dir <path>]

${C.dim(`Requires Overleaf git access (paid). Account Settings → Git integration →
generate a token; use your email as username and the token as password.`)}

Example:
  otu init --project 65f0a1b2c3d4e5f60718293a \\
           --template https://github.com/borisveytsman/acmart.git
  otu status
  otu update --dry-run
  otu update
  otu push
`;

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];

try {
  switch (cmd) {
    case 'init': cmdInit(args); break;
    case 'status': cmdStatus(args); break;
    case 'update': cmdUpdate(args); break;
    case 'push': cmdPush(args); break;
    default: console.log(USAGE); process.exit(cmd ? 1 : 0);
  }
} catch (err) {
  die(err.message);
}
