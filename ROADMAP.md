# Roadmap

Solo-maintained. Discrete feature requests go to GitHub Issues; this file holds direction and the reasoning behind it.

## Now

1. **Working tree node** — show uncommitted changes as a pseudo-commit at the top of the commit view. Agents leave dirty trees beside their commits; today those are invisible.
2. **Export to file** — write the review summary to a stable path (in addition to the clipboard) so agents can read it directly. Optionally emit `suggestion` blocks the agent can apply verbatim.
3. **Round tracking** — after new commits land, mark each archived comment as addressed (commented span changed between its commit and HEAD) or still open. Data source is the existing archive in workspace storage, not the exported file.

## Next

- Base-ref picker: review "since main" / "since tag" even after pushing.

## Decided against (for now)

- Splitting `extension.js` — one file is still navigable; split when a second contributor appears.
- Configurable risk-flag patterns — nobody has asked; defaults cover the agent scope-drift cases.
- More dependency-view heuristics — current language coverage has no open requests.
- Telemetry — Marketplace reviews and Issues are the signal; revisit only if decisions start being guesses.
