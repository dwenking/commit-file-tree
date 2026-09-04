# Commit Review Tree

A Cursor/VS Code extension for reviewing AI-generated commits fast. It adds a **Commit Review Tree** panel to the Source Control sidebar that shows your unpushed work as a clear file tree — per commit or combined — with one-click multi-diff review, reviewed checkmarks, notes, risk flags, and revert.

## Features

- **Your work first** — by default the list shows only your local unpushed commits (`@{upstream}..HEAD`) with subject, short hash, relative time, and diff stats (`3 files +10 −2`); "Show pushed history…" pages in remote history 50 commits at a time, "Hide pushed history" collapses it back. Repos without an upstream show plain history.
- **Two view modes** — toggle from the view title bar between *by commits* (expand each commit into its file tree) and *combined* (all unpushed changes as one tree, diffed against the upstream — ideal when the AI made many intermediate commits and you only care about the net result).
- **Review all changes in one click** — the multi-diff button on the view title (or on a single commit) opens every changed file's diff stacked in one editor tab.
- **Reviewed checkmarks** — mark files as reviewed from the hover actions; they turn dim with a ✓ badge, and the state persists per workspace so interrupted reviews resume where you left off.
- **Notes** — attach a note to any file (hover action); shown as 📝 in the row and in the tooltip.
- **Risk flags for scope drift** — files an AI session usually shouldn't touch are flagged with ⚠ and a reason: deletions, lockfiles, CI config, env files, container and build config.
- **Folder tree with native styling** — real directory nesting with single-child chains compacted (`src/utils/git`), files colored and badged like the built-in SCM view, blue dots for unpushed commits, dimmed for pushed.
- **Click to view changes** — modified files open a side-by-side diff; added files open the new content, deleted files the old. Root commits are handled correctly.
- **Commit actions** — right-click a commit to copy its hash or message, or **revert it** (safe: creates a new commit undoing it, after confirmation).

## Install

Search for `dwenking.commit-file-tree` in the Extensions panel, or:

```sh
npx @vscode/vsce package          # produces commit-file-tree-<version>.vsix
cursor --install-extension commit-file-tree-<version>.vsix
```

Or for development: open this folder in Cursor and press `F5` (Run Extension).

## Test

```sh
node test.js
```
