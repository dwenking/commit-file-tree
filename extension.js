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
        const markers = [];
        if (risks.length && !isReviewed) markers.push(`⚠ ${risks.join(', ')}`);
        if (note) markers.push('📝');
        item.description = markers.join(' ') || undefined;
        const lines = [`${STATUS_LABEL[f.status] || f.status}: ${f.path}`];
        if (risks.length) lines.push(`⚠ Review carefully: ${risks.join(', ')}`);
        if (note) lines.push(`📝 ${note}`);
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

  context.subscriptions.push(
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
  CommitTreeProvider,
};
