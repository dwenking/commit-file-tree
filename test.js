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
module.exports.TreeItemCollapsibleState = {};
module.exports.ThemeIcon = class {};
module.exports.ThemeIcon.Folder = {};
module.exports.workspace = { workspaceFolders: undefined };
module.exports.commands = { executeCommand: () => {} };
module.exports.ThemeColor = class {};
module.exports.MarkdownString = class {
  appendMarkdown() {}
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
  // diff stats live in the dimmed description
  assert.ok(items[0].description.startsWith('+1 −0'), 'commit description missing stats');

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

  fs.rmSync(repo, { recursive: true, force: true });
  console.log('ok');
})();

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
      comments: [{ line: 42, text: 'do not hardcode this', code: 'const t = 5000;' }],
    },
    { path: 'package-lock.json', status: 'M', risks: ['lockfile'], reviewed: false, comments: [] },
  ],
});
for (const expected of [
  '# Code review feedback (aaa..bbb)',
  '### src/a.ts:42',
  'const t = 5000;',
  'do not hardcode this',
  'looks fine overall',
]) {
  assert.ok(md.includes(expected), `summary missing: ${expected}`);
}
