const vscode = require('vscode');
const cp = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function git(cwd, args) {
  return new Promise((resolve, reject) => {
    cp.execFile('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

// Parse `git show --name-status` lines into [{status, path, oldPath?}].
// Renames/copies (R100\told\tnew) use the new path; oldPath keeps the origin,
// needed to show the base side of the diff (the new path doesn't exist there).
function parseNameStatus(output) {
  const files = [];
  for (const line of output.split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 2 || !parts[0]) continue;
    const status = parts[0][0];
    const f = { status, path: parts[parts.length - 1] };
    if (parts.length > 2) f.oldPath = parts[1];
    files.push(f);
  }
  return files;
}

// Build a nested tree: {dirs: Map<name, node>, files: [{name, status, path}]}
function buildTree(files) {
  const root = { dirs: new Map(), files: [] };
  for (const f of files) {
    const segments = f.path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i];
      if (!node.dirs.has(seg)) {
        node.dirs.set(seg, { dirs: new Map(), files: [], path: segments.slice(0, i + 1).join('/') });
      }
      node = node.dirs.get(seg);
    }
    node.files.push({ name: segments[segments.length - 1], status: f.status, path: f.path, oldPath: f.oldPath });
  }
  return root;
}

// Parse `git log --decorate=full --format=%H%x09%h%x09%an%x09%ar%x09%D%x09%s --shortstat` output.
// Each commit is a tab-separated header line, optionally followed by a
// "N files changed, X insertions(+), Y deletions(-)" line. Branch refs become
// Graph badges (local or remote); HEAD, */HEAD and tags are dropped.
function parseLog(output) {
  const commits = [];
  for (const line of output.split('\n')) {
    if (/^[0-9a-f]{40}\t/.test(line)) {
      const [sha, short, author, when, decor, subject] = line.split('\t');
      const refs = decor
        .split(', ')
        .map((r) => /^(?:HEAD -> )?refs\/(heads|remotes)\/(.+)$/.exec(r))
        .filter((m) => m && !m[2].endsWith('/HEAD'))
        .map((m) => ({ name: m[2], remote: m[1] === 'remotes' }));
      commits.push({ sha, short, author, when, refs, subject, files: 0, ins: 0, del: 0 });
    } else if (commits.length && /\d+ files? changed/.test(line)) {
      const c = commits[commits.length - 1];
      c.files = Number((line.match(/(\d+) files? changed/) || [])[1] || 0);
      c.ins = Number((line.match(/(\d+) insertions?\(\+\)/) || [])[1] || 0);
      c.del = Number((line.match(/(\d+) deletions?\(-\)/) || [])[1] || 0);
    }
  }
  return commits;
}

// Compact-folder collapsing: merge chains of single-child directories
// (a/b/c) into one label, like the Explorer's "compact folders".
function compactDir(name, node) {
  while (node.files.length === 0 && node.dirs.size === 1) {
    const [childName, child] = node.dirs.entries().next().value;
    name += '/' + childName;
    node = child;
  }
  return { name, node };
}

// Scope-drift heuristics: paths an AI session usually should not touch.
const RISKY_PATTERNS = [
  [/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|go\.sum)$/, 'lockfile'],
  [/^\.github\//, 'CI config'],
  [/(^|\/)(\.gitlab-ci\.yml|Jenkinsfile|\.circleci\/)/, 'CI config'],
  [/(^|\/)\.env(\.|$)/, 'env file'],
  [/(^|\/)(Dockerfile|docker-compose[^/]*\.ya?ml)$/, 'container config'],
  [/(^|\/)tsconfig[^/]*\.json$/, 'build config'],
  [/(^|\/)\.git(ignore|attributes)$/, 'git config'],
];

function riskReasons(file) {
  const reasons = [];
  if (file.status === 'D') reasons.push('deleted');
  for (const [re, label] of RISKY_PATTERNS) {
    if (re.test(file.path)) {
      reasons.push(label);
      break;
    }
  }
  return reasons;
}

const STATUS_LABEL = { A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed', C: 'Copied' };

// If every file beneath a tree node shares status D (or A), the folder itself
// was effectively deleted (or added). Mixed content returns undefined.
function aggStatus(node) {
  let s;
  const walk = (n) => {
    for (const f of n.files) {
      if (s === undefined) s = f.status;
      else if (s !== f.status) s = null;
    }
    for (const [, c] of n.dirs) walk(c);
  };
  walk(node);
  return s === 'D' || s === 'A' ? s : undefined;
}

// --- Dependency analysis (import-level, heuristic) ---------------------------

const JS_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte'];
const JS_IMPORT_RES = [
  /import\s+[^'"()]*?from\s+['"]([^'"]+)['"]/g,
  /import\s*\(\s*['"]([^'"]+)['"]/g,
  /require\s*\(\s*['"]([^'"]+)['"]/g,
  /export\s+[^'"()]*?from\s+['"]([^'"]+)['"]/g,
];
const PY_IMPORT_RES = [/^\s*import\s+([\w.]+)/gm, /^\s*from\s+([.\w]+)\s+import/gm];
const JAVA_EXTS = ['.java', '.kt', '.kts', '.scala', '.groovy'];
const JAVA_IMPORT_RES = [/^\s*import\s+(?:static\s+)?(\w+(?:\.\w+)*(?:\.\*)?)/gm];
const C_EXTS = ['.c', '.h', '.cpp', '.hpp', '.cc', '.hh', '.cxx', '.hxx'];
const C_IMPORT_RES = [/^\s*#\s*include\s*["<]([^">]+)[">]/gm];
const RUST_IMPORT_RES = [/^\s*(?:pub\s+)?use\s+([\w:]+)/gm, /^\s*(?:pub\s+)?mod\s+(\w+)\s*;/gm];
const CS_IMPORT_RES = [/^\s*using\s+(?:static\s+)?(\w+(?:\.\w+)*)\s*;/gm];
const RB_IMPORT_RES = [/require(?:_relative)?\s*\(?\s*['"]([^'"]+)['"]/g];
const PHP_IMPORT_RES = [/^\s*use\s+([\w\\]+)/gm, /(?:require|include)(?:_once)?\s*\(?\s*['"]([^'"]+)['"]/g];

const LANG_RES = new Map([
  ...JS_EXTS.map((e) => [e, JS_IMPORT_RES]),
  ...JAVA_EXTS.map((e) => [e, JAVA_IMPORT_RES]),
  ...C_EXTS.map((e) => [e, C_IMPORT_RES]),
  ['.py', PY_IMPORT_RES],
  ['.rs', RUST_IMPORT_RES],
  ['.cs', CS_IMPORT_RES],
  ['.rb', RB_IMPORT_RES],
  ['.php', PHP_IMPORT_RES],
]);

// Import specifiers in source text, by file extension, each with its 1-based line.
function importSpecs(filePath, source) {
  const ext = path.posix.extname(filePath);
  const specs = [];
  const add = (spec, index) => specs.push({ spec, line: source.slice(0, index).split('\n').length });
  for (const re of LANG_RES.get(ext) || []) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source))) add(m[1], m.index);
  }
  if (ext === '.go') {
    // single imports and import ( ... ) blocks
    for (const m of source.matchAll(/^\s*import\s+(?:\w+\s+)?"([^"]+)"/gm)) add(m[1], m.index);
    for (const b of source.matchAll(/import\s*\(([^)]*)\)/g)) {
      const start = b.index + b[0].indexOf(b[1]);
      for (const m of b[1].matchAll(/"([^"]+)"/g)) add(m[1], start + m.index);
    }
  }
  return specs;
}

function parseImports(filePath, source) {
  return importSpecs(filePath, source).map((s) => s.spec);
}

// Does some changed file's path (sans extension) end with this suffix?
function bySuffix(changedSet, exts, suffix, dirOnly) {
  for (const f of changedSet) {
    if (exts && !exts.includes(path.posix.extname(f))) continue;
    const noExt = '/' + f.replace(/\.[^./]+$/, '');
    if (dirOnly ? path.posix.dirname(noExt).endsWith(suffix) : noExt.endsWith(suffix)) return f;
  }
  return undefined;
}

// Resolve an import specifier from `fromFile` to a path in `changedSet`, or undefined.
// All of this is heuristic: fully-qualified names and include paths resolve by
// path suffix, so source-root prefixes (src/main/java/, module dirs) don't matter.
// ponytail: identical trailing paths across modules may cross-match
function resolveImport(fromFile, spec, changedSet) {
  const dir = path.posix.dirname(fromFile);
  const ext = path.posix.extname(fromFile);
  const candidates = [];

  if (JAVA_EXTS.includes(ext)) {
    const wildcard = spec.endsWith('.*');
    const clean = spec.replace(/\.\*$/, '');
    if (wildcard) return bySuffix(changedSet, JAVA_EXTS, '/' + clean.replace(/\./g, '/'), true);
    // plain import → class path; static import → also try dropping the member
    for (const c of [clean, clean.split('.').slice(0, -1).join('.')]) {
      const hit = c && bySuffix(changedSet, JAVA_EXTS, '/' + c.replace(/\./g, '/'));
      if (hit) return hit;
    }
    return undefined;
  }
  if (ext === '.go') {
    // package path → directory of changed .go files; longest suffix wins
    const segs = spec.split('/');
    for (let i = 0; i < segs.length; i++) {
      const hit = bySuffix(changedSet, ['.go'], '/' + segs.slice(i).join('/'), true);
      if (hit) return hit;
    }
    return undefined;
  }
  if (ext === '.rs') {
    const segs = spec.split('::').filter((s) => !['crate', 'self', 'super', ''].includes(s));
    // mod foo; → sibling foo.rs / foo/mod.rs
    if (!spec.includes('::')) {
      candidates.push(path.posix.join(dir, `${spec}.rs`), path.posix.join(dir, spec, 'mod.rs'));
    }
    // use a::b::Item — trailing segments may be items, drop from the right
    for (let k = segs.length; k >= 1; k--) {
      const p = '/' + segs.slice(0, k).join('/');
      const hit =
        bySuffix(changedSet, ['.rs'], p) ||
        bySuffix(new Set([...changedSet].filter((f) => f.endsWith('/mod.rs'))), null, p + '/mod');
      if (hit) return hit;
    }
  } else if (C_EXTS.includes(ext)) {
    candidates.push(path.posix.normalize(path.posix.join(dir, spec)));
    const hit = bySuffix(changedSet, null, '/' + spec.replace(/\.[^./]+$/, ''));
    if (hit) return hit;
  } else if (ext === '.cs') {
    // namespace segments map to folders, but project dirs may keep dots
    // (Corp.App/Models) — drop leading segments until a suffix matches
    const segs = spec.split('.');
    for (let i = 0; i < segs.length; i++) {
      const p = '/' + segs.slice(i).join('/');
      const hit = bySuffix(changedSet, ['.cs'], p) || bySuffix(changedSet, ['.cs'], p, true);
      if (hit) return hit;
    }
  } else if (ext === '.rb') {
    candidates.push(path.posix.normalize(path.posix.join(dir, `${spec}.rb`)), `${spec}.rb`);
    const hit = bySuffix(changedSet, ['.rb'], '/' + spec.replace(/\.rb$/, ''));
    if (hit) return hit;
  } else if (ext === '.php') {
    if (spec.includes('\\')) {
      const segs = spec.split('\\').filter(Boolean);
      // PSR-4: namespace prefix maps to a source root — drop leading segments
      for (let i = 0; i < segs.length; i++) {
        const hit = bySuffix(changedSet, ['.php'], '/' + segs.slice(i).join('/'));
        if (hit) return hit;
      }
    } else {
      candidates.push(path.posix.normalize(path.posix.join(dir, spec)));
    }
  } else if (ext === '.py') {
    const base = spec.replace(/^\.+/, '').replace(/\./g, '/');
    candidates.push(`${base}.py`, `${base}/__init__.py`);
    if (spec.startsWith('.')) candidates.push(path.posix.join(dir, `${base}.py`));
  } else if (spec.startsWith('.')) {
    const base = path.posix.normalize(path.posix.join(dir, spec));
    candidates.push(base);
    for (const e of JS_EXTS) candidates.push(base + e, `${base}/index${e}`);
  }
  return candidates.find((c) => changedSet.has(c));
}

// Edges among changed files: {from, to, line} = "from imports to", at from's first such line.
function buildEdges(sources) {
  const changedSet = new Set(sources.keys());
  const edges = [];
  for (const [file, source] of sources) {
    // Map: several imports (class, static, nested) can resolve to the same file.
    const targets = new Map();
    for (const { spec, line } of importSpecs(file, source)) {
      const to = resolveImport(file, spec, changedSet);
      if (to && to !== file) targets.set(to, Math.min(targets.get(to) || Infinity, line));
    }
    for (const [to, line] of targets) edges.push({ from: file, to, line });
  }
  return edges;
}

// --- Symbol changes ------------------------------------------------------------
// Declarations a reviewer scans a diff for: top-level functions, classes, types
// and module variables, plus one level of class members (methods, fields).
// Static line regexes per language: language servers serve no git: URIs, so the
// base side can only be read this way without a checkout. Other languages (and
// files over 1 MB) yield nothing, which keeps their rows plain leaves.
const SYMBOL_MAX_CHARS = 1024 * 1024;
// A variable or field whose value is an arrow or function expression is a function.
const FN_VALUE = /^(?:async\s+)?(?:\(|function\b|\w+\s*=>)/;
// Statement keywords that look like "name(" at member depth.
const CONTROL = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'else', 'do', 'try', 'throw', 'constructor', 'super', 'this']);
const TYPE_KIND = { class: 'class', interface: 'interface', enum: 'enum', record: 'class', '@interface': 'interface' };
const JS_MODS = '(?:(?:public|private|protected|static|readonly|abstract|override|declare|async|get|set)\\s+)*';
const JAVA_MODS = '(?:(?:public|private|protected|static|final|abstract|synchronized|native|default|strictfp|transient|volatile|sealed|non-sealed)\\s+)*';
const JAVA_TYPE = '[\\w.<>\\[\\],?]+(?:\\s+[\\w.<>\\[\\],?]+)*\\s+';
const JAVA_TYPES = '(?<type>class|interface|enum|record|@interface)\\s+(?<name>\\w+)';
// Each rule: [regex with a `name` group (optional `value` / `type` groups), kind].
// `top` rules match at column 0, `member` rules one indent level inside a class.
const JS_RULES = {
  top: [
    [/^(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:abstract\s+)?class\s+(?<name>\w*)/, 'class'],
    [/^(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:async\s+)?function\b\s*\*?\s*(?<name>\w*)/, 'function'],
    [/^(?:export\s+)?(?:declare\s+)?interface\s+(?<name>\w+)/, 'interface'],
    [/^(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+(?<name>\w+)/, 'enum'],
    [/^(?:export\s+)?(?:declare\s+)?type\s+(?<name>\w+)/, 'type'],
    [/^(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+(?<name>\w+)(?:\s*:[^=]*)?(?:\s*=\s*(?<value>.*))?/, 'variable'],
    [/^(?:module\.)?exports\.(?<name>\w+)\s*=\s*(?<value>.*)/, 'variable'],
  ],
  member: [
    [new RegExp(`^\\s+${JS_MODS}\\*?\\s*(?<name>\\w+)\\s*(?:<[^>]*>)?\\s*\\(`), 'function'],
    [new RegExp(`^\\s+${JS_MODS}(?<name>\\w+)\\s*[?!]?\\s*(?::[^=]*)?(?:=\\s*(?<value>.*)|;|$)`), 'field'],
  ],
};
const PY_RULES = {
  docstring: true,
  top: [
    [/^(?:async\s+)?def\s+(?<name>\w+)/, 'function'],
    [/^class\s+(?<name>\w+)/, 'class'],
    [/^(?<name>\w+)\s*(?::\s*\w|=(?!=))/, 'variable'],
  ],
  member: [
    [/^\s+(?:async\s+)?def\s+(?<name>\w+)/, 'function'],
    [/^\s+(?<name>\w+)\s*(?::\s*\w|=(?!=))/, 'field'],
  ],
};
const JAVA_RULES = {
  top: [[new RegExp(`^${JAVA_MODS}${JAVA_TYPES}`), null]],
  member: [
    [new RegExp(`^\\s+${JAVA_MODS}${JAVA_TYPES}`), null],
    [new RegExp(`^\\s+${JAVA_MODS}(?:<[^>]+>\\s+)?(?:${JAVA_TYPE})?(?<name>\\w+)\\s*\\(`), 'function'],
    [new RegExp(`^\\s+${JAVA_MODS}${JAVA_TYPE}(?<name>\\w+)\\s*(?:=|;)`), 'field'],
  ],
};
const SYMBOL_RULES = new Map([
  ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'].map((e) => [e, JS_RULES]),
  ['.py', PY_RULES],
  ['.java', JAVA_RULES],
]);
const SYMBOL_ICON = {
  function: 'symbol-method',
  class: 'symbol-class',
  interface: 'symbol-interface',
  enum: 'symbol-enum',
  type: 'symbol-class',
  variable: 'symbol-variable',
  field: 'symbol-field',
};

function matchSymbol(rules, line, lineNo) {
  for (const [re, kind] of rules) {
    const m = re.exec(line);
    if (!m) continue;
    const { name = '', value, type } = m.groups;
    if (CONTROL.has(name)) return undefined;
    const k = type ? TYPE_KIND[type] : value !== undefined && FN_VALUE.test(value) ? 'function' : kind;
    return { name: name || 'default', kind: k, line: lineNo };
  }
  return undefined;
}

// Brace counts of a line, ignoring string/char/template literals and // comments.
// ponytail: a regex literal like /{/ still miscounts; a column-0 declaration resyncs the depth
function braces(line) {
  const code = line.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\/.*$/g, '');
  return { opens: (code.match(/{/g) || []).length, closes: (code.match(/}/g) || []).length };
}
const parens = (text) => (text.match(/\(/g) || []).length - (text.match(/\)/g) || []).length;

// [{name, kind, line}] in source order; members are "Owner.name". Comments and
// docstrings are skipped so commented-out code does not count. Brace languages
// take members from brace depth 1 (the class body, wherever its `{` lands, so a
// header continued on a deeper line and method locals never count); Python takes
// them from the body's own indentation once the header's parentheses close.
function extractSymbols(filePath, source) {
  const rules = SYMBOL_RULES.get(path.posix.extname(filePath));
  if (!rules || source.length > SYMBOL_MAX_CHARS) return [];
  const out = [];
  let owner; // enclosing top-level class: { name, opened } (braces) or { name, open, indent } (Python)
  let depth = 0;
  let inComment = false;
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const text = line.trim();
    if (!text) continue;
    const lineNo = i + 1;
    if (rules.docstring) {
      const toggles = (text.match(/"""|'''/g) || []).length % 2 === 1;
      if (inComment) {
        if (toggles) inComment = false;
        continue;
      }
      if (text.startsWith('#')) continue;
      if (toggles) inComment = true; // the opening line itself may still declare (SQL = """…)
      if (owner && owner.open > 0) {
        // still inside a "class X(" header spanning lines; the body starts after it closes
        owner.open += parens(text);
        continue;
      }
      const indent = line.length - line.trimStart().length;
      if (indent === 0) {
        owner = undefined;
        const hit = matchSymbol(rules.top, line, lineNo);
        if (!hit) continue;
        out.push(hit);
        if (hit.kind === 'class') owner = { name: hit.name, open: parens(text) };
        continue;
      }
      if (!owner) continue;
      if (owner.indent === undefined) owner.indent = indent;
      if (indent < owner.indent) {
        owner = undefined;
        continue;
      }
      if (indent !== owner.indent) continue;
      const hit = matchSymbol(rules.member, line, lineNo);
      if (hit) out.push({ ...hit, name: `${owner.name}.${hit.name}` });
      continue;
    }
    if (inComment) {
      if (text.includes('*/')) inComment = false;
      continue;
    }
    if (text.startsWith('//')) continue;
    if (text.startsWith('/*')) {
      if (!text.includes('*/')) inComment = true;
      continue;
    }
    const open = line.indexOf('/*');
    if (open >= 0 && line.indexOf('*/', open) < 0) {
      inComment = true;
      line = line.slice(0, open);
    }
    if (line === line.trimStart()) {
      const hit = matchSymbol(rules.top, line, lineNo);
      if (hit) {
        out.push(hit);
        depth = 0; // a declaration at column 0 is top level, whatever a miscounted brace said
        // ponytail: enum bodies are not scanned (constants read like fields); methods on enums go unreported
        owner = hit.kind === 'class' || hit.kind === 'interface' ? { name: hit.name, opened: false } : undefined;
      }
    } else if (owner && owner.opened && depth === 1) {
      const hit = matchSymbol(rules.member, line, lineNo);
      if (hit) out.push({ ...hit, name: `${owner.name}.${hit.name}` });
    }
    const { opens, closes } = braces(line);
    depth = Math.max(0, depth + opens - closes);
    if (owner) {
      if (opens) owner.opened = true;
      if (owner.opened && depth === 0) owner = undefined;
    }
  }
  return out;
}

// Set difference by name: added (with target lines) first, then removed (base
// lines). Overloads collapse into their name; a moved symbol is not a change.
function diffSymbols(before, after) {
  const names = (list) => new Set(list.map((s) => s.name));
  const was = names(before);
  const now = names(after);
  const firstOfName = (list) => list.filter((s, i) => list.findIndex((t) => t.name === s.name) === i);
  return [
    ...firstOfName(after).filter((s) => !was.has(s.name)).map((s) => ({ change: '+', ...s })),
    ...firstOfName(before).filter((s) => !now.has(s.name)).map((s) => ({ change: '-', ...s })),
  ];
}

// "+ foo()" in the tree (sep = ' '), "+foo()" in the export (sep = '').
const symbolText = (s, sep) => `${s.change === '+' ? '+' : '−'}${sep}${s.name}${s.kind === 'function' ? '()' : ''}`;

// --- Review summary export ---------------------------------------------------

// Quote source lines for a comment: up to 8 lines, ellipsis beyond.
function quoteLines(content, line, endLine) {
  if (!content) return '';
  const all = content.split('\n');
  const end = Math.min(endLine || line, line + 7);
  let code = all.slice(line - 1, end).join('\n').trim();
  if ((endLine || line) > end) code += '\n…';
  return code;
}

// data: {rangeLabel, files: [{path, status, risks, reviewed, note, comments: [{line, text, code}]}]}
function buildSummaryMd(data) {
  const lines = [`# Code review feedback (${data.rangeLabel})`, ''];
  const withFeedback = data.files.filter((f) => f.note || (f.comments && f.comments.length));
  const folders = data.folders || [];
  if (withFeedback.length || folders.length) {
    const count = withFeedback.reduce((n, f) => n + (f.note ? 1 : 0) + (f.comments || []).length, folders.length);
    lines.push(`## 🎯 Action items (${count})`, '');
    for (const d of folders) lines.push(`### 📁 ${d.path} (folder)`, '', d.text, '');
    for (const f of withFeedback) {
      if (f.note) lines.push(`### 📝 ${f.path}`, '', f.note, '');
      for (const c of f.comments || []) {
        lines.push(`### 💬 ${f.path}:${c.line}${c.endLine ? '-' + c.endLine : ''}`, '');
        if (c.code) lines.push('```', c.code, '```');
        lines.push(c.text, '');
      }
    }
  }
  // Comments made on files/revisions outside the unpushed range still matter
  // (e.g. "this untouched file should change too") — never drop user input.
  if (data.outside && data.outside.length) {
    lines.push('## 🌐 Comments outside this change', '');
    for (const c of data.outside) {
      const at = c.ref === 'working' ? 'working copy' : c.ref.slice(0, 7);
      const loc = c.line ? `:${c.line}${c.endLine ? '-' + c.endLine : ''}` : '';
      lines.push(`### ${c.line ? '💬' : '📝'} ${c.path}${loc} (${at}${c.line ? '' : ' · file note'})`, '');
      if (c.code) lines.push('```', c.code, '```');
      lines.push(c.text, '');
    }
  }
  // Declarations added/removed per file: the shape of the change without opening diffs.
  const structural = data.files.filter((f) => f.symbols && f.symbols.length);
  if (structural.length) {
    lines.push('## 🧩 Structure changes', '');
    for (const f of structural) lines.push(`- ${f.path}: ${f.symbols.map((s) => symbolText(s, '')).join(', ')}`);
    lines.push('');
  }
  return lines.join('\n') + '\n';
}

// Old-side line ranges of every hunk in a unified diff: "@@ -a,b +c,d @@" →
// [a, a+b-1]; b omitted = 1 line; b = 0 (pure insertion) touches a and a+1.
function hunkOldRanges(diff) {
  const ranges = [];
  for (const m of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? /gm)) {
    const a = Number(m[1]);
    const b = m[2] === undefined ? 1 : Number(m[2]);
    ranges.push(b === 0 ? [a, a + 1] : [a, a + b - 1]);
  }
  return ranges;
}

// Old-side line → new-side line through a unified diff's hunk headers. Inside a
// hunk: the hunk's start on the new side (the line after it for a pure deletion);
// elsewhere: shifted by the hunks above. A diff editor selects on the new side,
// and removed symbols only have an old-side line.
function newLineFor(diff, oldLine) {
  let delta = 0;
  for (const m of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const a = Number(m[1]);
    const b = m[2] === undefined ? 1 : Number(m[2]);
    const c = Number(m[3]);
    const d = m[4] === undefined ? 1 : Number(m[4]);
    // "-a,0" is an insertion after old line a: that line is still above the hunk.
    if (b === 0 ? oldLine <= a : oldLine < a) break;
    if (b > 0 && oldLine < a + b) return Math.max(d === 0 ? c + 1 : c, 1);
    delta += d - b;
  }
  return oldLine + delta;
}

// For each comment/note of an exported round: has its code changed since?
// addressed is true/false. Commit-based items diff their commit against the
// working copy (so uncommitted fixes count) and check the commented span;
// working-copy items have no commit to diff, so they count as changed when
// the file was modified (or removed) after the export.
async function lastRoundStatus(root, round) {
  const items = [];
  const split = (key) => [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
  const touchedSinceExport = async (rel) => {
    try {
      return (await fs.promises.stat(path.join(root, rel))).mtimeMs > (round.at || 0);
    } catch (e) {
      return true; // gone since the export
    }
  };
  const diffFor = (ref, rel) => git(root, ['diff', '-U0', ref, '--', rel]).catch(() => '');
  for (const [key, list] of Object.entries(round.comments || {})) {
    const [ref, rel] = split(key);
    const working = ref === 'working';
    const ranges = working ? null : hunkOldRanges(await diffFor(ref, rel));
    const touched = working ? await touchedSinceExport(rel) : null;
    for (const c of list) {
      const end = c.endLine || c.line;
      const addressed = working ? touched : ranges.some(([s, e]) => s <= end && e >= c.line);
      items.push({ path: rel, line: c.line, endLine: c.endLine, text: c.text, addressed });
    }
  }
  for (const [key, text] of Object.entries(round.notes || {})) {
    const [ref, rel] = split(key);
    const addressed = ref === 'working' ? await touchedSinceExport(rel) : (await diffFor(ref, rel)).trim().length > 0;
    items.push({ path: rel, text, addressed });
  }
  return items;
}

// Write the review summary to a repo-relative path for the agent to read, and
// keep it out of git via .git/info/exclude (local, worktree-safe, never touches
// the user's .gitignore). Returns the absolute path written.
async function writeReviewFile(root, relPath, md) {
  const abs = path.join(root, relPath);
  await fs.promises.mkdir(path.dirname(abs), { recursive: true });
  await fs.promises.writeFile(abs, md);
  const excludeFile = path.resolve(root, (await git(root, ['rev-parse', '--git-path', 'info/exclude'])).trim());
  const rule = '/' + relPath.split(path.sep).join('/');
  let existing = '';
  try {
    existing = await fs.promises.readFile(excludeFile, 'utf8');
  } catch (e) {
    await fs.promises.mkdir(path.dirname(excludeFile), { recursive: true });
  }
  if (!existing.split('\n').includes(rule)) {
    await fs.promises.appendFile(excludeFile, (existing && !existing.endsWith('\n') ? '\n' : '') + rule + '\n');
  }
  return abs;
}

// URI the built-in git extension's content provider understands.
function gitUri(repoRoot, filePath, ref) {
  const abs = path.join(repoRoot, filePath);
  return vscode.Uri.file(abs).with({ scheme: 'git', query: JSON.stringify({ path: abs, ref }) });
}

const NOOP_STATE = { get: (k, d) => d, update: async () => {} };

const MODE_LABEL = { commits: 'by commits', combined: 'combined', deps: 'by dependencies', comments: 'comments' };

class CommitTreeProvider {
  constructor(state) {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this.state = state || NOOP_STATE;
    this.mode = 'commits'; // 'commits' | 'combined'
    // Number of remote-history commits to show below the local (unpushed) ones.
    this.extra = 0;
    // extractSymbols results by "ref:path"; commit refs never change, so never evicted.
    this.symbolCache = new Map();
  }

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  // Whether combined/review-all include uncommitted work (default) or committed files only.
  includeLocal() {
    return this.state.get('cft.includeLocal', true);
  }

  async setIncludeLocal(on) {
    await this.state.update('cft.includeLocal', on);
    this.refresh();
  }

  loadMore() {
    this.extra += 50;
    this.refresh();
  }

  hideHistory() {
    this.extra = 0;
    this.refresh();
  }

  setMode(mode) {
    this.mode = mode;
    vscode.commands.executeCommand('setContext', 'commitFileTree.mode', mode);
    if (this.graphView) this.graphView.description = MODE_LABEL[mode];
    this.refresh();
  }

  get repoRoot() {
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length ? folders[0].uri.fsPath : undefined;
  }

  reviewKey(ctx, filePath) {
    return `${ctx.keyRef}:${filePath}`;
  }

  reviewed() {
    return this.state.get('cft.reviewed', {});
  }

  notes() {
    return this.state.get('cft.notes', {});
  }

  comments() {
    return this.state.get('cft.comments', {});
  }

  commentsFor(ctx, filePath) {
    const store = this.comments();
    // Set: the target may itself be 'working' (working tree, combined with uncommitted changes).
    return [...new Set([ctx.target, ctx.base, 'working'])].flatMap((ref) => store[`${ref}:${filePath}`] || []);
  }

  // Export ends a review round: move comments and notes into a per-round
  // archive so the next round starts clean. Rounds can be restored one by one.
  // file: repo-relative path of this round's exported markdown, if one was written.
  async archiveReviewData(file) {
    const comments = this.comments();
    const notes = this.notes();
    const rounds = [...this.state.get('cft.archive.rounds', [])];
    rounds.push({ at: Date.now(), comments, notes, ...(file ? { file } : {}) });
    await this.state.update('cft.archive.rounds', rounds);
    await this.state.update('cft.comments', {});
    await this.state.update('cft.notes', {});
    this.refresh();
    return {
      comments: Object.values(comments).reduce((n, list) => n + list.length, 0),
      notes: Object.keys(notes).length,
    };
  }

  // Undo for archiveReviewData: merge the most recent round back into the
  // active state. Returns false when there is nothing to restore.
  async restoreLastRound() {
    const rounds = [...this.state.get('cft.archive.rounds', [])];
    const round = rounds.pop();
    if (!round) return false;
    const comments = { ...this.comments() };
    const notes = { ...this.notes() };
    for (const [k, list] of Object.entries(round.comments)) {
      comments[k] = [...(comments[k] || []), ...list];
    }
    for (const [k, text] of Object.entries(round.notes)) {
      notes[k] = notes[k] ? `${notes[k]}\n---\n${text}` : text;
    }
    await this.state.update('cft.archive.rounds', rounds);
    await this.state.update('cft.comments', comments);
    await this.state.update('cft.notes', notes);
    this.refresh();
    return true;
  }

  async clearReviewData() {
    const keys = ['cft.comments', 'cft.notes', 'cft.archive.rounds', 'cft.reviewed'];
    for (const k of keys) await this.state.update(k, undefined);
    this.refresh();
  }

  async toggleReviewed(item) {
    const map = { ...this.reviewed() };
    if (map[item.reviewId]) delete map[item.reviewId];
    else map[item.reviewId] = true;
    await this.state.update('cft.reviewed', map);
    this.refresh();
  }

  async editNote(item) {
    const notes = { ...this.notes() };
    const text = await vscode.window.showInputBox({
      prompt: `Note for ${item.filePath || item.notePath}`,
      value: notes[item.reviewId] || '',
      placeHolder: 'Leave empty to remove the note',
    });
    if (text === undefined) return; // cancelled
    if (text) notes[item.reviewId] = text;
    else delete notes[item.reviewId];
    await this.state.update('cft.notes', notes);
    this.refresh();
  }

  async getChildren(element) {
    const root = this.repoRoot;
    if (!root) return [];
    try {
      if (!element) {
        this.updateBadge(root); // fire-and-forget
        if (this.mode === 'combined') return await this.getCombined(root);
        if (this.mode === 'deps') return await this.getDeps(root);
        if (this.mode === 'comments') return await this.getCommentsView(root);
        return await this.getCommits(root);
      }
      if (element.contextValue === 'depfile') {
        // once a chain is opened, show the whole subtree expanded
        return element.depChildren.map((p) => this.depItem(p, [...element.ancestry, p], true));
      }
      if (element.contextValue === 'depgroup') {
        return element.filesList.map((p) => this.depItem(p, [p]));
      }
      if (element.contextValue === 'commit') {
        const out = await git(root, ['show', '--format=', '--name-status', element.sha]);
        const ctx = { base: `${element.sha}~1`, target: element.sha, keyRef: element.sha };
        return this.getTreeNodes(buildTree(parseNameStatus(out)), ctx);
      }
      if (element.contextValue === 'worktree') {
        return this.getTreeNodes(buildTree(await this.workingTreeFiles(root)), CommitTreeProvider.WORKING_CTX);
      }
      if (['roundcurrent', 'round', 'roundarchived', 'archivedrounds'].includes(element.contextValue)) {
        return element.children;
      }
      if (element.contextValue === 'commentgroup') {
        return element.entries.map((e) => this.commentEntryItem(element.label, e));
      }
      if (element.contextValue === 'file' && element.symbols) {
        return element.symbols.map((s) => this.symbolItem(s, element));
      }
      if (element.contextValue === 'dir') {
        return this.getTreeNodes(element.node, element.ctx);
      }
    } catch (e) {
      // Not a git repo, or git failed — show nothing rather than erroring.
      return [];
    }
    return [];
  }

  // Rounded view-header badge: number of changed files not yet marked reviewed.
  async updateBadge(root) {
    // Kept across the awaits: hiding the view disposes the webview and clears graphView.
    const view = this.graphView;
    if (!view) return;
    let badge;
    try {
      const ctx = await this.getReviewRange(root);
      const files = parseNameStatus(await git(root, ['diff', '--name-status', ctx.base, ctx.target]));
      const reviewed = this.reviewed();
      // ponytail: a file counts as reviewed if marked under any ref (commit or combined scope)
      const done = new Set(Object.keys(reviewed).map((k) => k.slice(k.indexOf(':') + 1)));
      const left = files.filter((f) => !done.has(f.path)).length;
      badge = left > 0 ? { value: left, tooltip: `${left} file(s) awaiting review` } : undefined;
    } catch (e) {
      badge = undefined;
    }
    view.badge = badge;
  }

  // git's well-known empty tree: lets local-only repos diff their entire history
  static EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
  // Uncommitted changes: base is HEAD, the "target" is the working copy on disk.
  static WORKING_CTX = { base: 'HEAD', target: 'working', keyRef: 'working' };

  // Tracked edits (staged + unstaged) vs base (HEAD by default), plus untracked files as added.
  async workingTreeFiles(root, base = 'HEAD') {
    const [diff, untracked] = await Promise.all([
      git(root, ['diff', base, '--name-status', '-M']),
      git(root, ['ls-files', '--others', '--exclude-standard']),
    ]);
    const files = parseNameStatus(diff);
    for (const p of untracked.split('\n').filter(Boolean)) files.push({ status: 'A', path: p });
    return files;
  }

  // Base for "what am I reviewing": upstream if set, else merge-base with a
  // local main branch, else the empty tree (whole repo counts as new work).
  // What the combined/deps/export views review: the base picked with the commit
  // checkboxes (cft.reviewBase), as long as it is still an ancestor of HEAD;
  // otherwise the unpushed range.
  async getReviewRange(root) {
    const ctx = await this.getUnpushedRange(root);
    const base = this.state.get('cft.reviewBase');
    if (!base || base === ctx.base) return ctx;
    if (base !== CommitTreeProvider.EMPTY_TREE) {
      const ok = await git(root, ['merge-base', '--is-ancestor', base, 'HEAD']).then(() => true, () => false);
      if (!ok) return ctx;
    }
    return { base, target: ctx.target, keyRef: base };
  }

  // Option A (contiguous): checking a commit moves the base to its parent, so it and
  // everything newer is in range; unchecking moves the base to the commit itself.
  async setCommitChecked(sha, checked) {
    const root = this.repoRoot;
    let base = sha;
    if (checked) {
      base = await git(root, ['rev-parse', `${sha}~1`]).then((o) => o.trim(), () => CommitTreeProvider.EMPTY_TREE);
    }
    const unpushed = (await this.getUnpushedRange(root)).base;
    await this.state.update('cft.reviewBase', base === unpushed ? undefined : base);
    this.refresh();
  }

  async resetReviewRange() {
    await this.state.update('cft.reviewBase', undefined);
    this.refresh();
  }

  async getUnpushedRange(root) {
    const target = (await git(root, ['rev-parse', 'HEAD'])).trim();
    let base;
    try {
      base = (await git(root, ['rev-parse', '@{upstream}'])).trim();
    } catch (e) {
      // No upstream: match the Graph's notion of "ahead" — commits not on any
      // remote. The first-parent boundary is the nearest pushed ancestor.
      try {
        const out = await git(root, ['rev-list', '--first-parent', '--boundary', 'HEAD', '--not', '--remotes']);
        const lines = out.trim().split('\n').filter(Boolean);
        const boundary = lines.find((l) => l.startsWith('-'));
        if (boundary) base = boundary.slice(1);
        else if (!lines.length) base = target; // HEAD itself is on a remote: all pushed
      } catch (e2) {
        // fall through to the local-branch heuristics below
      }
      const branch = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
      for (const main of ['main', 'master']) {
        if (base || main === branch) continue;
        try {
          const mb = (await git(root, ['merge-base', main, 'HEAD'])).trim();
          if (mb !== target) {
            base = mb;
            break;
          }
        } catch (e2) {
          // no such branch
        }
      }
      base = base || CommitTreeProvider.EMPTY_TREE;
    }
    return { base, target, keyRef: base };
  }

  // Everything the export and the comments view show: per-file notes/comments in the
  // unpushed range, folder notes, and feedback outside the range. null = no range.
  async summaryData(root) {
    let ctx;
    try {
      ctx = await this.getReviewRange(root);
    } catch (e) {
      return null;
    }
    const files = parseNameStatus(await git(root, ['diff', '--name-status', ctx.base, ctx.target]));
    const shas = (await git(root, ['rev-list', `${ctx.base}..${ctx.target}`])).split('\n').filter(Boolean);
    const refs = new Set([...shas, ctx.base, ctx.target, 'working']);
    const reviewed = this.reviewed();
    const notes = this.notes();
    const store = this.comments();
    const data = {
      rangeLabel:
        ctx.base === ctx.target ? ctx.base.slice(0, 7) : `${ctx.base.slice(0, 7)}..${ctx.target.slice(0, 7)}`,
      files: await Promise.all(
        files.map(async (f) => {
          const comments = [];
          for (const [key, list] of Object.entries(store)) {
            const [ref, rel] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
            if (rel !== f.path || !refs.has(ref)) continue;
            let content;
            for (const c of list) {
              if (content === undefined && f.status !== 'D') {
                content = await git(root, ['show', `${ctx.target}:${f.path}`]).catch(() => '');
              }
              comments.push({
                line: c.line,
                endLine: c.endLine,
                text: c.text,
                code: quoteLines(content, c.line, c.endLine),
              });
            }
          }
          comments.sort((a, b) => a.line - b.line);
          // A file may be marked reviewed under one ref (commit view) and noted
          // under another (combined view): look each up independently, and
          // keep every note rather than the first ref's only.
          const byRef = (map) => [...refs].map((r) => map[`${r}:${f.path}`]).filter(Boolean);
          return {
            path: f.path,
            status: f.status,
            risks: riskReasons(f),
            reviewed: byRef(reviewed).length > 0,
            note: byRef(notes).join('\n---\n') || undefined,
            comments,
            symbols: await this.symbolChanges(root, f, ctx),
          };
        })
      ),
    };
    // Comments and notes on files or revisions outside the unpushed range go
    // in their own section — user feedback is never dropped.
    const filePaths = new Set(files.map((f) => f.path));
    data.outside = [];
    data.folders = [];
    for (const [key, text] of Object.entries(notes)) {
      const idx = key.indexOf(':');
      const ref = key.slice(0, idx);
      const rel = key.slice(idx + 1);
      if (filePaths.has(rel) && refs.has(ref)) continue; // already in action items
      if (rel.endsWith('/') && refs.has(ref)) {
        data.folders.push({ path: rel, text });
        continue;
      }
      data.outside.push({ path: rel, ref, text });
    }
    for (const [key, list] of Object.entries(store)) {
      const idx = key.indexOf(':');
      const ref = key.slice(0, idx);
      const rel = key.slice(idx + 1);
      if (filePaths.has(rel) && refs.has(ref)) continue; // already in action items
      let content;
      if (ref === 'working') {
        try {
          content = fs.readFileSync(path.join(root, rel), 'utf8');
        } catch (e) {
          content = '';
        }
      } else {
        content = await git(root, ['show', `${ref}:${rel}`]).catch(() => '');
      }
      for (const c of list) {
        data.outside.push({
          path: rel,
          ref,
          line: c.line,
          endLine: c.endLine,
          text: c.text,
          code: quoteLines(content, c.line, c.endLine),
        });
      }
    }
    return data;
  }

  // Current round: every stored note/comment (all of it goes into the export), grouped by path.
  // Comments mode: the current (editable) round, then every exported round, newest first.
  async getCommentsView(root) {
    const groups = await this.currentGroups(root);
    const count = groups.reduce((n, g) => n + (g.entries ? g.entries.length : 0), 0);
    const cur = new vscode.TreeItem('Current round', vscode.TreeItemCollapsibleState.Expanded);
    cur.contextValue = 'roundcurrent';
    cur.children = groups;
    cur.description = `${count} · not exported`;
    cur.iconPath = new vscode.ThemeIcon('edit', new vscode.ThemeColor('charts.green'));
    const rounds = this.state.get('cft.archive.rounds', []);
    const items = [cur];
    const archived = [];
    for (let i = rounds.length - 1; i >= 0; i--) {
      const item = await this.roundItem(root, rounds[i], i + 1, i === rounds.length - 1);
      item.roundIndex = i;
      if (rounds[i].archived) {
        item.contextValue = 'roundarchived';
        archived.push(item);
      } else {
        items.push(item);
      }
    }
    // Archived rounds stay out of the way: collapsed until the user opens the group.
    if (archived.length) {
      const group = new vscode.TreeItem(`Archived rounds (${archived.length})`, vscode.TreeItemCollapsibleState.Collapsed);
      group.contextValue = 'archivedrounds';
      group.iconPath = new vscode.ThemeIcon('archive');
      group.children = archived;
      items.push(group);
    }
    return items;
  }

  async setRoundArchived(index, archived) {
    const rounds = [...this.state.get('cft.archive.rounds', [])];
    rounds[index] = { ...rounds[index], archived };
    await this.state.update('cft.archive.rounds', rounds);
    this.refresh();
  }

  // An exported round: read-only entries; the latest one carries ✅ changed / ⏳ unchanged status
  // (did the agent touch it since?). Older rounds skip the git diffs.
  async roundItem(root, round, n, latest) {
    const split = (key) => [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
    let entries;
    if (latest) {
      entries = await lastRoundStatus(root, round);
    } else {
      entries = [
        ...Object.entries(round.notes || {}).map(([key, text]) => ({ path: split(key)[1], text })),
        ...Object.entries(round.comments || {}).flatMap(([key, list]) =>
          list.map((c) => ({ path: split(key)[1], line: c.line, endLine: c.endLine, text: c.text }))
        ),
      ];
    }
    const d = new Date(round.at);
    const pad = (x) => String(x).padStart(2, '0');
    const when = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const item = new vscode.TreeItem(`Round ${n} · ${when}`, vscode.TreeItemCollapsibleState.Collapsed);
    item.contextValue = 'round';
    item.iconPath = new vscode.ThemeIcon('export', new vscode.ThemeColor('charts.purple'));
    const mark = (e) => (e.addressed === undefined ? '' : e.addressed ? '✅' : '⏳');
    const desc = [`${entries.length} item(s)`];
    if (latest) {
      const tally = ['✅', '⏳'].map((m) => [m, entries.filter((e) => mark(e) === m).length]);
      desc.push(tally.filter(([, k]) => k).map(([m, k]) => `${m}${k}`).join(' '));
    }
    item.description = desc.filter(Boolean).join(' · ');
    const legend = latest ? '✅ code changed since export · ⏳ not changed yet' : '';
    item.tooltip = legend || undefined;
    if (round.file) {
      item.tooltip = [`Exported to ${round.file} — click to open`, legend].filter(Boolean).join('\n');
      item.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(path.join(root, round.file))] };
    }
    item.children = entries.map((e) => {
      const loc = `${e.path}${e.line ? `:${e.line}${e.endLine ? '-' + e.endLine : ''}` : ''}`;
      const child = new vscode.TreeItem(e.text.split('\n')[0], vscode.TreeItemCollapsibleState.None);
      child.contextValue = 'roundentry';
      child.description = [mark(e), loc].filter(Boolean).join(' ');
      child.tooltip = e.text;
      if (!e.path.endsWith('/')) {
        const opts = e.line ? { selection: new vscode.Range(e.line - 1, 0, (e.endLine || e.line) - 1, 0) } : {};
        child.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(path.join(root, e.path)), opts] };
      }
      return child;
    });
    return item;
  }

  async currentGroups(root) {
    const groups = new Map();
    const split = (key) => [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
    const add = (p, entry) => groups.set(p, [...(groups.get(p) || []), entry]);
    for (const [key, text] of Object.entries(this.notes())) {
      const rel = split(key)[1];
      add(rel, { key, text, tag: rel.endsWith('/') ? 'folder note' : 'file note' });
    }
    for (const [key, list] of Object.entries(this.comments())) {
      const [ref, rel] = split(key);
      let content;
      if (ref === 'working') {
        content = await fs.promises.readFile(path.join(root, rel), 'utf8').catch(() => '');
      } else {
        content = await git(root, ['show', `${ref}:${rel}`]).catch(() => '');
      }
      for (const c of list) add(rel, { ...c, key, code: quoteLines(content, c.line, c.endLine) });
    }
    if (!groups.size) {
      const empty = new vscode.TreeItem('No comments yet', vscode.TreeItemCollapsibleState.None);
      empty.description = 'add line comments or 📝 notes in the other views';
      empty.iconPath = new vscode.ThemeIcon('info');
      return [empty];
    }
    return [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([p, entries]) => {
        entries.sort((a, b) => (a.line || 0) - (b.line || 0));
        const item = new vscode.TreeItem(p, vscode.TreeItemCollapsibleState.Expanded);
        item.contextValue = 'commentgroup';
        item.entries = entries;
        item.description = `${entries.length}`;
        // File-type icon from the icon theme, like the other views' file rows.
        // The query keeps git's M/U label colors off these rows (they are comment groups, not changes).
        item.resourceUri = vscode.Uri.file(path.join(root, p)).with({ query: 'cftComments' });
        item.iconPath = p.endsWith('/') ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;
        return item;
      });
  }

  // Edit a Comments-view entry in place: a line comment (matched by line) or a note.
  async updateEntry(item, text) {
    const e = item.entry;
    if (e.line) {
      const store = { ...this.comments() };
      store[e.key] = store[e.key].map((c) => (c.line === e.line ? { ...c, text } : c));
      await this.state.update('cft.comments', store);
    } else {
      await this.state.update('cft.notes', { ...this.notes(), [e.key]: text });
    }
    this.refresh();
  }

  async deleteEntry(item) {
    const e = item.entry;
    if (e.line) {
      const store = { ...this.comments() };
      store[e.key] = store[e.key].filter((c) => c.line !== e.line);
      if (!store[e.key].length) delete store[e.key];
      await this.state.update('cft.comments', store);
    } else {
      const notes = { ...this.notes() };
      delete notes[e.key];
      await this.state.update('cft.notes', notes);
    }
    this.refresh();
  }

  commentEntryItem(p, e) {
    const item = new vscode.TreeItem(e.text.split('\n')[0], vscode.TreeItemCollapsibleState.None);
    item.contextValue = 'commententry';
    item.entry = e;
    const span = e.line ? `L${e.line}${e.endLine ? '-' + e.endLine : ''}` : '';
    item.description = [span, e.tag].filter(Boolean).join(' · ');
    // Colored icons set entries apart from the plain file rows they sit under.
    const icon = e.line ? ['comment', 'charts.blue'] : e.tag === 'folder note' ? ['note', 'charts.orange'] : ['note', 'charts.yellow'];
    item.iconPath = new vscode.ThemeIcon(icon[0], new vscode.ThemeColor(icon[1]));
    const md = new vscode.MarkdownString();
    if (e.code) md.appendMarkdown('```\n' + e.code + '\n```\n\n');
    md.appendMarkdown(e.text.replace(/\n/g, '  \n'));
    item.tooltip = md;
    if (!p.endsWith('/')) {
      const opts = e.line ? { selection: new vscode.Range(e.line - 1, 0, (e.endLine || e.line) - 1, 0) } : {};
      item.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(path.join(this.repoRoot, p)), opts] };
    }
    return item;
  }

  async getCombined(root) {
    let ctx;
    try {
      ctx = await this.getReviewRange(root);
    } catch (e) {
      const item = new vscode.TreeItem('No upstream branch', vscode.TreeItemCollapsibleState.None);
      item.description = 'combined view needs one — switch to commit view';
      item.iconPath = new vscode.ThemeIcon('warning');
      return [item];
    }
    const range = await this.rangeFiles(root, ctx);
    const nodes = range.files.length ? await this.getTreeNodes(buildTree(range.files), range.ctx) : [this.allPushedItem()];
    return nodes;
  }

  // Files of the review range, honoring the Working tree checkbox (include uncommitted): when on,
  // diff the base against the working copy and retarget ctx at it.
  async rangeFiles(root, ctx) {
    if (this.includeLocal()) {
      return { files: await this.workingTreeFiles(root, ctx.base), ctx: { ...ctx, target: 'working' } };
    }
    if (ctx.base === ctx.target) return { files: [], ctx };
    return { files: parseNameStatus(await git(root, ['diff', '--name-status', ctx.base, ctx.target])), ctx };
  }

  // Dependency mode: roots are foundations (files importing no other changed
  // file, review them first); a file's children are the changed files that
  // import it. Cycles surface their members as extra roots.
  async getDeps(root) {
    let ctx, files;
    try {
      ctx = await this.getReviewRange(root);
    } catch (e) {
      const item = new vscode.TreeItem('No upstream branch', vscode.TreeItemCollapsibleState.None);
      item.description = 'dependency view needs one — switch to commit view';
      item.iconPath = new vscode.ThemeIcon('warning');
      return [item];
    }
    ({ files, ctx } = await this.rangeFiles(root, ctx));
    if (!files.length) return [this.allPushedItem()];
    const sources = new Map();
    for (const f of files) {
      if (f.status !== 'D' && ctx.target === 'working') {
        sources.set(f.path, await fs.promises.readFile(path.join(root, f.path), 'utf8').catch(() => ''));
        continue;
      }
      const ref = f.status === 'D' ? ctx.base : ctx.target;
      sources.set(f.path, await git(root, ['show', `${ref}:${f.path}`]).catch(() => ''));
    }
    const edges = buildEdges(sources);
    const importLine = new Map(edges.map((e) => [`${e.from}\0${e.to}`, e.line]));
    const importers = new Map();
    const outEdges = new Map();
    const outdeg = new Map(files.map((f) => [f.path, 0]));
    for (const e of edges) {
      importers.set(e.to, [...(importers.get(e.to) || []), e.from]);
      outEdges.set(e.from, [...(outEdges.get(e.from) || []), e.to]);
      outdeg.set(e.from, outdeg.get(e.from) + 1);
    }
    const roots = files.map((f) => f.path).filter((p) => outdeg.get(p) === 0);
    const reachable = new Set();
    const stack = [...roots];
    while (stack.length) {
      const p = stack.pop();
      if (reachable.has(p)) continue;
      reachable.add(p);
      stack.push(...(importers.get(p) || []));
    }
    for (const f of files) if (!reachable.has(f.path)) roots.push(f.path);
    // Separate import chains from standalone files (no edges either way).
    const isolated = roots.filter((p) => !(importers.get(p) || []).length);
    const connected = roots.filter((p) => (importers.get(p) || []).length);
    const grouped = connected.length > 0 && isolated.length > 0;
    this._deps = { ctx, importers, outEdges, importLine, grouped, isolated, meta: new Map(files.map((f) => [f.path, f])) };
    const header = [this.depSearchItem()];
    if (!connected.length) return [...header, ...roots.map((p) => this.depItem(p, [p]))];
    const items = [...header, ...connected.map((p) => this.depItem(p, [p]))];
    if (grouped) items.push(this.depGroupItem());
    return items;
  }

  // Tree views cannot host a text box: this row opens the fuzzy file finder instead.
  depSearchItem() {
    const item = new vscode.TreeItem('Search files…', vscode.TreeItemCollapsibleState.None);
    item.contextValue = 'depsearch';
    item.iconPath = new vscode.ThemeIcon('search');
    item.description = 'find a changed file by class or file name';
    item.command = { command: 'commitFileTree.findInDeps', title: 'Find File in Dependency View' };
    return item;
  }

  depGroupItem() {
    const group = new vscode.TreeItem(
      `Standalone files (${this._deps.isolated.length})`,
      vscode.TreeItemCollapsibleState.Collapsed
    );
    group.id = 'cft:depgroup';
    group.contextValue = 'depgroup';
    group.iconPath = new vscode.ThemeIcon('files');
    group.description = 'no import relationships with other changed files';
    group.filesList = this._deps.isolated;
    return group;
  }

  // Shortest chain from a root down to `target` in the dependency tree,
  // following the target's own imports upward (greedy, cycle-safe).
  depChainFor(target) {
    const { outEdges, grouped, isolated } = this._deps;
    const chain = [target];
    const seen = new Set(chain);
    let cur = target;
    let next;
    while ((next = (outEdges.get(cur) || []).find((n) => !seen.has(n)))) {
      chain.push(next);
      seen.add(next);
      cur = next;
    }
    chain.reverse();
    return { chain, inGroup: grouped && isolated.includes(target) };
  }

  depItem(p, ancestry, expandIfParent) {
    const { ctx, importers, meta } = this._deps;
    const m = meta.get(p) || {};
    const f = { name: path.posix.basename(p), status: m.status || 'M', path: p, oldPath: m.oldPath };
    const item = this.fileItem(f, ctx);
    item.id = 'cft:dep:' + ancestry.join('|');
    // A child row imports its parent: open it at that import line.
    const parent = ancestry[ancestry.length - 2];
    const line = parent && this._deps.importLine.get(`${p}\0${parent}`);
    if (line) item.command.arguments.push(line);
    const children = (importers.get(p) || []).filter((c) => !ancestry.includes(c));
    const dir = path.posix.dirname(p);
    const parts = [dir === '.' ? '' : dir, item.description || ''];
    if (children.length) {
      parts.unshift(`↑${children.length}`);
      item.collapsibleState = expandIfParent
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed;
      item.contextValue = 'depfile';
      item.depChildren = children;
      item.ancestry = ancestry;
      item.tooltip = `${item.tooltip}\n↑ imported by ${children.length} changed file(s)`;
    }
    item.description = parts.filter(Boolean).join(' · ');
    return item;
  }

  allPushedItem() {
    const empty = new vscode.TreeItem('No unpushed commits', vscode.TreeItemCollapsibleState.None);
    empty.iconPath = new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'));
    empty.description = 'everything is pushed';
    return empty;
  }

  async getCommits(root) {
    const FORMAT = '--format=%H%x09%h%x09%an%x09%ar%x09%D%x09%s';
    // Local (unpushed) commits are the focus; remote history is behind "Show pushed history".
    // The base comes from getUnpushedRange so all views agree on what "unpushed" means.
    const ctx = await this.getUnpushedRange(root);
    const hasBase = ctx.base !== CommitTreeProvider.EMPTY_TREE;
    let local = [];
    if (hasBase) {
      local = parseLog(await git(root, ['log', `${ctx.base}..HEAD`, '--shortstat', '--decorate=full', FORMAT]));
    }
    let history = [];
    const historyLimit = hasBase ? this.extra : this.extra + 50;
    if (historyLimit > 0) {
      history = parseLog(await git(root, ['log', `-${historyLimit}`, hasBase ? ctx.base : 'HEAD', '--shortstat', '--decorate=full', FORMAT]));
    }
    // Checkbox = in the review range (base..HEAD) that the other views show.
    const review = await this.getReviewRange(root);
    const rangeSpec = review.base === CommitTreeProvider.EMPTY_TREE ? 'HEAD' : `${review.base}..HEAD`;
    const inRange = new Set((await git(root, ['rev-list', rangeSpec]).catch(() => '')).split('\n').filter(Boolean));
    const items = local.map((c) => this.commitItem(c, true, inRange.has(c.sha)));
    // Hide sits on the boundary so it is visible without scrolling past the history.
    if (this.extra > 0) {
      const hide = new vscode.TreeItem('Hide pushed history', vscode.TreeItemCollapsibleState.None);
      hide.iconPath = new vscode.ThemeIcon('fold-up');
      hide.description = 'pushed commits below';
      hide.command = { command: 'commitFileTree.hideHistory', title: 'Hide Pushed History' };
      items.push(hide);
    }
    items.push(...history.map((c) => this.commitItem(c, false, inRange.has(c.sha), hasBase)));
    const dirty = await this.workingTreeFiles(root);
    if (dirty.length) {
      const wt = new vscode.TreeItem('Working tree', vscode.TreeItemCollapsibleState.Collapsed);
      wt.contextValue = 'worktree';
      // The one control for including uncommitted changes in combined/deps/review-all.
      wt.checkboxState = this.includeLocal() ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
      wt.description = `${dirty.length} uncommitted`;
      wt.iconPath = new vscode.ThemeIcon('edit', new vscode.ThemeColor('charts.yellow'));
      wt.tooltip = 'Uncommitted changes (staged, unstaged, untracked) vs HEAD';
      items.unshift(wt);
    }
    if (hasBase && local.length === 0 && this.extra === 0) {
      items.unshift(this.allPushedItem());
    }
    if (review.base !== ctx.base) {
      const reset = new vscode.TreeItem('Reset review range', vscode.TreeItemCollapsibleState.None);
      reset.contextValue = 'resetrange';
      reset.iconPath = new vscode.ThemeIcon('discard');
      reset.description = 'back to unpushed commits only';
      reset.command = { command: 'commitFileTree.resetReviewRange', title: 'Reset Review Range' };
      items.unshift(reset);
    }
    if (historyLimit === 0 || history.length === historyLimit) {
      const more = new vscode.TreeItem('Show pushed history…', vscode.TreeItemCollapsibleState.None);
      more.iconPath = new vscode.ThemeIcon('cloud');
      more.description = hasBase ? 'commits already on the remote' : 'older commits';
      more.command = { command: 'commitFileTree.loadMore', title: 'Show Pushed History' };
      items.push(more);
    }
    return items;
  }

  // Hover card for a commit row, like the Source Control Graph's: the parsed log
  // entry (stats included) plus what the list does not load up front.
  async commitCard(root, c) {
    const [email, date, message] = (await git(root, ['show', '-s', '--format=%ae%x00%aI%x00%B', c.sha])).split('\0');
    return { ...c, email, date, message: message.trim() };
  }

  // Lanes follow the Source Control Graph: local = unpushed, remote = already on
  // the remote; history with no base at all has no lane color.
  commitItem(c, unpushed, checked, pushed) {
    const item = new vscode.TreeItem(c.subject, vscode.TreeItemCollapsibleState.Collapsed);
    item.contextValue = 'commit';
    item.lane = unpushed ? 'local' : pushed ? 'remote' : 'none';
    item.refs = c.refs;
    item.commit = c;
    item.checkboxState = checked ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
    item.sha = c.sha;
    item.subject = c.subject;
    item.description = c.author;
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${c.subject}**\n\n`);
    md.appendMarkdown(`${c.author}, ${c.when}${unpushed ? ' · *unpushed*' : ''}\n\n`);
    md.appendMarkdown(`${c.files} files changed, **+${c.ins}** insertions, **−${c.del}** deletions\n\n`);
    md.appendMarkdown(`\`${c.short}\``);
    item.tooltip = md;
    return item;
  }

  fileItem(f, ctx) {
    const reviewed = this.reviewed();
    const notes = this.notes();
    const item = new vscode.TreeItem(f.name, vscode.TreeItemCollapsibleState.None);
    item.contextValue = 'file';
    item.filePath = f.path;
    item.reviewId = this.reviewKey(ctx, f.path);
    const isReviewed = !!reviewed[item.reviewId];
    const note = notes[item.reviewId];
    const risks = riskReasons(f);
    // Query marks the URI for our FileDecorationProvider (badge + color).
    item.resourceUri = vscode.Uri.file(path.join(this.repoRoot, f.path)).with({
      query: `cftStatus=${f.status}&rev=${isReviewed ? 1 : 0}`,
    });
    const comments = this.commentsFor(ctx, f.path);
    const markers = [];
    if (risks.length && !isReviewed) markers.push(`⚠ ${risks.join(', ')}`);
    if (note) markers.push('📝');
    if (comments.length) markers.push(`💬${comments.length}`);
    item.description = markers.join(' ') || undefined;
    const lines = [`${STATUS_LABEL[f.status] || f.status}: ${f.path}`];
    if (risks.length) lines.push(`⚠ Review carefully: ${risks.join(', ')}`);
    if (note) lines.push(`📝 ${note}`);
    for (const c of comments) lines.push(`💬 L${c.line}${c.endLine ? '-' + c.endLine : ''}: ${c.text}`);
    if (isReviewed) lines.push('✓ Reviewed');
    item.tooltip = lines.join('\n');
    item.command = {
      command: 'commitFileTree.openDiff',
      title: 'Open Diff',
      arguments: [f.path, f.status, ctx, f.oldPath],
    };
    return item;
  }

  // Declarations added/removed in a changed file between ctx.base and ctx.target,
  // for the rows under it and the export. Per-ref results are cached; HEAD and
  // the working copy move, so those are read every time.
  async symbolChanges(root, f, ctx) {
    if (!SYMBOL_RULES.has(path.posix.extname(f.path))) return [];
    const side = async (ref, rel) => {
      const key = `${ref}:${rel}`;
      if (this.symbolCache.has(key)) return this.symbolCache.get(key);
      const content = await (ref === 'working'
        ? fs.promises.readFile(path.join(root, rel), 'utf8')
        : git(root, ['show', `${ref}:${rel}`])
      ).catch(() => '');
      const syms = extractSymbols(rel, content);
      if (ref !== 'working' && ref !== 'HEAD') this.symbolCache.set(key, syms);
      return syms;
    };
    // ponytail: two git calls per file, in sequence; `git cat-file --batch` if large commits feel slow
    const before = f.status === 'A' ? [] : await side(ctx.base, f.oldPath || f.path);
    const after = f.status === 'D' ? [] : await side(ctx.target, f.path);
    return diffSymbols(before, after);
  }

  // "+ foo()" / "− bar" under a file. Opens the diff at the symbol's line; a removed
  // symbol's line is on the base side, which openDiff maps onto the modified side.
  symbolItem(s, file) {
    const item = new vscode.TreeItem(symbolText(s, ' '), vscode.TreeItemCollapsibleState.None);
    item.contextValue = 'symbol';
    item.iconPath = new vscode.ThemeIcon(SYMBOL_ICON[s.kind], new vscode.ThemeColor(s.change === '+' ? 'charts.green' : 'charts.red'));
    const side = s.change === '-' ? ['base'] : [];
    item.command = { command: 'commitFileTree.openDiff', title: 'Open Diff', arguments: [...file.command.arguments, s.line, ...side] };
    return item;
  }

  async getTreeNodes(node, ctx) {
    const notes = this.notes();
    const dirs = [...node.dirs.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([rawName, rawChild]) => {
        const { name, node: child } = compactDir(rawName, rawChild);
        const item = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.Expanded);
        item.contextValue = 'dir';
        item.node = child;
        item.ctx = ctx;
        item.iconPath = vscode.ThemeIcon.Folder;
        // Folder notes key on a trailing slash so they never collide with a file path.
        item.notePath = `${child.path}/`;
        item.reviewId = this.reviewKey(ctx, item.notePath);
        const note = notes[item.reviewId];
        if (note) item.description = '📝';
        let agg = aggStatus(child);
        // Unchanged files never appear in the diff, so "all D" only means the
        // folder is gone if it no longer exists on disk.
        if (agg === 'D' && child.path && fs.existsSync(path.join(this.repoRoot, child.path))) {
          agg = undefined;
        }
        if (agg) {
          item.resourceUri = vscode.Uri.file(path.join(this.repoRoot, child.path || name)).with({
            query: `cftStatus=${agg}&rev=0`,
          });
          item.tooltip = agg === 'D' ? 'Folder deleted (all files inside removed)' : 'All changed files inside are new';
        }
        if (note) item.tooltip = [item.tooltip, `📝 ${note}`].filter(Boolean).join('\n');
        return item;
      });
    const files = [];
    for (const f of node.files.sort((a, b) => a.name.localeCompare(b.name))) {
      const item = this.fileItem(f, ctx);
      // Files whose declarations changed expand into those symbols; others stay leaves.
      const symbols = await this.symbolChanges(this.repoRoot, f, ctx);
      if (symbols.length) {
        item.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
        item.symbols = symbols;
      }
      files.push(item);
    }
    return [...dirs, ...files];
  }
}

