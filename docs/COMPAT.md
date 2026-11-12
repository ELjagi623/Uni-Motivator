# Compatibility checklist / 兼容性冒烟清单

Tuition Ticker is a Node.js service (22+) plus a browser page. This file lists what to try on each platform and what has
**actually been verified**. Anything marked "not verified" has not been run by the project; please do not read it as
"works".

## Smoke checklist (run it from the unzipped release, not from the source folder)

1. Start: double-click `start.cmd` (Windows) / `start.command` (macOS). The window prints
   `TUITION_TICKER_URL=http://127.0.0.1:<port>` and the browser opens.
2. First-run setup (7 steps) with a calendar file; the preview and the home screen show numbers.
3. Home screen (demo mode is enough: "Try the demo first"), the "slacking" page and its settlement card.
4. Class list: mark a class as skipped, reload the page, the mark is still there.
5. Statistics page; make a share card (a 1080 × 1440 PNG that can be saved).
6. Theme: follow system / light / dark. Language: 简体中文 / 繁體中文 / English.
7. At widths 1280 and 640: no horizontal scrollbar, fonts load (`document.fonts.status === "loaded"`), no console errors.
8. Settings → Backup: export, change the tuition, import, the tuition is back.

## Results

| Platform | Browser | Status | Notes |
|---|---|---|---|
| Windows 11 | Chromium (the embedded Browser pane of the development tool; the same engine as Chrome / Edge) | **verified** on the unzipped release 0.1.0, served by `node server/index.js` from a folder with spaces and Chinese in its path: items 2-8 (first-run setup with a small fictional calendar, demo mode with the slacking page and settlement card, skipping a class and reloading, statistics page and a 1080 × 1440 share card, light / dark / system theme, the three languages, backup export and import), at 1280 and 640 wide, with no console errors, no horizontal scrollbar and all four fonts `loaded` | `?now=` is dev-only, so the home screen is checked through the demo mode. `start.cmd` itself is exercised by the automated acceptance check, not in a visible window |
| Windows | Google Chrome (stand-alone) | not verified | same engine as above, but the browser itself was not run |
| Windows | Microsoft Edge | not verified | same engine as above, but the browser itself was not run |
| Windows | Firefox | **not verified** | |
| macOS | Safari | **not verified** | |
| macOS | Chrome | **not verified** | |
| macOS | `start.command` | **not verified** | only checked statically: `#!/bin/bash` first line, LF endings, `bash -n` syntax, Node version check, `open` is used by the server to open the browser; the right-click → Open flow was never run on a Mac |
| Linux | any | not verified | `xdg-open` is used to open the browser; `start.command` also runs under bash |

Known platform notes:

- `start.cmd` must stay ASCII with CRLF line endings; `start.command` must stay LF (`.gitattributes` enforces both).
- macOS marks downloaded scripts as quarantined: the first launch needs right-click → Open (or `chmod +x start.command`).
- Browsers that do not allow `Notification` or `localStorage` still work; reminders then only show inside the page and the
  theme / language fall back to the saved settings after the first load.
