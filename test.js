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
  constructor(label, collapsibleState) {
    this.label = label;
    if (collapsibleState !== undefined) this.collapsibleState = collapsibleState;
  }
};
module.exports.TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };
module.exports.TreeItemCheckboxState = { Unchecked: 0, Checked: 1 };
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

  const mem = {};
  const provider = new CommitTreeProvider({ get: (k, d) => (k in mem ? mem[k] : d), update: async (k, v) => { mem[k] = v; } });
  let items = await provider.getCommits(repo);
  // c3, c2 are unpushed; "Load more…" hides the single history commit c1
  assert.deepStrictEqual(items.map(lbl), ['c3', 'c2', 'Show pushed history…']);
  // commit rows show only the author; stats live in the hover
  assert.strictEqual(items[0].description, 't');

  // Uncommitted work shows as a "Working tree" node above the commits:
  // tracked edits diff against HEAD, untracked files count as added.
  Object.defineProperty(provider, 'repoRoot', { value: repo });
  fs.writeFileSync(path.join(repo, 'f1'), '1 edited');
  fs.writeFileSync(path.join(repo, 'f9'), 'new');
  items = await provider.getCommits(repo);
  assert.deepStrictEqual(items.map(lbl), ['Working tree', 'c3', 'c2', 'Show pushed history…']);
  assert.strictEqual(items[0].contextValue, 'worktree');
  // its checkbox is the shared "include uncommitted changes" setting, on by default
  assert.strictEqual(items[0].checkboxState, 1);
  await provider.setIncludeLocal(false);
  assert.strictEqual((await provider.getCommits(repo))[0].checkboxState, 0);
  await provider.setIncludeLocal(true);
  const wt = await provider.getChildren(items[0]);
  assert.deepStrictEqual(wt.map(lbl), ['f1', 'f9']);
  assert.strictEqual(wt[0].command.arguments[1], 'M');
  assert.strictEqual(wt[1].command.arguments[1], 'A');
  assert.deepStrictEqual(wt[0].command.arguments[2], { base: 'HEAD', target: 'working', keyRef: 'working' });
  sh('git checkout -q -- f1 && rm f9');
  items = await provider.getCommits(repo);
  assert.strictEqual(lbl(items[0]), 'c3'); // clean tree: no node

  provider.loadMore();
  items = await provider.getCommits(repo);
  // history exhausted (1 < 50): no "show more", but a way back
  // hide sits on the boundary between local and pushed commits, not at the bottom
  assert.deepStrictEqual(items.map(lbl), ['c3', 'c2', 'Hide pushed history', 'c1']);

  provider.hideHistory();
  items = await provider.getCommits(repo);
  assert.deepStrictEqual(items.map(lbl), ['c3', 'c2', 'Show pushed history…']);

  // Review range: commit rows carry checkboxes; local commits are checked by default
  provider.loadMore();
  const row = async (l) => (await provider.getCommits(repo)).find((i) => lbl(i) === l);
  const checks = async () => Promise.all(['c3', 'c2', 'c1'].map(async (l) => (await row(l)).checkboxState));
  assert.deepStrictEqual(await checks(), [1, 1, 0]);
  // checking a pushed commit extends the range down to it (contiguous, option A)
  await provider.setCommitChecked((await row('c1')).sha, true);
  assert.deepStrictEqual(await checks(), [1, 1, 1]);
  assert.strictEqual((await provider.getReviewRange(repo)).base, CommitTreeProvider.EMPTY_TREE); // c1 is the root
  items = await provider.getCommits(repo);
  assert.deepStrictEqual([lbl(items[0]), items[0].command.command], ['Reset review range', 'commitFileTree.resetReviewRange']);
  provider.setMode('combined');
  assert.ok((await provider.getCombined(repo)).some((i) => i.label === 'f1'), 'combined must follow the checked range');
  // unchecking a commit narrows the range to the commits above it
  await provider.setCommitChecked((await row('c2')).sha, false);
  assert.deepStrictEqual(await checks(), [1, 0, 0]);
  // reset returns to "unpushed only", and the reset row goes away
  await provider.resetReviewRange();
  assert.deepStrictEqual(await checks(), [1, 1, 0]);
  assert.notStrictEqual(lbl((await provider.getCommits(repo))[0]), 'Reset review range');
  provider.hideHistory();
  provider.setMode('commits');

  // Combined mode: one tree for everything unpushed (f2.js, f3.js from c2/c3)
  provider.setMode('combined');
  items = await provider.getCombined(repo);
  assert.strictEqual(items[0].contextValue, 'includeLocal');
  assert.deepStrictEqual(items.slice(1).map((i) => i.label).sort(), ['f2.js', 'f3.js']);
  assert.strictEqual(items[1].command.command, 'commitFileTree.openDiff');

  // A working-copy comment is counted once, even when the view itself targets the working copy
  mem['cft.comments'] = { 'working:f2.js': [{ line: 1, text: 'once' }] };
  items = await provider.getCombined(repo);
  assert.strictEqual(items.find((i) => i.label === 'f2.js').description, '💬1');
  mem['cft.comments'] = {};

  // Folder rows take notes keyed by path + '/', shown as a 📝 marker
  sh('mkdir -p sub && echo y > sub/a.txt');
  items = await provider.getCombined(repo);
  const dir = items.find((i) => i.contextValue === 'dir');
  assert.strictEqual(dir.reviewId, `${dir.ctx.keyRef}:sub/`);
  mem['cft.notes'] = { [dir.reviewId]: 'too big' };
  items = await provider.getCombined(repo);
  assert.strictEqual(items.find((i) => i.contextValue === 'dir').description, '📝');
  mem['cft.notes'] = {};
  sh('rm -r sub');

  // Comments mode: "Current round" first; inside it one row per commented path
  mem['cft.comments'] = { 'working:f2.js': [{ line: 1, endLine: 2, text: 'fix this\nsecond line' }] };
  mem['cft.notes'] = { 'working:f3.js': 'whole file note' };
  const current = async () => provider.getChildren((await provider.getCommentsView(repo))[0]);
  items = await provider.getCommentsView(repo);
  assert.deepStrictEqual(items.map(lbl), ['Current round']);
  items = await current();
  assert.deepStrictEqual(items.map(lbl), ['f2.js', 'f3.js']);
  let kids = await provider.getChildren(items[0]);
  assert.deepStrictEqual([lbl(kids[0]), kids[0].description], ['fix this', 'L1-2']);
  assert.strictEqual(kids[0].command.command, 'vscode.open');
  kids = await provider.getChildren(items[1]);
  assert.deepStrictEqual([lbl(kids[0]), kids[0].description], ['whole file note', 'file note']);
  // Entries are editable and deletable in place
  kids = await provider.getChildren(items[0]);
  assert.strictEqual(kids[0].contextValue, 'commententry');
  await provider.updateEntry(kids[0], 'reworded');
  assert.deepStrictEqual(mem['cft.comments']['working:f2.js'], [{ line: 1, endLine: 2, text: 'reworded' }]);
  kids = await provider.getChildren((await current())[1]);
  await provider.updateEntry(kids[0], 'new note');
  assert.strictEqual(mem['cft.notes']['working:f3.js'], 'new note');
  await provider.deleteEntry(kids[0]);
  assert.strictEqual(mem['cft.notes']['working:f3.js'], undefined);
  kids = await provider.getChildren((await current())[0]);
  await provider.deleteEntry(kids[0]);
  assert.strictEqual(mem['cft.comments']['working:f2.js'], undefined);
  assert.deepStrictEqual((await current()).map(lbl), ['No comments yet']);

  // Exported rounds follow, newest first; only the latest gets ✅/⏳ status,
  // and a round with a recorded file opens it on click
  mem['cft.archive.rounds'] = [
    { at: 1, comments: { 'working:f2.js': [{ line: 1, text: 'old ask' }] }, notes: {} },
    { at: 2, comments: {}, notes: { 'working:f3.js': 'latest ask' }, file: '.commit-review/r2.md' },
  ];
  items = await provider.getCommentsView(repo);
  assert.deepStrictEqual(items.map((i) => lbl(i).split(' ·')[0]), ['Current round', 'Round 2', 'Round 1']);
  assert.ok(/✅1|⏳1/.test(items[1].description), 'latest round status missing');
  assert.strictEqual(items[1].command.command, 'vscode.open');
  assert.strictEqual(items[2].command, undefined); // older round without a file
  kids = await provider.getChildren(items[1]);
  assert.ok(['✅ f3.js', '⏳ f3.js'].includes(kids[0].description), 'latest round item mark missing');
  assert.strictEqual(lbl(kids[0]), 'latest ask');
  kids = await provider.getChildren(items[2]);
  assert.deepStrictEqual([lbl(kids[0]), kids[0].description], ['old ask', 'f2.js:1']);
  // Archiving a round tucks it into a collapsed "Archived rounds" group; unarchive brings it back
  await provider.setRoundArchived(items[2].roundIndex, true);
  items = await provider.getCommentsView(repo);
  assert.deepStrictEqual(items.map((i) => lbl(i).split(' ·')[0]), ['Current round', 'Round 2', 'Archived rounds (1)']);
  assert.strictEqual(items[2].collapsibleState, 1); // Collapsed: hidden until opened
  kids = await provider.getChildren(items[2]);
  assert.deepStrictEqual([lbl(kids[0]).split(' ·')[0], kids[0].contextValue], ['Round 1', 'roundarchived']);
  await provider.setRoundArchived(kids[0].roundIndex, false);
  items = await provider.getCommentsView(repo);
  assert.deepStrictEqual(items.map((i) => lbl(i).split(' ·')[0]), ['Current round', 'Round 2', 'Round 1']);
  mem['cft.archive.rounds'] = [];

  // The checkbox row decides whether uncommitted files join the combined tree
  sh('echo x > local.txt');
  items = await provider.getCombined(repo);
  assert.ok(items.some((i) => i.label === 'local.txt'), 'checked: uncommitted file missing');
  await provider.setIncludeLocal(false);
  items = await provider.getCombined(repo);
  assert.strictEqual(items[0].checkboxState, 0);
  assert.ok(!items.some((i) => i.label === 'local.txt'), 'unchecked: uncommitted file shown');
  await provider.setIncludeLocal(true);
  sh('rm local.txt');

  // Dependency mode: f3.js imports f2.js, so f2.js is the root and f3.js its child
  provider.setMode('deps');
  // Same "Include uncommitted changes" checkbox row as the combined view
  assert.strictEqual((await provider.getDeps(repo))[0].contextValue, 'includeLocal');
  // ...followed by a search row that opens the fuzzy file finder
  const search = (await provider.getDeps(repo))[1];
  assert.deepStrictEqual([search.contextValue, search.command.command], ['depsearch', 'commitFileTree.findInDeps']);
  const deps = async () =>
    (await provider.getDeps(repo)).filter((i) => !['includeLocal', 'depsearch'].includes(i.contextValue));
  sh('echo "require(\'./f2\')" > local.js');
  assert.ok((await deps()).length === 1 && (await provider.getChildren((await deps())[0])).some((i) => lbl(i) === 'local.js'),
    'checked: uncommitted importer missing');
  await provider.setIncludeLocal(false);
  assert.ok(!(await provider.getChildren((await deps())[0])).some((i) => lbl(i) === 'local.js'), 'unchecked: uncommitted file shown');
  await provider.setIncludeLocal(true);
  sh('rm local.js');
  items = await deps();
  assert.deepStrictEqual(items.map(lbl), ['f2.js']);
  assert.ok(items[0].description.startsWith('↑1'), 'dep root missing importer count');
  assert.strictEqual(items[0].contextValue, 'depfile');
  const children = await provider.getChildren(items[0]);
  assert.deepStrictEqual(children.map(lbl), ['f3.js']);
  assert.strictEqual(children[0].contextValue, 'file'); // leaf: no further importers

  // Renamed file has no import edges → grouped under "Standalone files",
  // and must diff against its old path at base
  sh('git mv f1 f1r && git commit -qm c4');
  items = await deps();
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
  items = await deps();
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
  items = await deps();
  assert.deepStrictEqual(items.map(lbl), ['f2.js', 'Standalone files (1)']);

  // No upstream but remote refs exist (e.g. an unpushed worktree branch):
  // "unpushed" must match the Graph — commits not on any remote — not
  // everything since main diverged.
  sh('git update-ref refs/remotes/origin/other HEAD~1');
  const ctx = await provider.getUnpushedRange(repo);
  assert.strictEqual(ctx.base, sh('git rev-parse HEAD~1').toString().trim());
  items = await provider.getCommits(repo);
  assert.deepStrictEqual(items.map(lbl), ['c5', 'Show pushed history…']);

  // HEAD fully reachable from a remote → everything is pushed
  sh('git update-ref refs/remotes/origin/other HEAD');
  items = await provider.getCommits(repo);
  assert.strictEqual(lbl(items[0]), 'No unpushed commits');

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
  '## 🎯 Action items (3)',
  '### 📝 src/a.ts',
  '### 💬 src/a.ts:42',
  '### 💬 src/a.ts:50-53',
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

