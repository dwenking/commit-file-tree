# Roadmap

Solo-maintained. Discrete feature requests go to GitHub Issues; this file holds direction and the reasoning behind it.

## Now

- (empty — pick from Next, or wait for an Issue)

## Next

- `suggestion` blocks in the export that the agent can apply verbatim — only if plain comments prove too ambiguous for agents.

## Shipped

- 0.4.35 — Dependency view: clicking a nested row opens its diff at the line where it imports its parent.
- 0.4.34 — Symbol changes: file rows expand into the functions, classes and variables added or removed (JS/TS, Python, Java), click opens the diff at that line; "Structure changes" section in the export. Static regex scan of both sides, since no language server serves `git:` URIs.
- 0.4.33 — Fix: the view no longer changes height when switching modes; every mode renders in the one webview instead of swapping a webview and a native tree.
- 0.4.32 — Fix: clicking a commit closes its hover card, which covered the files that opened under it.
- 0.4.31 — Graph-style hover card on commits (author, dates, full message, stats, badges); covers the list and lets the pointer through, since a webview cannot draw beside it.
- 0.4.30 — By commits looks like the Source Control Graph: blue/purple lanes, right-aligned branch badges (≤¼ row), compact rows. Webview built with vscode-elements, since native tree rows can hold neither.
- 0.4.29 — Export carries this round only; previous-round status stays in the Comments view.
- 0.4.28 — Fix: dependency view listed a file once per import of the same target; edges are now deduplicated.
- 0.4.27 — Removed the duplicate "Include uncommitted changes" row from Combined/Dependencies; the Working tree checkbox is the one control.
- 0.4.26 — Review range picked with commit checkboxes (contiguous; pushed commits can be included), Working tree checkbox = include uncommitted changes. Replaces the planned base-ref picker.
- 0.4.25 — Round status down to two marks: ✅ code changed since export / ⏳ not changed yet; compared against the working copy, so uncommitted fixes count.
- 0.4.24 — Fix: working-copy comments counted twice when the view targets the working copy.
- 0.4.23 — README restructured (overview, comparison, highlights, tables, FAQ); Simplified Chinese README on GitHub.
- 0.4.22 — Dependencies view: "Search files…" row, fuzzy-find a changed file and reveal it.
- 0.4.21 — Archive exported rounds into a collapsed group; "archive" wording now only means hiding a round.
- 0.4.20 — Comments view by round: current round, exported rounds with their files, ✅/⚠️/❓ checklist under the latest round (replaces the "Check Last Round" command and the planned tree decoration for still-open items). Colored entries. Uncommitted checkbox in the dependency view.
- 0.4.19 — Comments view: inline edit and delete.
- 0.4.18 — Comments view mode; emoji and counts in the export; "Hide pushed history" on the local/pushed boundary.
- 0.4.17 — Folder notes.
- 0.4.15–0.4.16 — Combined view includes uncommitted changes, with an "Include uncommitted changes" checkbox.
- 0.4.13–0.4.14 — Quieter export (no editor tab, Open on the toast); empty sections omitted.
- 0.4.12 — Round tracking: previous-round checklist in the export, "Check Last Round" command, timestamped per-round files, export always archives. Fix: refresh after push.
- 0.4.11 — Export to file (`.commit-review/latest.md`, git-excluded via `.git/info/exclude`).
- 0.4.10 — Working tree node for uncommitted changes.

## Decided against (for now)

- Splitting `extension.js` — one file is still navigable; split when a second contributor appears.
- Configurable risk-flag patterns — nobody has asked; defaults cover the agent scope-drift cases.
- More dependency-view heuristics — current language coverage has no open requests.
- Telemetry — Marketplace reviews and Issues are the signal; revisit only if decisions start being guesses.
- Language-server symbols for the symbol-change rows — `executeDocumentSymbolProvider` returns nothing for `git:` URIs (TS/JS lists `git` in its disabled schemes; Python, gopls and rust-analyzer select `file:` only), so the base side would need temp files. Regexes cover the three languages asked for.
