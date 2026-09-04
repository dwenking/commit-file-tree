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
    const out = await git(root, ['log', '-50', '--format=%H%x09%h%x09%an%x09%ar%x09%s']);
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha, short, author, when, subject] = line.split('\t');
        const item = new vscode.TreeItem(subject, vscode.TreeItemCollapsibleState.Collapsed);
        item.contextValue = 'commit';
        item.sha = sha;
        item.description = `${short} · ${author} · ${when}`;
        item.tooltip = `${subject}\n${sha}\n${author}, ${when}`;
        item.iconPath = new vscode.ThemeIcon('git-commit');
        return item;
      });
  }

  getTreeNodes(node, sha) {
    const dirs = [...node.dirs.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, child]) => {
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
        item.resourceUri = vscode.Uri.file(path.join(this.repoRoot, f.path));
        item.description = f.status;
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

function activate(context) {
  const provider = new CommitTreeProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('commitFileTree', provider),
    vscode.commands.registerCommand('commitFileTree.refresh', () => provider.refresh()),
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

module.exports = { activate, deactivate, parseNameStatus, buildTree };
