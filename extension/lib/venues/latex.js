/* Minimal brace-aware LaTeX reading.
 *
 * Enough to pull a document's front matter apart reliably: balanced-brace
 * argument reading, optional-argument reading, and environment extraction.
 * It is deliberately not a LaTeX parser -- it never expands macros and never
 * touches the body. */

/** True if the character at `index` sits after an unescaped % on its line. */
export function isCommented(text, index) {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  for (let i = lineStart; i < index; i++) {
    if (text[i] === '%') {
      let bs = 0, j = i - 1;
      while (j >= lineStart && text[j] === '\\') { bs++; j--; }
      if (bs % 2 === 0) return true;
    }
  }
  return false;
}

/**
 * Read a balanced {...} group starting at the first `{` at or after `from`.
 * Skips whitespace before the brace. Returns null if there is no group.
 */
export function readGroup(text, from) {
  let i = from;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (text[i] !== '{') return null;

  let depth = 0;
  for (let j = i; j < text.length; j++) {
    const c = text[j];
    if (c === '\\') { j++; continue; }          // skip escaped char
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return { value: text.slice(i + 1, j), start: i, end: j + 1 };
    }
  }
  return null;
}

/** Read an optional [...] argument at `from`, if present. */
export function readOptional(text, from) {
  let i = from;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (text[i] !== '[') return null;

  let depth = 0;
  for (let j = i; j < text.length; j++) {
    const c = text[j];
    if (c === '\\') { j++; continue; }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return { value: text.slice(i + 1, j), start: i, end: j + 1 };
    }
  }
  return null;
}

/**
 * Every uncommented occurrence of \name, with its optional argument and up to
 * `arity` mandatory arguments.
 * @returns {Array<{name, optional, args:string[], start, end, raw}>}
 */
export function findCommands(text, name, arity = 1) {
  const out = [];
  const re = new RegExp('\\\\' + name + '(?![a-zA-Z@])', 'g');
  let m;
  while ((m = re.exec(text)) !== null) {
    if (isCommented(text, m.index)) continue;

    let cursor = m.index + m[0].length;
    const opt = readOptional(text, cursor);
    if (opt) cursor = opt.end;

    const args = [];
    for (let k = 0; k < arity; k++) {
      const g = readGroup(text, cursor);
      if (!g) break;
      args.push(g.value);
      cursor = g.end;
    }

    out.push({
      name,
      optional: opt ? opt.value : null,
      args,
      start: m.index,
      end: cursor,
      raw: text.slice(m.index, cursor),
    });
  }
  return out;
}

export function findCommand(text, name, arity = 1) {
  return findCommands(text, name, arity)[0] || null;
}

/** Extract the first \begin{env}...\end{env}, handling nesting of the same env. */
export function extractEnv(text, env) {
  const open = new RegExp('\\\\begin\\s*\\{' + env + '\\}', 'g');
  let m;
  while ((m = open.exec(text)) !== null) {
    if (isCommented(text, m.index)) continue;

    const closeRe = new RegExp('\\\\(begin|end)\\s*\\{' + env + '\\}', 'g');
    closeRe.lastIndex = m.index + m[0].length;
    let depth = 1, c;
    while ((c = closeRe.exec(text)) !== null) {
      if (isCommented(text, c.index)) continue;
      depth += c[1] === 'begin' ? 1 : -1;
      if (depth === 0) {
        return {
          inner: text.slice(m.index + m[0].length, c.index),
          start: m.index,
          end: c.index + c[0].length,
        };
      }
    }
    return null; // unterminated
  }
  return null;
}

/** Position of an uncommented \command, or -1. */
export function indexOfCommand(text, name) {
  const re = new RegExp('\\\\' + name + '(?![a-zA-Z@])', 'g');
  let m;
  while ((m = re.exec(text)) !== null) {
    if (!isCommented(text, m.index)) return m.index;
  }
  return -1;
}

/** \documentclass[opts]{name} */
export function documentClass(text) {
  const cmd = findCommand(text, 'documentclass', 1);
  if (!cmd) return null;
  return {
    name: (cmd.args[0] || '').trim(),
    options: (cmd.optional || '').split(',').map((s) => s.trim()).filter(Boolean),
    start: cmd.start,
    end: cmd.end,
  };
}

/** All \usepackage lines, in order. */
export function packages(text) {
  return findCommands(text, 'usepackage', 1).map((c) => ({
    names: (c.args[0] || '').split(',').map((s) => s.trim()).filter(Boolean),
    options: c.optional,
    raw: c.raw,
  }));
}

/** Collapse whitespace, for values that are semantically one line. */
export function tidy(s) {
  return (s || '').replace(/\s*\n\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

/**
 * Split on a command that sits at brace depth 0.
 *
 * llncs writes all its authors in one \author{A \and B \and C} and all its
 * institutions in one \institute{X \and Y}, so splitting on \and is how you
 * recover the individual entries — but only the \and separators at the top
 * level, never one nested inside somebody's \inst{} or a braced group.
 */
export function splitOnCommand(text, name) {
  const re = new RegExp('\\\\' + name + '(?![a-zA-Z@])', 'g');
  const parts = [];
  let last = 0, m;

  while ((m = re.exec(text)) !== null) {
    if (isCommented(text, m.index)) continue;

    let depth = 0;
    for (let i = 0; i < m.index; i++) {
      const c = text[i];
      if (c === '\\') { i++; continue; }
      if (c === '{') depth++;
      else if (c === '}') depth--;
    }
    if (depth !== 0) continue;

    parts.push(text.slice(last, m.index));
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Remove every uncommented \name{...} from a string, returning what is left. */
export function stripCommand(text, name, arity = 1) {
  let out = text;
  for (;;) {
    const cmd = findCommand(out, name, arity);
    if (!cmd) return out;
    out = out.slice(0, cmd.start) + out.slice(cmd.end);
  }
}

/** Split "a, b, c" or "a \sep b \sep c" into parts. */
export function splitList(s, sep = ',') {
  const raw = sep === 'sep'
    ? String(s).split(/\\sep\b/)
    : String(s).split(sep);
  return raw.map((x) => tidy(x)).filter(Boolean);
}
