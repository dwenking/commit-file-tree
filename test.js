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
const { parseNameStatus, buildTree } = require('./extension.js');

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

console.log('ok');
