# 学费计价器 (Tuition Ticker)

A local, open-source "class cost meter": it converts tuition into cost per second, uses the imported class timetable (.ics) to detect class time automatically, and tracks slacking.

- Requirements: [docs/PRD.md](docs/PRD.md)
- Development plan and phases: [docs/DEV_PLAN.md](docs/DEV_PLAN.md). Check which phase is current before starting work.

## Form
A local folder. Double-clicking `start.cmd` starts a Node service bound to 127.0.0.1 and opens the browser. All data is stored as JSON files under `data/`. Requires Node.js ≥ 22.

## Architecture rules
- `src/core/`: pure functions only. No DOM, no network, no direct reads of `Date.now()`; the current time is passed in as the `now` parameter. All billing and time logic lives here and must have Vitest tests.
- The UI layer only displays and collects input; it does not compute money itself.
- `server/`: plain JS (ESM) using only Node built-in modules, with **no third-party dependencies**. It only stores files, reads files, downloads subscription links and serves `app/`.
- Store tuition as integer minor units (cents). Compute consumption from the timetable and `now` each time; never accumulate it by ticking.
- Session ID = `UID|original start time`. User marks are keyed by this ID.

## Privacy (must follow)
- `test-data/private/` holds the user's real calendar. **Never commit it**, and never paste its contents into issues, documentation or external services.
- `data/` is user data and is also not committed.

## Conventions
- UI copy defaults to Simplified Chinese. Code, identifiers and commit messages are in English.
- Commands (available after Phase 0): `npm run dev` (development), `npm test`, `npm run build`, `npm run release`.
