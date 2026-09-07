# Changelog

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
