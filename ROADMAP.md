# Roadmap

Solo-maintained. Discrete feature requests go to GitHub Issues; this file holds direction and the reasoning behind it.

## Now

- (empty — pick from Next, or wait for an Issue)

## Next

- Base-ref picker: review "since main" / "since tag" even after pushing.
- `suggestion` blocks in the export that the agent can apply verbatim — only if plain comments prove too ambiguous for agents.

## Shipped

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
