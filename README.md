# Commit File Tree

A Cursor/VS Code extension that adds a **Commit File Tree** panel to the Source Control sidebar. It shows each commit's changed files as a real folder tree instead of a flat list, so you can see at a glance which parts of the codebase a commit touched.

## Features

- **Commit history in the sidebar** — lists the last 50 commits with subject, short hash, author, and relative time.
- **Folder tree per commit** — expand a commit to see its changed files nested under their real directories, sorted folders-first.
- **Change status at a glance** — each file is marked Added / Modified / Deleted / Renamed, with the full path and status in the tooltip.
- **Click to view changes** — modified and renamed files open a side-by-side diff against the parent commit; added files open the new content, deleted files open the old content. Root commits are handled correctly.
- **Refresh button** — reload the commit list from the view title bar after new commits land.
- **Zero configuration** — works with the repository of your first workspace folder; no settings, no login, no telemetry.

## Install

Search for `dwenking.commit-file-tree` in the Extensions panel, or:

```sh
npx @vscode/vsce package          # produces commit-file-tree-<version>.vsix
cursor --install-extension commit-file-tree-0.0.2.vsix
```

Or for development: open this folder in Cursor and press `F5` (Run Extension).

## Test

```sh
node test.js
```
