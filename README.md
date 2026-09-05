# Commit Review Tree

A Cursor/VS Code extension for reviewing AI-generated commits fast. It adds a **Commit Review Tree** panel to the Source Control sidebar that shows your unpushed work as a clear file tree — per commit or combined — with one-click multi-diff review, reviewed checkmarks, notes, risk flags, and revert.

## Features

- **Your work first** — by default the list shows only your local unpushed commits (`@{upstream}..HEAD`) with subject, short hash, relative time, and diff stats (`3 files +10 −2`); "Show pushed history…" pages in remote history 50 commits at a time, "Hide pushed history" collapses it back. Repos without an upstream show plain history.
- **Three view modes** — dedicated title-bar buttons, active mode shown in the view header: *by commits* (expand each commit into its file tree), *combined* (all unpushed changes as one tree, diffed against the upstream — ideal when the AI made many intermediate commits and you only care about the net result), and *by dependencies* (foundations at the root, expand a file to see the changed files that import it — review dependencies before their callers; files with no import relationships are grouped under "Standalone files"; import detection is heuristic, JS/TS/Python).
- **Review all changes in one click** — the multi-diff button on the view title (or on a single commit) opens every changed file's diff stacked in one editor tab.
- **Reviewed checkmarks** — mark files as reviewed from the hover actions; they turn dim with a ✓ badge, and the state persists per workspace so interrupted reviews resume where you left off.
- **Line-level comments** — GitHub-style review comments right in the diff: click the "+" in the gutter, type, done. Threads persist per commit (and re-appear when you reopen the diff), files show a 💬 count in the tree, and comments can be deleted from the thread title bar.
- **Export review summary for AI** — one click collects every note and line comment (with the quoted code line) into an action-item markdown report, copies it to the clipboard, and opens it — paste it straight into your AI agent as the fix list.
- **Notes** — attach a file-level note (hover action); shown as 📝 in the row and in the tooltip.
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
