// A file's change as rows for the review editor: [type, old line, new line, text],
// type ' ' (unchanged), '+' or '-', a line number 0 on the side a row is not on.
// A '~' row stands for lines that are not included.
const fs = require('fs');
const path = require('path');
const { git } = require('../extension.js');

// An answer to the editor may be 1 MiB; past this many bytes of text a file comes
// with less context, and then cut short.
const MAX_BYTES = 700 * 1024;
// A file on disk larger than this is not read at all (git's own output is capped
// by the 10 MiB buffer of git()).
const MAX_FILE = 10 * 1024 * 1024;

const lines = (text) => (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');

// The file on disk, read no further than the repository: a link is shown as git
// stores it (its target), and a path that leaves the repository through a linked
// folder, or is not a regular file, is refused.
async function readWorking(root, relative) {
  const file = path.join(root, relative);
  const stat = await fs.promises.lstat(file);
  if (stat.isSymbolicLink()) return fs.promises.readlink(file);
  const [realRoot, realFolder] = await Promise.all([fs.promises.realpath(root), fs.promises.realpath(path.dirname(file))]);
  const inside = path.relative(realRoot, realFolder);
  if (!stat.isFile() || inside.startsWith('..') || path.isAbsolute(inside)) throw new Error(`not a file of this repository: ${relative}`);
  if (stat.size > MAX_FILE) throw new Error(`too large to show (${Math.round(stat.size / 1024 / 1024)} MB)`);
  return fs.promises.readFile(file, 'utf8');
}

// One version of a file: a git revision, or the file on disk ('working').
const read = (root, side) => (side.ref === 'working' ? readWorking(root, side.path) : git(root, ['show', `${side.ref}:${side.path}`]));

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

module.exports = { parseDiff, fileRows };
