// Orca worker: hosts the VS Code extension itself. extension.js runs unchanged on
// orca/vscode.js (the VS Code API over Orca); this file is the host behind that API:
// which repository is focused, where its review state lives, and the message channel
// to the panel (media/graph.js behind orca/panel.js) and the review editor.
const { AsyncLocalStorage } = require('async_hooks');
const cp = require('child_process');
const fs = require('fs');
const Module = require('module');
const path = require('path');

// extension.js requires 'vscode'; give it the stand-in (same trick as test.js).
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'vscode') return require.resolve('./vscode.js');
  return resolveFilename.call(this, request, ...args);
};
const vscode = require('./vscode.js');
const extension = require('../extension.js');
const { git, watchGitDirs, writeReviewFile } = extension;
const { fileRows } = require('./diff.js');

// Commands the panel's toolbar may run by name; row actions name theirs with the row.
const TOOLBAR = new Set(['viewByCommits', 'viewCombined', 'viewByDeps', 'viewComments', 'goBack', 'refresh', 'reviewAll', 'restoreLastRound', 'resetReviewRange', 'clearReviewData'].map((c) => `commitFileTree.${c}`));
const VIEW = { commits: 'viewByCommits', combined: 'viewCombined', deps: 'viewByDeps', comments: 'viewComments' };

// Changes under these never change what the views show: git's own files (watched
// separately, see watchGitDirs), dependencies, and .commit-review, our own output.
const UNWATCHED = /(^|[\\/])(\.git|node_modules)([\\/]|$)|^\.commit-review([\\/]|$)/;
// The shortest time between two refreshes that file changes ask for.
const REFRESH_MS = 2000;
// The most one answer to the panel carries (Orca takes 1 MiB).
const ANSWER_BYTES = 900 * 1024;

// Where a repository's review state is kept, in its git directory.
const STATE_FILE = 'commit-review-tree.json';
// What the review editor shows: a request written here (see `show`), kept out of git.
const REVIEW_FILE = '.commit-review/review.crdiff';

const infoRow = (label, description) => ({ id: 'info', label, description, icon: 'info' });

