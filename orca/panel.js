// The Orca panel around media/graph.js. It stands in for the VS Code webview API
// (messages go to the plugin's worker, which runs the extension) and draws what
// VS Code draws outside a webview: the view's title bar, input boxes, pick lists,
// confirmations, toasts and the rows' right-click menu.
(() => {
  const $ = (selector) => document.querySelector(selector);
  function el(tag, attrs = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== false) e.setAttribute(k, v === true ? '' : v);
    e.append(...children);
    return e;
  }
  const command = (name) => `commitFileTree.${name}`;

  // --- The channel to the worker -------------------------------------------------
  // Every request is answered with all the messages the worker has for the panel:
  // graph.js's own (root, children, card, reveal) are handed on as the window
  // 'message' events the extension would have posted, the rest are drawn here.
  const deliver = (data) => window.dispatchEvent(new MessageEvent('message', { data }));
  // A failed load says so in the tree (as the extension does for a git error)
  // instead of leaving it blank; the next reload retries.
  const failed = (error) => ({
    type: 'root',
    mode: 'commits',
    rows: [{ id: 'error', label: 'Could not load this view', description: error.message, tooltip: `${error.code}: ${error.message}`, icon: 'error', iconColor: 'errorForeground' }],
  });
  const ours = { ui, context, view };
  // Orca takes plain JSON only: an undefined field (a cancelled question's value)
  // gets the whole request refused.
  const send = (message) =>
    orca.plugin.request('message', JSON.parse(JSON.stringify(message))).then(
      (messages) => messages.forEach((m) => (ours[m.type] || deliver)(m)),
      (error) => (message.type === 'ready' ? deliver(failed(error)) : console.error('Commit Review Tree:', error.code, error.message))
    );
  // Several things ask for a load at once (the page, the workspace event). A load
  // runs git over the whole repository, which takes a while on a large one: the
  // title bar shows it is under way.
  let loading;
  let loads = 0;
  function reload() {
    clearTimeout(loading);
    loading = setTimeout(() => {
      $('#busy').hidden = !++loads;
      send({ type: 'ready' }).finally(() => ($('#busy').hidden = !--loads));
    }, 50);
  }

  // Expand state lives as long as the frame does.
  let state;
  window.acquireVsCodeApi = () => ({
    postMessage: (message) => (message.type === 'ready' ? reload() : send(message)),
    getState: () => state,
    setState: (next) => (state = next),
  });

  // The worker has something to fetch (a refresh, a question); another workspace
  // got the focus; the panel is shown again.
  // A hidden panel leaves its messages waiting, which also tells the worker that
  // nobody is looking (it stops rebuilding rows).
  orca.plugin.on('pull', () => document.hidden || send({ type: 'pull' }));
  orca.on('workspace.changed', reload);
  document.addEventListener('visibilitychange', () => document.hidden || reload());
  // Orca stops a worker that has had no request for five minutes, and the worker
  // is what watches the repository: a panel on show keeps it running.
  setInterval(() => document.hidden || send({ type: 'pull' }), 4 * 60 * 1000);

  // --- Title bar -----------------------------------------------------------------
  // VS Code's context keys enable and show the view's buttons; here they arrive as
  // messages. The mode's own button is lit, Back shows when there is a view to go
  // back to, Combined and By dependencies are off while the range is empty.
  const contexts = {};
  function context({ values }) {
    Object.assign(contexts, values);
    for (const button of document.querySelectorAll('#bar [data-mode]')) {
      button.checked = button.dataset.mode === contexts[command('mode')];
      const empty = contexts[command('rangeEmpty')] && ['combined', 'deps'].includes(button.dataset.mode);
      button.toggleAttribute('disabled', !!empty);
    }
    $('#bar [data-command=goBack]').hidden = !contexts[command('canGoBack')];
  }
  // The view's description (the mode) and badge (files awaiting review). Hovering
  // the mode names the repository: workspaces called "main" look alike.
  function view({ description, badge, root }) {
    if (description !== undefined) $('#mode').textContent = description;
    if (root !== undefined) $('#mode').title = root;
    if (badge === undefined) return;
    $('#badge').hidden = !badge;
    $('#badge').textContent = badge ? badge.value : '';
    $('#badge').title = badge ? badge.tooltip : '';
  }
  $('#bar').addEventListener('click', (e) => {
    const button = e.target.closest('[data-command]');
    if (!button || button.hasAttribute('disabled')) return;
    // A toggle button flips itself on click; the mode message sets it right.
    if (button.dataset.mode) button.checked = button.dataset.mode === contexts[command('mode')];
    send({ type: 'command', command: command(button.dataset.command) });
  });

  // --- Menus ---------------------------------------------------------------------
  // One menu element, shown at a point; `pick` gets the chosen item's value.
  const menu = $('#menu');
  let picked = () => {};
  function showMenu(items, x, y, pick) {
    menu.data = items;
    picked = pick;
    menu.show = true;
    // Placed once it has a size, kept inside the view.
    requestAnimationFrame(() => {
      const box = menu.getBoundingClientRect();
      menu.style.left = `${Math.max(4, Math.min(x, innerWidth - box.width - 4))}px`;
      menu.style.top = `${Math.max(4, Math.min(y, innerHeight - box.height - 4))}px`;
    });
  }
  menu.addEventListener('vsc-context-menu-select', (e) => {
    menu.show = false;
    picked(e.detail.value);
  });

  // Commands VS Code offers in its palette, on the title bar here.
  $('#more').addEventListener('click', (e) => {
    e.stopPropagation();
    const box = e.currentTarget.getBoundingClientRect();
    const items = [
      { label: 'Review All Changes', value: 'reviewAll' },
      { separator: true },
      { label: 'Restore Last Exported Round', value: 'restoreLastRound' },
      { label: 'Reset Review Range to Unpushed Commits', value: 'resetReviewRange' },
      { separator: true },
      { label: 'Clear All Review Data', value: 'clearReviewData' },
    ];
    showMenu(items, box.right, box.bottom + 2, (value) => send({ type: 'command', command: command(value) }));
  });

  // A row's right-click menu (package.json's webview/context menus), by row type.
  const ROW_MENU = {
    commit: [
      { label: 'Copy Commit Hash', value: 'copySha' },
      { label: 'Copy Commit Message', value: 'copyMessage' },
      { separator: true },
      { label: 'Revert This Commit', value: 'revertCommit' },
    ],
    file: [{ label: 'Reveal in Dependency View', value: 'revealInDeps' }],
  };
  ROW_MENU.depfile = ROW_MENU.file;
  document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const row = e.target.closest('vscode-tree-item[data-id]');
    const items = row && ROW_MENU[row.dataset.context];
    // Nothing to reveal from within the dependency view itself.
    if (!items || (items === ROW_MENU.file && contexts[command('mode')] === 'deps')) return;
    showMenu(items, e.clientX, e.clientY, (value) => send({ type: 'action', id: row.dataset.id, command: command(value) }));
  });

  // --- Questions and notices -----------------------------------------------------
  // What the extension asks through VS Code's window API. One question at a time:
  // a new one answers the open one with nothing, as closing it would.
  const askBox = $('#ask');
  let dismiss = () => {};
  function ui(m) {
    if (m.kind === 'copy') return copy(m.text);
    if (m.kind === 'toast') return toast(m);
    // The worker withdrew its question: the workspace it was about lost the focus.
    if (m.kind === 'dismiss') return dismiss();
    dismiss();
    const reply = (value) => {
      dismiss = () => {};
      askBox.hidden = true;
      askBox.replaceChildren();
      document.removeEventListener('keydown', onKey, true);
      send({ type: 'ui.reply', id: m.id, value });
    };
    dismiss = () => reply(undefined);
    // Keys pressed while an input method composes text (Chinese, Japanese) belong
    // to the composition: its Enter commits the characters, not the answer.
    const typing = (e) => e.isComposing || e.keyCode === 229;
    const onKey = (e) => e.key === 'Escape' && !typing(e) && reply(undefined);
    document.addEventListener('keydown', onKey, true);
    const box = el('div', { class: 'box' });
    askBox.replaceChildren(box);
    askBox.classList.toggle('modal', m.kind === 'confirm');
    askBox.onclick = (e) => e.target === askBox && reply(undefined);
    askBox.hidden = false;

    if (m.kind === 'confirm') {
      const buttons = m.actions.map((action) => {
        const button = el('vscode-button', {}, action);
        button.addEventListener('click', () => reply(action));
        return button;
      });
      const cancel = el('vscode-button', { secondary: true }, 'Cancel');
      cancel.addEventListener('click', () => reply(undefined));
      box.append(el('div', { class: 'prompt' }, m.message), el('div', { class: 'buttons' }, ...buttons, cancel));
      requestAnimationFrame(() => cancel.focus());
      return;
    }

    const field = el('vscode-textfield', { placeholder: m.placeHolder });
    field.value = m.value || '';
    box.append(field);
    requestAnimationFrame(() => {
      field.focus();
      field.shadowRoot && field.shadowRoot.querySelector('input') && field.shadowRoot.querySelector('input').select();
    });
    if (m.kind === 'input') {
      box.append(el('div', { class: 'prompt hint' }, `${m.prompt} (Enter to confirm, Escape to cancel)`));
      field.addEventListener('keydown', (e) => e.key === 'Enter' && !typing(e) && reply(field.value));
      return;
    }
    // Pick list: every typed word must appear in the label or its description.
    const picks = el('div', { class: 'picks' });
    box.append(picks);
    let shown = [];
    let active = 0;
    const draw = () => {
      const words = field.value.toLowerCase().split(/\s+/).filter(Boolean);
      shown = m.items
        .map((item, index) => ({ ...item, index }))
        .filter((item) => words.every((w) => `${item.label} ${item.description || ''}`.toLowerCase().includes(w)))
        .slice(0, 50);
      active = Math.min(active, Math.max(shown.length - 1, 0));
      picks.replaceChildren(
        ...shown.map((item, i) => {
          const row = el('div', { class: i === active ? 'pick active' : 'pick' }, el('span', {}, item.label), el('span', { class: 'description' }, item.description || ''));
          row.addEventListener('click', () => reply(item.index));
          return row;
        })
      );
      const current = picks.children[active];
      if (current) current.scrollIntoView({ block: 'nearest' });
    };
    field.addEventListener('input', () => {
      active = 0;
      draw();
    });
    field.addEventListener('keydown', (e) => {
      if (typing(e)) return;
      if (e.key === 'Enter' && shown[active]) return reply(shown[active].index);
      const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
      if (!step) return;
      e.preventDefault();
      active = (active + step + shown.length) % Math.max(shown.length, 1);
      draw();
    });
    draw();
  }

  // A toast answers with the button pressed, or with nothing when it is closed or
  // its time is up (VS Code keeps one until dismissed; a panel has less room).
  const ICON = { info: 'info', warning: 'warning', error: 'error' };
  function toast(m) {
    const node = el('div', { class: `toast ${m.level}`, role: 'status' }, el('vscode-icon', { name: ICON[m.level] }), el('span', { class: 'text' }, m.message));
    const done = (value) => {
      clearTimeout(timer);
      node.remove();
      if (m.id) send({ type: 'ui.reply', id: m.id, value });
    };
    const timer = setTimeout(done, m.actions.length || m.level === 'error' ? 12000 : 6000);
    const actions = m.actions.map((action) => {
      const button = el('vscode-button', { secondary: true }, action);
      button.addEventListener('click', () => done(action));
      return button;
    });
    const close = el('vscode-toolbar-button', { icon: 'close', title: 'Dismiss' });
    close.addEventListener('click', () => done(undefined));
    node.append(el('span', { class: 'actions' }, ...actions, close));
    $('#toasts').append(node);
  }

  // Copy by selection first: it needs no permission, where the clipboard API needs
  // one a plugin frame may not have (and then may never answer).
  function copy(text) {
    const area = el('textarea', { style: 'position: fixed; opacity: 0' });
    area.value = text;
    document.body.append(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    if (!copied) navigator.clipboard.writeText(text).catch((e) => toast({ level: 'error', message: `Could not copy to the clipboard: ${e.message}`, actions: [] }));
  }
})();
