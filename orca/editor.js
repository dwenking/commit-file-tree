// The review editor's page. The document Orca hands it is the worker's request:
// { root, title, files: [{ path, base?, target?, view? }], line? } (see vscode.js).
// Each file's rows and comments come from the worker, which is told the request's
// repository (root) every time; comments are added and deleted through it, by the
// extension's own commands.
(() => {
  function el(tag, attrs = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== false) e.setAttribute(k, v === true ? '' : v);
    e.append(...children.filter((c) => c !== undefined && c !== false && c !== ''));
    return e;
  }
  const CONTEXT = 3; // unchanged lines kept around a change
  const FOLD = 8; // fewer hidden lines than this are not worth folding
  const CLASS = { '+': 'add', '-': 'del', ' ': 'same' };
  // Files shown as pictures (the worker knows the same ones, see diff.js).
  const IMAGE = /\.(png|jpe?g|gif|webp|bmp|ico|avif)$/i;
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  const title = document.querySelector('#title');
  const files = document.querySelector('#files');
  // Per file: { file, node, lines, rows, comments, note, at, open, draft }.
  let sections = [];
  let root;
  // Orca takes plain JSON only: an undefined field (a one-line comment's endLine)
  // gets the whole request refused.
  const ask = (name, input) => orca.plugin.request(name, JSON.parse(JSON.stringify({ root, ...input })));

  orca.document.onDidChange((doc) => {
    let request;
    try {
      request = JSON.parse(doc.content.text);
    } catch (e) {
      // not a request: an empty or foreign .crdiff file
    }
    if (!request || !Array.isArray(request.files)) {
      title.textContent = '';
      sections = [];
      return files.replaceChildren();
    }
    for (const s of sections) Object.values(s.pictures || {}).forEach((url) => URL.revokeObjectURL(url));
    root = request.root;
    title.textContent = request.title || '';
    sections = request.files.map((file, i) => section(file, i === 0 ? request.line : undefined));
    files.replaceChildren(...sections.map((s) => s.node));
    // ponytail: one file after another; load on scroll if a review of hundreds of files feels slow
    sections.reduce((before, s) => before.then(() => load(s)), Promise.resolve());
  });

  // Comments change elsewhere too: the Comments view edits and deletes them, an
  // export clears them. The worker says so; coming back to the tab asks as well.
  const recomment = () =>
    sections.forEach(async (s) => {
      const comments = await ask('comments', { file: s.file }).catch(() => s.comments);
      if (JSON.stringify(comments) === JSON.stringify(s.comments)) return;
      s.comments = comments;
      draw(s);
    });
  orca.plugin.on('comments', recomment);
  window.addEventListener('focus', recomment);

  function section(file, line) {
    const status = file.view ? '' : !file.base ? 'A' : !file.target ? 'D' : file.base.path !== file.target.path ? 'R' : 'M';
    const header = el(
      'header',
      {},
      status && el('span', { class: `status ${status}` }, status),
      el('span', { class: 'path' }, file.path),
      status === 'R' && el('span', { class: 'was' }, `← ${file.base.path}`)
    );
    const lines = el('table', { class: 'lines' });
    const node = el('section', { class: 'file' }, header, lines);
    header.addEventListener('click', () => node.classList.toggle('closed'));
    return { file, line, node, lines, rows: [], comments: { old: [], new: [] }, note: 'Loading…', open: new Set() };
  }

  // One version of an image as a URL the page can show, fetched in the parts the
  // worker hands out.
  async function picture(side) {
    const parts = [];
    let type;
    for (let offset = 0; offset !== undefined; ) {
      const part = await ask('image', { side, offset });
      parts.push(Uint8Array.from(atob(part.data), (c) => c.charCodeAt(0)));
      type = part.type;
      offset = part.next;
    }
    return URL.createObjectURL(new Blob(parts, { type }));
  }

  async function load(s) {
    try {
      if (IMAGE.test(s.file.path)) {
        // The version before and the one after, whichever there are.
        const { base, target, view } = s.file;
        s.pictures = { ...(base ? { old: await picture(base) } : {}), ...(target ? { new: await picture(target) } : {}), ...(view ? { view: await picture(view) } : {}) };
        s.note = '';
        return draw(s);
      }
      const data = await ask('diff', { file: s.file });
      s.rows = data.rows;
      s.comments = data.comments;
      s.note = data.binary ? 'Binary file' : data.rows.length ? '' : 'Empty file';
    } catch (e) {
      s.note = `Could not load this file: ${e.message}`;
    }
    draw(s);
    // Open at the line the row in the tree points to (a declaration, an import).
    const at = s.lines.querySelector('.row.at');
    if (at) at.scrollIntoView({ block: 'center' });
  }

  // The row a comment sits under: the one with that line number on its side.
  const rowAt = (s, side, line) => s.rows.findIndex((r) => r[0] !== '~' && r[side === 'old' ? 1 : 2] === line);

  // A file's comments as threads: all comments that start on one line of one side,
  // under the last line they cover. `row` is -1 when that line is not among the rows.
  function threads(s) {
    const byLine = new Map();
    for (const side of ['old', 'new']) {
      for (const c of s.comments[side]) {
        const key = `${side}:${c.line}`;
        const thread = byLine.get(key) || { side, line: c.line, endLine: c.line, texts: [] };
        thread.endLine = Math.max(thread.endLine, c.endLine || c.line);
        thread.texts.push(c.text);
        byLine.set(key, thread);
      }
    }
    return [...byLine.values()].map((t) => ({ ...t, row: rowAt(s, t.side, t.endLine) }));
  }

  function draw(s) {
    const { rows } = s;
    const all = threads(s);
    const at = s.line ? rowAt(s, 'new', s.line) : -1;
    // Unchanged lines far from anything of interest fold away; a file that is all
    // one kind (added, deleted, on view) shows whole.
    const mixed = rows.some((r) => r[0] === ' ') && rows.some((r) => r[0] === '+' || r[0] === '-');
    const show = rows.map((r, i) => !mixed || r[0] !== ' ' || s.open.has(i));
    const near = (i) => {
      for (let j = Math.max(0, i - CONTEXT); j <= Math.min(rows.length - 1, i + CONTEXT); j++) show[j] = true;
    };
    if (mixed) {
      rows.forEach((r, i) => r[0] !== ' ' && near(i));
      for (const i of [at, s.draft ? s.draft.row : -1, ...all.map((t) => t.row)]) if (i >= 0) near(i);
    }

    const body = document.createElement('tbody');
    for (let i = 0; i < rows.length; i++) {
      if (!show[i]) {
        let end = i;
        while (end < rows.length && !show[end]) end++;
        if (end - i >= FOLD) {
          body.append(fold(s, i, end));
          i = end - 1;
          continue;
        }
      }
      body.append(row(s, i, i === at));
      for (const t of all) if (t.row === i) body.append(threadRow(s, t));
      if (s.draft && s.draft.row === i) body.append(formRow(s));
    }
    // Comments on lines that are not among the rows (the file changed since, or was cut short).
    for (const t of all) if (t.row < 0) body.append(threadRow(s, t));
    if (s.pictures) {
      const images = Object.entries(s.pictures).map(([side, src]) => el('img', { class: side, src, alt: '' }));
      body.append(el('tr', {}, el('td', { colspan: 3 }, el('div', { class: 'pictures' }, ...images))));
    }
    if (s.note) body.append(el('tr', {}, el('td', { colspan: 3, class: 'note' }, s.note)));
    s.lines.replaceChildren(body);
    const field = s.lines.querySelector('.form vscode-textarea');
    if (field) requestAnimationFrame(() => field.focus());
  }

  function row(s, i, at) {
    const [type, oldLine, newLine, text] = s.rows[i];
    if (type === '~') return el('tr', { class: 'gap' }, el('td', { colspan: 3 }, `⋯ ${text}`));
    const plus = el('button', { class: 'plus', title: 'Add Comment' }, '+');
    // Pressing the button must not drop the selection it is about to read.
    plus.addEventListener('mousedown', (e) => e.preventDefault());
    plus.addEventListener('click', () => compose(s, i));
    return el(
      'tr',
      { class: `row ${CLASS[type]}${at ? ' at' : ''}`, 'data-i': i },
      el('td', { class: 'num' }, oldLine ? String(oldLine) : ''),
      el('td', { class: 'num' }, newLine ? String(newLine) : ''),
      el('td', { class: 'code', 'data-mark': type.trim() }, plus, text)
    );
  }

  function fold(s, from, to) {
    const tr = el('tr', { class: 'fold' }, el('td', { colspan: 3 }, `⋯ ${plural(to - from, 'unchanged line')}`));
    tr.addEventListener('click', () => {
      for (let i = from; i < to; i++) s.open.add(i);
      draw(s);
    });
    return tr;
  }

  // A comment sits under its line; only a span of lines needs saying.
  const span = (t) => (t.endLine > t.line ? `Lines ${t.line}–${t.endLine}` : '');

  function threadRow(s, t) {
    const remove = el('vscode-toolbar-button', { icon: 'trash', title: 'Delete Review Comment' });
    const texts = el('div', { class: 'texts' }, span(t) && el('div', { class: 'hint' }, span(t)), ...t.texts.map((text) => el('div', { class: 'text' }, text)));
    remove.addEventListener('click', async () => {
      try {
        s.comments = await ask('comment.delete', { file: s.file, side: t.side, line: t.line });
        draw(s);
      } catch (e) {
        texts.append(el('div', { class: 'hint' }, `Could not delete: ${e.message}`));
      }
    });
    return el('tr', { class: 'thread' }, el('td', { colspan: 3 }, el('div', { class: 'bubble' }, texts, remove)));
  }

  // Start a comment on row i: on the old version for a removed line, else the new
  // one. A selection that covers the row makes it a comment on all selected lines.
  function compose(s, i) {
    const side = s.rows[i][0] === '-' ? 'old' : 'new';
    const number = (j) => s.rows[j][side === 'old' ? 1 : 2];
    let [from, to] = selected(s);
    if (from === undefined || i < from || i > to || !number(from) || !number(to)) from = to = i;
    s.draft = { side, line: number(from), endLine: number(to) > number(from) ? number(to) : undefined, row: to, text: '' };
    draw(s);
  }
  // The first and last row of the text selection, when it lies within this file.
  function selected(s) {
    const selection = getSelection();
    if (!selection || selection.isCollapsed) return [];
    const index = (node) => {
      const tr = node && (node.nodeType === 1 ? node : node.parentElement).closest('tr.row');
      return tr && s.lines.contains(tr) ? Number(tr.dataset.i) : undefined;
    };
    const ends = [index(selection.anchorNode), index(selection.focusNode)];
    return ends.includes(undefined) ? [] : [Math.min(...ends), Math.max(...ends)];
  }

  function formRow(s) {
    const draft = s.draft;
    const field = el('vscode-textarea', { rows: 3 });
    field.value = draft.text;
    field.addEventListener('input', () => (draft.text = field.value));
    const close = () => {
      s.draft = undefined;
      draw(s);
    };
    const hint = el('div', { class: 'hint' }, span(draft));
    const save = async () => {
      if (!field.value.trim()) return;
      try {
        s.comments = await ask('comment.add', { file: s.file, side: draft.side, line: draft.line, endLine: draft.endLine, text: field.value.trim() });
        close();
      } catch (e) {
        // The comment stays in the box: nothing typed is lost.
        hint.textContent = `Could not add the comment: ${e.message}`;
      }
    };
    field.addEventListener('keydown', (e) => {
      // Keys pressed while an input method composes text belong to the composition.
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape') close();
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save();
    });
    const add = el('vscode-button', {}, 'Add Comment');
    add.addEventListener('click', save);
    const cancel = el('vscode-button', { secondary: true }, 'Cancel');
    cancel.addEventListener('click', close);
    const form = el('div', { class: 'form' }, hint, field, el('div', { class: 'buttons' }, add, cancel));
    return el('tr', { class: 'thread' }, el('td', { colspan: 3 }, form));
  }
})();