// Same colors the built-in SCM view uses for changed files.
const STATUS_COLOR = {
  A: 'gitDecoration.addedResourceForeground',
  M: 'gitDecoration.modifiedResourceForeground',
  D: 'gitDecoration.deletedResourceForeground',
  R: 'gitDecoration.renamedResourceForeground',
  C: 'gitDecoration.addedResourceForeground',
};

// Badge + color for a changed file's URI query (set by fileItem/getTreeNodes):
// the webview colors the row and draws the badge itself.
function statusDecoration(query) {
  const m = /^cftStatus=([A-Z])&rev=([01])$/.exec(query || '');
  if (!m) return undefined;
  const [, status, rev] = m;
  if (rev === '1') {
    return { badge: '✓', color: new vscode.ThemeColor('gitDecoration.ignoredResourceForeground'), tooltip: 'Reviewed' };
  }
  return {
    badge: status,
    color: new vscode.ThemeColor(STATUS_COLOR[status] || 'foreground'),
    tooltip: STATUS_LABEL[status] || status,
  };
}

// Plain-JSON rows for the webview, built from the provider's TreeItems in every mode.
// byId maps row ids back to TreeItems for commands and children. Expanded rows
// (folders, comment groups, opened dependency chains) arrive with their children;
// collapsed ones (commits, the working tree, dependency roots) load on expand.
async function graphRows(provider, items, parentId, byId) {
  const rows = [];
  for (const item of items) {
    const label = typeof item.label === 'string' ? item.label : item.label.label;
    let id = item.sha || item.id || `${parentId}/${label}`;
    // Same-label siblings (two comments with the same first line) need distinct ids.
    for (let n = 2; byId.has(id) && byId.get(id) !== item; n++) id = `${parentId}/${label}#${n}`;
    byId.set(id, item);
    const icon = item.iconPath;
    const deco = item.resourceUri && statusDecoration(item.resourceUri.query);
    const tip = item.tooltip;
    const row = {
      id,
      label,
      description: item.description,
      tooltip: typeof tip === 'string' ? tip : tip && tip.value.replace(/[*`]/g, ''),
      icon: icon && icon.id,
      iconColor: icon && icon.color && icon.color.id,
      checked: item.checkboxState === undefined ? undefined : item.checkboxState === vscode.TreeItemCheckboxState.Checked,
      branch: !!item.collapsibleState,
      open: item.collapsibleState === vscode.TreeItemCollapsibleState.Expanded,
      context: item.contextValue,
      // data-vscode-context for right-click menus: the fields their commands read
      ctx: JSON.parse(JSON.stringify({ sha: item.sha, subject: item.subject, filePath: item.filePath })),
      run: !!item.command,
      lane: item.lane,
      refs: item.refs,
      deco: deco && { badge: deco.badge, color: deco.color.id },
    };
    if (row.open) row.children = await graphRows(provider, await provider.getChildren(item), id, byId);
    rows.push(row);
  }
  return rows;
}

// Commit graph page: vscode-elements' tree (vendored in media/) and codicons;
// media/graph.js renders the rows posted by the extension.
function graphHtml(webview, media) {
  const src = (f) => webview.asWebviewUri(vscode.Uri.joinPath(media, f));
  const nonce = crypto.randomBytes(16).toString('hex');
  const csp = `default-src 'none'; font-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <link rel="stylesheet" href="${src('codicon.css')}" id="vscode-codicon-stylesheet">
  <link rel="stylesheet" href="${src('graph.css')}">
</head>
<body data-vscode-context='{"preventDefaultContextMenuItems": true}'>
  <vscode-tree indent-guides="onHover" hide-arrows indent="16"></vscode-tree>
  <script type="module" nonce="${nonce}" src="${src('vscode-elements.js')}"></script>
  <script type="module" nonce="${nonce}" src="${src('graph.js')}"></script>
</body>
</html>`;
}

// Identify a document as (ref, repo-relative path), for comment storage.
// git-scheme URIs carry {path, ref} in their query; file-scheme = working copy.
function locOf(uri, root) {
  if (!root) return undefined;
  if (uri.scheme === 'git') {
    try {
      const q = JSON.parse(uri.query);
      const rel = path.relative(root, q.path);
      return rel.startsWith('..') ? undefined : { ref: q.ref, rel };
    } catch (e) {
      return undefined;
    }
  }
  if (uri.scheme === 'file') {
    const rel = path.relative(root, uri.fsPath);
    return rel.startsWith('..') ? undefined : { ref: 'working', rel };
  }
  return undefined;
}

// Commenting range for a document: one zero-width range on the cursor's line
// of whichever *visible* editor shows it. Deliberately not focus-dependent —
// focus sits in the comment widget while ranges are re-queried after a
// draft is discarded (the 0.3.13 regression).
function commentRangeFor(documentUri, editors, root) {
  if (!locOf(documentUri, root)) return [];
  const ed = editors.find((e) => e.document.uri.toString() === documentUri.toString());
  if (!ed) return [];
  const sel = ed.selection;
  // multi-line selection → the whole span is commentable; else the cursor line
  const start = sel.start ? sel.start.line : sel.active.line;
  const end = sel.end ? sel.end.line : sel.active.line;
  return [new vscode.Range(start, 0, end, 0)];
}

// Cursor kills its builtin extension hosts after ~30 idle minutes and restarts
// them on the next focus/activity. Each restarted host constructs a new
// MainThreadComments, whose constructor calls unregisterCommentController()
// with no argument — clearing *every* comment controller on the main thread,
// including ours, while our extension host keeps running. From then on VS Code
// never asks us for commenting ranges and the "+" gutter is gone until reload.
// A poke (reassigning commentingRangeProvider) that is not answered by a
// provideCommentingRanges call within timeoutMs means we were dropped → the
// caller re-registers the controller. cooldownMs bounds thrash if a poke is
// ever unanswered for another reason (e.g. commenting disabled).
function controllerWatchdog(recreate, { timeoutMs = 1500, cooldownMs = 30000 } = {}) {
  let lastProvide = 0;
  let lastRecreate = 0;
  let timer;
  return {
    provided() {
      lastProvide = Date.now();
    },
    poked() {
      const at = Date.now();
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (lastProvide >= at || Date.now() - lastRecreate < cooldownMs) return;
        lastRecreate = Date.now();
        recreate();
      }, timeoutMs);
    },
  };
}

// The "target" side of a change: a git revision, or the file on disk for the working tree.
function targetUri(root, filePath, ctx) {
  return ctx.target === 'working' ? vscode.Uri.file(path.join(root, filePath)) : gitUri(root, filePath, ctx.target);
}

function changeResources(root, files, ctx) {
  return files.map((f) => [
    vscode.Uri.file(path.join(root, f.path)),
    f.status === 'A' ? undefined : gitUri(root, f.oldPath || f.path, ctx.base),
    f.status === 'D' ? undefined : targetUri(root, f.path, ctx),
  ]);
}

// Watch everything git writes on commit, checkout, fetch, and push: the
// repo's git dir (HEAD, index, refs/heads) and, for a linked worktree, the
// common dir where remote-tracking refs and packed-refs live. Recursive so a
// push updating refs/remotes/origin/<branch> is seen. Returns {close}.
async function watchGitDirs(root, onChange) {
  const dirs = new Set();
  for (const flag of ['--absolute-git-dir', '--git-common-dir']) {
    try {
      dirs.add(path.resolve(root, (await git(root, ['rev-parse', flag])).trim()));
    } catch (e) {
      // not a git repo
    }
  }
  const watchers = [];
  for (const dir of dirs) {
    try {
      watchers.push(fs.watch(dir, { recursive: true }, onChange));
    } catch (e) {
      // ponytail: no recursive watch on this platform → fall back to the old flat watch
      try {
        watchers.push(fs.watch(dir, onChange));
      } catch (e2) {
        // dir vanished between rev-parse and watch
      }
    }
  }
  return { close: () => watchers.forEach((w) => w.close()) };
}

function activate(context) {
  const provider = new CommitTreeProvider(context.workspaceState);
  vscode.commands.executeCommand('setContext', 'commitFileTree.mode', 'commits');

  async function reviewAll(item) {
    const root = provider.repoRoot;
    if (!root) return;
    let ctx, files, title;
    try {
      if (item && item.contextValue === 'commit') {
        ctx = { base: `${item.sha}~1`, target: item.sha };
        files = parseNameStatus(await git(root, ['show', '--format=', '--name-status', item.sha]));
        title = `Review ${item.sha.slice(0, 7)}: ${item.subject}`;
      } else if (item && item.contextValue === 'worktree') {
        ctx = CommitTreeProvider.WORKING_CTX;
        files = await provider.workingTreeFiles(root);
        title = 'Review working tree';
      } else {
        ({ files, ctx } = await provider.rangeFiles(root, await provider.getReviewRange(root)));
        title = 'Review unpushed changes';
      }
    } catch (e) {
      vscode.window.showWarningMessage('Commit Review Tree: nothing to review (no upstream or no changes).');
      return;
    }
    if (!files.length) {
      vscode.window.showInformationMessage('Commit Review Tree: no changes to review.');
      return;
    }
    return vscode.commands.executeCommand('vscode.changes', title, changeResources(root, files, ctx));
  }

  async function revertCommit(item) {
    const root = provider.repoRoot;
    if (!root || !item || !item.sha) return;
    const short = item.sha.slice(0, 7);
    const pick = await vscode.window.showWarningMessage(
      `Revert commit ${short} "${item.subject}"?\n\nThis creates a new commit that undoes it.`,
      { modal: true },
      'Revert'
    );
    if (pick !== 'Revert') return;
    try {
      await git(root, ['revert', '--no-edit', item.sha]);
      provider.refresh();
      vscode.window.showInformationMessage(`Reverted ${short}.`);
    } catch (e) {
      vscode.window.showErrorMessage(`Revert failed: ${e.message}`);
    }
  }

  // --- Line comments (native Comments API) ---
  let controller; // (re)created by createController — see controllerWatchdog
  // Only offer the "+" gutter on the cursor's line, not on every hovered line.
  const rangeProvider = {
    provideCommentingRanges(document) {
      watchdog.provided();
      return commentRangeFor(document.uri, vscode.window.visibleTextEditors, provider.repoRoot);
    },
  };
  const liveThreads = new Map(); // "<ref>:<rel>:<line>" -> CommentThread

  function commentBody(text) {
    return { body: new vscode.MarkdownString(text), mode: vscode.CommentMode.Preview, author: { name: 'review' } };
  }

  async function saveComment(reply) {
    const loc = locOf(reply.thread.uri, provider.repoRoot);
    if (!loc || !reply.text) return;
    const line = reply.thread.range.start.line + 1; // store 1-based
    const endLine = reply.thread.range.end.line + 1;
    const store = { ...provider.comments() };
    const key = `${loc.ref}:${loc.rel}`;
    const entry = { line, text: reply.text };
    if (endLine > line) entry.endLine = endLine;
    store[key] = [...(store[key] || []), entry];
    await provider.state.update('cft.comments', store);
    reply.thread.comments = [...reply.thread.comments, commentBody(reply.text)];
    reply.thread.canReply = true;
    reply.thread.contextValue = 'saved'; // gates the Delete button to real threads
    liveThreads.set(`${key}:${line}`, reply.thread);
    provider.refresh();
  }

  async function deleteThread(thread) {
    const loc = locOf(thread.uri, provider.repoRoot);
    if (loc) {
      const line = thread.range.start.line + 1;
      const store = { ...provider.comments() };
      const key = `${loc.ref}:${loc.rel}`;
      store[key] = (store[key] || []).filter((c) => c.line !== line);
      if (!store[key].length) delete store[key];
      await provider.state.update('cft.comments', store);
      liveThreads.delete(`${key}:${line}`);
      provider.refresh();
    }
    thread.dispose();
  }

  // Comments-view edits must also reach threads already shown in open editors.
  function dropLiveThread(entry) {
    const t = liveThreads.get(`${entry.key}:${entry.line}`);
    if (t) t.dispose();
    liveThreads.delete(`${entry.key}:${entry.line}`);
  }

  async function editEntry(item) {
    if (!item || !item.entry) return;
    const text = await vscode.window.showInputBox({
      prompt: item.entry.line ? `Edit comment on ${item.description}` : 'Edit note',
      value: item.entry.text,
    });
    if (!text) return; // cancelled or emptied — deleting is its own button
    await provider.updateEntry(item, text);
    if (item.entry.line) {
      dropLiveThread(item.entry);
      vscode.workspace.textDocuments.forEach(restoreThreads);
    }
  }

  async function deleteEntry(item) {
    if (!item || !item.entry) return;
    const pick = await vscode.window.showWarningMessage(`Delete "${item.label}"?`, { modal: true }, 'Delete');
    if (pick !== 'Delete') return;
    await provider.deleteEntry(item);
    if (item.entry.line) dropLiveThread(item.entry);
  }

  // Re-create persisted threads when a matching document opens.
  function restoreThreads(document) {
    const loc = locOf(document.uri, provider.repoRoot);
    if (!loc) return;
    const key = `${loc.ref}:${loc.rel}`;
    for (const c of provider.comments()[key] || []) {
      const threadKey = `${key}:${c.line}`;
      if (liveThreads.has(threadKey)) continue;
      const range = new vscode.Range(c.line - 1, 0, (c.endLine || c.line) - 1, 0);
      const thread = controller.createCommentThread(document.uri, range, [commentBody(c.text)]);
      thread.canReply = true;
      thread.contextValue = 'saved';
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
      liveThreads.set(threadKey, thread);
    }
  }
  function createController() {
    if (controller) controller.dispose(); // also disposes its threads
    liveThreads.clear();
    controller = vscode.comments.createCommentController('commitFileTree', 'Commit Review Tree');
    controller.commentingRangeProvider = rangeProvider;
    vscode.workspace.textDocuments.forEach(restoreThreads);
  }
  const watchdog = controllerWatchdog(createController);
  createController();
  let lastCommentLine;
  // Focus returning from the comment widget re-queries ranges so the "+" recovers.
  const focusListener = vscode.window.onDidChangeActiveTextEditor((ed) => {
    if (ed && locOf(ed.document.uri, provider.repoRoot)) {
      controller.commentingRangeProvider = rangeProvider;
    }
  });
  const selectionListener = vscode.window.onDidChangeTextEditorSelection((e) => {
    if (!locOf(e.textEditor.document.uri, provider.repoRoot)) return;
    const sel = e.textEditor.selection;
    // keyed by document too: the two sides of a diff share line numbers
    const span = `${e.textEditor.document.uri}:${sel.start.line}-${sel.end.line}`;
    if (span === lastCommentLine) return; // typing within the same span: no redraw, no flicker
    lastCommentLine = span;
    // ponytail: reassigning the provider pokes VS Code into re-querying ranges
    controller.commentingRangeProvider = rangeProvider;
    watchdog.poked();
  });

  function updateArchiveContext() {
    const rounds = provider.state.get('cft.archive.rounds', []);
    vscode.commands.executeCommand('setContext', 'commitFileTree.hasArchive', rounds.length > 0);
  }
  updateArchiveContext();

  // --- Export review summary ---
  async function exportSummary() {
    const root = provider.repoRoot;
    if (!root) return;
    // Export ends the round. No confirmation: the round is kept as a timestamped
    // file and in the archive (restorable), so nothing is lost.
    const archiveAfter =
      Object.values(provider.comments()).some((l) => l.length) || Object.keys(provider.notes()).length > 0;
    const data = await provider.summaryData(root);
    if (!data) {
      vscode.window.showWarningMessage('Commit Review Tree: no upstream branch — nothing to summarize.');
      return;
    }
    const md = buildSummaryMd(data);
    await vscode.env.clipboard.writeText(md);
    // Also write it where the agent can read it (empty setting = clipboard only).
    const exportPath = vscode.workspace.getConfiguration('commitFileTree').get('exportPath', '').trim();
    let where = 'copied to clipboard';
    let written; // absolute path of the file, when one was written
    if (exportPath) {
      try {
        written = await writeReviewFile(root, exportPath, md);
        where = `copied to clipboard and written to ${exportPath}`;
      } catch (e) {
        vscode.window.showErrorMessage(`Commit Review Tree: could not write ${exportPath}: ${e.message}`);
      }
    }
    // Nothing opens in the editor: the clipboard/file is the deliverable. "Open" is on the toast.
    const actions = written ? ['Open'] : [];
    if (!archiveAfter) {
      const pick = await vscode.window.showInformationMessage(`Review summary ${where}.`, ...actions);
      if (pick === 'Open') await vscode.window.showTextDocument(vscode.Uri.file(written), { preview: false });
      return;
    }
    // Keep a timestamped copy beside the latest file (e.g. .commit-review/2026-09-24_1608.md),
    // so the history of what was asked stays readable and sorts by time. The round
    // remembers it, so the Comments view can open exactly what was delivered.
    let stamped;
    if (written) {
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
      stamped = path.posix.join(path.posix.dirname(exportPath), `${stamp}${path.extname(exportPath)}`);
      stamped = await writeReviewFile(root, stamped, md).then(() => stamped, () => exportPath);
    }
    // Export ends the round: archive delivered feedback so the next round starts clean.
    await provider.archiveReviewData(stamped);
    liveThreads.forEach((t) => t.dispose());
    liveThreads.clear();
    updateArchiveContext();
    const pick = await vscode.window.showInformationMessage(
      `Review summary ${where} — exported as Round ${provider.state.get('cft.archive.rounds', []).length} in the Comments view.`,
      'Undo Export'
    );
    if (pick === 'Undo Export') await restoreLastRound();
  }

  async function restoreLastRound() {
    const restored = await provider.restoreLastRound();
    updateArchiveContext();
    if (!restored) {
      vscode.window.showInformationMessage('Commit Review Tree: no exported round to restore.');
      return;
    }
    // Re-create threads for documents that are already open.
    vscode.workspace.textDocuments.forEach(restoreThreads);
    vscode.window.showInformationMessage('Last archived round restored.');
  }

  async function clearReviewData() {
    const pick = await vscode.window.showWarningMessage(
      'Clear all review data (comments, notes, reviewed marks, archives)?',
      { modal: true },
      'Clear'
    );
    if (pick !== 'Clear') return;
    await provider.clearReviewData();
    liveThreads.forEach((t) => t.dispose());
    liveThreads.clear();
    updateArchiveContext();
  }

  // Every mode renders in one webview: a native tree row cannot hold Graph lanes or
  // right-aligned, width-capped ref badges, and swapping a tree and a webview by mode
  // made the Source Control panel resize the view on every switch.
  // Rows come from the provider's TreeItems (graphRows); byId resolves them back for actions.
  let byId = new Map();
  async function postGraph() {
    const wv = provider.graphView;
    if (!wv) return;
    const mode = provider.mode;
    const ids = new Map();
    const rows = await graphRows(provider, await provider.getChildren(), '', ids);
    if (mode !== provider.mode) return; // a quicker switch already posted the newer mode
    byId = ids;
    wv.webview.postMessage({ type: 'root', rows });
  }
  const graphProvider = {
    resolveWebviewView(wv) {
      provider.graphView = wv;
      wv.description = MODE_LABEL[provider.mode];
      const media = vscode.Uri.joinPath(context.extensionUri, 'media');
      wv.webview.options = { enableScripts: true, localResourceRoots: [media] };
      wv.webview.html = graphHtml(wv.webview, media);
      wv.onDidDispose(() => (provider.graphView = undefined));
      wv.webview.onDidReceiveMessage(async (m) => {
        if (m.type === 'ready') return postGraph();
        const item = byId.get(m.id);
        if (!item) return;
        if (m.type === 'children') {
          const rows = await graphRows(provider, await provider.getChildren(item), m.id, byId);
          wv.webview.postMessage({ type: 'children', id: m.id, rows });
        }
        if (m.type === 'card' && item.commit) {
          wv.webview.postMessage({ type: 'card', id: m.id, card: await provider.commitCard(provider.repoRoot, item.commit) });
        }
        // Commit checkboxes set the review range; the Working tree one includes uncommitted changes.
        if (m.type === 'check' && item.contextValue === 'worktree') provider.setIncludeLocal(m.checked);
        if (m.type === 'check' && item.contextValue === 'commit') provider.setCommitChecked(item.sha, m.checked);
        if (m.type === 'run' && item.command) vscode.commands.executeCommand(item.command.command, ...(item.command.arguments || []));
        if (m.type === 'action') vscode.commands.executeCommand(m.command, item);
      });
    },
  };
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('commitFileTree.graph', graphProvider),
    provider.onDidChangeTreeData(postGraph)
  );

  // Auto-refresh on commit, checkout, fetch, and push; debounce a burst into one refresh.
  (async () => {
    const root = provider.repoRoot;
    if (!root) return;
    let timer;
    const trigger = () => {
      clearTimeout(timer);
      timer = setTimeout(() => provider.refresh(), 500);
    };
    const gitWatch = await watchGitDirs(root, trigger);
    context.subscriptions.push({ dispose: () => gitWatch.close() });
    // Unstaged edits never touch the git dir; the working-tree node needs the workspace watcher.
    const ws = vscode.workspace.createFileSystemWatcher('**');
    ws.onDidChange(trigger);
    ws.onDidCreate(trigger);
    ws.onDidDelete(trigger);
    context.subscriptions.push(ws);
  })();

  let backMode;
  function setBack(mode) {
    backMode = mode;
    vscode.commands.executeCommand('setContext', 'commitFileTree.canGoBack', !!mode);
  }

  // Switch to dependency mode and reveal the file's shortest import chain.
  async function revealInDeps(item) {
    const root = provider.repoRoot;
    if (!root || !item || !item.filePath) return;
    setBack(provider.mode !== 'deps' ? provider.mode : undefined);
    provider.setMode('deps');
    await provider.getDeps(root); // ensure the dependency model exists
    const target = item.filePath;
    if (!provider._deps || !provider._deps.meta.has(target)) {
      vscode.window.showInformationMessage('Commit Review Tree: file is not part of the unpushed change set.');
      return;
    }
    // Row ids from the top of the chain down to the file; the webview opens each and selects the last.
    const { chain, inGroup } = provider.depChainFor(target);
    const ids = chain.map((_, i) => provider.depItem(chain[i], chain.slice(0, i + 1)).id);
    if (inGroup) ids.unshift(provider.depGroupItem().id);
    if (provider.graphView) provider.graphView.webview.postMessage({ type: 'reveal', ids });
  }

  // Fuzzy-find a changed file by name (or path) and reveal it in the dependency tree,
  // even when it sits deep inside a collapsed chain.
  async function findInDeps() {
    const root = provider.repoRoot;
    if (!root) return;
    await provider.getDeps(root);
    if (!provider._deps) return;
    const picks = [...provider._deps.meta.keys()].sort().map((p) => ({
      label: path.basename(p),
      description: path.dirname(p) === '.' ? '' : path.dirname(p),
      filePath: p,
    }));
    const pick = await vscode.window.showQuickPick(picks, {
      placeHolder: 'Find a changed file in the dependency view (type a class or file name)',
      matchOnDescription: true,
    });
    if (pick) await revealInDeps(pick);
  }

  context.subscriptions.push(
    { dispose: () => controller.dispose() },
    selectionListener,
    focusListener,
    vscode.workspace.onDidOpenTextDocument(restoreThreads),
    vscode.commands.registerCommand('commitFileTree.addComment', saveComment),
    vscode.commands.registerCommand('commitFileTree.deleteThread', deleteThread),
    vscode.commands.registerCommand('commitFileTree.exportSummary', exportSummary),
    vscode.commands.registerCommand('commitFileTree.editEntry', editEntry),
    vscode.commands.registerCommand('commitFileTree.archiveRound', (item) => item && provider.setRoundArchived(item.roundIndex, true)),
    vscode.commands.registerCommand('commitFileTree.unarchiveRound', (item) => item && provider.setRoundArchived(item.roundIndex, false)),
    vscode.commands.registerCommand('commitFileTree.deleteEntry', deleteEntry),
    vscode.commands.registerCommand('commitFileTree.viewComments', () => { setBack(undefined); provider.setMode('comments'); }),
    vscode.commands.registerCommand('commitFileTree.clearReviewData', clearReviewData),
    vscode.commands.registerCommand('commitFileTree.restoreLastRound', restoreLastRound),
    vscode.commands.registerCommand('commitFileTree.revealInDeps', revealInDeps),
    vscode.commands.registerCommand('commitFileTree.findInDeps', findInDeps),
    vscode.commands.registerCommand('commitFileTree.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('commitFileTree.resetReviewRange', () => provider.resetReviewRange()),
    vscode.commands.registerCommand('commitFileTree.loadMore', () => provider.loadMore()),
    vscode.commands.registerCommand('commitFileTree.hideHistory', () => provider.hideHistory()),
    vscode.commands.registerCommand('commitFileTree.viewCombined', () => { setBack(undefined); provider.setMode('combined'); }),
    vscode.commands.registerCommand('commitFileTree.viewByDeps', () => { setBack(undefined); provider.setMode('deps'); }),
    vscode.commands.registerCommand('commitFileTree.viewByCommits', () => { setBack(undefined); provider.setMode('commits'); }),
    vscode.commands.registerCommand('commitFileTree.goBack', () => {
      const mode = backMode || 'commits';
      setBack(undefined);
      provider.setMode(mode);
    }),
    vscode.commands.registerCommand('commitFileTree.reviewAll', reviewAll),
    vscode.commands.registerCommand('commitFileTree.revertCommit', revertCommit),
    vscode.commands.registerCommand('commitFileTree.toggleReviewed', (item) => provider.toggleReviewed(item)),
    vscode.commands.registerCommand('commitFileTree.editNote', (item) => provider.editNote(item)),
    vscode.commands.registerCommand('commitFileTree.copySha', (item) =>
      vscode.env.clipboard.writeText(item.sha)
    ),
    vscode.commands.registerCommand('commitFileTree.copyMessage', (item) =>
      vscode.env.clipboard.writeText(item.subject)
    ),
    // line: symbol rows (the declaration) and dependency rows (the import) open there;
    // side 'base': a removed symbol, whose line is in the old version.
    vscode.commands.registerCommand('commitFileTree.openDiff', async (filePath, status, ctx, oldPath, line, side) => {
      const root = provider.repoRoot;
      if (!root) return;
      const title = `${path.basename(filePath)} (${ctx.target.slice(0, 7)})`;
      const at = (n) => ({ selection: new vscode.Range(n - 1, 0, n - 1, 0) });
      let opts = line ? at(line) : undefined;
      // Deleted: no version at target — open the old content.
      if (status === 'D') {
        return vscode.commands.executeCommand('vscode.open', gitUri(root, oldPath || filePath, ctx.base), opts);
      }
      // Added: no base-side version (may even be a root commit) — open the new content.
      if (status === 'A') {
        return vscode.commands.executeCommand('vscode.open', targetUri(root, filePath, ctx), opts);
      }
      // A diff editor selects on the modified (right) side; an old-side line is mapped
      // through the file's hunks so the view lands where the symbol was removed.
      if (side === 'base' && line) {
        const paths = [...new Set([oldPath || filePath, filePath])];
        const target = ctx.target === 'working' ? [] : [ctx.target];
        const diff = await git(root, ['diff', '-U0', '-M', ctx.base, ...target, '--', ...paths]).catch(() => '');
        opts = at(newLineFor(diff, line));
      }
      // Renames/copies: the base side lives at the old path.
      const left = gitUri(root, oldPath || filePath, ctx.base);
      const right = targetUri(root, filePath, ctx);
      return vscode.commands.executeCommand('vscode.diff', left, right, title, opts);
    })
  );
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
  parseNameStatus,
  buildTree,
  parseLog,
  compactDir,
  riskReasons,
  parseImports,
  resolveImport,
  buildEdges,
  extractSymbols,
  diffSymbols,
  buildSummaryMd,
  writeReviewFile,
  hunkOldRanges,
  newLineFor,
  lastRoundStatus,
  watchGitDirs,
  aggStatus,
  commentRangeFor,
  controllerWatchdog,
  CommitTreeProvider,
  graphRows,
};
