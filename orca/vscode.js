// The VS Code API that extension.js uses, implemented over Orca. worker.js resolves
// 'vscode' to this module and connects it to a host (what Orca and the panel can do),
// then runs the extension's own activate(): its commands, views and review state are
// the same code in both editors. Only what the extension calls is here.
const path = require('path');

// Settings fall back to the defaults declared in package.json, as in VS Code.
const settings = require('../package.json').contributes.configuration.properties;
const exportDir = path.posix.dirname(settings['commitFileTree.exportPath'].default);

// Set by connect(): { root, view, ask, copy, show, openFile, context, log }.
let host;

const disposable = { dispose() {} };
const noEvent = () => disposable;

class Uri {
  constructor(scheme, fsPath, query = '') {
    this.scheme = scheme;
    this.fsPath = fsPath;
    this.query = query;
  }
  static file(fsPath) {
    return new Uri('file', fsPath);
  }
  static joinPath(base, ...segments) {
    return new Uri(base.scheme, path.join(base.fsPath, ...segments), base.query);
  }
  with(change) {
    return new Uri(change.scheme || this.scheme, this.fsPath, change.query === undefined ? this.query : change.query);
  }
  toString() {
    return `${this.scheme}://${this.fsPath}${this.query ? `?${this.query}` : ''}`;
  }
}

class TreeItem {
  constructor(label, collapsibleState) {
    this.label = label;
    if (collapsibleState !== undefined) this.collapsibleState = collapsibleState;
  }
}

class ThemeIcon {
  constructor(id, color) {
    this.id = id;
    this.color = color;
  }
}
ThemeIcon.Folder = new ThemeIcon('folder');
ThemeIcon.File = new ThemeIcon('file');

class ThemeColor {
  constructor(id) {
    this.id = id;
  }
}

class MarkdownString {
  constructor(value = '') {
    this.value = value;
  }
  appendMarkdown(s) {
    this.value += s;
  }
}

class Range {
  constructor(startLine, startCharacter, endLine, endCharacter) {
    this.start = { line: startLine, character: startCharacter };
    this.end = { line: endLine, character: endCharacter };
  }
}

// A listener that throws must not take the worker down: Orca exits a worker on an
// unhandled rejection, where VS Code's extension host only logs it.
const guarded = (what, run) =>
  Promise.resolve()
    .then(run)
    .catch((e) => host.log(`${what} failed: ${(e && e.stack) || e}`));

class EventEmitter {
  listeners = new Set();
  event = (listener) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  fire(e) {
    for (const listener of this.listeners) guarded('listener', () => listener(e));
  }
}

// What a document URI points at: a git revision of a file ({ path, ref } in the query,
// see gitUri in extension.js), or the file on disk ('working').
function sideOf(uri) {
  const at = (ref, file) => ({ ref, path: path.relative(host.root(), file).split(path.sep).join('/') });
  return uri.scheme === 'git' ? at(JSON.parse(uri.query).ref, JSON.parse(uri.query).path) : at('working', uri.fsPath);
}
const lineOf = (options) => (options && options.selection ? { line: options.selection.start.line + 1 } : {});

// The editor commands the extension runs become one request to the review editor:
// { title, files: [{ path, base?, target?, view? }], line? } with sides as { ref, path }.
const builtin = {
  setContext: (key, value) => host.context(key, value),
  'vscode.diff': (left, right, title, options) =>
    host.show({ title, files: [{ path: sideOf(right).path, base: sideOf(left), target: sideOf(right) }], ...lineOf(options) }),
  // One version of a file (added, deleted, a comment's file). An exported summary
  // is a document to read, not a change to review.
  'vscode.open': (uri, options) => {
    const side = sideOf(uri);
    if (uri.scheme === 'file' && side.path.startsWith(`${exportDir}/`)) return host.openFile(side.path);
    return host.show({ title: path.basename(side.path), files: [{ path: side.path, view: side }], ...lineOf(options) });
  },
  'vscode.changes': (title, resources) =>
    host.show({
      title,
      files: resources.map(([file, base, target]) => ({ path: sideOf(file).path, base: base && sideOf(base), target: target && sideOf(target) })),
    }),
};

const registered = new Map();
const commands = {
  registerCommand(id, handler) {
    registered.set(id, handler);
    return { dispose: () => registered.delete(id) };
  },
  // Resolves with the command's result, or undefined when it failed (logged).
  executeCommand(id, ...args) {
    const handler = builtin[id] || registered.get(id);
    return guarded(`command ${id}`, () => handler && handler(...args));
  },
  has: (id) => registered.has(id),
};

// VS Code's message boxes: a modal one waits for a choice, the others are toasts
// whose buttons may never be pressed.
function message(level, text, rest) {
  const modal = !!(rest[0] && typeof rest[0] === 'object' && rest[0].modal);
  return host.ask({ kind: modal ? 'confirm' : 'toast', level, message: text, actions: rest.filter((a) => typeof a === 'string') });
}

const window = {
  registerWebviewViewProvider(id, provider) {
    host.view(provider);
    return disposable;
  },
  showInputBox: (options) => host.ask({ kind: 'input', prompt: options.prompt, value: options.value, placeHolder: options.placeHolder }),
  async showQuickPick(items, options = {}) {
    const index = await host.ask({ kind: 'pick', placeHolder: options.placeHolder, items: items.map(({ label, description }) => ({ label, description })) });
    return index === undefined ? undefined : items[index];
  },
  showInformationMessage: (text, ...rest) => message('info', text, rest),
  showWarningMessage: (text, ...rest) => message('warning', text, rest),
  showErrorMessage: (text, ...rest) => message('error', text, rest),
  showTextDocument: (uri) => host.openFile(sideOf(uri).path),
  // No text editors to follow: the review editor keeps its own comments (worker.js).
  visibleTextEditors: [],
  onDidChangeActiveTextEditor: noEvent,
  onDidChangeTextEditorSelection: noEvent,
};

const workspace = {
  get workspaceFolders() {
    const root = host && host.root();
    return root ? [{ uri: Uri.file(root) }] : undefined;
  },
  textDocuments: [],
  onDidOpenTextDocument: noEvent,
  // worker.js watches the repository itself: the focused workspace changes, a VS Code window's does not.
  createFileSystemWatcher: () => ({ onDidChange: noEvent, onDidCreate: noEvent, onDidDelete: noEvent, dispose() {} }),
  getConfiguration: (section) => ({
    get(key, fallback) {
      const setting = settings[`${section}.${key}`];
      return setting && setting.default !== undefined ? setting.default : fallback;
    },
  }),
};

module.exports = {
  connect: (to) => (host = to),
  Uri,
  TreeItem,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  TreeItemCheckboxState: { Unchecked: 0, Checked: 1 },
  ThemeIcon,
  ThemeColor,
  MarkdownString,
  Range,
  EventEmitter,
  CommentMode: { Editing: 0, Preview: 1 },
  CommentThreadCollapsibleState: { Collapsed: 0, Expanded: 1 },
  commands,
  window,
  workspace,
  env: { clipboard: { writeText: async (text) => host.copy(text) } },
  // Threads are plain records: the review editor draws comments from the stored ones.
  comments: {
    createCommentController: () => ({ createCommentThread: (uri, range, comments) => ({ uri, range, comments, dispose() {} }), dispose() {} }),
  },
};