// Comments outside the unpushed change set are exported, not dropped
const mdOutside = buildSummaryMd({
  rangeLabel: 'aaa..bbb',
  files: [],
  outside: [
    { path: 'src/config.ts', ref: 'working', line: 12, text: 'this file should change too', code: 'const RETRIES = 1;' },
    { path: 'src/old.ts', ref: 'c0ffee1234deadbeef', line: 3, endLine: 5, text: 'legacy concern', code: 'x' },
  ],
});
for (const expected of [
  '## 🌐 Comments outside this change',
  '### 💬 src/config.ts:12 (working copy)',
  'this file should change too',
  '### 💬 src/old.ts:3-5 (c0ffee1)',
]) {
  assert.ok(mdOutside.includes(expected), `outside section missing: ${expected}`);
}
// and the section is absent when there is nothing outside
assert.ok(!md.includes('Comments outside this change'));

// Archive-on-export: comments and notes move to the archive, active state resets
(async () => {
  const mem = {};
  const state = { get: (k, d) => (k in mem ? mem[k] : d), update: async (k, v) => { mem[k] = v; } };
  const p = new CommitTreeProvider(state);
  mem['cft.comments'] = { 'sha1:a.js': [{ line: 1, text: 'old' }] };
  mem['cft.notes'] = { 'sha1:a.js': 'note one' };
  let counts = await p.archiveReviewData('.commit-review/r1.md');
  assert.deepStrictEqual(counts, { comments: 1, notes: 1 });
  assert.strictEqual(mem['cft.archive.rounds'][0].file, '.commit-review/r1.md');
  assert.deepStrictEqual(mem['cft.comments'], {});
  assert.deepStrictEqual(mem['cft.notes'], {});
  assert.strictEqual(mem['cft.archive.rounds'].length, 1);
  // second round becomes its own archive entry
  mem['cft.comments'] = { 'sha1:a.js': [{ line: 9, text: 'new' }] };
  mem['cft.notes'] = { 'sha1:a.js': 'note two' };
  await p.archiveReviewData();
  assert.strictEqual(mem['cft.archive.rounds'].length, 2);
  // undo restores only the most recent round and merges into active state
  assert.strictEqual(await p.restoreLastRound(), true);
  assert.strictEqual(mem['cft.archive.rounds'].length, 1);
  assert.deepStrictEqual(mem['cft.comments']['sha1:a.js'], [{ line: 9, text: 'new' }]);
  assert.strictEqual(mem['cft.notes']['sha1:a.js'], 'note two');
  // restore again → round one; then nothing left to restore
  assert.strictEqual(await p.restoreLastRound(), true);
  assert.deepStrictEqual(mem['cft.comments']['sha1:a.js'].map((c) => c.text).sort(), ['new', 'old']);
  assert.strictEqual(mem['cft.notes']['sha1:a.js'], 'note two\n---\nnote one');
  assert.strictEqual(await p.restoreLastRound(), false);
  // clear wipes everything including archives
  await p.clearReviewData();
  assert.strictEqual(mem['cft.archive.rounds'], undefined);
})();

