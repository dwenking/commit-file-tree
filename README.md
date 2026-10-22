<!-- markdownlint-disable MD013 MD033 MD041 -->

<div align="center">

<img src="icon.png" alt="Commit Review Tree logo" width="128" />

# Commit Review Tree

### Review AI-generated commits the way a human reviews a PR — without leaving Cursor/VS Code.

When a coding agent works in your repo, it leaves behind a pile of local commits: intermediate fixes, broad file churn, and the occasional change you never asked for. Commit Review Tree turns that pile into a reviewable unit — your unpushed work as clear file trees with review tooling attached — so you can inspect, annotate, and feed the results straight back to the agent.

[![VS Marketplace](https://img.shields.io/badge/VS%20Marketplace-Install-007ACC?logo=visualstudiocode&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=dwenking.commit-file-tree)
[![Open VSX](https://img.shields.io/open-vsx/v/dwenking/commit-file-tree?label=Open%20VSX)](https://open-vsx.org/extension/dwenking/commit-file-tree)
[![Open VSX Downloads](https://img.shields.io/open-vsx/dt/dwenking/commit-file-tree?label=Open%20VSX%20Downloads)](https://open-vsx.org/extension/dwenking/commit-file-tree)
[![VS Code](https://img.shields.io/badge/VS%20Code-%E2%89%A5%201.80-007ACC?logo=visualstudiocode&logoColor=white)](#requirements)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**4 view modes · Line comments & notes · Scope-drift flags · Review rounds · One-click export for your agent**

<p align="center">
  <b>Translations:</b>
  <a href="https://github.com/dwenking/commit-file-tree#readme">English</a> |
  <a href="https://github.com/dwenking/commit-file-tree/blob/main/README.zh-CN.md">简体中文</a>
</p>

</div>

---

## Why Commit Review Tree?

Source Control shows *what is uncommitted*. The Graph shows *that commits exist*. Neither answers the reviewer's questions: what did the agent change in total, what did it touch that it shouldn't have, and did it fix what I asked last time?

| Capability                                    | Plain Source Control + Graph | Commit Review Tree |
| --------------------------------------------- | :--------------------------: | :----------------: |
| Unpushed commits as file trees                |              No              |        Yes         |
| Net result of many commits as one tree        |              No              |        Yes         |
| Changed files ordered by imports              |              No              |        Yes         |
| Line comments on any commit's diff            |              No              |        Yes         |
| Reviewed checkmarks that survive reloads      |              No              |        Yes         |
| Flags for lockfiles, CI, env, deletions       |              No              |        Yes         |
| Feedback exported as agent-ready instructions |              No              |        Yes         |
| Tracks which feedback the agent addressed     |              No              |        Yes         |

> **Tip:** Use **Combined** to judge the final state, **By commits** to follow the agent's steps, and **By dependencies** to review foundations before their callers.

---

## Highlights

<table>
<tr>
<td width="50%" valign="top">

<h3>Unpushed work first</h3>

Only local commits not yet on the remote are listed, each with a `+adds −deletes` tag. Uncommitted changes appear as a **Working tree** row above them.

</td>
<td width="50%" valign="top">

<h3>Four view modes</h3>

By commits, Combined, By dependencies, and Comments — one click apart in the section's title bar, with the active mode shown in the header.

</td>
</tr>
<tr>
<td width="50%" valign="top">

<h3>PR-style review</h3>

GitHub-style line comments in the diff gutter, file and folder notes, reviewed checkmarks, and a one-click multi-diff for a whole commit.

</td>
<td width="50%" valign="top">

<h3>Scope-drift flags</h3>

Deletions, lockfiles, CI config, env files, and build config are flagged with ⚠ and a reason — the classic "touched things you didn't ask about" failure.

</td>
</tr>
<tr>
<td width="50%" valign="top">

<h3>Agent-ready export</h3>

Every comment and note becomes an action-item markdown report — copied to the clipboard and written to `.commit-review/latest.md` for the agent to read.

</td>
<td width="50%" valign="top">

<h3>Review rounds</h3>

Each export becomes a round. The latest round marks every item ✅ (code changed since) or ⏳ (not changed yet).

</td>
</tr>
</table>

---

## Table of Contents

- [How It Works](#how-it-works)
- [View Modes](#view-modes)
- [Features](#features)
- [Export Format](#export-format)
- [Requirements](#requirements)
- [Installation](#installation)
- [Getting Started](#getting-started)
- [Configuration](#configuration)
- [Commands](#commands)
- [Data and Privacy](#data-and-privacy)
- [FAQ](#faq)
- [License](#license)

---

## How It Works

The extension is built around one loop: **review → comment → export → agent fixes → check**.

1. **Review**
   Open the unpushed work in whichever view fits — per commit, combined, or by dependencies. Risk flags point at changes outside the intended scope.

2. **Comment**
   Add line comments in any diff, or a note on a whole file or folder. Mark files reviewed as you go.

3. **Export**
   One click turns all feedback into a markdown report, copies it, and writes it to `.commit-review/latest.md`. Your comments move into an exported round, so the next review starts clean.

4. **Agent fixes**
   Paste the report into the agent chat, or tell the agent to read the file.

5. **Check**
   In the **Comments** view, the latest round marks every item ✅ (code changed since the export, committed or not) or ⏳ (not changed yet). Click any item to jump to its line.

---

## View Modes

| Mode                | What it shows                                                                                                                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **By commits**      | Each unpushed commit expands into a real folder tree of its changes. A **Working tree** row on top holds uncommitted changes. Checkboxes pick which commits the other views review.                                                 |
| **Combined**        | The *net* result of all unpushed commits as one tree — ideal when the agent made ten intermediate commits and you only care about the final state.                                                                                     |
| **By dependencies** | Changed files ordered by who imports whom (`↑N` = imported by N changed files), so you review foundations first. Files with no relationships go under "Standalone files". A **Search files…** row fuzzy-finds any file by name.   |
| **Comments**        | A round-by-round overview: the editable **Current round**, then every exported round, newest first.                                                                                                                                   |

What **Combined** and **By dependencies** show is picked in the **By commits** view: the commit checkboxes set the range, and the **Working tree** checkbox (on by default) decides whether uncommitted changes are included.

Dependency analysis is heuristic and covers JS/TS/Vue/Svelte, Python, Java/Kotlin/Scala, Go, Rust, C/C++, C#, Ruby, and PHP.

---

## Features

### See what the agent actually did

- **Unpushed work first** — only local commits not yet on the remote (`@{upstream}..HEAD`). Remote history stays behind "Show pushed history…"; once shown, "Hide pushed history" sits right on the boundary between local and pushed commits.
- **Working tree** — uncommitted changes (staged, unstaged, untracked) appear as a row above the commits, diffed against HEAD, so agent edits are reviewable before they are committed.
- **Pick the review range** — every commit row has a checkbox. Unpushed commits are checked by default; open the pushed history and check an older commit to review from there (the commits in between are included, so the range stays contiguous; they stay listed when the history is hidden again). Combined, By dependencies, Review All, and the export follow the checked range. The Working tree checkbox includes or excludes uncommitted changes. **Reset review range** at the top returns to unpushed only.
- **Jump between modes per file** — right-click a file → **Reveal in Dependency View** switches modes, expands its import chain from the root, and selects it.
- **Find any file in the dependency tree** — the **Search files…** row opens a fuzzy search by class or file name and reveals the file, however deep its chain is collapsed.
- **Scope-drift risk flags** — deletions, lockfiles, CI config, env files, and build config are flagged with ⚠ and a reason.
- **Native styling** — SCM status colors and badges, compact folders, and a Graph-style commit list: blue lane = unpushed, purple = on the remote, branch badges at the right edge, and a hover card with the full message and stats.

### Review it like a PR

- **Review a whole commit in one click** — hover a commit row and hit the multi-diff button: every file's diff opens stacked in a single tab.
- **GitHub-style line comments** — click "+" in the diff gutter to comment on the cursor line, or select several lines to comment on the span. Threads are keyed to the immutable commit, so they never drift, persist across reloads, and show as 💬 counts in the tree.
- **Reviewed checkmarks** — mark files done as you go; they dim with a ✓ so interrupted reviews resume where you stopped.
- **File and folder notes** — attach a whole-file or whole-folder remark (📝) when a line comment is too narrow.
- **Correct diffs everywhere** — renames, added and deleted files, and root commits.

### Keep track of your feedback

- **Comments view** — everything you wrote this round, grouped by path. Hover for the quoted code and full text, click to jump to the line, and use the inline ✏️ / 🗑 buttons to reword or drop an entry.
- **Exported rounds** — each export appears as a round; click it to open the markdown file it was written to.
- **Archive old rounds** — the inline Archive button tucks a round into a collapsed "Archived rounds" group; unarchive anytime.

### Close the loop with the agent

- **Export review summary** — the button at the end of the **Current round** row in the Comments view (look the round over, then export it) collects every line comment (with the quoted code), note, and flag into an action-item report. Comments on files outside the change set ("this file should change too") get their own section — nothing you write is dropped.
- **Review rounds** — exporting moves delivered feedback into an exported round and keeps a timestamped copy (`.commit-review/2026-09-24_1608.md`). The export carries this round's feedback only; the ✅ / ⏳ status of the last round is shown in the Comments view.
- **Undo** — "Undo Export" on the toast, or "Restore Last Exported Round" from the command palette, brings the last round back into the current one.
- **Revert a commit** — right-click → revert (creates an undo commit, after confirmation) when a change should simply not exist.

---

## Export Format

The report reads as instructions, not prose. A shortened example:

````markdown
# Code review feedback (a1b2c3d..e4f5a6b)

## 🎯 Action items (3)

### 📁 src/legacy/ (folder)

This whole folder should not change in this task.

### 💬 src/api/client.ts:58-61

```
if (!res.ok) return null;
```
Throw instead of swallowing the error.

### 📝 package.json

Revert the dependency bump.
````

| Marker                        | Meaning                                                                   |
| ----------------------------- | ------------------------------------------------------------------------- |
| 💬                            | Line comment, with the quoted code                                        |
| 📝                            | File note                                                                 |
| 📁                            | Folder note                                                               |
| 🌐 Comments outside this change | Feedback on files outside the unpushed range                            |

---

## Requirements

- **VS Code 1.80 or newer**, or an editor built on it (Cursor and other Open VSX editors)
- **Git** available on your `PATH`
- A Git repository opened as the workspace folder

---

## Installation

- **VS Code** — install from the [Marketplace](https://marketplace.visualstudio.com/items?itemName=dwenking.commit-file-tree), or run `ext install dwenking.commit-file-tree` from the command palette.
- **Cursor and other Open VSX editors** — search *Commit Review Tree* in the Extensions view, or install from [Open VSX](https://open-vsx.org/extension/dwenking/commit-file-tree).

---

## Getting Started

1. Open the **Source Control** sidebar (`Cmd/Ctrl+Shift+G`).
2. Find the **COMMIT REVIEW TREE** section below the built-in Changes/Graph sections. It may start collapsed at the bottom — click its header to expand it, or drag the header upward to pin it.
3. Click a commit row to expand its file tree. Hover a row for the review-all and revert buttons; right-click for copy and revert actions.
4. Switch modes with the buttons in the section's title bar.

---

## Configuration

| Setting                     | Default                    | Description                                                                                                                                                             |
| --------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commitFileTree.exportPath` | `.commit-review/latest.md` | Repo-relative path where **Export Review Summary** also writes the report, so your agent can read it. Kept out of git via `.git/info/exclude`. Empty = clipboard only. |

---

## Commands

Title-bar buttons and command palette entries:

| Command                                         | Description                                              |
| ----------------------------------------------- | -------------------------------------------------------- |
| View by Commits                                 | Switch to the per-commit view                            |
| View All Unpushed Changes as One Tree           | Switch to the Combined view                              |
| View by Dependencies                            | Switch to the dependency view                            |
| View Review Comments                            | Switch to the Comments view                              |
| Export Review Summary (copy for AI)             | Export all feedback and start a new round                |
| Review All Changes                              | Open every unpushed change in one multi-diff tab         |
| Refresh                                         | Reload the tree                                          |
| Commit Review Tree: Reset Review Range to Unpushed Commits | Uncheck pushed commits; review unpushed work only |
| Commit Review Tree: Restore Last Exported Round | Move the last exported round back into the current round |
| Commit Review Tree: Clear All Review Data       | Delete all comments, notes, rounds, and reviewed marks   |

Row actions (comment, note, mark reviewed, revert, copy, archive, edit, delete) appear as inline buttons and in the right-click menu.

---

## Data and Privacy

- Comments, notes, reviewed marks, and rounds are stored in the editor's per-workspace storage, on your machine. Each worktree folder has its own.
- Nothing is sent anywhere. The extension runs local `git` commands only and has no telemetry.
- Exported reports are written inside your repo and excluded from git via `.git/info/exclude`; your `.gitignore` is never touched.

---

## FAQ

<details>
<summary><strong>I deleted the <code>.commit-review/</code> files, but the rounds are still shown.</strong></summary>

The files are copies written for your agent; the extension never reads them back. Rounds live in the editor's workspace storage. Run **Commit Review Tree: Clear All Review Data** to remove them, or archive rounds you no longer need.

</details>

<details>
<summary><strong>The combined view shows too many (or too few) commits.</strong></summary>

By default the range is the unpushed commits; use the commit checkboxes to widen or narrow it, and **Reset review range** to go back. "Unpushed" means commits since the upstream branch. Without an upstream, the extension uses the nearest commit that is on any remote, then the merge-base with a local `main`/`master`, then the whole history.

</details>

<details>
<summary><strong>Why is a file missing from the dependency chains?</strong></summary>

Dependency analysis is a heuristic over import statements. Files with no detected relationships are listed under "Standalone files". Use the **Search files…** row to find any changed file.

</details>

---

## License

[MIT](LICENSE)
