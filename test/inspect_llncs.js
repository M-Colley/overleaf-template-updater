#!/usr/bin/env node
/* Read llncs.cls to see what front-matter commands it actually defines.
 * Springer ships no sample .tex on CTAN (the bundle is just the class, its
 * documentation PDF and splncs04.bst), so the class itself is the authority
 * for the venue-shift profile. */

const fs = require('fs');
const path = require('path');
const fixtures = require('./fixtures');

const BS = '\\';
const text = fs.readFileSync(fixtures.ensure('llncs.cls'), 'utf8');

const WANT = ['author', 'institute', 'inst', 'orcidID', 'keywords',
  'authorrunning', 'titlerunning', 'email', 'subtitle', 'thanks', 'and'];

console.log('Commands llncs.cls defines:\n');
for (const cmd of WANT) {
  const re = new RegExp(
    BS + BS + '(?:def|newcommand|renewcommand)\\s*' +
    BS + BS + '?\\{?' + BS + BS + cmd + '(?![a-zA-Z@])'
  );
  const m = re.exec(text);
  if (!m) continue;
  const line = text.slice(m.index, text.indexOf('\n', m.index));
  console.log(`  ${BS}${cmd.padEnd(15)} ${line.trim().slice(0, 76)}`);
}

console.log('\nHow \\inst and \\and behave:\n');
for (const cmd of ['inst', 'and', 'institute']) {
  const re = new RegExp(BS + BS + '(?:def|newcommand)\\s*' + BS + BS + '?\\{?' +
    BS + BS + cmd + '(?![a-zA-Z@])[\\s\\S]{0,180}');
  const m = re.exec(text);
  if (m) console.log(`--- ${BS}${cmd} ---\n${m[0].split('\n').slice(0, 6).join('\n')}\n`);
}
