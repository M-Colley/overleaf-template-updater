#!/usr/bin/env node
/* venue-shift — convert a paper's front matter between venue templates.
 *
 * The case this exists for: a CHI/AutoUI paper that is being extended into an
 * Elsevier journal submission, or an Elsevier manuscript being cut down for an
 * ACM conference. The prose is the same; the front matter is entirely different
 * furniture, and moving it by hand is a fiddly hour that is easy to get subtly
 * wrong.
 *
 * Two rules make this safe to use on a real paper:
 *
 *   1. It NEVER modifies your input. It writes a new .tex beside it.
 *   2. It never rewrites your body. The text between the front matter and
 *      \end{document} is copied verbatim, with exactly one exception -- the
 *      argument of \bibliographystyle, because leaving ACM-Reference-Format in
 *      an Elsevier submission simply will not compile.
 *
 * Anything the target venue has no concept of is preserved as a tagged comment
 * rather than deleted, and anything the target requires that cannot be derived
 * is scaffolded as a TODO and listed in a migration checklist.
 *
 *   venue-shift main.tex --to elsarticle
 *   venue-shift manuscript.tex --to acmart -o chi-submission.tex
 *   venue-shift --list
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';

import { documentClass } from './venues/latex.mjs';
import { Report } from './venues/ir.mjs';
import * as acmart from './venues/acmart.mjs';
import * as elsarticle from './venues/elsarticle.mjs';

const VENUES = [acmart, elsarticle];

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

function die(msg) {
  console.error(C.red('error: ') + msg);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o') { out.out = argv[++i]; continue; }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

const USAGE = `
${C.bold('venue-shift')} — move a paper's front matter between venue templates

  venue-shift <file.tex> --to <venue> [-o <out.tex>] [--report <out.md>] [--force]
  venue-shift --list

${C.dim(`Your input file is never modified. A new .tex is written beside it, and the
body of the document is carried across verbatim.`)}

Examples:
  venue-shift main.tex --to elsarticle
  venue-shift manuscript.tex --to acmart -o chi-submission.tex
`;

function list() {
  console.log(C.bold('\nSupported venues\n'));
  for (const v of VENUES) console.log(`  ${C.cyan(v.id.padEnd(14))} ${v.name}`);
  console.log(`\n  Conversions run between any pair, in either direction.\n`);
}

function summarise(report, from, to, outFile, reportFile) {
  const n = (a) => String(a.length);
  console.log('');
  console.log(`${C.bold('Converted')}  ${from} ${C.dim('→')} ${to}`);
  console.log(`${C.bold('Written')}    ${outFile}`);
  console.log(`${C.bold('Checklist')}  ${reportFile}`);
  console.log('');

  if (report.mapped.length) {
    console.log(C.green(`✓ translated automatically (${n(report.mapped)})`));
    for (const m of report.mapped) {
      console.log(`    ${m.what}${m.detail ? C.dim(' — ' + m.detail) : ''}`);
    }
  }
  if (report.dropped.length) {
    console.log(C.yellow(`\n▲ dropped, preserved as comments (${n(report.dropped)})`));
    for (const d of report.dropped) console.log(`    ${d.what}${C.dim(' — ' + d.why)}`);
  }
  if (report.warnings.length) {
    console.log(C.yellow(`\n▲ worth checking (${n(report.warnings)})`));
    for (const w of report.warnings) console.log(`    ${w}`);
  }
  if (report.todo.length) {
    console.log(C.red(`\n● you must fill these in (${n(report.todo)})`));
    for (const t of report.todo) console.log(`    ${t.what}${C.dim(' — ' + t.why)}`);
    console.log(C.dim(`\n  Each is marked TODO-venue-shift in the converted file.`));
    console.log(C.dim(`  grep -n "TODO-venue-shift" ${outFile}`));
  }
  console.log('');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.list) return list();

  const input = args._[0];
  if (!input || args.help) { console.log(USAGE); process.exit(input ? 0 : 1); }
  if (!args.to) die('--to <venue> is required. Run "venue-shift --list" to see them.');

  const inPath = resolve(input);
  if (!existsSync(inPath)) die(`no such file: ${input}`);

  const text = readFileSync(inPath, 'utf8');
  const cls = documentClass(text);
  if (!cls) die(`could not find \\documentclass in ${input}`);

  const source = VENUES.find((v) => v.detect(cls.name));
  if (!source) {
    die(`\\documentclass{${cls.name}} is not a venue this tool knows.\n` +
      `Known: ${VENUES.map((v) => v.id).join(', ')}`);
  }
  const target = VENUES.find((v) => v.id === args.to);
  if (!target) {
    die(`unknown target venue "${args.to}".\n` +
      `Known: ${VENUES.map((v) => v.id).join(', ')}`);
  }
  if (source.id === target.id) {
    die(`${input} is already an ${target.id} document.`);
  }

  const report = new Report();
  const ir = source.parse(text, report);

  if (!ir.title) report.warn('No \\title was found in the source.');
  if (!ir.authors.length) report.warn('No \\author was found in the source.');

  // Layout changes people trip over; reported, never silently rewritten.
  if (/\\begin\s*\{(figure|table)\*\}/.test(ir.body)) {
    report.warn('The body uses full-width `figure*`/`table*` floats. Column ' +
      'layouts differ between these templates, so check they still fit.');
  }

  const converted = target.emit(ir, report);

  const dir = dirname(inPath);
  const stem = basename(inPath, extname(inPath));
  const outFile = args.out ? resolve(args.out) : join(dir, `${stem}-${target.id}.tex`);
  const reportFile = args.report
    ? resolve(args.report)
    : join(dir, `${stem}-${target.id}-MIGRATION.md`);

  if (resolve(outFile) === inPath) die('refusing to overwrite the input file.');
  if (existsSync(outFile) && !args.force) {
    die(`${outFile} already exists. Pass --force to overwrite it.`);
  }

  writeFileSync(outFile, converted, 'utf8');
  writeFileSync(reportFile, report.toMarkdown(source.id, target.id, basename(outFile)), 'utf8');

  summarise(report, source.id, target.id, outFile, reportFile);
}

try {
  main();
} catch (err) {
  die(err.stack || err.message);
}
