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

const STATUS_LABEL = { A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed', C: 'Copied' };

// URI the built-in git extension's content provider understands.
function gitUri(repoRoot, filePath, ref) {
  const abs = path.join(repoRoot, filePath);
  return vscode.Uri.file(abs).with({ scheme: 'git', query: JSON.stringify({ path: abs, ref }) });
}

class CommitTreeProvider {
  constructor() {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    // Number of remote-history commits to show below the local (unpushed) ones.
    this.extra = 0;
  }

  loadMore() {
    this.extra += 50;
    this.refresh();
  }

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  get repoRoot() {
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length ? folders[0].uri.fsPath : undefined;
  }

  getTreeItem(element) {
    return element;
  }

  async getChildren(element) {
    const root = this.repoRoot;
    if (!root) return [];
    try {
      if (!element) return await this.getCommits(root);
      if (element.contextValue === 'commit') {
        const out = await git(root, ['show', '--format=', '--name-status', element.sha]);
        element.tree = buildTree(parseNameStatus(out));
        return this.getTreeNodes(element.tree, element.sha);
      }
      if (element.contextValue === 'dir') {
        return this.getTreeNodes(element.node, element.sha);
      }
    } catch (e) {
      // Not a git repo, or git failed — show nothing rather than erroring.
      return [];
    }
    return [];
  }

  async getCommits(root) {
    const FORMAT = '--format=%H%x09%h%x09%an%x09%ar%x09%s';
    // Local (unpushed) commits are the focus; remote history is behind "Load more".
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
      const empty = new vscode.TreeItem('No unpushed commits', vscode.TreeItemCollapsibleState.None);
      empty.iconPath = new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'));
      empty.description = 'everything is pushed';
      items.unshift(empty);
    }
    if (historyLimit === 0 || history.length === historyLimit) {
      const more = new vscode.TreeItem('Show pushed history…', vscode.TreeItemCollapsibleState.None);
      more.iconPath = new vscode.ThemeIcon('cloud');
      more.description = hasUpstream ? 'commits already on the remote' : 'older commits';
      more.command = { command: 'commitFileTree.loadMore', title: 'Show Pushed History' };
      items.push(more);
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

  getTreeNodes(node, sha) {
    const dirs = [...node.dirs.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([rawName, rawChild]) => {
        const { name, node: child } = compactDir(rawName, rawChild);
        const item = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.Expanded);
        item.contextValue = 'dir';
        item.node = child;
        item.sha = sha;
        item.iconPath = vscode.ThemeIcon.Folder;
        return item;
      });
    const files = node.files
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((f) => {
        const item = new vscode.TreeItem(f.name, vscode.TreeItemCollapsibleState.None);
        item.contextValue = 'file';
        // Query marks the URI for our FileDecorationProvider (badge + color).
        item.resourceUri = vscode.Uri.file(path.join(this.repoRoot, f.path)).with({
          query: `cftStatus=${f.status}`,
        });
        item.tooltip = `${STATUS_LABEL[f.status] || f.status}: ${f.path}`;
        item.command = {
          command: 'commitFileTree.openDiff',
          title: 'Open Diff',
          arguments: [f.path, f.status, sha],
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

function activate(context) {
  const provider = new CommitTreeProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('commitFileTree', provider),
    vscode.window.registerFileDecorationProvider({
      provideFileDecoration(uri) {
        const m = /^cftStatus=([A-Z])$/.exec(uri.query);
        if (!m) return undefined;
        const status = m[1];
        return {
          badge: status,
          color: new vscode.ThemeColor(STATUS_COLOR[status] || 'foreground'),
          tooltip: STATUS_LABEL[status] || status,
        };
      },
    }),
    vscode.commands.registerCommand('commitFileTree.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('commitFileTree.loadMore', () => provider.loadMore()),
    vscode.commands.registerCommand('commitFileTree.copySha', (item) =>
      vscode.env.clipboard.writeText(item.sha)
    ),
    vscode.commands.registerCommand('commitFileTree.copyMessage', (item) =>
      vscode.env.clipboard.writeText(item.subject)
    ),
    vscode.commands.registerCommand('commitFileTree.openDiff', (filePath, status, sha) => {
      const root = provider.repoRoot;
      if (!root) return;
      const title = `${path.basename(filePath)} (${sha.slice(0, 7)})`;
      // Added: no parent-side version (may even be a root commit) — open the new content.
      if (status === 'A') {
        return vscode.commands.executeCommand('vscode.open', gitUri(root, filePath, sha));
      }
      // Deleted: no version at sha — open the old content.
      if (status === 'D') {
        return vscode.commands.executeCommand('vscode.open', gitUri(root, filePath, `${sha}~1`));
      }
      const left = gitUri(root, filePath, `${sha}~1`);
      const right = gitUri(root, filePath, sha);
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
  CommitTreeProvider,
};
