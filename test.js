// Minimal self-check: node test.js
// Stub the 'vscode' module so extension.js can be required outside the editor.
const Module = require('module');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'vscode') return __filename;
  return origResolve.call(this, request, ...args);
};
module.exports.Uri = { file: () => ({ with: () => ({}) }) };
module.exports.EventEmitter = class {};
module.exports.TreeItem = class {};
module.exports.TreeItemCollapsibleState = {};
module.exports.ThemeIcon = class {};

const assert = require('assert');
const { parseNameStatus, buildTree, parseLog, compactDir } = require('./extension.js');

const files = parseNameStatus('M\tsrc/a/one.js\nA\tsrc/two.js\nR100\told.js\tnew.js\nD\tREADME.md\n');
assert.deepStrictEqual(files, [
  { status: 'M', path: 'src/a/one.js' },
  { status: 'A', path: 'src/two.js' },
  { status: 'R', path: 'new.js' },
  { status: 'D', path: 'README.md' },
]);

const tree = buildTree(files);
assert.deepStrictEqual([...tree.dirs.keys()], ['src']);
assert.deepStrictEqual(tree.files.map((f) => f.name).sort(), ['README.md', 'new.js']);
assert.deepStrictEqual([...tree.dirs.get('src').dirs.keys()], ['a']);
assert.strictEqual(tree.dirs.get('src').dirs.get('a').files[0].path, 'src/a/one.js');

// parseLog: header + shortstat pairs, including a stat-less (empty) commit
const sha1 = 'a'.repeat(40);
const sha2 = 'b'.repeat(40);
const log = parseLog(
  `${sha1}\ta1\tAlice\t2 days ago\tfix: bug\n\n 3 files changed, 10 insertions(+), 2 deletions(-)\n${sha2}\tb2\tBob\t3 days ago\tempty commit\n`
);
assert.deepStrictEqual(log, [
  { sha: sha1, short: 'a1', author: 'Alice', when: '2 days ago', subject: 'fix: bug', files: 3, ins: 10, del: 2 },
  { sha: sha2, short: 'b2', author: 'Bob', when: '3 days ago', subject: 'empty commit', files: 0, ins: 0, del: 0 },
]);

// compactDir: a/b/c collapses into one label; stops at a dir with files
const deep = buildTree([{ status: 'M', path: 'a/b/c/one.js' }]);
const compacted = compactDir('a', deep.dirs.get('a'));
assert.strictEqual(compacted.name, 'a/b/c');
assert.strictEqual(compacted.node.files[0].name, 'one.js');
const mixed = buildTree([
  { status: 'M', path: 'a/one.js' },
  { status: 'M', path: 'a/b/two.js' },
]);
assert.strictEqual(compactDir('a', mixed.dirs.get('a')).name, 'a');

console.log('ok');
