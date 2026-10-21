// Minimal self-check: node test.js
// Stub the 'vscode' module so extension.js can be required outside the editor.
const Module = require('module');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'vscode') return __filename;
  return origResolve.call(this, request, ...args);
};
module.exports.Uri = { file: () => ({ with: (o) => ({ ...o }) }) };
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
module.exports.ThemeIcon = class {
  constructor(id, color) {
    this.id = id;
    this.color = color;
  }
};
module.exports.ThemeIcon.Folder = new module.exports.ThemeIcon('folder');
module.exports.workspace = { workspaceFolders: undefined };
module.exports.commands = { executeCommand: () => {} };
module.exports.ThemeColor = class {
  constructor(id) {
    this.id = id;
  }
};
module.exports.MarkdownString = class {
  value = '';
  appendMarkdown(s) {
    this.value += s;
  }
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

// parseLog: header + shortstat pairs, including a stat-less (empty) commit.
// Branch refs (%D, --decorate=full) become Graph badges, local or remote;
// HEAD, origin/HEAD and tags are dropped.
const sha1 = 'a'.repeat(40);
const sha2 = 'b'.repeat(40);
const decor = 'HEAD -> refs/heads/main, refs/remotes/origin/main, refs/remotes/origin/HEAD, tag: refs/tags/v1';
const log = parseLog(
  `${sha1}\ta1\tAlice\t2 days ago\t${decor}\tfix: bug\n\n 3 files changed, 10 insertions(+), 2 deletions(-)\n${sha2}\tb2\tBob\t3 days ago\t\tempty commit\n`
);
assert.deepStrictEqual(log, [
  { sha: sha1, short: 'a1', author: 'Alice', when: '2 days ago', refs: [{ name: 'main', remote: false }, { name: 'origin/main', remote: true }], subject: 'fix: bug', files: 3, ins: 10, del: 2 },
  { sha: sha2, short: 'b2', author: 'Bob', when: '3 days ago', refs: [], subject: 'empty commit', files: 0, ins: 0, del: 0 },
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
const { CommitTreeProvider, graphRows } = require('./extension.js');
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
  // Commit graph webview rows: Graph lanes (unpushed local, pushed remote), ref badges
  // kept apart from the subject, checkboxes, and the right-click context for menus.
  const byId = new Map();
  const rows = await graphRows(provider, items, '', byId);
  assert.deepStrictEqual(rows.map((r) => [r.label, r.lane, r.checked]), [
    ['c3', 'local', true], ['c2', 'local', true], ['Hide pushed history', undefined, undefined], ['c1', 'remote', false],
  ]);
  assert.deepStrictEqual(rows[0].refs, [{ name: 'main', remote: false }]);
  assert.deepStrictEqual(rows[0].ctx, { sha: items[0].sha, subject: 'c3' });
  assert.ok(rows[0].branch && !rows[0].children, 'commit files load lazily');
  assert.ok(rows[2].run && byId.get(rows[2].id) === items[2], 'command rows resolve back to their TreeItem');
  // a commit's files carry the status badge and color the native tree gets from decorations
  const files = await graphRows(provider, await provider.getChildren(items[0]), rows[0].id, byId);
  assert.deepStrictEqual(files.map((r) => [r.label, r.deco]), [['f3.js', { badge: 'A', color: 'gitDecoration.addedResourceForeground' }]]);
  assert.deepStrictEqual(files[0].ctx, { filePath: 'f3.js' });
  // Hover card (like the Graph's): the row's commit plus email, exact date and full message
  const card = await provider.commitCard(repo, byId.get(rows[0].id).commit);
  assert.deepStrictEqual([card.subject, card.author, card.email, card.message, card.files, card.ins], ['c3', 't', 't@t', 'c3', 1, 1]);
  assert.match(card.date, /^\d{4}-\d\d-\d\dT/);
  // Same-label rows (two comments with the same first line) still get distinct ids.
  const twins = await graphRows(provider, [new module.exports.TreeItem('same'), new module.exports.TreeItem('same')], '', new Map());
  assert.notStrictEqual(twins[0].id, twins[1].id);
  // The webview is disposed when the view is hidden; a badge update in flight must not throw.
  provider.graphView = {};
  const pending = provider.updateBadge(repo);
  provider.graphView = undefined;
  await pending;

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
  // no checkbox row: the Working tree checkbox in the commits view is the only control;
  // the expand/collapse-declarations buttons are drawn by the webview above the tree
  assert.deepStrictEqual(items.map((i) => i.label).sort(), ['f2.js', 'f3.js']);
  assert.strictEqual(items[0].command.command, 'commitFileTree.openDiff');

  // A working-copy comment is counted once, even when the view itself targets the working copy
  mem['cft.comments'] = { 'working:f2.js': [{ line: 1, text: 'once' }] };
  items = await provider.getCombined(repo);
  assert.strictEqual(items.find((i) => i.label === 'f2.js').description, '💬1');
  mem['cft.comments'] = {};

  // Folder rows take notes keyed by path + '/', shown as a 📝 marker
  sh('mkdir -p sub && echo y > sub/a.txt');
  items = await provider.getCombined(repo);
  const dir = items.find((i) => i.contextValue === 'dir');
  // Folders and files stay open by default; only the declaration lists under files start folded.
  assert.strictEqual(dir.collapsibleState, 2);
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

  // The include-uncommitted setting (Working tree checkbox) decides whether uncommitted files join
  sh('echo x > local.txt');
  items = await provider.getCombined(repo);
  assert.ok(items.some((i) => i.label === 'local.txt'), 'checked: uncommitted file missing');
  await provider.setIncludeLocal(false);
  items = await provider.getCombined(repo);
  assert.ok(!items.some((i) => i.label === 'local.txt'), 'unchecked: uncommitted file shown');
  await provider.setIncludeLocal(true);
  sh('rm local.txt');

  // Dependency mode: f3.js imports f2.js, so f2.js is the root and f3.js its child
  provider.setMode('deps');
  // First row: search, which opens the fuzzy file finder
  const search = (await provider.getDeps(repo))[0];
  assert.deepStrictEqual([search.contextValue, search.command.command], ['depsearch', 'commitFileTree.findInDeps']);
  const deps = async () =>
    (await provider.getDeps(repo)).filter((i) => i.contextValue !== 'depsearch');
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
  // One webview shows every mode: dependency rows keep their TreeItem ids (Reveal in
  // Dependency View opens them by id), and expanded rows arrive with their children.
  const depRows = await graphRows(provider, await provider.getChildren(rootItem), 'cft:dep:f2.js', new Map());
  assert.deepStrictEqual(depRows.map((r) => [r.id, r.children && r.children.map((c) => c.id)]), [
    ['cft:dep:f2.js|f3.js', ['cft:dep:f2.js|f3.js|f4.js']],
  ]);

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
assert.deepStrictEqual(buildEdges(sources), [{ from: 'src/a.ts', to: 'src/b.ts', line: 1 }]);
// Several imports resolving to the same changed file make one edge, not one per import
assert.deepStrictEqual(
  buildEdges(new Map([
    ['src/A.java', 'import com.x.B;\nimport static com.x.B.helper;\nimport com.x.B.Inner;\n'],
    ['src/com/x/B.java', 'package com.x;\n'],
  ])),
  [{ from: 'src/A.java', to: 'src/com/x/B.java', line: 1 }]
);
// Edges carry the line of the first import of the target, also inside Go import blocks.
assert.deepStrictEqual(
  buildEdges(new Map([
    ['svc/main.go', 'package main\n\nimport (\n\t"fmt"\n\tfoo "corp/mod/db"\n)\n'],
    ['mod/db/conn.go', 'package db\n'],
  ])),
  [{ from: 'svc/main.go', to: 'mod/db/conn.go', line: 5 }]
);

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
  // The export carries this round only; last-round status lives in the Comments view.
  assert.ok(!buildSummaryMd({ rangeLabel: 'r', files: [], previous: status }).includes('Previous round'));
  fs.rmSync(repo, { recursive: true, force: true });
})();

// --- Symbol changes (0.4.34) --------------------------------------------------
// Static, per-language declaration scan of both sides of a change; nothing from
// a language server (none serve git: URIs). Top level plus one class level.
const { extractSymbols, diffSymbols } = require('./extension.js');
const tsSrc = [
  'import x from "./x";',
  '/*',
  'const old = 1;',
  '*/',
  'export const PORT = 3000;',
  'const handler = async (req) => {};',
  'let count: number;',
  'export default function () {}',
  'export async function* gen() {}',
  'export interface Opts { a: number }',
  'type Id = string;',
  'enum Color { Red }',
  'export abstract class Store {',
  '  private cache = new Map();',
  '  static readonly MAX = 3;',
  '  constructor() {}',
  '  async load(id: string) {',
  '    const inner = 1;',
  '    helper(inner);',
  '  }',
  '  onTick = () => {};',
  '}',
  'module.exports = { a: 1 };',
].join('\n');
// `text` is the declaration as shown: header only, no body or initializer.
const sym = (name, kind, line, text) => ({ name, kind, line, text });
assert.deepStrictEqual(extractSymbols('src/a.ts', tsSrc), [
  sym('PORT', 'variable', 5, 'export const PORT'),
  sym('handler', 'function', 6, 'const handler = async (req)'),
  sym('count', 'variable', 7, 'let count: number'),
  sym('default', 'function', 8, 'export default function ()'),
  sym('gen', 'function', 9, 'export async function* gen()'),
  sym('Opts', 'interface', 10, 'export interface Opts'),
  sym('Id', 'type', 11, 'type Id = string'),
  sym('Color', 'enum', 12, 'enum Color'),
  sym('Store', 'class', 13, 'export abstract class Store'),
  sym('Store.cache', 'field', 14, 'private cache'),
  sym('Store.MAX', 'field', 15, 'static readonly MAX'),
  sym('Store.load', 'function', 17, 'async load(id: string)'),
  sym('Store.onTick', 'function', 21, 'onTick = ()'),
]);
const pySrc = [
  '"""Module doc',
  'VERSION = "in docstring"',
  '"""',
  'import os',
  'VERSION = "1.0"',
  'TIMEOUT: int = 5',
  'x == 1',
  'count += 1',
  'if TYPE_CHECKING:',
  '    def hidden(): ...',
  'async def fetch(url):',
  '    inner = 1',
  'class Repo(Base):',
  '    """Doc."""',
  '    table = "repos"',
  '    @staticmethod',
  '    def find(id):',
  '        local = 2',
  '        return local',
  '    async def save(self):',
  '        pass',
  'def main():',
  '    pass',
].join('\n');
assert.deepStrictEqual(extractSymbols('app/m.py', pySrc), [
  sym('VERSION', 'variable', 5, 'VERSION'),
  sym('TIMEOUT', 'variable', 6, 'TIMEOUT: int'),
  sym('fetch', 'function', 11, 'async def fetch(url)'),
  sym('Repo', 'class', 13, 'class Repo(Base)'),
  sym('Repo.table', 'field', 15, 'table'),
  sym('Repo.find', 'function', 17, 'def find(id)'),
  sym('Repo.save', 'function', 20, 'async def save(self)'),
  sym('main', 'function', 22, 'def main()'),
]);
const javaSrc = [
  'package com.x;',
  'import java.util.*;',
  '/**',
  ' * Service doc; mentions build(args) here.',
  ' */',
  '@Service',
  'public class UserService extends Base',
  '    implements Runnable {',
  '  private static final int MAX = 3;',
  '  private final Map<String, List<User>> byName = new HashMap<>();',
  '  @Autowired',
  '  public UserService(Repo repo) {',
  '    final var local = "{"; // }',
  '    this.repo = repo;',
  '  }',
  '  public <T> List<T> find(String name) {',
  '    if (name == null) {',
  '      return List.of();',
  '    }',
  '    return helper(name);',
  '  }',
  '  void run();',
  '  enum State { ON, OFF }',
  '}',
  'class Helper {',
  '  static int count(List<?> l) { return l.size(); }',
  '}',
].join('\n');
// Members are whatever sits at brace depth 1, whatever the indentation: the class
// header continues on a deeper-indented line, and method locals are never members.
assert.deepStrictEqual(extractSymbols('src/UserService.java', javaSrc), [
  sym('UserService', 'class', 7, 'public class UserService extends Base implements Runnable'),
  sym('UserService.MAX', 'field', 9, 'private static final int MAX'),
  sym('UserService.byName', 'field', 10, 'private final Map<String, List<User>> byName'),
  sym('UserService.UserService', 'function', 12, 'public UserService(Repo repo)'),
  sym('UserService.find', 'function', 16, 'public <T> List<T> find(String name)'),
  sym('UserService.run', 'function', 22, 'void run()'),
  sym('UserService.State', 'enum', 23, 'enum State'),
  sym('Helper', 'class', 25, 'class Helper'),
  sym('Helper.count', 'function', 26, 'static int count(List<?> l)'),
]);
// Allman braces: the class body opens on its own line. A parameter list that
// continues on the next line is joined into one signature.
assert.deepStrictEqual(
  extractSymbols(
    'A.java',
    ['public class Allman', '{', '    private int a;', '    void run(', '        final String id)', '    {', '        int local = 1;', '    }', '}'].join('\n')
  ),
  [sym('Allman', 'class', 1, 'public class Allman'), sym('Allman.a', 'field', 3, 'private int a'), sym('Allman.run', 'function', 4, 'void run(final String id)')]
);
// Python: a class header may span lines and close with "):" at column 0.
assert.deepStrictEqual(
  extractSymbols('m.py', ['class Repo(', '    Base,', '):', '    table = "x"', '    def find(self):', '        local = 1', 'X = 1'].join('\n')),
  [sym('Repo', 'class', 1, 'class Repo(Base)'), sym('Repo.table', 'field', 4, 'table'), sym('Repo.find', 'function', 5, 'def find(self)'), sym('X', 'variable', 7, 'X')]
);
// Unsupported languages and oversized files yield nothing (so their rows stay leaves).
assert.deepStrictEqual(extractSymbols('a.go', 'func main() {}'), []);
assert.deepStrictEqual(extractSymbols('a.js', 'function a() {}' + ' '.repeat(1024 * 1024)), []);
// Set difference by signature, reported like file statuses: A (added, target line),
// M (same name, different declaration: one row carrying the old text), D (removed,
// base line). A moved symbol is not a change; dropping one overload of a name is a
// D, since the remaining overload matches exactly and so is not paired with it.
const symsBefore = [
  sym('a', 'function', 1, 'function a()'),
  sym('b', 'variable', 2, 'const b'),
  sym('C', 'class', 3, 'class C'),
  sym('R.audited', 'function', 4, 'JsonArray audited(List<Cdo> s)'),
  sym('R.audited', 'function', 8, 'JsonObject audited(Cdo s)'),
];
const symsAfter = [
  sym('C', 'class', 1, 'class C'),
  sym('a', 'function', 5, 'function a(x)'),
  sym('d', 'function', 9, 'function d()'),
  sym('R.audited', 'function', 12, 'JsonArray audited(List<Cdo> s)'),
];
assert.deepStrictEqual(diffSymbols(symsBefore, symsAfter), [
  { change: 'M', ...sym('a', 'function', 5, 'function a(x)'), was: 'function a()' },
  { change: 'A', ...sym('d', 'function', 9, 'function d()') },
  { change: 'D', ...sym('b', 'variable', 2, 'const b') },
  { change: 'D', ...sym('R.audited', 'function', 8, 'JsonObject audited(Cdo s)') },
]);
// Row text: the kind word, then a method's bare name or a variable's type and name
// (modifiers dropped); members say "method", top-level functions "function".
const { symbolLabel } = require('./extension.js');
assert.deepStrictEqual(
  [
    { kind: 'field', name: 'R.javers', text: 'private final Javers javers' },
    { kind: 'function', name: 'R.audited', text: 'private JsonObject audited(final CdoSnapshot snapshot)' },
    { kind: 'function', name: 'git', text: 'function git(cwd, args)' },
    { kind: 'variable', name: 'count', text: 'let count: number' },
    { kind: 'variable', name: 'PORT', text: 'export const PORT' },
    { kind: 'class', name: 'R.LoadedCommit', text: 'private record LoadedCommit(Changes changes)' },
    { kind: 'variable', name: 'Repo.table', text: 'table' },
  ].map(symbolLabel),
  ['variable Javers javers', 'method audited', 'function git', 'variable count: number', 'variable PORT', 'class LoadedCommit', 'variable table']
);
// A removed symbol's line exists only on the old side, and a diff editor selects on the
// new side: map it through the hunks. Inside a hunk → its new-side start (the line after
// it for a pure deletion); elsewhere → shifted by the hunks above.
const { newLineFor } = require('./extension.js');
const hunks = '@@ -3,2 +3,4 @@\n@@ -7,0 +10,3 @@\n@@ -10,5 +14,0 @@\n';
assert.deepStrictEqual([1, 4, 7, 8, 12, 15, 20].map((l) => newLineFor(hunks, l)), [1, 3, 9, 13, 15, 15, 20]);
assert.strictEqual(newLineFor('@@ -1,2 +0,0 @@\n', 1), 1);
assert.strictEqual(newLineFor('', 7), 7);
// Export: a "Structure changes" section with each file's added/removed declarations; omitted when none.
const symMd = buildSummaryMd({
  rangeLabel: 'r',
  files: [
    {
      path: 'src/a.ts',
      comments: [],
      symbols: [
        { change: 'A', name: 'foo', kind: 'function', text: 'function foo(a: number)' },
        { change: 'M', name: 'Bar', kind: 'class', text: 'class Bar extends Base', was: 'class Bar' },
        { change: 'D', name: 'baz', kind: 'variable', text: 'const baz' },
      ],
    },
    { path: 'src/b.ts', comments: [], symbols: [] },
  ],
});
assert.ok(
  symMd.includes(
    '## 🧩 Structure changes\n\n- src/a.ts\n  - added: function foo(a: number)\n  - modified: class Bar extends Base (was: class Bar)\n  - removed: const baz\n'
  ),
  symMd
);
assert.ok(!symMd.includes('src/b.ts'));
assert.ok(!buildSummaryMd({ rangeLabel: 'r', files: [{ path: 'x', comments: [] }] }).includes('Structure'));

// Provider: file rows with symbol changes expand into +/− rows that open the diff at
// the symbol's line; other files stay leaves.
(async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cft-sym-'));
  const sh = (cmd) => cp.execSync(cmd, { cwd: repo, stdio: 'pipe' });
  sh('git init -q -b main && git config user.email t@t && git config user.name t');
  fs.writeFileSync(path.join(repo, 'lib.js'), 'function a() {}\nconst b = 1;\n');
  sh('git add . && git commit -qm c1');
  fs.writeFileSync(path.join(repo, 'lib.js'), 'function a() {}\nfunction c() {}\n');
  fs.writeFileSync(path.join(repo, 'note.txt'), 'x');
  fs.writeFileSync(path.join(repo, 'app.js'), '// app\n\nconst lib = require("./lib");\n');
  sh('git add . && git commit -qm c2');
  sh('git branch up HEAD~1 && git branch --set-upstream-to=up');
  const provider = new CommitTreeProvider();
  Object.defineProperty(provider, 'repoRoot', { value: repo });
  const [c2] = await provider.getCommits(repo);
  const rows = await provider.getChildren(c2);
  const byPath = (p) => rows.find((r) => r.filePath === p);
  assert.strictEqual(byPath('note.txt').collapsibleState, 0);
  assert.strictEqual(byPath('app.js').collapsibleState, 1);
  assert.strictEqual(byPath('lib.js').collapsibleState, 1);
  const syms = await provider.getChildren(byPath('lib.js'));
  // Rows read "kind name"; the file-status color and A/M/D badge say what happened
  // to them (same decoration as file rows); the icon color gives the kind.
  assert.deepStrictEqual(syms.map((s) => s.label), ['function c', 'variable b']);
  assert.deepStrictEqual(syms.map((s) => s.resourceUri.query), ['cftStatus=A&rev=0', 'cftStatus=D&rev=0']);
  assert.deepStrictEqual(syms.map((s) => [s.iconPath.id, s.iconPath.color.id]), [
    ['symbol-method', 'symbolIcon.methodForeground'],
    ['symbol-variable', 'symbolIcon.variableForeground'],
  ]);
  assert.strictEqual(syms[0].command.command, 'commitFileTree.openDiff');
  assert.deepStrictEqual(syms[0].command.arguments.slice(4), [2]);
  assert.deepStrictEqual(syms[1].command.arguments.slice(4), [2, 'base']);
  const data = await provider.summaryData(repo);
  assert.deepStrictEqual(data.files.find((f) => f.path === 'lib.js').symbols.map((s) => s.change + s.name), ['Ac', 'Db']);
  // Dependency view: a row under lib.js is a file importing it; it opens at that import line.
  provider.mode = 'deps';
  const deps = await provider.getChildren();
  const libDep = deps.find((d) => d.filePath === 'lib.js');
  const [appDep] = await provider.getChildren(libDep);
  assert.strictEqual(appDep.filePath, 'app.js');
  assert.strictEqual(appDep.command.arguments[4], 3);
  assert.strictEqual(libDep.command.arguments[4], undefined);
  fs.rmSync(repo, { recursive: true, force: true });
})();
