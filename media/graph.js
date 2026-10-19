// Commit graph webview: renders the rows posted by the extension (graphRows in
// extension.js) with vscode-elements' tree, and posts user actions back.
const vscode = acquireVsCodeApi();
const tree = document.querySelector('vscode-tree');
// Expand state the user changed, by row id; survives refreshes and reloads.
const state = vscode.getState() || { open: {} };

// Inline (hover) actions, mirroring the tree's `view/item/context` inline menus.
const ACTIONS = {
  commit: [['commitFileTree.reviewAll', 'diff-multiple', 'Review All Changes'], ['commitFileTree.revertCommit', 'discard', 'Revert This Commit']],
  worktree: [['commitFileTree.reviewAll', 'diff-multiple', 'Review All Changes']],
  file: [['commitFileTree.toggleReviewed', 'check', 'Toggle Reviewed'], ['commitFileTree.editNote', 'edit', 'Add/Edit Note']],
  dir: [['commitFileTree.editNote', 'edit', 'Add/Edit Note']],
};

const color = (id) => `var(--vscode-${id.replace(/\./g, '-')})`;

function el(tag, attrs, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) e.setAttribute(k, v);
  e.append(...children);
  return e;
}

function icon(name, slot, colorId) {
  const i = el('vscode-icon', { name, slot });
  if (colorId) i.style.color = color(colorId);
  return i;
}

// The native tree's checkbox (codicon check on a 16px box, see graph.css), not
// vscode-checkbox: that is an 18px form control with margins and a hidden input
// whose focus scroll made the box jump on click.
function checkbox(r) {
  const title = r.context === 'worktree' ? 'Include uncommitted changes' : 'In review range';
  const box = el('span', { class: 'checkbox codicon codicon-check', role: 'checkbox', tabindex: '0', title });
  const set = (on) => {
    box.classList.toggle('checked', on);
    box.setAttribute('aria-checked', String(on));
  };
  set(r.checked);
  const toggle = (e) => {
    // Keep the click / key from selecting or expanding the row.
    e.stopPropagation();
    e.preventDefault();
    set(!box.classList.contains('checked'));
    vscode.postMessage({ type: 'check', id: r.id, checked: box.classList.contains('checked') });
  };
  box.addEventListener('click', toggle);
  box.addEventListener('keydown', (e) => (e.key === ' ' || e.key === 'Enter') && toggle(e));
  return box;
}

function row(r, nested) {
  const item = el('vscode-tree-item', {
    slot: nested ? 'children' : undefined,
    title: r.tooltip,
    'data-id': r.id,
    'data-lane': r.lane,
    'data-vscode-context': JSON.stringify({ webviewSection: r.context, preventDefaultContextMenuItems: true, ...r.ctx }),
  });
  // Icon: a Graph lane segment + dot for commits, the TreeItem's codicon otherwise.
  const slots = r.branch ? ['icon-branch', 'icon-branch-opened'] : ['icon-leaf'];
  for (const slot of slots) {
    if (r.lane) item.append(el('span', { slot, class: `lane ${r.lane}` }));
    else if (r.icon === 'folder') item.append(icon(slot === 'icon-branch-opened' ? 'folder-opened' : 'folder', slot));
    else if (r.icon) item.append(icon(r.icon, slot, r.iconColor));
    else if (r.context === 'file') item.append(icon('file', slot));
  }
  if (r.checked !== undefined) item.append(checkbox(r));
  const label = el('span', { class: 'label' }, r.label);
  if (r.deco) label.style.color = color(r.deco.color);
  item.append(label);
  if (r.description) item.append(el('span', { slot: 'description' }, r.description));
  // Right edge: branch badges (whole group capped at a quarter of the width), or the file status.
  if (r.refs && r.refs.length) {
    const badges = r.refs.map((ref) =>
      el('span', { class: `ref ${ref.remote ? 'remote' : 'local'}`, title: ref.name }, icon(ref.remote ? 'cloud' : 'target'), el('span', { class: 'name' }, ref.name))
    );
    item.append(el('span', { slot: 'decoration', class: 'refs' }, ...badges));
  }
  if (r.deco) {
    const badge = el('span', { slot: 'decoration', class: 'status' }, r.deco.badge);
    badge.style.color = color(r.deco.color);
    item.append(badge);
  }
  for (const [command, name, title] of ACTIONS[r.context] || []) {
    const btn = el('vscode-toolbar-button', { slot: 'actions', icon: name, label: title, title });
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: 'action', id: r.id, command });
    });
    item.append(btn);
  }
  // Children: folders come filled in; commits and the working tree load on expand,
  // with a placeholder so the tree treats them as expandable.
  if (r.children) item.append(...r.children.map((c) => row(c, true)));
  else if (r.branch) {
    item.dataset.lazy = '1';
    item.append(el('vscode-tree-item', { slot: 'children', class: 'pending' }, 'Loading…'));
  }
  if (r.id in state.open ? state.open[r.id] : r.open) item.setAttribute('open', '');
  return item;
}

function load(item) {
  if (!item.dataset.lazy || item.dataset.loading) return;
  item.dataset.loading = '1';
  vscode.postMessage({ type: 'children', id: item.dataset.id });
}

const kids = (item) => item.querySelectorAll(':scope > vscode-tree-item');

window.addEventListener('message', ({ data }) => {
  if (data.type === 'root') {
    const prev = new Map([...tree.querySelectorAll('vscode-tree-item[data-id]')].map((i) => [i.dataset.id, i]));
    tree.replaceChildren(...data.rows.map((r) => row(r, false)));
    for (const item of tree.querySelectorAll('vscode-tree-item[open][data-lazy]')) {
      // Refresh: show the last-known files until fresh ones arrive, instead of "Loading…".
      const old = prev.get(item.dataset.id);
      if (old && !old.dataset.lazy) item.querySelector(':scope > .pending').replaceWith(...kids(old));
      load(item);
    }
  }
  if (data.type === 'children') {
    const item = tree.querySelector(`vscode-tree-item[data-id="${CSS.escape(data.id)}"]`);
    if (!item) return;
    delete item.dataset.lazy;
    kids(item).forEach((c) => c.remove());
    item.append(...data.rows.map((r) => row(r, true)));
  }
});

// Expanding a row: remember it, and fetch lazy children the first time.
new MutationObserver((records) => {
  for (const { target } of records) {
    if (!target.dataset.id) continue;
    state.open[target.dataset.id] = target.hasAttribute('open');
    if (target.hasAttribute('open')) load(target);
  }
  vscode.setState(state);
}).observe(tree, { subtree: true, attributes: true, attributeFilter: ['open'] });

// Click / Enter on a row runs its TreeItem command (open diff, show history, ...).
tree.addEventListener('vsc-tree-select', (e) => {
  const selected = Array.isArray(e.detail) ? e.detail : e.detail.selectedItems;
  const item = selected && selected[0];
  if (item && item.dataset.id) vscode.postMessage({ type: 'run', id: item.dataset.id });
});

vscode.postMessage({ type: 'ready' });