// Outside section renders file notes (no line number) with their source
const mdNoteOutside = buildSummaryMd({
  rangeLabel: 'x..y',
  files: [],
  outside: [{ path: 'src/config.ts', ref: 'working', text: 'update this config too' }],
});
assert.ok(mdNoteOutside.includes('### 📝 src/config.ts (working copy · file note)'), 'note-outside heading missing');
assert.ok(mdNoteOutside.includes('update this config too'));

// Folder notes render as action items with a trailing-slash heading
const mdFolder = buildSummaryMd({ rangeLabel: 'x..y', files: [], folders: [{ path: 'src/api/', text: 'split this module' }] });
assert.ok(mdFolder.includes('## 🎯 Action items (1)'), 'folder note must be an action item');
assert.ok(mdFolder.includes('### 📁 src/api/ (folder)\n\nsplit this module'), 'folder note heading missing');


// Controller watchdog: Cursor's idle ext-host restart silently drops our
// comment controller on the main thread. A poke that is never answered by a
// provideCommentingRanges call means the controller is gone → recreate once.
const { controllerWatchdog } = require('./extension.js');
(async () => {
  const tick = (ms) => new Promise((r) => setTimeout(r, ms));
  let recreated = 0;
  const wd = controllerWatchdog(() => recreated++, { timeoutMs: 20, cooldownMs: 1000 });
  // healthy: poke answered → no recreate
  wd.poked();
  wd.provided();
  await tick(40);
  assert.strictEqual(recreated, 0, 'answered poke must not recreate');
  // dead: poke unanswered → recreate
  wd.poked();
  await tick(40);
  assert.strictEqual(recreated, 1, 'unanswered poke must recreate');
  // still dead within cooldown → do not thrash
  wd.poked();
  await tick(40);
  assert.strictEqual(recreated, 1, 'cooldown must suppress a second recreate');
})();

