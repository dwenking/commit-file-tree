const vscode = require('vscode');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

function git(cwd, args) {
  return new Promise((resolve, reject) => {
    cp.execFile('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

// Parse `git show --name-status` lines into [{status, path, oldPath?}].
// Renames/copies (R100\told\tnew) use the new path; oldPath keeps the origin,
// needed to show the base side of the diff (the new path doesn't exist there).
function parseNameStatus(output) {
  const files = [];
  for (const line of output.split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 2 || !parts[0]) continue;
    const status = parts[0][0];
    const f = { status, path: parts[parts.length - 1] };
    if (parts.length > 2) f.oldPath = parts[1];
    files.push(f);
  }
  return files;
}

// Build a nested tree: {dirs: Map<name, node>, files: [{name, status, path}]}
function buildTree(files) {
  const root = { dirs: new Map(), files: [] };
  for (const f of files) {
    const segments = f.path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i];
      if (!node.dirs.has(seg)) {
        node.dirs.set(seg, { dirs: new Map(), files: [], path: segments.slice(0, i + 1).join('/') });
      }
      node = node.dirs.get(seg);
    }
    node.files.push({ name: segments[segments.length - 1], status: f.status, path: f.path, oldPath: f.oldPath });
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

// If every file beneath a tree node shares status D (or A), the folder itself
// was effectively deleted (or added). Mixed content returns undefined.
function aggStatus(node) {
  let s;
  const walk = (n) => {
    for (const f of n.files) {
      if (s === undefined) s = f.status;
      else if (s !== f.status) s = null;
    }
    for (const [, c] of n.dirs) walk(c);
  };
  walk(node);
  return s === 'D' || s === 'A' ? s : undefined;
}

// --- Dependency analysis (import-level, heuristic) ---------------------------

const JS_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte'];
const JS_IMPORT_RES = [
  /import\s+[^'"()]*?from\s+['"]([^'"]+)['"]/g,
  /import\s*\(\s*['"]([^'"]+)['"]/g,
  /require\s*\(\s*['"]([^'"]+)['"]/g,
  /export\s+[^'"()]*?from\s+['"]([^'"]+)['"]/g,
];
const PY_IMPORT_RES = [/^\s*import\s+([\w.]+)/gm, /^\s*from\s+([.\w]+)\s+import/gm];
const JAVA_EXTS = ['.java', '.kt', '.kts', '.scala', '.groovy'];
const JAVA_IMPORT_RES = [/^\s*import\s+(?:static\s+)?(\w+(?:\.\w+)*(?:\.\*)?)/gm];
const C_EXTS = ['.c', '.h', '.cpp', '.hpp', '.cc', '.hh', '.cxx', '.hxx'];
const C_IMPORT_RES = [/^\s*#\s*include\s*["<]([^">]+)[">]/gm];
const RUST_IMPORT_RES = [/^\s*(?:pub\s+)?use\s+([\w:]+)/gm, /^\s*(?:pub\s+)?mod\s+(\w+)\s*;/gm];
const CS_IMPORT_RES = [/^\s*using\s+(?:static\s+)?(\w+(?:\.\w+)*)\s*;/gm];
const RB_IMPORT_RES = [/require(?:_relative)?\s*\(?\s*['"]([^'"]+)['"]/g];
const PHP_IMPORT_RES = [/^\s*use\s+([\w\\]+)/gm, /(?:require|include)(?:_once)?\s*\(?\s*['"]([^'"]+)['"]/g];

const LANG_RES = new Map([
  ...JS_EXTS.map((e) => [e, JS_IMPORT_RES]),
  ...JAVA_EXTS.map((e) => [e, JAVA_IMPORT_RES]),
  ...C_EXTS.map((e) => [e, C_IMPORT_RES]),
  ['.py', PY_IMPORT_RES],
  ['.rs', RUST_IMPORT_RES],
  ['.cs', CS_IMPORT_RES],
  ['.rb', RB_IMPORT_RES],
  ['.php', PHP_IMPORT_RES],
]);

// Extract import specifiers from source text, by file extension.
function parseImports(filePath, source) {
  const ext = path.posix.extname(filePath);
  const specs = [];
  for (const re of LANG_RES.get(ext) || []) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source))) specs.push(m[1]);
  }
  if (ext === '.go') {
    // single imports and import ( ... ) blocks
    for (const m of source.matchAll(/^\s*import\s+(?:\w+\s+)?"([^"]+)"/gm)) specs.push(m[1]);
    for (const b of source.matchAll(/import\s*\(([^)]*)\)/g)) {
      for (const m of b[1].matchAll(/"([^"]+)"/g)) specs.push(m[1]);
    }
  }
  return specs;
}

// Does some changed file's path (sans extension) end with this suffix?
function bySuffix(changedSet, exts, suffix, dirOnly) {
  for (const f of changedSet) {
    if (exts && !exts.includes(path.posix.extname(f))) continue;
    const noExt = '/' + f.replace(/\.[^./]+$/, '');
    if (dirOnly ? path.posix.dirname(noExt).endsWith(suffix) : noExt.endsWith(suffix)) return f;
  }
  return undefined;
}

// Resolve an import specifier from `fromFile` to a path in `changedSet`, or undefined.
// All of this is heuristic: fully-qualified names and include paths resolve by
// path suffix, so source-root prefixes (src/main/java/, module dirs) don't matter.
// ponytail: identical trailing paths across modules may cross-match
function resolveImport(fromFile, spec, changedSet) {
  const dir = path.posix.dirname(fromFile);
  const ext = path.posix.extname(fromFile);
  const candidates = [];

  if (JAVA_EXTS.includes(ext)) {
    const wildcard = spec.endsWith('.*');
    const clean = spec.replace(/\.\*$/, '');
    if (wildcard) return bySuffix(changedSet, JAVA_EXTS, '/' + clean.replace(/\./g, '/'), true);
    // plain import → class path; static import → also try dropping the member
    for (const c of [clean, clean.split('.').slice(0, -1).join('.')]) {
      const hit = c && bySuffix(changedSet, JAVA_EXTS, '/' + c.replace(/\./g, '/'));
      if (hit) return hit;
    }
    return undefined;
  }
  if (ext === '.go') {
    // package path → directory of changed .go files; longest suffix wins
    const segs = spec.split('/');
    for (let i = 0; i < segs.length; i++) {
      const hit = bySuffix(changedSet, ['.go'], '/' + segs.slice(i).join('/'), true);
      if (hit) return hit;
    }
    return undefined;
  }
  if (ext === '.rs') {
    const segs = spec.split('::').filter((s) => !['crate', 'self', 'super', ''].includes(s));
    // mod foo; → sibling foo.rs / foo/mod.rs
    if (!spec.includes('::')) {
      candidates.push(path.posix.join(dir, `${spec}.rs`), path.posix.join(dir, spec, 'mod.rs'));
    }
    // use a::b::Item — trailing segments may be items, drop from the right
    for (let k = segs.length; k >= 1; k--) {
      const p = '/' + segs.slice(0, k).join('/');
      const hit =
        bySuffix(changedSet, ['.rs'], p) ||
        bySuffix(new Set([...changedSet].filter((f) => f.endsWith('/mod.rs'))), null, p + '/mod');
      if (hit) return hit;
    }
  } else if (C_EXTS.includes(ext)) {
    candidates.push(path.posix.normalize(path.posix.join(dir, spec)));
    const hit = bySuffix(changedSet, null, '/' + spec.replace(/\.[^./]+$/, ''));
    if (hit) return hit;
  } else if (ext === '.cs') {
    // namespace segments map to folders, but project dirs may keep dots
    // (Corp.App/Models) — drop leading segments until a suffix matches
    const segs = spec.split('.');
    for (let i = 0; i < segs.length; i++) {
      const p = '/' + segs.slice(i).join('/');
      const hit = bySuffix(changedSet, ['.cs'], p) || bySuffix(changedSet, ['.cs'], p, true);
      if (hit) return hit;
    }
  } else if (ext === '.rb') {
    candidates.push(path.posix.normalize(path.posix.join(dir, `${spec}.rb`)), `${spec}.rb`);
    const hit = bySuffix(changedSet, ['.rb'], '/' + spec.replace(/\.rb$/, ''));
    if (hit) return hit;
  } else if (ext === '.php') {
    if (spec.includes('\\')) {
      const segs = spec.split('\\').filter(Boolean);
      // PSR-4: namespace prefix maps to a source root — drop leading segments
      for (let i = 0; i < segs.length; i++) {
        const hit = bySuffix(changedSet, ['.php'], '/' + segs.slice(i).join('/'));
        if (hit) return hit;
      }
    } else {
      candidates.push(path.posix.normalize(path.posix.join(dir, spec)));
    }
  } else if (ext === '.py') {
    const base = spec.replace(/^\.+/, '').replace(/\./g, '/');
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
    vscode.commands.executeCommand('setContext', 'commitFileTree.mode', mode);
    if (this.view) {
      this.view.description = { commits: 'by commits', combined: 'combined', deps: 'by dependencies' }[mode];
    }
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

  // Required by TreeView.reveal(); only dependency-mode items track parents.
  getParent(element) {
    return element.parentItem;
  }

  async getChildren(element) {
    const root = this.repoRoot;
    if (!root) return [];
    try {
      if (!element) {
        this.updateBadge(root); // fire-and-forget
        if (this.mode === 'combined') return await this.getCombined(root);
        if (this.mode === 'deps') return await this.getDeps(root);
        return await this.getCommits(root);
      }
      if (element.contextValue === 'depfile') {
        // once a chain is opened, show the whole subtree expanded
        return element.depChildren.map((p) => {
          const child = this.depItem(p, [...element.ancestry, p], true);
          child.parentItem = element;
          return child;
        });
      }
      if (element.contextValue === 'depgroup') {
        return element.filesList.map((p) => {
          const child = this.depItem(p, [p]);
          child.parentItem = element;
          return child;
        });
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

  // Rounded view-header badge: number of changed files not yet marked reviewed.
  async updateBadge(root) {
    if (!this.view) return;
    try {
      const ctx = await this.getUnpushedRange(root);
      const files = parseNameStatus(await git(root, ['diff', '--name-status', ctx.base, ctx.target]));
      const reviewed = this.reviewed();
      // ponytail: a file counts as reviewed if marked under any ref (commit or combined scope)
      const done = new Set(Object.keys(reviewed).map((k) => k.slice(k.indexOf(':') + 1)));
      const left = files.filter((f) => !done.has(f.path)).length;
      this.view.badge = left > 0 ? { value: left, tooltip: `${left} file(s) awaiting review` } : undefined;
    } catch (e) {
      this.view.badge = undefined;
    }
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

  // Dependency mode: roots are foundations (files importing no other changed
  // file, review them first); a file's children are the changed files that
  // import it. Cycles surface their members as extra roots.
  async getDeps(root) {
    let ctx;
    try {
      ctx = await this.getUnpushedRange(root);
    } catch (e) {
      const item = new vscode.TreeItem('No upstream branch', vscode.TreeItemCollapsibleState.None);
      item.description = 'dependency view needs one — switch to commit view';
      item.iconPath = new vscode.ThemeIcon('warning');
      return [item];
    }
    if (ctx.base === ctx.target) return [this.allPushedItem()];
    const files = parseNameStatus(await git(root, ['diff', '--name-status', ctx.base, ctx.target]));
    const sources = new Map();
    for (const f of files) {
      const ref = f.status === 'D' ? ctx.base : ctx.target;
      sources.set(f.path, await git(root, ['show', `${ref}:${f.path}`]).catch(() => ''));
    }
    const edges = buildEdges(sources);
    const importers = new Map();
    const outEdges = new Map();
    const outdeg = new Map(files.map((f) => [f.path, 0]));
    for (const e of edges) {
      importers.set(e.to, [...(importers.get(e.to) || []), e.from]);
      outEdges.set(e.from, [...(outEdges.get(e.from) || []), e.to]);
      outdeg.set(e.from, outdeg.get(e.from) + 1);
    }
    const roots = files.map((f) => f.path).filter((p) => outdeg.get(p) === 0);
    const reachable = new Set();
    const stack = [...roots];
    while (stack.length) {
      const p = stack.pop();
      if (reachable.has(p)) continue;
      reachable.add(p);
      stack.push(...(importers.get(p) || []));
    }
    for (const f of files) if (!reachable.has(f.path)) roots.push(f.path);
    // Separate import chains from standalone files (no edges either way).
    const isolated = roots.filter((p) => !(importers.get(p) || []).length);
    const connected = roots.filter((p) => (importers.get(p) || []).length);
    const grouped = connected.length > 0 && isolated.length > 0;
    this._deps = { ctx, importers, outEdges, grouped, isolated, meta: new Map(files.map((f) => [f.path, f])) };
    if (!connected.length) return roots.map((p) => this.depItem(p, [p]));
    const items = connected.map((p) => this.depItem(p, [p]));
    if (grouped) items.push(this.depGroupItem());
    return items;
  }

  depGroupItem() {
    const group = new vscode.TreeItem(
      `Standalone files (${this._deps.isolated.length})`,
      vscode.TreeItemCollapsibleState.Collapsed
    );
    group.id = 'cft:depgroup';
    group.contextValue = 'depgroup';
    group.iconPath = new vscode.ThemeIcon('files');
    group.description = 'no import relationships with other changed files';
    group.filesList = this._deps.isolated;
    return group;
  }

  // Shortest chain from a root down to `target` in the dependency tree,
  // following the target's own imports upward (greedy, cycle-safe).
  depChainFor(target) {
    const { outEdges, grouped, isolated } = this._deps;
    const chain = [target];
    const seen = new Set(chain);
    let cur = target;
    let next;
    while ((next = (outEdges.get(cur) || []).find((n) => !seen.has(n)))) {
      chain.push(next);
      seen.add(next);
      cur = next;
    }
    chain.reverse();
    return { chain, inGroup: grouped && isolated.includes(target) };
  }

  depItem(p, ancestry, expandIfParent) {
    const { ctx, importers, meta } = this._deps;
    const m = meta.get(p) || {};
    const f = { name: path.posix.basename(p), status: m.status || 'M', path: p, oldPath: m.oldPath };
    const item = this.fileItem(f, ctx);
    item.id = 'cft:dep:' + ancestry.join('|');
    const children = (importers.get(p) || []).filter((c) => !ancestry.includes(c));
    const dir = path.posix.dirname(p);
    const parts = [dir === '.' ? '' : dir, item.description || ''];
    if (children.length) {
      parts.unshift(`↑${children.length}`);
      item.collapsibleState = expandIfParent
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed;
      item.contextValue = 'depfile';
      item.depChildren = children;
      item.ancestry = ancestry;
      item.tooltip = `${item.tooltip}\n↑ imported by ${children.length} changed file(s)`;
    }
    item.description = parts.filter(Boolean).join(' · ');
    return item;
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
    item.description = c.author;
    item.iconPath = unpushed
      ? new vscode.ThemeIcon('git-commit', new vscode.ThemeColor('charts.blue'))
      : new vscode.ThemeIcon('git-commit', new vscode.ThemeColor('descriptionForeground'));
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${c.subject}**\n\n`);
    md.appendMarkdown(`${c.author}, ${c.when}${unpushed ? ' · *unpushed*' : ''}\n\n`);
    md.appendMarkdown(`${c.files} files changed, **+${c.ins}** insertions, **−${c.del}** deletions\n\n`);
    md.appendMarkdown(`\`${c.short}\``);
    item.tooltip = md;
    return item;
  }

  fileItem(f, ctx) {
    const reviewed = this.reviewed();
    const notes = this.notes();
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
      arguments: [f.path, f.status, ctx, f.oldPath],
    };
    return item;
  }

  getTreeNodes(node, ctx) {
    const dirs = [...node.dirs.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([rawName, rawChild]) => {
        const { name, node: child } = compactDir(rawName, rawChild);
        const item = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.Expanded);
        item.contextValue = 'dir';
        item.node = child;
        item.ctx = ctx;
        item.iconPath = vscode.ThemeIcon.Folder;
        let agg = aggStatus(child);
        // Unchanged files never appear in the diff, so "all D" only means the
        // folder is gone if it no longer exists on disk.
        if (agg === 'D' && child.path && fs.existsSync(path.join(this.repoRoot, child.path))) {
          agg = undefined;
        }
        if (agg) {
          item.resourceUri = vscode.Uri.file(path.join(this.repoRoot, child.path || name)).with({
            query: `cftStatus=${agg}&rev=0`,
          });
          item.tooltip = agg === 'D' ? 'Folder deleted (all files inside removed)' : 'All changed files inside are new';
        }
        return item;
      });
    const files = node.files
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((f) => this.fileItem(f, ctx));
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
    f.status === 'A' ? undefined : gitUri(root, f.oldPath || f.path, ctx.base),
    f.status === 'D' ? undefined : gitUri(root, f.path, ctx.target),
  ]);
}

function activate(context) {
  const provider = new CommitTreeProvider(context.workspaceState);
  vscode.commands.executeCommand('setContext', 'commitFileTree.mode', 'commits');

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
  // Only offer the "+" gutter on the cursor's line, not on every hovered line.
  const rangeProvider = {
    provideCommentingRanges(document) {
      if (!locOf(document.uri, provider.repoRoot)) return [];
      const ed = vscode.window.activeTextEditor;
      if (!ed || ed.document.uri.toString() !== document.uri.toString()) return [];
      return ed.selections.map((s) => new vscode.Range(s.start.line, 0, s.end.line, 0));
    },
  };
  controller.commentingRangeProvider = rangeProvider;
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
    reply.thread.contextValue = 'saved'; // gates the Delete button to real threads
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
      thread.contextValue = 'saved';
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
      liveThreads.set(threadKey, thread);
    }
  }
  vscode.workspace.textDocuments.forEach(restoreThreads);
  const selectionListener = vscode.window.onDidChangeTextEditorSelection((e) => {
    if (!locOf(e.textEditor.document.uri, provider.repoRoot)) return;
    // ponytail: reassigning the provider pokes VS Code into re-querying ranges
    controller.commentingRangeProvider = rangeProvider;
  });

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

  const view = vscode.window.createTreeView('commitFileTree', { treeDataProvider: provider });
  provider.view = view;
  view.description = 'by commits';

  let backMode;
  function setBack(mode) {
    backMode = mode;
    vscode.commands.executeCommand('setContext', 'commitFileTree.canGoBack', !!mode);
  }

  // Switch to dependency mode and reveal the file's shortest import chain.
  async function revealInDeps(item) {
    const root = provider.repoRoot;
    if (!root || !item || !item.filePath) return;
    setBack(provider.mode !== 'deps' ? provider.mode : undefined);
    provider.setMode('deps');
    await provider.getDeps(root); // ensure the dependency model exists
    const target = item.filePath;
    if (!provider._deps || !provider._deps.meta.has(target)) {
      vscode.window.showInformationMessage('Commit Review Tree: file is not part of the unpushed change set.');
      return;
    }
    const { chain, inGroup } = provider.depChainFor(target);
    let parent = inGroup ? provider.depGroupItem() : undefined;
    let el = parent;
    for (let i = 0; i < chain.length; i++) {
      el = provider.depItem(chain[i], chain.slice(0, i + 1));
      el.parentItem = parent;
      parent = el;
    }
    try {
      // expand: 3 is the API's maximum subtree depth
      await view.reveal(el, { select: true, expand: 3, focus: true });
    } catch (e) {
      // reveal is best-effort; the mode switch alone already helps
    }
  }

  context.subscriptions.push(
    view,
    controller,
    selectionListener,
    vscode.workspace.onDidOpenTextDocument(restoreThreads),
    vscode.commands.registerCommand('commitFileTree.addComment', saveComment),
    vscode.commands.registerCommand('commitFileTree.deleteThread', deleteThread),
    vscode.commands.registerCommand('commitFileTree.exportSummary', exportSummary),
    vscode.commands.registerCommand('commitFileTree.revealInDeps', revealInDeps),
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
    vscode.commands.registerCommand('commitFileTree.viewCombined', () => { setBack(undefined); provider.setMode('combined'); }),
    vscode.commands.registerCommand('commitFileTree.viewByDeps', () => { setBack(undefined); provider.setMode('deps'); }),
    vscode.commands.registerCommand('commitFileTree.viewByCommits', () => { setBack(undefined); provider.setMode('commits'); }),
    vscode.commands.registerCommand('commitFileTree.goBack', () => {
      const mode = backMode || 'commits';
      setBack(undefined);
      provider.setMode(mode);
    }),
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
    vscode.commands.registerCommand('commitFileTree.openDiff', (filePath, status, ctx, oldPath) => {
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
      // Renames/copies: the base side lives at the old path.
      const left = gitUri(root, oldPath || filePath, ctx.base);
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
  buildSummaryMd,
  aggStatus,
  CommitTreeProvider,
};
