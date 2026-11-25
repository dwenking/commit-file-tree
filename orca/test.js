// Self-check for the Orca worker: node orca/test.js
const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const activate = require('./worker.js');

// A repository with two commits, focused in a stand-in Orca.
const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cft-orca-')));
const git = (...args) => cp.execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { cwd: repo });
git('init', '-q', '-b', 'main');
fs.writeFileSync(path.join(repo, 'a.txt'), 'hi\n');
git('add', '.');
git('commit', '-q', '-m', 'first commit');
fs.writeFileSync(path.join(repo, 'a.txt'), 'hello\nworld\n');
git('commit', '-q', '-am', 'greeting');

// A stand-in `orca` command first on PATH: it notes how it was called and prints
// what the test sets (the worker asks the Orca CLI what the plugin API cannot do).
const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'cft-orca-bin-'));
const cliCalls = path.join(bin, 'calls');
const cliAnswer = (result) => fs.writeFileSync(path.join(bin, 'answer'), JSON.stringify({ ok: true, result }));
cliAnswer({ terminals: [] });
fs.writeFileSync(path.join(bin, 'orca'), `#!/bin/sh\necho "$@" >> "${cliCalls}"\ncat "${path.join(bin, 'answer')}"\n`, { mode: 0o755 });
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;

const answers = {
  'workspace.readContext': { branch: 'main', displayName: 'main', terminals: [] },
  'workspace.list': { workspaces: [{ id: 'w1', kind: 'worktree', name: 'main', path: repo, branch: 'main', hostId: null }], truncated: false },
};

// One worker, as Orca starts it. `send` is the panel's request; everything the
// worker has for the panel comes back on it, and `take` waits for a message that
// arrives later (after a refresh, or when the worker asks the panel something).
function boot() {
  const handlers = {};
  const inbox = [];
  const caller = { panel: { id: 'panel-1', surface: 'panel' } };
  activate({
    panels: { handle: (name, fn) => (handlers[name] = fn), post() {} },
    host: { call: async (method) => answers[method] },
    log: (line) => console.error(line),
  });
  const send = async (message) => {
    const got = await handlers.message(message, caller);
    // Orca refuses an answer that is not plain JSON (an undefined field is enough).
    assert.deepStrictEqual(got, JSON.parse(JSON.stringify(got)));
    inbox.push(...got);
  };
  const take = async (type, where = () => true, patience = 200) => {
    for (let tries = 0; tries < patience; tries++) {
      const i = inbox.findIndex((m) => m.type === type && where(m));
      if (i >= 0) return inbox.splice(i, 1)[0];
      await new Promise((resolve) => setTimeout(resolve, 10));
      await send({ type: 'pull' });
    }
    throw new Error(`no ${type} message`);
  };
  // The newest commit's file row, as the panel gets it by expanding the commit.
  const fileRow = async () => {
    await send({ type: 'ready' });
    const commit = (await take('root')).rows.find((r) => r.context === 'commit');
    await send({ type: 'children', id: commit.id });
    return (await take('children')).rows[0];
  };
  return { send, take, fileRow, handlers, inbox };
}

