# Contributing / 贡献指南

Thanks for helping! 谢谢你愿意参与。This project is a small, local, dependency-light app, so most contributions are a
data file or a dictionary away. Read [CLAUDE.md](CLAUDE.md) (architecture rules) and [README.md](README.md) first.

## Ground rules

- `src/core/` is **pure functions only** (no DOM, no network, no `Date.now()`; the time is a `now` parameter) and every
  change there needs Vitest tests. Money is stored as integer minor units.
- `server/` uses only Node built-in modules (no third-party dependencies).
- The UI only displays and collects input. **UI text goes through `t()`**: no Chinese literals and no hard-coded colours in
  `src/ui/` and `src/state/` (`npm run check:ui` enforces this).
- Never commit `data/` or `test-data/private/` (your real calendar), and never paste calendar contents into issues,
  docs or tests.
- Before opening a pull request run: `npm test`, `npm run check:arch`, `npm run check:ui`, `npm run check:tokens`,
  `npm run check:i18n`, `npm run build`, and `npm run acceptance`.
- UI copy is Simplified Chinese by default; code, identifiers and commit messages are English.

## Add a school / region preset

A preset fills the default **academic year start** and **semester split date** (`MM-DD`) in the first-run setup.

1. Edit `src/data/regions.ts`: add an entry to `REGION_PRESETS` (`id`, `yearStart`, `splitDate`) and widen the `id` type.
   Example: northern hemisphere is `08-01` / `12-25`, southern hemisphere `01-01` / `07-01`. The split date should fall
   inside the winter break; the app's split-date check suggests a better one when it does not.
2. Add the display name to all three dictionaries (`region.<id>` in `src/i18n/zh-CN.ts`, `zh-TW.ts`, `en.ts`).
3. **Course-code rules and non-course keywords** (what counts as a course and what is ignored) live in
   `src/core/courses.ts`: `CODE_RE` (e.g. `COMP3230`), `EXCLUDE_RE` (words such as exam, holiday, reading week) and
   `SUFFIX_RE` (Lecture / Tutorial / Lab ... that are merged into one course). If your school uses another pattern, extend
   these regular expressions and add a case to `tests/core/courses.test.ts` with a **fictional** calendar fixture in
   `tests/fixtures/`.

## Add a city price pack ("what could this money have bought?")

1. Copy `src/data/price-pack-hk.ts` to `src/data/price-pack-<city>.ts`. Each item has an `id`, a name, an emoji, a
   counter word (`unit`), a price in major units and the currency of that price. Keep roughly 15-20 everyday items from a
   few cents to a few thousand, rounded and with an updated-date constant. Prices are rough reference values.
2. Add the translated names and counter words (`zh-TW`, `en`) the way `PRICE_PACK_TEXT` does in the Hong Kong pack. For
   English the counter word is written `×`.
3. Wire the pack into `src/core/equivalents.ts` (`pickEquivalent` takes a pack argument) and the places that call it
   (`src/state/slack.ts`, `src/state/sessions.ts`); `tests/core/equivalents.test.ts` shows what to assert (for example the
   "skip calculator" must give 88 boxes for 3,980 against the HK$45 box).

## Add or improve a translation

The interface has three dictionaries with **identical keys**: `src/i18n/zh-CN.ts` (the source), `zh-TW.ts` and `en.ts`.

1. To fix wording, edit the value in `zh-TW.ts` or `en.ts`; keep the `{placeholders}` exactly as they are.
2. To add a message, add the key to `zh-CN.ts` first, then to the other two (TypeScript refuses to compile if a key is
   missing). Use it with `t('your.key', { name: value })`.
3. To add a language, create `src/i18n/<code>.ts` typed as `Record<MessageKey, string>`, register it in
   `src/i18n/index.ts` (`dictionaries`, `LOCALES`), add its name to `lang.*` and extend `scripts/check-i18n.mjs`.
4. Run `npm run check:i18n`: it fails on missing / extra keys, changed placeholders and empty messages.

The Traditional Chinese dictionary was generated from the Simplified one with a character table and has **not been
reviewed by a native reader**; the English one is hand-written but also unreviewed. Corrections are very welcome.

## Add or change the copy lines (the rotating text)

The lines shown during class, on the slacking page, in breaks and after slacking live in `src/data/copy-zh-cn.ts`,
`copy-zh-tw.ts` and `copy-en.ts`: 3 tones (`gentle`, `normal`, `extreme`) × 4 scenes (`in-class`, `slacking`, `break`,
`settlement`), at least 8 lines each (`npm run check:i18n` checks this).

- A line may use only the placeholders its scene provides (listed at the top of `copy-zh-cn.ts`, e.g. `{course}`,
  `{amount}`, `{rate}`, `{minutes}`); a line whose placeholder has no value is skipped, never shown with `{...}`.
- Keep the tone of each level: gentle = encouraging, normal = factual, extreme = dramatic (but never abusive).
- Add the same idea to every language file, or leave the other languages alone: a language missing a scene falls back to
  Simplified Chinese.

## Releasing (maintainers)

`npm run release` builds `app/` and writes `release/tuition-ticker-v<version>.zip` (git-ignored). The GitHub Actions
workflow `.github/workflows/release.yml` does the same on a `v*` tag and attaches the zip to a Release. Bump `version`
in `package.json` first.