const branchName = (ref) => (ref || '').replace(/^refs\/heads\//, '');

// The Orca CLI, for what the plugin API cannot do yet (see `focused` and `openFile`).
// It ships in the app's resources, which the worker's PATH does not include.
// Resolves with the command's JSON result.
function orcaCli(args) {
  const PATH = [process.resourcesPath && path.join(process.resourcesPath, 'bin'), process.env.PATH].filter(Boolean).join(path.delimiter);
  return new Promise((resolve, reject) => {
    cp.execFile('orca', [...args, '--json'], { timeout: 10000, maxBuffer: 10 * 1024 * 1024, env: { ...process.env, PATH } }, (err, stdout) => {
      let answer;
      try {
        answer = JSON.parse(stdout);
      } catch (e) {
        // no answer: the error below
      }
      if (answer && answer.ok !== false && answer.result) resolve(answer.result);
      else reject(new Error((answer && answer.error && answer.error.message) || (err && err.message) || 'the Orca CLI gave no answer'));
    });
  });
}

// Stops the running instance's watchers.
let stop = () => {};

function activate(orca) {
  // The focused workspace's repository and its Orca id; undefined when there is none.
  let root;
  let workspaceId;
  // The extension's workspaceState: per repository, in a file in its git directory,
  // so it survives the worker (Orca stops an idle one after five minutes) and never
  // shows up in the working tree.
  let state = {};
  let stateFile;
  // What the extension does for a workspace carries that workspace along, through
  // every await: a change that finishes after the focus has moved (a note typed
  // into a box that was left open, say) is dropped, not written into the state of
  // the repository that has the focus now.
  const begunOn = new AsyncLocalStorage();
  const onRoot = (run) => begunOn.run({ root }, run);
  const memento = {
    get: (key, fallback) => (key in state ? state[key] : fallback),
    async update(key, value) {
      const begun = begunOn.getStore();
      if (begun && begun.root !== root) return orca.log(`dropped a change to ${key}: its workspace no longer has the focus`);
      if (value === undefined) delete state[key];
      else state[key] = value;
      // The Comments view edits and deletes comments too, and an export clears them.
      if (key === 'cft.comments') orca.panels.post('comments', {});
      if (!stateFile) return;
      fs.writeFileSync(`${stateFile}.tmp`, JSON.stringify(state));
      fs.renameSync(`${stateFile}.tmp`, stateFile);
    },
  };

  const stateFileOf = async (dir) => path.join((await git(dir, ['rev-parse', '--absolute-git-dir'])).trim(), STATE_FILE);
  function readState(file) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      return {}; // nothing saved yet
    }
  }

  // Messages for a panel wait in its outbox until it asks: an answer may be 1 MiB, a
  // pushed event a quarter of that, and a view of a large change is bigger. `pull`
  // only tells the panels there is something to fetch. One outbox per open panel
  // (a second window has its own), so each gets every message.
  const outboxes = new Map();
  const unseen = (outbox) => outbox.some((m) => m.type === 'root');
  let pinged = false;
  // When the watcher last started a refresh (0: none running) and when rows last arrived.
  let building = 0;
  let built = 0;
  function post(message) {
    if (message.type === 'root') {
      building = 0;
      built = Date.now();
    }
    for (const [panel, outbox] of outboxes) {
      // A newer root replaces one the panel has not fetched yet.
      if (message.type === 'root') for (let i = outbox.length - 1; i >= 0; i--) if (outbox[i].type === 'root') outbox.splice(i, 1);
      outbox.push(message);
      // A panel that has stopped asking is closed.
      if (outbox.length > 500) outboxes.delete(panel);
    }
    if (pinged) return;
    pinged = true;
    orca.panels.post('pull', {});
  }
  // As many waiting messages as fit one answer; the rest go with the next request.
  // JSON also drops the undefined fields rows carry: VS Code's postMessage does the
  // same, and Orca refuses an answer that has one.
  function drain(panel) {
    pinged = false;
    const outbox = outboxes.get(panel);
    const batch = [];
    let bytes = 0;
    while (outbox.length) {
      let json = JSON.stringify(outbox[0]);
      if (Buffer.byteLength(json) > ANSWER_BYTES) json = JSON.stringify(tooLarge(outbox[0]));
      bytes += Buffer.byteLength(json) + 1;
      if (batch.length && bytes > ANSWER_BYTES) break;
      batch.push(JSON.parse(json));
      outbox.shift();
    }
    if (outbox.length) {
      pinged = true;
      orca.panels.post('pull', {});
    }
    return batch;
  }
  // A message that could never be delivered, as what the panel can show in its place.
  // ponytail: a view of several thousand rows is not shown at all; send rows in
  // parts if reviews that large turn out to matter.
  function tooLarge(message) {
    const row = { id: 'error', label: 'Too large to show here', description: `${(message.rows || []).length} rows: narrow the review range with the commit checkboxes`, icon: 'warning' };
    if (message.type === 'root' || message.type === 'children') return { ...message, rows: [row] };
    return { type: 'ui', kind: 'toast', level: 'error', message: 'That was too large to hand to the panel.', actions: [] };
  }

  // Questions to the person (input box, pick list, confirmation, toast buttons) are
  // put to the panel and settle when it replies. Ids are unique across workers: a
  // panel may answer a question the worker before this one asked.
  const asks = new Map();
  let lastAsk = 0;
  function ask(request) {
    if (request.kind === 'toast' && !request.actions.length) {
      post({ type: 'ui', ...request });
      return Promise.resolve(undefined);
    }
    const id = `${Date.now()}-${++lastAsk}`;
    post({ type: 'ui', id, ...request });
    return new Promise((resolve) => asks.set(id, resolve));
  }

  // The extension's side of the webview channel (graphProvider in extension.js).
  const listeners = new Set();
  const deliver = (message) => onRoot(() => Promise.all([...listeners].map((listener) => listener(message))));
  const view = {
    webview: {
      options: {},
      html: '',
      cspSource: '',
      asWebviewUri: (uri) => uri,
      postMessage: post,
      onDidReceiveMessage: (listener) => listeners.add(listener),
    },
    onDidDispose: () => {},
    // The view title's description and badge are drawn by the panel's title bar.
    set description(text) {
      title.description = text;
      post({ type: 'view', description: text });
    },
    set badge(badge) {
      title.badge = badge || null;
      post({ type: 'view', badge: title.badge });
    },
  };
  // What the title bar shows: the view's description and badge, and the context keys
  // (VS Code: menu enablement and the view's mode). Kept, because a panel opened
  // later has missed the messages that set them; every load sends them whole.
  const title = {};
  const contexts = {};

  let mode = 'commits';
  // Open a file of the repository as a tab and bring it to the front: the person
  // asked for it by clicking. A .crdiff file opens in the review editor.
  // ponytail: through the CLI, because the plugin API for it (editor.open) needs a
  // capability that only Orca 1.4.248 and later accept in a manifest; use the API
  // once 1.4.247 no longer needs supporting.
  async function openFile(file) {
    try {
      const worktree = workspaceId.startsWith('identity:') ? workspaceId : `id:${workspaceId}`;
      await orcaCli(['file', 'open', path.join(root, file), '--worktree', worktree, '--focus']);
    } catch (e) {
      ask({ kind: 'toast', level: 'error', message: `Could not open ${file}: ${e.message}`, actions: [] });
    }
  }
  vscode.connect({
    root: () => root,
    view: (provider) => provider.resolveWebviewView(view),
    ask,
    copy: (text) => post({ type: 'ui', kind: 'copy', text }),
    // The view mode is also remembered with the repository, for the next worker.
    context(key, value) {
      contexts[key] = value;
      post({ type: 'context', values: { [key]: value } });
      if (key !== 'commitFileTree.mode') return;
      mode = value;
      if (root) memento.update('orca.mode', value).catch((e) => orca.log(`could not save the view mode: ${e.message}`));
    },
    // The review editor shows what this file names; opening it brings the editor up.
    async show(request) {
      await writeReviewFile(root, REVIEW_FILE, JSON.stringify({ root, ...request, at: Date.now() }));
      await openFile(REVIEW_FILE);
    },
    openFile,
    log: (line) => orca.log(line),
  });
  extension.activate({ workspaceState: memento, subscriptions: [], extensionUri: vscode.Uri.file(path.dirname(__dirname)) });

  // Refresh on commit, checkout, fetch and push (the git directories) and on edits
  // in the working tree. Changes are gathered for half a second, and a busy tree (a
  // build, an agent at work, a repository that is a whole home directory) gets a
  // refresh two seconds after the last one arrived at the earliest, never two at
  // once. While every panel has a root waiting unfetched nobody is looking, so
  // nothing is rebuilt.
  let unwatch = () => {};
  function watch(dir) {
    let timer;
    let closed = false;
    const watchers = [];
    const changed = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        // Still building (30 s at most: a refresh that was dropped posts nothing): look again later.
        if (Date.now() - building < 30000) return changed();
        if ([...outboxes.values()].every(unseen)) return;
        building = Date.now();
        vscode.commands.executeCommand('commitFileTree.refresh');
      }, Math.max(500, built + REFRESH_MS - Date.now()));
    };
    // Our own state file lives in the git directory: saving it is no change to show.
    watchGitDirs(dir, (event, name) => (name && name.includes(STATE_FILE)) || changed()).then((w) => (closed ? w.close() : watchers.push(w)));
    // ponytail: Linux has no native recursive watch (Node adds a watch per directory,
    // which a large tree cannot afford), so there edits show on the next refresh or
    // git operation; use a watcher library if that proves too stale.
    if (process.platform !== 'linux') {
      try {
        const watcher = fs.watch(dir, { recursive: true }, (event, name) => name && !UNWATCHED.test(name) && changed());
        watcher.on('error', () => {}); // it just stops; unheard, the event would end the worker
        watchers.push(watcher);
      } catch (e) {
        // the folder cannot be watched: same as above
      }
    }
    unwatch = () => {
      closed = true;
      clearTimeout(timer);
      watchers.forEach((w) => w.close());
    };
  }
  stop = () => unwatch();

  async function setRoot(next) {
    if (next === root) return;
    unwatch();
    unwatch = () => {};
    // Questions about the workspace being left are withdrawn, as if dismissed.
    for (const settle of asks.values()) settle(undefined);
    asks.clear();
    post({ type: 'ui', kind: 'dismiss' });
    // A refresh under way is for the workspace being left: its rows will be dropped.
    building = 0;
    // The state is read before the root changes, so the two never disagree.
    const file = next ? await stateFileOf(next).catch(() => undefined) : undefined; // not a repository: `load` says so
    root = next;
    stateFile = file;
    state = readState(file);
    if (!stateFile) return;
    watch(root);
    // Each repository opens in the view it was left in.
    const saved = state['orca.mode'] in VIEW ? state['orca.mode'] : 'commits';
    if (saved !== mode) await vscode.commands.executeCommand(`commitFileTree.${VIEW[saved]}`);
  }

  // The focused workspace: { path, id }, or { row } saying why there is none.
  // readContext names it by display name and branch only; workspace.list has the
  // paths. Several workspaces can share both (every repository's main checkout is
  // "main"); then one of its terminals tells, since the Orca CLI knows each
  // terminal's worktree. With no terminal open there is no telling, and a guess
  // would show another repository's commits.
  // ponytail: one CLI spawn (~0.3 s) per load of a same-name workspace; cache
  // handle → path if that shows, drop it all once readContext carries the workspace id.
  async function focused() {
    const none = { row: infoRow('No workspace') };
    const context = await orca.host.call('workspace.readContext');
    if (!context) return none;
    const { workspaces } = await orca.host.call('workspace.list');
    const named = workspaces.filter((w) => w.name === context.displayName && branchName(w.branch) === branchName(context.branch));
    if (named.length <= 1) return local(named[0]) || none;
    const handles = new Set(context.terminals.map((t) => t.id));
    // (The CLI's "active" worktree is no use: it means the calling terminal's, and a worker has none.)
    const { terminals } = await orcaCli(['terminal', 'list']).catch(() => ({ terminals: [] }));
    const terminal = terminals.find((t) => handles.has(t.handle));
    const found = terminal && named.find((w) => w.path === terminal.worktreePath);
    return local(found) || { row: infoRow(`${named.length} workspaces are named ${context.displayName}`, 'open a terminal in this one to tell them apart') };
  }
  // git runs on this machine: a workspace on an SSH or WSL host is out of reach.
  const local = (workspace) =>
    workspace && workspace.hostId && workspace.hostId !== 'local' ? { row: infoRow('Remote workspace', 'reviewing needs the repository on this machine') } : workspace;

  // Point the extension at the focused workspace and have it post its rows.
  // `reviewing` is true once it has: not in a new worker (which has no rows for the
  // ids the panel holds) and not while there is no repository to review.
  let loaded = false;
  let reviewing = false;
  async function load() {
    loaded = true;
    reviewing = false;
    const { path: repo, id, row } = await focused();
    workspaceId = id;
    await setRoot(repo);
    if (row) return post({ type: 'root', mode: 'commits', rows: [row] });
    if (!stateFile) return post({ type: 'root', mode: 'commits', rows: [infoRow('Not a git repository')] });
    post({ type: 'context', values: contexts });
    post({ type: 'view', ...title, root });
    await deliver({ type: 'ready' });
    reviewing = true;
  }
  // One at a time, so a quick switch between workspaces ends on the last one.
  let queue = Promise.resolve();
  function inTurn(run) {
    const result = queue.then(run);
    queue = result.catch(() => {});
    return result;
  }

  // The panel's messages: graph.js's own protocol goes to the extension as the
  // webview's messages would; the toolbar and the answers to `ask` are ours.
  // Everything the panel is owed comes back as the answer.
  orca.panels.handle('message', async (m, caller) => {
    const panel = (caller && caller.panel && caller.panel.id) || 'panel';
    if (!outboxes.has(panel)) outboxes.set(panel, []);
    if (m.type === 'ui.reply') {
      const settle = asks.get(m.id);
      asks.delete(m.id);
      if (settle) settle(m.value);
      return drain(panel);
    }
    // Start over where the extension has no rows to act on: the panel opened, a new
    // worker heard from a panel that was already open, or a button was pressed where
    // there was nothing to review.
    if (m.type === 'ready' || (m.type === 'pull' ? !loaded : !reviewing)) await inTurn(load);
    if (!reviewing || m.type === 'ready' || m.type === 'pull') return drain(panel);
    if (m.type === 'command') {
      if (TOOLBAR.has(m.command)) onRoot(() => vscode.commands.executeCommand(m.command));
    } else {
      // Rows are answered at once; an action may wait on the person, so it is not waited for.
      const handled = deliver(m);
      if (m.type === 'children' || m.type === 'card') await handled;
      else handled.catch((e) => orca.log(`${m.type} failed: ${(e && e.stack) || e}`));
    }
    return drain(panel);
  });

  // --- The review editor (orca/editor.js) ---
  // It draws a file from `diff`, and keeps line comments through the extension's own
  // commands: a comment belongs to one version of the file, the old one ('old': the
  // base) or the new one ('new': the target, or the single version on view).
  //
  // Every request names its repository (`root`, from the request file): the editor
  // may ask while the panel, and with it the extension, is on another workspace.
  // And the request file sits in a repository where anyone could have put one, so
  // nothing in it is trusted: the root must be a workspace open in Orca, a side must
  // name a revision as the extension writes them (never something git would read as
  // an option) and a path inside the repository.
  async function reviewOf(dir) {
    if (typeof dir !== 'string') throw new Error('this review names no repository');
    if (dir === root) return state;
    const { workspaces } = await orca.host.call('workspace.list');
    if (!workspaces.some((w) => w.path === dir)) throw new Error(`not an Orca workspace: ${dir}`);
    return readState(await stateFileOf(dir));
  }
  function checked(dir, file) {
    for (const side of [file.base, file.target, file.view]) {
      if (!side) continue;
      if (!/^(working|HEAD|[0-9a-f]{7,40})(~\d+)?$/.test(side.ref)) throw new Error(`not a revision: ${side.ref}`);
      const inside = path.relative(dir, path.resolve(dir, String(side.path)));
      if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) throw new Error(`not a path in this repository: ${side.path}`);
    }
    return file;
  }
  const sides = (file) => ({ old: file.base, new: file.target || file.view });
  function comments(saved, file) {
    // Stored under the path as the extension has it: with this system's separators.
    const of = (side) => (side && (saved['cft.comments'] || {})[`${side.ref}:${side.path.split('/').join(path.sep)}`]) || [];
    return { old: of(sides(file).old), new: of(sides(file).new) };
  }
  orca.panels.handle('diff', async ({ root: dir, file }) => {
    const saved = await reviewOf(dir);
    return { ...(await fileRows(dir, checked(dir, file))), comments: comments(saved, file) };
  });
  orca.panels.handle('comments', async ({ root: dir, file }) => comments(await reviewOf(dir), checked(dir, file)));

  // Changing comments is the extension's work, on the workspace it is on. Someone
  // typing in a review has that workspace focused; if the extension is still
  // elsewhere, it catches up first.
  async function change(command, input, argument) {
    await reviewOf(input.root);
    checked(input.root, input.file);
    if (input.root !== root) await inTurn(load);
    if (input.root !== root) throw new Error('This review belongs to another workspace: focus it in Orca first.');
    const side = sides(input.file)[input.side];
    const lines = [input.line, input.endLine || input.line];
    if (!side || !lines.every((n) => Number.isInteger(n) && n > 0) || lines[1] < lines[0]) throw new Error('not a line of this file');
    // The comment thread VS Code would hand the command: the document and the lines.
    const { ref, path: relative } = side;
    const onDisk = vscode.Uri.file(path.join(root, relative));
    const thread = {
      uri: ref === 'working' ? onDisk : onDisk.with({ scheme: 'git', query: JSON.stringify({ path: onDisk.fsPath, ref }) }),
      range: new vscode.Range(lines[0] - 1, 0, lines[1] - 1, 0),
      comments: [],
      dispose() {},
    };
    await onRoot(() => vscode.commands.executeCommand(command, argument(thread)));
    return comments(state, input.file);
  }
  orca.panels.handle('comment.add', (input) => change('commitFileTree.addComment', input, (thread) => ({ text: String(input.text), thread })));
  orca.panels.handle('comment.delete', (input) => change('commitFileTree.deleteThread', input, (thread) => thread));
}

// Orca calls the default export with its API, and deactivate before it stops the worker.
module.exports = activate;
module.exports.deactivate = () => stop();
