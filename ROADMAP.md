# Roadmap

Solo-maintained. Discrete feature requests go to GitHub Issues; this file holds direction and the reasoning behind it.

## Now

- (empty — pick from Next, or wait for an Issue)

## Next

- Base-ref picker: review "since main" / "since tag" even after pushing.
- Tree decoration for still-open items from the previous round — only if "Check Last Round" gets run constantly.
- `suggestion` blocks in the export that the agent can apply verbatim — only if plain comments prove too ambiguous for agents.

## Shipped

- 0.4.12 — Round tracking: previous-round checklist in the export, "Check Last Round" command, timestamped per-round files, export always archives. Fix: refresh after push.
- 0.4.11 — Export to file (`.commit-review/latest.md`, git-excluded via `.git/info/exclude`).
- 0.4.10 — Working tree node for uncommitted changes.

## Decided against (for now)

- Splitting `extension.js` — one file is still navigable; split when a second contributor appears.
- Configurable risk-flag patterns — nobody has asked; defaults cover the agent scope-drift cases.
- More dependency-view heuristics — current language coverage has no open requests.
- Telemetry — Marketplace reviews and Issues are the signal; revisit only if decisions start being guesses.
