// The view's webview, for every mode: renders the rows posted by the extension
// (graphRows in extension.js) with vscode-elements' tree, and posts user actions back.
const vscode = acquireVsCodeApi();
const tree = document.querySelector('vscode-tree');
// Expand state the user changed, by row id; survives refreshes and reloads.
const state = vscode.getState() || { open: {} };

// Inline (hover) actions by row type (the TreeItem's contextValue).
const ACTIONS = {
  commit: [['commitFileTree.reviewAll', 'diff-multiple', 'Review All Changes'], ['commitFileTree.revertCommit', 'discard', 'Revert This Commit']],
  worktree: [['commitFileTree.reviewAll', 'diff-multiple', 'Review All Changes']],
  file: [['commitFileTree.toggleReviewed', 'check', 'Toggle Reviewed'], ['commitFileTree.editNote', 'edit', 'Add/Edit Note']],
  dir: [['commitFileTree.editNote', 'edit', 'Add/Edit Note']],
  commententry: [['commitFileTree.editEntry', 'edit', 'Edit'], ['commitFileTree.deleteEntry', 'trash', 'Delete']],
  round: [['commitFileTree.archiveRound', 'archive', 'Archive Round']],
  roundarchived: [['commitFileTree.unarchiveRound', 'reply', 'Unarchive Round']],
};
ACTIONS.depfile = ACTIONS.file;

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
    // Commit rows get the hover card instead of a plain-text tooltip.
    title: r.lane ? undefined : r.tooltip,
    'data-id': r.id,
    'data-lane': r.lane,
    'data-context': r.context,
    'data-vscode-context': JSON.stringify({ webviewSection: r.context, preventDefaultContextMenuItems: true, ...r.ctx }),
  });
  // Icon: a Graph lane segment + dot for commits, the TreeItem's codicon otherwise.
  const slots = r.branch ? ['icon-branch', 'icon-branch-opened'] : ['icon-leaf'];
  for (const slot of slots) {
    if (r.lane) item.append(el('span', { slot, class: `lane ${r.lane}` }));
    else if (r.icon === 'folder') item.append(icon(slot === 'icon-branch-opened' ? 'folder-opened' : 'folder', slot));
    else if (r.icon) item.append(icon(r.icon, slot, r.iconColor));
    else if (r.context === 'file' || r.context === 'depfile') item.append(icon('file', slot));
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
  // Children: expanded rows come filled in; collapsed ones load on expand,
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
const rowOf = (id) => tree.querySelector(`vscode-tree-item[data-id="${CSS.escape(id)}"]`);

// Reveal in Dependency View: open each row down the chain (collapsed ones load their
// children first, so this resumes on every message), then select the last one.
let reveal = [];
function continueReveal() {
  while (reveal.length) {
    const item = rowOf(reveal[0]);
    if (!item) return;
    if (reveal.length > 1) {
      item.setAttribute('open', '');
      reveal.shift();
      continue;
    }
    for (const s of tree.querySelectorAll('vscode-tree-item[selected]')) s.selected = false;
    item.selected = true;
    item.scrollIntoView({ block: 'nearest' });
    reveal = [];
  }
}

window.addEventListener('message', ({ data }) => {
  if (data.type === 'reveal') reveal = data.ids;
  if (data.type === 'root') {
    const prev = new Map([...tree.querySelectorAll('vscode-tree-item[data-id]')].map((i) => [i.dataset.id, i]));
    const selected = [...tree.querySelectorAll('vscode-tree-item[selected]')].map((i) => i.dataset.id);
    tree.replaceChildren(...data.rows.map((r) => row(r, false)));
    // A refresh keeps the selection, like the native tree.
    for (const id of selected) if (rowOf(id)) rowOf(id).selected = true;
    for (const item of tree.querySelectorAll('vscode-tree-item[open][data-lazy]')) {
      // Refresh: show the last-known files until fresh ones arrive, instead of "Loading…".
      const old = prev.get(item.dataset.id);
      if (old && !old.dataset.lazy) item.querySelector(':scope > .pending').replaceWith(...kids(old));
      load(item);
    }
  }
  if (data.type === 'children') {
    const item = rowOf(data.id);
    if (!item) return;
    delete item.dataset.lazy;
    kids(item).forEach((c) => c.remove());
    item.append(...data.rows.map((r) => row(r, true)));
  }
  // Collapse All (view title): close every expanded row except folders, which only
  // group files. The open-attribute observer below records the new state.
  if (data.type === 'collapse') {
    for (const item of tree.querySelectorAll('vscode-tree-item[open]')) {
      if (item.dataset.context !== 'dir') item.removeAttribute('open');
    }
  }
  continueReveal();
  if (data.type === 'card') {
    cards.set(data.id, data.card);
    showCard(data.id);
  }
});

// Hover card for commit rows, like the Source Control Graph's. It appears after
// the workbench's default hover delay and is fetched once per commit (a commit's
// message and stats never change). A webview cannot draw beside the list the way
// the Graph's hover does, so the card covers rows instead; it lets the pointer
// through (see graph.css) so those rows stay reachable, and follows the pointer.
const card = el('div', { class: 'card', role: 'tooltip', hidden: '' });
document.body.append(card);
const cards = new Map();
let hovered; // id of the commit row under the pointer
let showTimer;
let dismissed; // a click closes the card until the pointer leaves that row

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function showCard(id) {
  const item = rowOf(id);
  const c = cards.get(id);
  if (hovered !== id || dismissed || !item || !c) return;
  const date = new Date(c.date).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const author = el('strong', { title: c.email }, c.author);
  const parts = [el('div', {}, author, ', ', icon('history'), ` ${c.when} (${date})`), el('div', { class: 'message' }, c.message)];
  if (c.files) {
    const stats = el('div', {}, `${plural(c.files, 'file')} changed, `, el('span', { class: 'ins' }, `+${c.ins}`), ' ', el('span', { class: 'del' }, `−${c.del}`));
    parts.push(el('hr', {}), stats);
  }
  // The row's own branch badges, so the card always matches the list.
  const refs = item.querySelector(':scope > .refs');
  if (refs) parts.push(el('hr', {}), refs.cloneNode(true));
  card.replaceChildren(...parts);
  // Below the row, or above it when it only fits there; a webview cannot draw past
  // its own edges, so the card scrolls when neither side has room for all of it.
  const rowBox = item.shadowRoot.querySelector('.wrapper').getBoundingClientRect();
  const below = innerHeight - rowBox.bottom - 4;
  card.style.maxHeight = `${Math.max(below, rowBox.top - 4)}px`;
  card.hidden = false;
  const message = card.querySelector('.message');
  message.classList.toggle('clipped', message.scrollHeight > message.clientHeight);
  const h = card.offsetHeight;
  card.style.top = `${h <= below ? rowBox.bottom + 2 : rowBox.top - h - 2}px`;
}

function hideCard() {
  clearTimeout(showTimer);
  hovered = undefined;
  dismissed = false;
  card.hidden = true;
}

tree.addEventListener('pointerover', (e) => {
  const item = e.target.closest('vscode-tree-item');
  const id = item && item.dataset.lane ? item.dataset.id : undefined;
  if (id === hovered) return;
  hideCard();
  hovered = id;
  if (id) showTimer = setTimeout(() => (cards.has(id) ? showCard(id) : vscode.postMessage({ type: 'card', id })), 500);
});
tree.addEventListener('pointerleave', hideCard);
// Clicking a commit expands its files right where the card sits, so get out of the way.
tree.addEventListener('pointerdown', () => {
  clearTimeout(showTimer);
  dismissed = true;
  card.hidden = true;
});
window.addEventListener('scroll', hideCard);

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
