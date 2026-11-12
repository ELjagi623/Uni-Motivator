# Tuition Ticker (学费计价器)

**English** | [简体中文](README.md)

Turn the tuition you paid into "money per second". Import your class timetable and the app knows when you are in class and tells you, second by second, how much of your tuition has burned in this lecture. Slacking is billed, skipped classes count as losses. It runs entirely on your own computer; open source and free.

<!-- TODO (before publishing): docs/screenshot.png is a placeholder (coloured blocks that only hint at the layout). Replace it with a real screenshot. -->
![Screenshot (placeholder, to be replaced by a real screenshot)](docs/screenshot.png)

## Get started in three steps

1. **Install Node.js** from <https://nodejs.org/> (the LTS version; 22 or newer). You only do this once.
2. **Download and unzip**: get `tuition-ticker-vX.Y.Z.zip` from the project's Releases page (repository address: to be filled in after publishing) and unzip it anywhere. The release already contains the built interface, so you do **not** need to run `npm`.
3. **Double-click to start**:
   - Windows: double-click `start.cmd`.
   - macOS: the **first time**, in Finder **right-click `start.command` → Open → Open** (macOS asks once before running a downloaded script; afterwards a double-click is enough). If it says you lack permission, run `chmod +x start.command` once in Terminal.

Your browser opens the page by itself (an address like `http://127.0.0.1:4280`); closing the black command window stops the app. The first visit starts a 7-step setup: language → school & region → tuition (per year or per semester, currency, amount) → year start & split date → import calendar → recognise courses → confirm. To look around first, click "Try the demo first": it uses a made-up timetable and saves nothing.

## Export your timetable from Google Calendar

1. Open [Google Calendar](https://calendar.google.com/) on a computer, click the gear icon → "Settings".
2. On the left choose "Import & export" → "Export". A `.zip` downloads, with one `.ics` file per calendar.
3. In setup step 5 (or "Settings" → "Calendars") drop that `.zip` in, or just one of the `.ics` files. The app unzips it and works out which events are classes.

Most university timetable systems can export `.ics` too, and you can import that the same way. iCal subscription links are supported as well: paste an http / https link in the settings and the app syncs it every 6 hours (the link is kept on this computer only, see Privacy; Google Calendar's "Secret address in iCal format" works like a password, do not share it).

## Features

- A per-second money counter, the semester tuition "fuel tank" and today's timeline; the screen follows the state: in class / break / no class today / term not started / term over.
- A "slacking" button that records how long you slacked, what it cost, and what that money could have bought (rice boxes, milk tea, ...).
- Class list: mark classes as skipped / cancelled / late / left early and see what the school swallowed and what you lost; add classes by hand when the calendar lacks them.
- Statistics, a share card (no name, no school name), a skip calculator, class reminders, calendar subscription sync.
- Peek-proof mode (press `B` to blur every amount), a second display currency, credit-weighted billing, several academic years.
- Backup export / import, interface languages Simplified Chinese, Traditional Chinese and English, three tones for the copy lines.

## Privacy

- **All data stays on your computer**, in the `data/` folder next to the app (settings, marks, slacking records and the raw text of the calendars you imported). No accounts, no cloud, no analytics.
- The service listens on `127.0.0.1` only (the loopback address), so other devices on your network cannot reach it; write requests also need a custom header so that other web pages cannot call it behind your back.
- The app **does not go online by itself**. The one exception is an iCal subscription link you add: then the local service downloads the calendar from that link. The link is stored in `data/subscriptions.json` on this computer and never appears on screen, in logs or in exported backups. The exchange-rate table is built in and is never fetched online.
- To erase everything: close the app and delete the folder (or just `data/`).

## Backup export and import

"Settings" → "Backup":

- **Export backup** downloads `tuition-ticker-backup-<date>.json` with your settings, marks, slacking records and the calendar texts. **Subscription links are not exported** (a link can carry a private token).
- **Import backup** only accepts files written by this app. The format and version are checked first; after you confirm, the app **saves your current data to `data/backups/` first** (`…_before-import.json`) and then replaces everything.
- Note: calendars that came from a subscription become **ordinary calendars after an import and no longer sync automatically**; add the subscription link again in the settings if you need it.

## FAQ

**Will the Windows firewall ask me something?** No. The service only listens on the loopback address `127.0.0.1` and accepts no connections from the network, so Windows has no reason to ask "allow this app to access the network?".

**The port is taken / the page does not open?** The default port is 4280. If another program holds it, the app tries 4281, 4282 … (up to 4290) and prints the real address in the command window (`TUITION_TICKER_URL=…`). Double-clicking again while it is running just opens the running instance. You can also choose a port: `start.cmd --port 5000`.

**The window flashes and closes / says Node is missing?** Node.js is not installed or is older than version 22. Install the LTS version from <https://nodejs.org/> and try again; the message in the window says which case it is. On macOS, "cannot be opened because it is from an unidentified developer" means you need the right-click → Open step above.

**The time is wrong?** The app uses your computer's system clock to decide whether you are in class and to compute amounts. Make sure automatic time sync and the right time zone are on.

**Where is my data?** In `data/` inside the app folder (`config.json`, `marks.json`, `slacks.json`, `calendars/*.ics`, and `backups/` with an automatic copy before every save). To upgrade, unzip the new version elsewhere and copy your old `data/` folder across; or use backup export / import.

**New school or a fresh start?** Delete `data/` and open the app again to see the setup. A new semester or academic year does not need that: import the new calendar under "Settings" → "Academic years".

**Are the translations reliable?** Simplified Chinese is the original text. **The Traditional Chinese and English interface texts and copy lines have not been reviewed by native speakers**, so some wording may sound off; issues and pull requests are welcome (see [CONTRIBUTING.md](CONTRIBUTING.md)).

**Which browsers work?** Development and testing happened on Windows with Chromium-based browsers (Chrome / Edge) only. Running on Firefox, Safari and macOS is **not verified yet**; see [docs/COMPAT.md](docs/COMPAT.md).

## Run from source / contribute

Needs Node.js 22+.

```
npm install
npm run dev        # development (Vite + local service)
npm test           # unit tests and server tests
npm run build      # build app/
npm run release    # write the release zip under release/
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for conventions and how to contribute. License: [MIT](LICENSE).