(async () => {
  let panel = boot();

  // The panel's first message gets the By commits rows of the focused workspace.
  await panel.send({ type: 'ready' });
  const root = await panel.take('root');
  assert.strictEqual(root.mode, 'commits');
  const commit = root.rows.find((r) => r.context === 'commit');
  assert.strictEqual(commit.label, 'greeting');

  // Expanding the commit lists its files.
  await panel.send({ type: 'children', id: commit.id });
  const file = (await panel.take('children')).rows[0];
  assert.strictEqual(file.label, 'a.txt');

  // A row action runs the extension's command: the file is marked reviewed...
  await panel.send({ type: 'action', id: file.id, command: 'commitFileTree.toggleReviewed' });
  await panel.take('root');
  assert.strictEqual((await panel.fileRow()).deco.badge, '✓');

  // ...and what VS Code asks in an input box, the panel is asked: a note on the file.
  await panel.send({ type: 'action', id: file.id, command: 'commitFileTree.editNote' });
  const input = await panel.take('ui', (m) => m.kind === 'input');
  assert.strictEqual(input.prompt, 'Note for a.txt');
  await panel.send({ type: 'ui.reply', id: input.id, value: 'check the greeting' });
  await panel.take('root');
  assert.match((await panel.fileRow()).description, /📝/);

  // Clicking the file writes a request that names the change, and has Orca open it
  // (in the review editor, which takes .crdiff files) and bring it to the front...
  await panel.send({ type: 'run', id: file.id });
  const requestFile = path.join(repo, '.commit-review/review.crdiff');
  const opened = () => fs.existsSync(cliCalls) && fs.readFileSync(cliCalls, 'utf8').split('\n').find((line) => line.startsWith('file open'));
  for (let tries = 0; tries < 200 && !opened(); tries++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.strictEqual(opened(), `file open ${requestFile} --worktree id:w1 --focus --json`);
  const request = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
  const [change] = request.files;
  assert.strictEqual(change.path, 'a.txt');
  // It names its repository, so the editor still gets this one when the panel has moved on.
  assert.strictEqual(request.root, repo);
  // ...and the editor asks the worker for its rows: [type, old line, new line, text].
  const diff = await panel.handlers.diff({ root: repo, file: change });
  assert.deepStrictEqual(diff.rows, [['-', 1, 0, 'hi'], ['+', 0, 1, 'hello'], ['+', 0, 2, 'world']]);
  // The request file sits in the repository, where anyone could have put it: a
  // revision that git would read as an option, or a path outside the repository, is refused.
  await assert.rejects(panel.handlers.diff({ root: repo, file: { view: { ref: '--output=/tmp/x', path: 'a.txt' } } }), /revision/);
  await assert.rejects(panel.handlers.diff({ root: repo, file: { view: { ref: 'working', path: '../outside.txt' } } }), /path/);
  await assert.rejects(panel.handlers.diff({ root: os.homedir(), file: change }), /workspace/);
  // A line comment goes through the extension's own command: the editor gets it
  // back with the file's comments, and the tree counts it on the file's row.
  const commented = await panel.handlers['comment.add']({ root: repo, file: change, side: 'new', line: 2, text: 'why world?' });
  assert.deepStrictEqual(commented.new, [{ line: 2, text: 'why world?' }]);
  assert.match((await panel.fileRow()).description, /💬1/);
  assert.deepStrictEqual((await panel.handlers['comment.delete']({ root: repo, file: change, side: 'new', line: 2 })).new, []);

  // A second panel (another window) is owed the same messages: what the first one
  // fetched is still there for it.
  const second = { panel: { id: 'panel-2', surface: 'panel' } };
  await panel.handlers.message({ type: 'pull' }, second);
  await panel.send({ type: 'command', command: 'commitFileTree.refresh' });
  let owed = [];
  for (let tries = 0; tries < 200 && !owed.some((m) => m.type === 'root'); tries++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    await panel.send({ type: 'pull' });
    owed = await panel.handlers.message({ type: 'pull' }, second);
  }
  assert.ok(owed.some((m) => m.type === 'root'));

  // The toolbar switches the view.
  await panel.send({ type: 'command', command: 'commitFileTree.viewCombined' });
  assert.strictEqual((await panel.take('root', (m) => m.mode === 'combined')).mode, 'combined');

  // Orca stops an idle worker. The next one picks up where the repository was left:
  // same view, same review state.
  activate.deactivate();
  panel = boot();
  await panel.send({ type: 'ready' });
  await panel.take('root', (m) => m.mode === 'combined');
  await panel.send({ type: 'command', command: 'commitFileTree.viewByCommits' });
  await panel.take('root', (m) => m.mode === 'commits');
  assert.strictEqual((await panel.fileRow()).deco.badge, '✓');

  // Orca names the focused workspace by display name and branch only. When another
  // workspace shares both, its terminals tell: `orca terminal list` has every
  // terminal's worktree path.
  cliAnswer({ terminals: [{ handle: 'term_other', worktreePath: os.tmpdir() }, { handle: 'term_1', worktreePath: repo }] });
  answers['workspace.list'].workspaces.unshift({ id: 'w0', kind: 'worktree', name: 'main', path: os.tmpdir(), branch: 'main', hostId: null });
  // With no terminal open there is nothing to tell by: say so, never guess a repository.
  await panel.send({ type: 'ready' });
  const unknown = await panel.take('root');
  assert.deepStrictEqual(unknown.rows.map((r) => r.id), ['info']);
  assert.match(unknown.rows[0].description, /terminal/);
  answers['workspace.readContext'].terminals = [{ id: 'term_1' }];
  await panel.send({ type: 'ready' });
  assert.strictEqual((await panel.take('root')).rows.find((r) => r.context === 'commit').label, 'greeting');

  // A link in the working tree is shown as git stores it, its target: never the
  // file it points to, which may be anywhere.
  fs.symlinkSync('/etc/hosts', path.join(repo, 'link'));
  const link = await panel.handlers.diff({ root: repo, file: { path: 'link', view: { ref: 'working', path: 'link' } } });
  assert.deepStrictEqual(link.rows, [[' ', 1, 1, '/etc/hosts']]);
  fs.rmSync(path.join(repo, 'link'));

  // --- Moving between workspaces ---
  // A second repository, of one commit with thousands of files, under its own name.
  const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cft-orca-other-')));
  const gitOther = (...args) => cp.execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { cwd: other });
  gitOther('init', '-q', '-b', 'main');
  for (let i = 0; i < 5000; i++) fs.writeFileSync(path.join(other, `file-${i}.txt`), '');
  gitOther('add', '.');
  gitOther('commit', '-q', '-m', 'many files');
  answers['workspace.list'].workspaces.push({ id: 'w2', kind: 'worktree', name: 'other', path: other, branch: 'main', hostId: null });
  const focus = (name) => (answers['workspace.readContext'] = name && { branch: 'main', displayName: name, terminals: [{ id: 'term_1' }] });
  const savedIn = (dir) => (fs.existsSync(path.join(dir, '.git/commit-review-tree.json')) ? fs.readFileSync(path.join(dir, '.git/commit-review-tree.json'), 'utf8') : '');

  // A question still open when the focus moves is withdrawn, and a late answer to
  // it changes nothing: one repository's notes must never land in another's.
  const noted = await panel.fileRow();
  await panel.send({ type: 'action', id: noted.id, command: 'commitFileTree.editNote' });
  const question = await panel.take('ui', (m) => m.kind === 'input');
  focus('other');
  await panel.send({ type: 'ready' });
  await panel.take('ui', (m) => m.kind === 'dismiss');
  await panel.send({ type: 'ui.reply', id: question.id, value: 'a late answer' });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(!savedIn(other).includes('a late answer') && !savedIn(other).includes('check the greeting'));
  assert.ok(savedIn(repo).includes('check the greeting') && !savedIn(repo).includes('a late answer'));

  // A view too large for one answer (Orca takes 1 MiB) says so instead of failing.
  await panel.send({ type: 'command', command: 'commitFileTree.viewCombined' });
  const huge = await panel.take('root', (m) => m.mode === 'combined');
  assert.strictEqual(huge.rows.length, 1);
  assert.match(huge.rows[0].label, /too large/i);
  await panel.send({ type: 'command', command: 'commitFileTree.viewByCommits' });
  await panel.take('root', (m) => m.mode === 'commits');

  // Rows still being built for a workspace are dropped once it has lost the focus...
  focus('main');
  await panel.send({ type: 'ready' });
  await panel.take('root', (m) => m.rows.some((r) => r.label === 'greeting'));
  await panel.send({ type: 'command', command: 'commitFileTree.refresh' });
  focus(null);
  await panel.send({ type: 'ready' });
  await panel.take('root', (m) => m.rows[0].id === 'info');
  panel.inbox.length = 0;
  await assert.rejects(panel.take('root', () => true, 40), /no root/);
  // ...and with no workspace there is nothing for the title bar's buttons to refresh.
  await panel.send({ type: 'command', command: 'commitFileTree.refresh' });
  assert.strictEqual((await panel.take('root')).rows[0].id, 'info');
  focus('main');
  await panel.send({ type: 'ready' });
  await panel.take('root', (m) => m.rows.some((r) => r.label === 'greeting'));

  // A commit made meanwhile (an agent's) shows up on its own: the worker watches the repository.
  git('commit', '-q', '--allow-empty', '-m', 'made by an agent');
  await panel.take('root', (m) => m.rows.some((r) => r.label === 'made by an agent'));

  activate.deactivate();
  fs.rmSync(bin, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(other, { recursive: true, force: true });
  console.log('orca worker: ok');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
