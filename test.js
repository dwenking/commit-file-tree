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
  { status: 'R', path: 'new.js' },
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
  for (const n of [1, 2, 3]) {
    fs.writeFileSync(path.join(repo, `f${n}`), String(n));
    sh(`git add . && git commit -qm c${n}`);
  }
  sh('git branch up HEAD~2 && git branch --set-upstream-to=up');

  const provider = new CommitTreeProvider();
  let items = await provider.getCommits(repo);
  // c3, c2 are unpushed; "Load more…" hides the single history commit c1
  assert.deepStrictEqual(items.map((i) => i.label), ['c3', 'c2', 'Show pushed history…']);

  provider.loadMore();
  items = await provider.getCommits(repo);
  // history exhausted (1 < 50): no "show more", but a way back
  assert.deepStrictEqual(items.map((i) => i.label), ['c3', 'c2', 'c1', 'Hide pushed history']);

  provider.hideHistory();
  items = await provider.getCommits(repo);
  assert.deepStrictEqual(items.map((i) => i.label), ['c3', 'c2', 'Show pushed history…']);

  // Combined mode: one tree for everything unpushed (f2, f3 from c2/c3)
  Object.defineProperty(provider, 'repoRoot', { value: repo });
  provider.setMode('combined');
  items = await provider.getCombined(repo);
  assert.deepStrictEqual(items.map((i) => i.label).sort(), ['f2', 'f3']);
  assert.strictEqual(items[0].command.command, 'commitFileTree.openDiff');

  fs.rmSync(repo, { recursive: true, force: true });
  console.log('ok');
})();

// Risk flags: deletions and sensitive paths, nothing for ordinary files
const { riskReasons } = require('./extension.js');
assert.deepStrictEqual(riskReasons({ status: 'D', path: 'src/a.js' }), ['deleted']);
assert.deepStrictEqual(riskReasons({ status: 'M', path: 'package-lock.json' }), ['lockfile']);
assert.deepStrictEqual(riskReasons({ status: 'M', path: '.github/workflows/ci.yml' }), ['CI config']);
assert.deepStrictEqual(riskReasons({ status: 'M', path: 'src/app.js' }), []);