// Export to file: writes the summary at a repo-relative path (creating dirs)
// and hides it from git via .git/info/exclude, so it never shows up as an
// untracked change in git status or in the Working tree node.
const { writeReviewFile } = require('./extension.js');
(async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cft-export-'));
  const sh = (cmd) => cp.execSync(cmd, { cwd: repo, stdio: 'pipe' }).toString();
  sh('git init -q -b main');
  const abs = await writeReviewFile(repo, '.commit-review/latest.md', '# hi\n');
  assert.strictEqual(abs, path.join(repo, '.commit-review/latest.md'));
  assert.strictEqual(fs.readFileSync(abs, 'utf8'), '# hi\n');
  assert.strictEqual(sh('git status --porcelain').trim(), '', 'export file must be git-excluded');
  // second write: overwrite, and do not duplicate the exclude line
  await writeReviewFile(repo, '.commit-review/latest.md', '# again\n');
  const exclude = fs.readFileSync(path.join(repo, '.git/info/exclude'), 'utf8');
  assert.strictEqual(exclude.split('\n').filter((l) => l === '/.commit-review/latest.md').length, 1);
  fs.rmSync(repo, { recursive: true, force: true });
})();

// Auto-refresh must fire on remote-tracking ref updates (a push), including
// from a linked worktree whose remote refs live in the common git dir.
const { watchGitDirs } = require('./extension.js');
(async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cft-watch-'));
  const sh = (cmd, cwd = repo) => cp.execSync(cmd, { cwd, stdio: 'pipe' }).toString().trim();
  sh('git init -q -b main && git config user.email t@t && git config user.name t');
  fs.writeFileSync(path.join(repo, 'f'), '1');
  sh('git add . && git commit -qm c1');
  const wt = path.join(repo, 'wt');
  sh(`git worktree add -q ${wt} -b side`);
  const fired = (root, action) =>
    new Promise(async (resolve) => {
      const timer = setTimeout(() => resolve(false), 1500);
      const w = await watchGitDirs(root, () => {
        clearTimeout(timer);
        w.close();
        resolve(true);
      });
      await new Promise((r) => setTimeout(r, 100)); // let the watcher attach
      action();
    });
  assert.ok(await fired(repo, () => sh('git update-ref refs/remotes/origin/main HEAD')), 'push (remote ref) in main checkout');
  assert.ok(await fired(wt, () => sh('git update-ref refs/remotes/origin/side HEAD', wt)), 'push (remote ref) from a worktree');
  fs.rmSync(repo, { recursive: true, force: true });
})();

