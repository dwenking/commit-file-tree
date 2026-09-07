// Minimal self-check: node test.js
// Stub the 'vscode' module so extension.js can be required outside the editor.
const Module = require('module');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'vscode') return __filename;
  return origResolve.call(this, request, ...args);
};
module.exports.Uri = { file: () => ({ with: () => ({}) }) };
module.exports.EventEmitter = class {
  fire() {}
};
module.exports.TreeItem = class {
  constructor(label) {
    this.label = label;
  }
};
module.exports.TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };
module.exports.ThemeIcon = class {};
module.exports.ThemeIcon.Folder = {};
module.exports.workspace = { workspaceFolders: undefined };
module.exports.commands = { executeCommand: () => {} };
module.exports.ThemeColor = class {};
module.exports.MarkdownString = class {
  appendMarkdown() {}
};
module.exports.Range = class {
  constructor(sl, sc, el, ec) {
    this.start = { line: sl, character: sc };
    this.end = { line: el, character: ec };
  }
};

const assert = require('assert');
const { parseNameStatus, buildTree, parseLog, compactDir } = require('./extension.js');

const files = parseNameStatus('M\tsrc/a/one.js\nA\tsrc/two.js\nR100\told.js\tnew.js\nD\tREADME.md\n');
assert.deepStrictEqual(files, [
  { status: 'M', path: 'src/a/one.js' },
  { status: 'A', path: 'src/two.js' },
  { status: 'R', path: 'new.js', oldPath: 'old.js' },
  { status: 'D', path: 'README.md' },
]);

const tree = buildTree(files);
assert.deepStrictEqual([...tree.dirs.keys()], ['src']);
assert.deepStrictEqual(tree.files.map((f) => f.name).sort(), ['README.md', 'new.js']);
assert.deepStrictEqual([...tree.dirs.get('src').dirs.keys()], ['a']);
assert.strictEqual(tree.dirs.get('src').dirs.get('a').files[0].path, 'src/a/one.js');

// parseLog: header + shortstat pairs, including a stat-less (empty) commit
const sha1 = 'a'.repeat(40);
const sha2 = 'b'.repeat(40);
const log = parseLog(
  `${sha1}\ta1\tAlice\t2 days ago\tfix: bug\n\n 3 files changed, 10 insertions(+), 2 deletions(-)\n${sha2}\tb2\tBob\t3 days ago\tempty commit\n`
);
assert.deepStrictEqual(log, [
  { sha: sha1, short: 'a1', author: 'Alice', when: '2 days ago', subject: 'fix: bug', files: 3, ins: 10, del: 2 },
  { sha: sha2, short: 'b2', author: 'Bob', when: '3 days ago', subject: 'empty commit', files: 0, ins: 0, del: 0 },
]);

// compactDir: a/b/c collapses into one label; stops at a dir with files
const deep = buildTree([{ status: 'M', path: 'a/b/c/one.js' }]);
const compacted = compactDir('a', deep.dirs.get('a'));
assert.strictEqual(compacted.name, 'a/b/c');
assert.strictEqual(compacted.node.files[0].name, 'one.js');
const mixed = buildTree([
  { status: 'M', path: 'a/one.js' },
  { status: 'M', path: 'a/b/two.js' },
]);
assert.strictEqual(compactDir('a', mixed.dirs.get('a')).name, 'a');

// Local-vs-history split: unpushed commits show by default, history behind Load more.
const { CommitTreeProvider } = require('./extension.js');
const os = require('os');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

