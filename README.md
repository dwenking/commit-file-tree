# Commit File Tree

A Cursor/VS Code extension that adds a **Commit File Tree** panel to the Source Control sidebar. It lists the last 50 commits; expanding a commit shows its changed files as a real folder tree (instead of a flat list). Clicking a file opens the diff for that commit.

## Install

```sh
npx @vscode/vsce package          # produces commit-file-tree-0.0.1.vsix
cursor --install-extension commit-file-tree-0.0.1.vsix
```

Or for development: open this folder in Cursor and press `F5` (Run Extension).

## Test

```sh
node test.js
```
