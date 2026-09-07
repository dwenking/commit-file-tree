# Changelog

## 0.4.3
- Store page refresh: single hero screenshot, feature copy updated for review rounds and multi-line comments.

## 0.4.2
- Export shows a confirmation with archive counts, plus an "Export Only" choice that skips archiving.
- Restore Last Archived Round has a title-bar button (visible when an archive exists).
- Removed the title-bar Review All Changes button; the per-commit hover button remains.

## 0.4.1
- Archive-on-export is now undoable: the toast offers "Undo Archive", and "Restore Last Archived Round" in the command palette brings back the most recent round anytime. Archives are stored per round.

## 0.4.0
- Exporting a review summary now archives the delivered comments and file notes, so each review round starts clean after you paste feedback to the agent. Archives are kept in workspace storage.
- File notes outside the change set are exported too (own section), matching comments.
- New command: "Commit Review Tree: Clear All Review Data" (comments, notes, reviewed marks, archives).

## 0.3.16
- Export no longer drops comments made outside the unpushed change set — they appear under "Comments outside this change" with file, line, and source revision.

## 0.3.15
- Multi-line comments: select a range, click "+", and the thread anchors to the whole span (shown as L3-L7 in the tree and export; the export quotes up to 8 lines).

## 0.3.13 – 0.3.14
- Comment "+" no longer disappears after discarding an empty comment draft.

## 0.3.12
- New hero screenshot: combined view with the full change tree.

## 0.3.11
- Store page screenshots for the main review workflows.

## 0.3.10
- Combined and dependency views work in repos without an upstream: base falls back to the merge-base with a local main/master, or the empty tree for single-branch local repos.

## 0.3.9
- Comment "+" is a single steady marker on the cursor's line: no flicker while typing, no duplicates on wrapped or multi-line selections.

## 0.3.8
- Comment "+" gutter only appears on the cursor's line instead of every hovered line.
- Delete button only shows on threads with saved comments; new empty threads just have collapse.

## 0.3.6
- Folders whose files are all deleted (or all added) are colored and badged like their files, in combined and commit trees. Deletion is verified against the working tree so folders that still contain unchanged files are not misflagged.

## 0.3.5
- Commit rows show only the author, matching the native Graph; diff stats, file count, time, and hash moved to the hover.

## 0.3.4
- Reveal in Dependency View expands the target's subtree and adds a back button to return to the previous view.
- Expanding a dependency node now expands its whole subtree; roots stay collapsed.
- Store page documents Reveal in Dependency View.

## 0.3.3
- Right-click a file in commit/combined view → "Reveal in Dependency View" jumps to its import chain, expanded and selected.

## 0.3.2
- Dependency view nodes start collapsed for a cleaner overview.

## 0.3.1
- Dependency view covers Vue/Svelte, Go, Rust, C/C++, C#, Ruby, PHP, Scala/Groovy in addition to JS/TS, Python, Java/Kotlin.

## 0.3.0
- Dependency view supports Java and Kotlin (fully-qualified imports resolved by package path, incl. static and wildcard imports).

## 0.2.9
- Marketplace search keywords.

## 0.2.8
- Inline revert button on commit rows (previously right-click only).
- Store page explains where the panel lives after install.

## 0.2.7
- Rounded view badge showing the number of files awaiting review.
- Changelog moved to its own marketplace tab.

## 0.2.6
- Marketplace documentation rewrite.

## 0.2.5
- All three view-mode buttons are always visible; active mode shown in the view header.
- Dependency view groups files without import relationships under "Standalone files".

## 0.2.3 – 0.2.4
- Renamed/copied files diff against their origin path (fixed "nonexistent file" errors), in all three view modes.

## 0.2.1 – 0.2.2
- New **by dependencies** view mode with cycle-safe import analysis.
- Review actions promoted to the view title bar; one-click mode switching.
- Export trimmed to action items only.

## 0.2.0
- GitHub-style line comments via the native Comments API, persisted per commit.
- Export review summary for AI (clipboard + markdown report).

## 0.1.0
- Rebranded as **Commit Review Tree** with a review workflow: combined view, multi-diff review-all, reviewed checkmarks, file notes, scope-drift risk flags, commit revert.

## 0.0.1 – 0.0.6
- Initial release: unpushed-first commit list with folder trees, compact folders, diff stats, native SCM styling, pushed-history paging, copy hash/message.