(async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cft-'));
  const sh = (cmd) => cp.execSync(cmd, { cwd: repo, stdio: 'pipe' });
  sh('git init -q -b main && git config user.email t@t && git config user.name t');
  fs.writeFileSync(path.join(repo, 'f1'), '1');
  sh('git add . && git commit -qm c1');
  fs.writeFileSync(path.join(repo, 'f2.js'), 'exports.x = 1;');
  sh('git add . && git commit -qm c2');
  fs.writeFileSync(path.join(repo, 'f3.js'), "const { x } = require('./f2');");
  sh('git add . && git commit -qm c3');
  sh('git branch up HEAD~2 && git branch --set-upstream-to=up');

  // Labels may be TreeItemLabel objects with a highlighted trailing tag.
  const lbl = (i) => (typeof i.label === 'string' ? i.label : i.label.label).split('  ')[0];

  const provider = new CommitTreeProvider();
  let items = await provider.getCommits(repo);
  // c3, c2 are unpushed; "Load more…" hides the single history commit c1
  assert.deepStrictEqual(items.map(lbl), ['c3', 'c2', 'Show pushed history…']);
  // commit rows show only the author; stats live in the hover
  assert.strictEqual(items[0].description, 't');

  provider.loadMore();
  items = await provider.getCommits(repo);
  // history exhausted (1 < 50): no "show more", but a way back
  assert.deepStrictEqual(items.map(lbl), ['c3', 'c2', 'c1', 'Hide pushed history']);

  provider.hideHistory();
  items = await provider.getCommits(repo);
  assert.deepStrictEqual(items.map(lbl), ['c3', 'c2', 'Show pushed history…']);

  // Combined mode: one tree for everything unpushed (f2.js, f3.js from c2/c3)
  Object.defineProperty(provider, 'repoRoot', { value: repo });
  provider.setMode('combined');
  items = await provider.getCombined(repo);
  assert.deepStrictEqual(items.map((i) => i.label).sort(), ['f2.js', 'f3.js']);
  assert.strictEqual(items[0].command.command, 'commitFileTree.openDiff');

  // Dependency mode: f3.js imports f2.js, so f2.js is the root and f3.js its child
  provider.setMode('deps');
  items = await provider.getDeps(repo);
  assert.deepStrictEqual(items.map(lbl), ['f2.js']);
  assert.ok(items[0].description.startsWith('↑1'), 'dep root missing importer count');
  assert.strictEqual(items[0].contextValue, 'depfile');
  const children = await provider.getChildren(items[0]);
  assert.deepStrictEqual(children.map(lbl), ['f3.js']);
  assert.strictEqual(children[0].contextValue, 'file'); // leaf: no further importers

  // Renamed file has no import edges → grouped under "Standalone files",
  // and must diff against its old path at base
  sh('git mv f1 f1r && git commit -qm c4');
  items = await provider.getDeps(repo);
  assert.deepStrictEqual(items.map(lbl), ['f2.js', 'Standalone files (1)']);
  const standalone = await provider.getChildren(items[1]);
  const renamed = standalone.find((i) => lbl(i) === 'f1r');
  assert.strictEqual(renamed.command.arguments[1], 'R');
  assert.strictEqual(renamed.command.arguments[3], 'f1');

  // Reveal chain: connected file resolves root→target; standalone flags its group
  assert.deepStrictEqual(provider.depChainFor('f3.js'), { chain: ['f2.js', 'f3.js'], inGroup: false });
  assert.deepStrictEqual(provider.depChainFor('f1r'), { chain: ['f1r'], inGroup: true });

  // Expansion policy: roots start collapsed, but opened chains expand fully
  fs.writeFileSync(path.join(repo, 'f4.js'), "require('./f3');");
  sh('git add . && git commit -qm c5');
  items = await provider.getDeps(repo);
  const rootItem = items.find((i) => lbl(i) === 'f2.js');
  assert.strictEqual(rootItem.collapsibleState, 1); // Collapsed
  const mid = (await provider.getChildren(rootItem)).find((i) => lbl(i) === 'f3.js');
  assert.strictEqual(mid.collapsibleState, 2); // Expanded (has child f4.js)
  assert.deepStrictEqual(provider.depChainFor('f4.js').chain, ['f2.js', 'f3.js', 'f4.js']);

  // Local-only repo (no upstream): combined view falls back to the empty tree
  // and shows the whole history's net result instead of "No upstream branch"
  sh('git branch --unset-upstream');
  items = await provider.getCombined(repo);
  const names = items.map(lbl).sort();
  assert.ok(names.includes('f2.js') && names.includes('f4.js'), `unexpected: ${names}`);
  // Dependency view under the same fallback still splits chains from standalone files
  items = await provider.getDeps(repo);
  assert.deepStrictEqual(items.map(lbl), ['f2.js', 'Standalone files (1)']);

  fs.rmSync(repo, { recursive: true, force: true });
  console.log('ok');
})();

// Folder aggregate status: all-deleted → D, all-added → A, mixed → undefined
const { aggStatus } = require('./extension.js');
const delTree = buildTree([
  { status: 'D', path: 'gone/a.js' },
  { status: 'D', path: 'gone/sub/b.js' },
]);
assert.strictEqual(aggStatus(delTree.dirs.get('gone')), 'D');
const mixedTree = buildTree([
  { status: 'D', path: 'x/a.js' },
  { status: 'M', path: 'x/b.js' },
]);
assert.strictEqual(aggStatus(mixedTree.dirs.get('x')), undefined);
assert.strictEqual(aggStatus(buildTree([{ status: 'A', path: 'new/a.js' }]).dirs.get('new')), 'A');