// Round tracking: an archived comment is "addressed" when the commented span
// changed between its commit and HEAD (any hunk's old-side range overlaps it);
// a file note is addressed when the file changed at all; working-copy comments
// have no stable base → unknown (null).
const { hunkOldRanges, lastRoundStatus } = require('./extension.js');
assert.deepStrictEqual(hunkOldRanges('@@ -3,2 +3,4 @@\n-x\n+y\n@@ -10 +12 @@\n-a\n+b\n@@ -20,0 +23,2 @@\n+n\n'), [
  [3, 4],
  [10, 10],
  [20, 21],
]);
(async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cft-round-'));
  const sh = (cmd) => cp.execSync(cmd, { cwd: repo, stdio: 'pipe' }).toString().trim();
  sh('git init -q -b main && git config user.email t@t && git config user.name t');
  fs.writeFileSync(path.join(repo, 'a.js'), 'l1\nl2\nl3\nl4\nl5\n');
  fs.writeFileSync(path.join(repo, 'b.js'), 'same\n');
  fs.writeFileSync(path.join(repo, 'c.js'), 'untouched\n');
  sh('git add . && git commit -qm c1');
  const c1 = sh('git rev-parse HEAD');
  // agent's "fix": rewrite line 2 of a.js, touch b.js
  fs.writeFileSync(path.join(repo, 'a.js'), 'l1\nL2 fixed\nl3\nl4\nl5\n');
  fs.writeFileSync(path.join(repo, 'b.js'), 'changed\n');
  sh('git add . && git commit -qm c2');
  // uncommitted fix counts too: d.js edited in the working copy only
  fs.writeFileSync(path.join(repo, 'd.js'), 'old\n');
  sh('git add d.js && git commit -qm c3');
  const c3 = sh('git rev-parse HEAD');
  fs.writeFileSync(path.join(repo, 'd.js'), 'new\n');
  // working-copy items: changed = file modified after the export time
  const at = Date.now();
  fs.utimesSync(path.join(repo, 'b.js'), at / 1000 + 100, at / 1000 + 100);
  fs.utimesSync(path.join(repo, 'c.js'), at / 1000 - 100, at / 1000 - 100);
  const round = {
    at,
    comments: {
      [`${c1}:a.js`]: [
        { line: 2, text: 'rename this' },
        { line: 4, endLine: 5, text: 'still wrong' },
      ],
      [`${c3}:d.js`]: [{ line: 1, text: 'fix uncommitted' }],
      'working:c.js': [{ line: 1, text: 'working, untouched' }],
    },
    notes: { [`${c1}:b.js`]: 'rewrite file', [`${c1}:c.js`]: 'delete file', 'working:b.js': 'working, touched' },
  };
  const status = await lastRoundStatus(repo, round);
  assert.deepStrictEqual(
    status.map((s) => [s.path, s.line, s.addressed]),
    [
      ['a.js', 2, true],
      ['a.js', 4, false],
      ['d.js', 1, true],
      ['c.js', 1, false],
      ['b.js', undefined, true],
      ['c.js', undefined, false],
      ['b.js', undefined, true],
    ]
  );
  // The export renders the previous round as a checklist above the new action items.
  const mdPrev = buildSummaryMd({ rangeLabel: 'r', files: [], previous: status });
  assert.ok(mdPrev.includes('## 🔁 Previous round') && !mdPrev.includes('No notes'));
  assert.ok(mdPrev.includes('- [x] ✅ a.js:2 — rename this'));
  assert.ok(mdPrev.includes('- [ ] ⏳ a.js:4-5 — still wrong'));
  assert.ok(!mdPrev.includes('[?]'), 'no third state any more');
  assert.ok(mdPrev.includes('- [x] ✅ b.js — rewrite file'));
  fs.rmSync(repo, { recursive: true, force: true });
})();
