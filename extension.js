const vscode = require('vscode');
const cp = require('child_process');
const path = require('path');

function git(cwd, args) {
  return new Promise((resolve, reject) => {
    cp.execFile('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

// Parse `git show --name-status` lines into [{status, path}].
// Renames/copies (R100\told\tnew) use the new path.
function parseNameStatus(output) {
  const files = [];
  for (const line of output.split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 2 || !parts[0]) continue;
    const status = parts[0][0];
    files.push({ status, path: parts[parts.length - 1] });
  }
  return files;
}

// Build a nested tree: {dirs: Map<name, node>, files: [{name, status, path}]}
function buildTree(files) {
  const root = { dirs: new Map(), files: [] };
  for (const f of files) {
    const segments = f.path.split('/');
    let node = root;
    for (const seg of segments.slice(0, -1)) {
      if (!node.dirs.has(seg)) node.dirs.set(seg, { dirs: new Map(), files: [] });
      node = node.dirs.get(seg);
    }
    node.files.push({ name: segments[segments.length - 1], status: f.status, path: f.path });
  }
  return root;
}

// Parse `git log --format=%H%x09%h%x09%an%x09%ar%x09%s --shortstat` output.
// Each commit is a tab-separated header line, optionally followed by a
// "N files changed, X insertions(+), Y deletions(-)" line.
function parseLog(output) {
  const commits = [];
  for (const line of output.split('\n')) {
    if (/^[0-9a-f]{40}\t/.test(line)) {
      const [sha, short, author, when, subject] = line.split('\t');
      commits.push({ sha, short, author, when, subject, files: 0, ins: 0, del: 0 });
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

// --- Dependency analysis (import-level, heuristic) ---------------------------

const JS_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const JS_IMPORT_RES = [
  /import\s+[^'"()]*?from\s+['"]([^'"]+)['"]/g,
  /import\s*\(\s*['"]([^'"]+)['"]/g,
  /require\s*\(\s*['"]([^'"]+)['"]/g,
  /export\s+[^'"()]*?from\s+['"]([^'"]+)['"]/g,
];
const PY_IMPORT_RES = [/^\s*import\s+([\w.]+)/gm, /^\s*from\s+([.\w]+)\s+import/gm];

// Extract import specifiers from source text, by file extension.
function parseImports(filePath, source) {
  const ext = path.posix.extname(filePath);
  const regexes = ext === '.py' ? PY_IMPORT_RES : JS_EXTS.includes(ext) ? JS_IMPORT_RES : [];
  const specs = [];
  for (const re of regexes) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source))) specs.push(m[1]);
  }
  return specs;
}

// Resolve an import specifier from `fromFile` to a path in `changedSet`, or undefined.
function resolveImport(fromFile, spec, changedSet) {
  const dir = path.posix.dirname(fromFile);
  const candidates = [];
  if (fromFile.endsWith('.py')) {
    const rel = spec.replace(/^\.+/, '');
    const base = rel.replace(/\./g, '/');
    candidates.push(`${base}.py`, `${base}/__init__.py`);
    if (spec.startsWith('.')) candidates.push(path.posix.join(dir, `${base}.py`));
  } else if (spec.startsWith('.')) {
    const base = path.posix.normalize(path.posix.join(dir, spec));
    candidates.push(base);
    for (const e of JS_EXTS) candidates.push(base + e, `${base}/index${e}`);
  }
  return candidates.find((c) => changedSet.has(c));
}

// Edges among changed files: {from, to} = "from imports to".
function buildEdges(sources) {
  const changedSet = new Set(sources.keys());
  const edges = [];
  for (const [file, source] of sources) {
    for (const spec of parseImports(file, source)) {
      const to = resolveImport(file, spec, changedSet);
      if (to && to !== file) edges.push({ from: file, to });
    }
  }
  return edges;
}

// Dependencies-first ordering: if A imports B, review B before A.
function reviewOrder(files, edges) {
  const indeg = new Map(files.map((f) => [f, 0]));
  const dependents = new Map(files.map((f) => [f, []]));
  for (const e of edges) {
    if (!indeg.has(e.from) || !indeg.has(e.to)) continue;
    dependents.get(e.to).push(e.from);
    indeg.set(e.from, indeg.get(e.from) + 1);
  }
  const queue = files.filter((f) => indeg.get(f) === 0);
  const order = [];
  while (queue.length) {
    const f = queue.shift();
    order.push(f);
    for (const n of dependents.get(f)) {
      indeg.set(n, indeg.get(n) - 1);
      if (indeg.get(n) === 0) queue.push(n);
    }
  }
  for (const f of files) if (!order.includes(f)) order.push(f); // cycles keep original order
  return order;
}

// --- Review summary export ---------------------------------------------------

// data: {rangeLabel, files: [{path, status, risks, reviewed, note, comments: [{line, text, code}]}]}
function buildSummaryMd(data) {
  const lines = [`# Code review feedback (${data.rangeLabel})`, ''];
  const withFeedback = data.files.filter((f) => f.note || (f.comments && f.comments.length));
  if (withFeedback.length) {
    lines.push('## Action items', '');
    for (const f of withFeedback) {
      if (f.note) lines.push(`### ${f.path}`, '', f.note, '');
      for (const c of f.comments || []) {
        lines.push(`### ${f.path}:${c.line}`, '');
        if (c.code) lines.push('```', c.code, '```');
        lines.push(c.text, '');
      }
    }
  } else {
    lines.push('_No notes or comments._', '');
  }
  lines.push('## Files in this change', '');
  for (const f of data.files) {
    const flags = [
      STATUS_LABEL[f.status] || f.status,
      f.reviewed ? 'reviewed ✓' : 'NOT reviewed',
      ...(f.risks.length ? [`⚠ ${f.risks.join(', ')}`] : []),
    ];
    lines.push(`- \`${f.path}\` — ${flags.join(', ')}`);
  }
  return lines.join('\n') + '\n';
}

// URI the built-in git extension's content provider understands.
function gitUri(repoRoot, filePath, ref) {
  const abs = path.join(repoRoot, filePath);
  return vscode.Uri.file(abs).with({ scheme: 'git', query: JSON.stringify({ path: abs, ref }) });
}

const NOOP_STATE = { get: (k, d) => d, update: async () => {} };

class CommitTreeProvider {
  constructor(state) {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this.state = state || NOOP_STATE;
    this.mode = 'commits'; // 'commits' | 'combined'
    // Number of remote-history commits to show below the local (unpushed) ones.
    this.extra = 0;
  }

  refresh() {
    this._onDidChangeTreeData.fire();
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
    vscode.commands.executeCommand('setContext', 'commitFileTree.combined', mode === 'combined');
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
    return [ctx.target, ctx.base, 'working'].flatMap((ref) => store[`${ref}:${filePath}`] || []);
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
      prompt: `Note for ${item.filePath}`,
      value: notes[item.reviewId] || '',
      placeHolder: 'Leave empty to remove the note',
    });
    if (text === undefined) return; // cancelled
    if (text) notes[item.reviewId] = text;
    else delete notes[item.reviewId];
    await this.state.update('cft.notes', notes);
    this.refresh();
  }

  getTreeItem(element) {
    return element;
  }

  async getChildren(element) {
    const root = this.repoRoot;
    if (!root) return [];
    try {
      if (!element) {
        return this.mode === 'combined' ? await this.getCombined(root) : await this.getCommits(root);
      }
      if (element.contextValue === 'commit') {
        const out = await git(root, ['show', '--format=', '--name-status', element.sha]);
        const ctx = { base: `${element.sha}~1`, target: element.sha, keyRef: element.sha };
        return this.getTreeNodes(buildTree(parseNameStatus(out)), ctx);
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

  async getUnpushedRange(root) {
    const base = (await git(root, ['rev-parse', '@{upstream}'])).trim();
    const target = (await git(root, ['rev-parse', 'HEAD'])).trim();
    return { base, target, keyRef: base };
  }

  async getCombined(root) {
    let ctx;
    try {
      ctx = await this.getUnpushedRange(root);
    } catch (e) {
      const item = new vscode.TreeItem('No upstream branch', vscode.TreeItemCollapsibleState.None);
      item.description = 'combined view needs one — switch to commit view';
      item.iconPath = new vscode.ThemeIcon('warning');
      return [item];
    }
    if (ctx.base === ctx.target) return [this.allPushedItem()];
    const out = await git(root, ['diff', '--name-status', ctx.base, ctx.target]);
    return this.getTreeNodes(buildTree(parseNameStatus(out)), ctx);
  }

  allPushedItem() {
    const empty = new vscode.TreeItem('No unpushed commits', vscode.TreeItemCollapsibleState.None);
    empty.iconPath = new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'));
    empty.description = 'everything is pushed';
    return empty;
  }

  async getCommits(root) {
    const FORMAT = '--format=%H%x09%h%x09%an%x09%ar%x09%s';
    // Local (unpushed) commits are the focus; remote history is behind "Show pushed history".
    let local = [];
    let hasUpstream = true;
    try {
      local = parseLog(await git(root, ['log', '@{upstream}..HEAD', '--shortstat', FORMAT]));
    } catch (e) {
      hasUpstream = false; // no upstream configured — fall back to plain history
    }
    let history = [];
    const historyLimit = hasUpstream ? this.extra : this.extra + 50;
    if (historyLimit > 0) {
      const base = hasUpstream ? '@{upstream}' : 'HEAD';
      history = parseLog(await git(root, ['log', `-${historyLimit}`, base, '--shortstat', FORMAT]));
    }
    const items = [
      ...local.map((c) => this.commitItem(c, true)),
      ...history.map((c) => this.commitItem(c, false)),
    ];
    if (hasUpstream && local.length === 0 && this.extra === 0) {
      items.unshift(this.allPushedItem());
    }
    if (historyLimit === 0 || history.length === historyLimit) {
      const more = new vscode.TreeItem('Show pushed history…', vscode.TreeItemCollapsibleState.None);
      more.iconPath = new vscode.ThemeIcon('cloud');
      more.description = hasUpstream ? 'commits already on the remote' : 'older commits';
      more.command = { command: 'commitFileTree.loadMore', title: 'Show Pushed History' };
      items.push(more);
    }
    if (this.extra > 0) {
      const hide = new vscode.TreeItem('Hide pushed history', vscode.TreeItemCollapsibleState.None);
      hide.iconPath = new vscode.ThemeIcon('fold-up');
      hide.command = { command: 'commitFileTree.hideHistory', title: 'Hide Pushed History' };
      items.push(hide);
    }
    return items;
  }

  commitItem(c, unpushed) {
    const item = new vscode.TreeItem(c.subject, vscode.TreeItemCollapsibleState.Collapsed);
    item.contextValue = 'commit';
    item.sha = c.sha;
    item.subject = c.subject;
    item.description = `${c.files} files +${c.ins} −${c.del} · ${c.when}`;
    item.iconPath = unpushed
      ? new vscode.ThemeIcon('git-commit', new vscode.ThemeColor('charts.blue'))
      : new vscode.ThemeIcon('git-commit', new vscode.ThemeColor('descriptionForeground'));
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${c.subject}**\n\n`);
    md.appendMarkdown(`\`${c.short}\` ${c.author}, ${c.when}${unpushed ? ' · *unpushed*' : ''}\n\n`);
    md.appendMarkdown(`${c.files} files changed, **+${c.ins}** **−${c.del}**`);
    item.tooltip = md;
    return item;
  }

  getTreeNodes(node, ctx) {
    const reviewed = this.reviewed();
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
        return item;
      });
    const files = node.files
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((f) => {
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
        for (const c of comments) lines.push(`💬 L${c.line}: ${c.text}`);
        if (isReviewed) lines.push('✓ Reviewed');
        item.tooltip = lines.join('\n');
        item.command = {
          command: 'commitFileTree.openDiff',
          title: 'Open Diff',
          arguments: [f.path, f.status, ctx],
        };
        return item;
      });
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

function changeResources(root, files, ctx) {
  return files.map((f) => [
    vscode.Uri.file(path.join(root, f.path)),
    f.status === 'A' ? undefined : gitUri(root, f.path, ctx.base),
    f.status === 'D' ? undefined : gitUri(root, f.path, ctx.target),
  ]);
}

function activate(context) {
  const provider = new CommitTreeProvider(context.workspaceState);
  vscode.commands.executeCommand('setContext', 'commitFileTree.combined', false);

  async function reviewAll(item) {
    const root = provider.repoRoot;
    if (!root) return;
    let ctx, files, title;
    try {
      if (item && item.contextValue === 'commit') {
        ctx = { base: `${item.sha}~1`, target: item.sha };
        files = parseNameStatus(await git(root, ['show', '--format=', '--name-status', item.sha]));
        title = `Review ${item.sha.slice(0, 7)}: ${item.subject}`;
      } else {
        ctx = await provider.getUnpushedRange(root);
        files = parseNameStatus(await git(root, ['diff', '--name-status', ctx.base, ctx.target]));
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
  const controller = vscode.comments.createCommentController('commitFileTree', 'Commit Review Tree');
  controller.commentingRangeProvider = {
    provideCommentingRanges(document) {
      if (!locOf(document.uri, provider.repoRoot)) return [];
      return [new vscode.Range(0, 0, Math.max(document.lineCount - 1, 0), 0)];
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
    const store = { ...provider.comments() };
    const key = `${loc.ref}:${loc.rel}`;
    store[key] = [...(store[key] || []), { line, text: reply.text }];
    await provider.state.update('cft.comments', store);
    reply.thread.comments = [...reply.thread.comments, commentBody(reply.text)];
    reply.thread.canReply = true;
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

  // Re-create persisted threads when a matching document opens.
  function restoreThreads(document) {
    const loc = locOf(document.uri, provider.repoRoot);
    if (!loc) return;
    const key = `${loc.ref}:${loc.rel}`;
    for (const c of provider.comments()[key] || []) {
      const threadKey = `${key}:${c.line}`;
      if (liveThreads.has(threadKey)) continue;
      const range = new vscode.Range(c.line - 1, 0, c.line - 1, 0);
      const thread = controller.createCommentThread(document.uri, range, [commentBody(c.text)]);
      thread.canReply = true;
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
      liveThreads.set(threadKey, thread);
    }
  }
  vscode.workspace.textDocuments.forEach(restoreThreads);

  // --- Export review summary ---
  async function exportSummary() {
    const root = provider.repoRoot;
    if (!root) return;
    let ctx;
    try {
      ctx = await provider.getUnpushedRange(root);
    } catch (e) {
      vscode.window.showWarningMessage('Commit Review Tree: no upstream branch — nothing to summarize.');
      return;
    }
    const files = parseNameStatus(await git(root, ['diff', '--name-status', ctx.base, ctx.target]));
    const shas = (await git(root, ['rev-list', `${ctx.base}..${ctx.target}`])).split('\n').filter(Boolean);
    const refs = new Set([...shas, ctx.base, ctx.target, 'working']);
    const reviewed = provider.reviewed();
    const notes = provider.notes();
    const store = provider.comments();
    const data = {
      rangeLabel: `${ctx.base.slice(0, 7)}..${ctx.target.slice(0, 7)}`,
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
              const code = content ? (content.split('\n')[c.line - 1] || '').trim() : '';
              comments.push({ line: c.line, text: c.text, code });
            }
          }
          comments.sort((a, b) => a.line - b.line);
          const anyRef = [...refs].find((r) => reviewed[`${r}:${f.path}`] || notes[`${r}:${f.path}`]);
          return {
            path: f.path,
            status: f.status,
            risks: riskReasons(f),
            reviewed: !!(anyRef && reviewed[`${anyRef}:${f.path}`]),
            note: anyRef ? notes[`${anyRef}:${f.path}`] : undefined,
            comments,
          };
        })
      ),
    };
    const md = buildSummaryMd(data);
    await vscode.env.clipboard.writeText(md);
    const doc = await vscode.workspace.openTextDocument({ content: md, language: 'markdown' });
    await vscode.window.showTextDocument(doc);
    vscode.window.showInformationMessage('Review summary copied to clipboard.');
  }

  // --- Dependency graph & review order ---
  async function showGraph() {
    const root = provider.repoRoot;
    if (!root) return;
    let ctx;
    try {
      ctx = await provider.getUnpushedRange(root);
    } catch (e) {
      vscode.window.showWarningMessage('Commit Review Tree: no upstream branch — nothing to analyze.');
      return;
    }
    const files = parseNameStatus(await git(root, ['diff', '--name-status', ctx.base, ctx.target]));
    const sources = new Map();
    for (const f of files) {
      const ref = f.status === 'D' ? ctx.base : ctx.target;
      const content = await git(root, ['show', `${ref}:${f.path}`]).catch(() => '');
      sources.set(f.path, content);
    }
    const edges = buildEdges(sources);
    const order = reviewOrder([...sources.keys()], edges);
    const id = (f) => 'n' + order.indexOf(f);
    const lines = [
      `# Suggested review order (${ctx.base.slice(0, 7)}..${ctx.target.slice(0, 7)})`,
      '',
      'Dependencies first — files imported by other changed files come before their importers.',
      '',
      ...order.map((f, i) => `${i + 1}. \`${f}\``),
      '',
      '## Dependency graph (importer → imported)',
      '',
      '```mermaid',
      'flowchart LR',
      ...order.map((f) => `  ${id(f)}["${f}"]`),
      ...edges.map((e) => `  ${id(e.from)} --> ${id(e.to)}`),
      '```',
      '',
      ...(edges.length
        ? edges.map((e) => `- \`${e.from}\` imports \`${e.to}\``)
        : ['_No import relationships detected among the changed files._']),
      '',
      '_Import detection is heuristic (JS/TS/Python static imports only)._',
    ];
    const doc = await vscode.workspace.openTextDocument({ content: lines.join('\n'), language: 'markdown' });
    await vscode.window.showTextDocument(doc);
    vscode.commands.executeCommand('markdown.showPreview', doc.uri);
  }

  context.subscriptions.push(
    controller,
    vscode.workspace.onDidOpenTextDocument(restoreThreads),
    vscode.commands.registerCommand('commitFileTree.addComment', saveComment),
    vscode.commands.registerCommand('commitFileTree.deleteThread', deleteThread),
    vscode.commands.registerCommand('commitFileTree.exportSummary', exportSummary),
    vscode.commands.registerCommand('commitFileTree.showGraph', showGraph),
    vscode.window.registerTreeDataProvider('commitFileTree', provider),
    vscode.window.registerFileDecorationProvider({
      provideFileDecoration(uri) {
        const m = /^cftStatus=([A-Z])&rev=([01])$/.exec(uri.query);
        if (!m) return undefined;
        const [, status, rev] = m;
        if (rev === '1') {
          return {
            badge: '✓',
            color: new vscode.ThemeColor('gitDecoration.ignoredResourceForeground'),
            tooltip: 'Reviewed',
          };
        }
        return {
          badge: status,
          color: new vscode.ThemeColor(STATUS_COLOR[status] || 'foreground'),
          tooltip: STATUS_LABEL[status] || status,
        };
      },
    }),
    vscode.commands.registerCommand('commitFileTree.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('commitFileTree.loadMore', () => provider.loadMore()),
    vscode.commands.registerCommand('commitFileTree.hideHistory', () => provider.hideHistory()),
    vscode.commands.registerCommand('commitFileTree.viewCombined', () => provider.setMode('combined')),
    vscode.commands.registerCommand('commitFileTree.viewByCommits', () => provider.setMode('commits')),
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
    vscode.commands.registerCommand('commitFileTree.openDiff', (filePath, status, ctx) => {
      const root = provider.repoRoot;
      if (!root) return;
      const title = `${path.basename(filePath)} (${ctx.target.slice(0, 7)})`;
      // Added: no base-side version (may even be a root commit) — open the new content.
      if (status === 'A') {
        return vscode.commands.executeCommand('vscode.open', gitUri(root, filePath, ctx.target));
      }
      // Deleted: no version at target — open the old content.
      if (status === 'D') {
        return vscode.commands.executeCommand('vscode.open', gitUri(root, filePath, ctx.base));
      }
      const left = gitUri(root, filePath, ctx.base);
      const right = gitUri(root, filePath, ctx.target);
      return vscode.commands.executeCommand('vscode.diff', left, right, title);
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
  reviewOrder,
  buildSummaryMd,
  CommitTreeProvider,
};