// Risk flags: deletions and sensitive paths, nothing for ordinary files
const { riskReasons } = require('./extension.js');
assert.deepStrictEqual(riskReasons({ status: 'D', path: 'src/a.js' }), ['deleted']);
assert.deepStrictEqual(riskReasons({ status: 'M', path: 'package-lock.json' }), ['lockfile']);
assert.deepStrictEqual(riskReasons({ status: 'M', path: '.github/workflows/ci.yml' }), ['CI config']);
assert.deepStrictEqual(riskReasons({ status: 'M', path: 'src/app.js' }), []);

// Import parsing and dependency-first review order
const { parseImports, resolveImport, buildEdges, buildSummaryMd } = require('./extension.js');
assert.deepStrictEqual(
  parseImports('src/a.ts', `import x from './b';\nconst y = require('../c');\nexport { z } from './d';`),
  ['./b', '../c', './d']
);
assert.deepStrictEqual(parseImports('app/m.py', 'import app.util\nfrom .helpers import x\n'), [
  'app.util',
  '.helpers',
]);
assert.strictEqual(resolveImport('src/a.ts', './b', new Set(['src/b.ts'])), 'src/b.ts');
assert.strictEqual(resolveImport('src/a.ts', './lib', new Set(['src/lib/index.js'])), 'src/lib/index.js');
assert.strictEqual(resolveImport('app/m.py', 'app.util', new Set(['app/util.py'])), 'app/util.py');
assert.strictEqual(resolveImport('src/a.ts', 'react', new Set(['src/b.ts'])), undefined);

// Java/Kotlin: fully-qualified imports resolve by package-path suffix
const javaSet = new Set([
  'backend/mod-b/src/main/java/com/x/util/B.java',
  'backend/mod-c/src/main/java/com/x/pkg/C.kt',
]);
assert.deepStrictEqual(
  parseImports('A.java', 'package com.x;\nimport com.x.util.B;\nimport static com.x.pkg.C.helper;\nimport com.x.pkg.*;\n'),
  ['com.x.util.B', 'com.x.pkg.C.helper', 'com.x.pkg.*']
);
assert.strictEqual(resolveImport('backend/mod-a/src/main/java/com/x/A.java', 'com.x.util.B', javaSet), 'backend/mod-b/src/main/java/com/x/util/B.java');
assert.strictEqual(resolveImport('backend/mod-a/src/main/java/com/x/A.java', 'com.x.pkg.C.helper', javaSet), 'backend/mod-c/src/main/java/com/x/pkg/C.kt');
assert.strictEqual(resolveImport('backend/mod-a/src/main/java/com/x/A.java', 'com.x.pkg.*', javaSet), 'backend/mod-c/src/main/java/com/x/pkg/C.kt');
assert.strictEqual(resolveImport('backend/mod-a/src/main/java/com/x/A.java', 'java.util.List', javaSet), undefined);

// Vue SFCs parse with JS rules and resolve as import targets
assert.deepStrictEqual(parseImports('src/App.vue', `<script>import C from './C.vue';</script>`), ['./C.vue']);
assert.strictEqual(resolveImport('src/App.vue', './C.vue', new Set(['src/C.vue'])), 'src/C.vue');
assert.strictEqual(resolveImport('src/App.vue', './pages/Home', new Set(['src/pages/Home.vue'])), 'src/pages/Home.vue');

// Go: single and block imports; package path resolves to a directory
assert.deepStrictEqual(
  parseImports('svc/main.go', 'import "corp/mod/util"\nimport (\n\tfoo "corp/mod/db"\n\t"fmt"\n)\n'),
  ['corp/mod/util', 'corp/mod/db', 'fmt']
);
assert.strictEqual(resolveImport('svc/main.go', 'corp/mod/util', new Set(['mod/util/strings.go'])), 'mod/util/strings.go');

// Rust: use crate paths (trailing items dropped) and mod declarations
assert.deepStrictEqual(parseImports('src/main.rs', 'use crate::db::pool::Pool;\nmod handlers;\n'), [
  'crate::db::pool::Pool',
  'handlers',
]);
assert.strictEqual(resolveImport('src/main.rs', 'crate::db::pool::Pool', new Set(['src/db/pool.rs'])), 'src/db/pool.rs');
assert.strictEqual(resolveImport('src/main.rs', 'handlers', new Set(['src/handlers/mod.rs'])), 'src/handlers/mod.rs');

