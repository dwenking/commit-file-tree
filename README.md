# Commit File Tree

A Cursor/VS Code extension that adds a **Commit File Tree** panel to the Source Control sidebar. It shows each commit's changed files as a real folder tree instead of a flat list, so you can see at a glance which parts of the codebase a commit touched.

## Features

- **Your work first** — by default the list shows only your local unpushed commits (`@{upstream}..HEAD`) with subject, short hash, relative time, and diff stats (`3 files +10 −2`); "Load more…" pages in remote history 50 commits at a time (marked with a history icon). Repos without an upstream show plain history.
- **Folder tree per commit** — expand a commit to see its changed files nested under their real directories, sorted folders-first, with single-child folder chains compacted into one label (`src/utils/git`).
- **Change status at a glance** — files are colored and badged like the native SCM view (green added, orange modified, red deleted, renamed), with the full path and status in the tooltip. Unpushed commits get a blue dot, pushed ones a dimmed dot.
- **Commit context menu** — right-click a commit to copy its hash or message.
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
