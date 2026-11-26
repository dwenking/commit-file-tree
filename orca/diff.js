// A file's change as rows for the review editor: [type, old line, new line, text],
// type ' ' (unchanged), '+' or '-', a line number 0 on the side a row is not on.
// A '~' row stands for lines that are not included. An image comes as its bytes.
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const { git } = require('../extension.js');

// An answer to the editor may be 1 MiB; past this many bytes of text a file comes
// with less context, and then cut short.
const MAX_BYTES = 700 * 1024;
// A file on disk larger than this is not read at all (git's own output is capped
// by the 10 MiB buffer of git()).
const MAX_FILE = 10 * 1024 * 1024;
// Images the editor shows as pictures, the largest it will, and how many bytes go
// in one answer (base64 makes them a third more).
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.avif': 'image/avif' };
const MAX_IMAGE = 16 * 1024 * 1024;
const PART = 512 * 1024;

const lines = (text) => (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');

const megabytes = (bytes) => `${Math.round(bytes / 1024 / 1024)} MB`;

// A file on disk, reached no further than the repository: { file, size }, or
// { link } for a link, which is never followed (git stores its target, so that is
// what is shown). A path that leaves the repository through a linked folder, or
// is not a regular file, is refused.
async function onDisk(root, relative) {
  const file = path.join(root, relative);
  const stat = await fs.promises.lstat(file);
  if (stat.isSymbolicLink()) return { link: await fs.promises.readlink(file) };
  const [realRoot, realFolder] = await Promise.all([fs.promises.realpath(root), fs.promises.realpath(path.dirname(file))]);
  const inside = path.relative(realRoot, realFolder);
  if (!stat.isFile() || inside.startsWith('..') || path.isAbsolute(inside)) throw new Error(`not a file of this repository: ${relative}`);
  return { file, size: stat.size };
}

// One version of a file as text: a git revision, or the file on disk ('working').
async function read(root, side) {
  if (side.ref !== 'working') return git(root, ['show', `${side.ref}:${side.path}`]);
  const { file, size, link } = await onDisk(root, side.path);
  if (link !== undefined) return link;
  if (size > MAX_FILE) throw new Error(`too large to show (${megabytes(size)})`);
  return fs.promises.readFile(file, 'utf8');
}

// One version of an image, a part at a time: { type, data (base64), next? }, `next`
// being where the following part starts. git() decodes its output as text, so a
// revision's bytes are fetched here.
async function imagePart(root, side, offset) {
  const type = IMAGE_TYPES[path.extname(side.path).toLowerCase()];
  if (!type) throw new Error('not an image this editor shows');
  if (!Number.isInteger(offset) || offset < 0) throw new Error('not a place in the file');
  let size;
  let part;
  if (side.ref === 'working') {
    const at = await onDisk(root, side.path);
    if (at.link !== undefined) throw new Error('a link, not an image');
    size = at.size;
    if (size > MAX_IMAGE) throw new Error(`too large to show (${megabytes(size)})`);
    const handle = await fs.promises.open(at.file, 'r');
    try {
      const { bytesRead, buffer } = await handle.read(Buffer.alloc(Math.max(0, Math.min(PART, size - offset))), 0, undefined, offset);
      part = buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  } else {
    const whole = await new Promise((resolve, reject) => {
      cp.execFile('git', ['show', `${side.ref}:${side.path}`], { cwd: root, encoding: 'buffer', maxBuffer: MAX_IMAGE }, (err, stdout) => (err ? reject(err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? new Error('too large to show') : err) : resolve(stdout)));
    });
    size = whole.length;
    part = whole.subarray(offset, offset + PART);
  }
  const next = offset + part.length;
  return { type, data: part.toString('base64'), ...(part.length && next < size ? { next } : {}) };
}

// Rows of `git diff` output: the hunks, with a '~' row where lines between two
// hunks (or before the first) were left out.
function parseDiff(output) {
  const rows = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const line of output.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      const skipped = Number(hunk[2]) - 1 - newLine;
      if (skipped > 0) rows.push(['~', 0, 0, `${skipped} unchanged line${skipped === 1 ? '' : 's'}`]);
      oldLine = Number(hunk[1]) - 1;
      newLine = Number(hunk[2]) - 1;
      // An empty side starts at line 0 (@@ -0,0 +1 @@), with no line before it.
      if (hunk[1] === '0') oldLine = 0;
      if (hunk[2] === '0') newLine = 0;
      inHunk = true;
    } else if (!inHunk || line.startsWith('\\')) {
      // file headers, and "\ No newline at end of file"
    } else if (line.startsWith('+')) rows.push(['+', 0, ++newLine, line.slice(1)]);
    else if (line.startsWith('-')) rows.push(['-', ++oldLine, 0, line.slice(1)]);
    else if (line.startsWith(' ')) rows.push([' ', ++oldLine, ++newLine, line.slice(1)]);
  }
  return rows;
}

// Rows that fit an answer: past the budget the rest becomes one '~' row.
function capped(rows) {
  let bytes = 0;
  const end = rows.findIndex((row) => (bytes += Buffer.byteLength(row[3]) + 16) > MAX_BYTES);
  return end < 0 ? { rows } : { rows: [...rows.slice(0, end), ['~', 0, 0, `${rows.length - end} more lines, too many to show`]], partial: true };
}

// file: { base?, target?, view? }, each side { ref, path }. Both sides: their diff,
// with the whole file as context so any line can be commented on. One side: the
// file as added or deleted. `view`: one version, as it is.
// Returns { rows } or { rows: [], binary: true }; `partial` when context was cut.
async function fileRows(root, file) {
  const whole = async (side, row) => {
    const text = await read(root, side);
    return text.includes('\0') ? { rows: [], binary: true } : capped(text === '' ? [] : lines(text).map(row));
  };
  if (file.view) return whole(file.view, (text, i) => [' ', i + 1, i + 1, text]);
  if (!file.base) return whole(file.target, (text, i) => ['+', 0, i + 1, text]);
  if (!file.target) return whole(file.base, (text, i) => ['-', i + 1, 0, text]);
  const paths = [...new Set([file.base.path, file.target.path])];
  const revisions = file.target.ref === 'working' ? [file.base.ref] : [file.base.ref, file.target.ref];
  // Paths are taken literally (never as pathspec magic), and the diff is git's own
  // whatever external diff tool is configured.
  const diff = (context) => git(root, ['--literal-pathspecs', 'diff', '--no-color', '--no-ext-diff', '-M', `-U${context}`, ...revisions, '--', ...paths]);
  // With the whole file as context first; a file too large for that (or for git()'s
  // buffer) comes as its hunks only.
  let output = await diff(1000000).catch(() => undefined);
  const partial = output === undefined || Buffer.byteLength(output) > MAX_BYTES;
  if (partial) output = await diff(3);
  if (/^Binary files .* differ$/m.test(output)) return { rows: [], binary: true };
  // Renamed or re-moded without a changed line: show the file itself.
  if (!output.includes('\n@@ ')) return whole(file.target, (text, i) => [' ', i + 1, i + 1, text]);
  return { ...(partial ? { partial } : {}), ...capped(parseDiff(output)) };
}

module.exports = { parseDiff, fileRows, imagePart };