// C/C++: quoted and angled includes, relative or by path suffix
assert.deepStrictEqual(parseImports('a/b.cpp', '#include "util/log.h"\n#include <vector>\n'), ['util/log.h', 'vector']);
assert.strictEqual(resolveImport('src/a/b.cpp', 'util/log.h', new Set(['src/util/log.h'])), 'src/util/log.h');
assert.strictEqual(resolveImport('src/a/b.cpp', '../common.h', new Set(['src/common.h'])), 'src/common.h');

// C#: using namespace → directory or file path suffix
assert.deepStrictEqual(parseImports('A.cs', 'using Corp.App.Models;\nusing (var x = y) {}\n'), ['Corp.App.Models']);
assert.strictEqual(
  resolveImport('src/Corp.App/Api/A.cs', 'Corp.App.Models', new Set(['src/Corp.App/Models/User.cs'])),
  'src/Corp.App/Models/User.cs'
);

// Ruby: require_relative and require by suffix
assert.deepStrictEqual(parseImports('app/a.rb', "require 'app/helpers/text'\nrequire_relative 'b'\n"), [
  'app/helpers/text',
  'b',
]);
assert.strictEqual(resolveImport('app/a.rb', 'b', new Set(['app/b.rb'])), 'app/b.rb');
assert.strictEqual(resolveImport('lib/x.rb', 'app/helpers/text', new Set(['app/helpers/text.rb'])), 'app/helpers/text.rb');

// PHP: PSR-4 use statements drop the vendor namespace prefix
assert.deepStrictEqual(parseImports('src/A.php', 'use App\\Service\\Mailer;\n'), ['App\\Service\\Mailer']);
assert.strictEqual(
  resolveImport('src/Controller/A.php', 'App\\Service\\Mailer', new Set(['src/Service/Mailer.php'])),
  'src/Service/Mailer.php'
);

const sources = new Map([
  ['src/a.ts', `import b from './b';`],
  ['src/b.ts', `export const b = 1;`],
]);
assert.deepStrictEqual(buildEdges(sources), [{ from: 'src/a.ts', to: 'src/b.ts' }]);

// Summary export: action items with quoted code, plus the full file list
const md = buildSummaryMd({
  rangeLabel: 'aaa..bbb',
  files: [
    {
      path: 'src/a.ts',
      status: 'M',
      risks: [],
      reviewed: true,
      note: 'looks fine overall',
      comments: [
        { line: 42, text: 'do not hardcode this', code: 'const t = 5000;' },
        { line: 50, endLine: 53, text: 'extract this block', code: 'a\nb' },
      ],
    },
    { path: 'package-lock.json', status: 'M', risks: ['lockfile'], reviewed: false, comments: [] },
  ],
});
for (const expected of [
  '# Code review feedback (aaa..bbb)',
  '### src/a.ts:42',
  '### src/a.ts:50-53',
  'extract this block',
  'const t = 5000;',
  'do not hardcode this',
  'looks fine overall',
]) {
  assert.ok(md.includes(expected), `summary missing: ${expected}`);
}

// Comment "+" placement: focus-independent, tied to the visible editor's cursor.
// Regression for 0.3.13: ranges must not depend on which editor is *active*,
// only on which visible editor shows the document.
const { commentRangeFor } = require('./extension.js');
const docUri = { scheme: 'file', fsPath: '/repo/src/a.js', toString: () => 'file:///repo/src/a.js' };
const editorShowingDoc = { document: { uri: docUri }, selection: { active: { line: 41 } } };
const otherEditor = {
  document: { uri: { scheme: 'file', fsPath: '/repo/b.js', toString: () => 'file:///repo/b.js' } },
  selection: { active: { line: 0 } },
};
// doc visible (even though another editor might hold focus) → one zero-width range on line 41
let ranges = commentRangeFor(docUri, [otherEditor, editorShowingDoc], '/repo');
assert.strictEqual(ranges.length, 1);
assert.deepStrictEqual([ranges[0].start.line, ranges[0].end.line], [41, 41]);
// multi-line selection → the whole span is commentable
const multiSel = { document: { uri: docUri }, selection: { start: { line: 3 }, end: { line: 7 }, active: { line: 7 } } };
ranges = commentRangeFor(docUri, [multiSel], '/repo');
assert.deepStrictEqual([ranges[0].start.line, ranges[0].end.line], [3, 7]);
// document not visible in any editor → no ranges
assert.deepStrictEqual(commentRangeFor(docUri, [otherEditor], '/repo'), []);
// file outside the repo → no ranges
const outside = { scheme: 'file', fsPath: '/elsewhere/x.js', toString: () => 'file:///elsewhere/x.js' };
assert.deepStrictEqual(commentRangeFor(outside, [{ document: { uri: outside }, selection: { active: { line: 1 } } }], '/repo'), []);
