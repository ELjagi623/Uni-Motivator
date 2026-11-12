import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildPools, billingStateAt } from '../../src/core/billing';
import { rateText } from '../../src/state/dashboard';
import { billableSessions, billingConfigOf, pools } from '../../src/state/derived';
import { config, loadAll, resetDataState } from '../../src/state/data';
import {
  buildDraftConfig,
  cancelSave,
  confirmSave,
  draftFromConfig,
  editDraft,
  isDirty,
  parseTuitionText,
  pendingChanges,
  rateChangeText,
  rateChanges,
  resetSettingsState,
  saveSettings,
  setPoolText,
  settingsView,
  unsetBannerText,
  unsetPools,
} from '../../src/state/settings';
import { installFakeServer, type FakeServer } from './fake-server';
import { fixtureConfig, fullTermText } from './fixture-app';

let server: FakeServer;

async function boot(cfg = fixtureConfig()): Promise<void> {
  resetDataState();
  resetSettingsState();
  server?.restore();
  server = installFakeServer({ config: cfg as unknown as Record<string, unknown> }, [{ id: 'cal-0', text: fullTermText }]);
  await loadAll();
}

beforeEach(async () => {
  await boot();
});

afterEach(() => {
  server.restore();
});

const rateOf = (poolKey: string, list = pools.value) => rateText(list.find((p) => p.key === poolKey)!.averageRatePerSec, 'HKD');

describe('settings: the draft', () => {
  it('starts equal to the saved config: not dirty, one tuition field per semester', () => {
    const view = settingsView.value;
    expect(view.dirty).toBe(false);
    expect(view.pools.map((p) => p.key)).toEqual(['2026-S1', '2026-S2']);
    expect(view.pools.map((p) => p.text)).toEqual(['398,000.00', '398,000.00']);
    expect(view.pools.every((p) => !p.unset)).toBe(true);
    expect(draftFromConfig(config.value)).toMatchObject({ billingPeriod: 'semester', currency: 'HKD', yearStart: '08-01', splitDate: '12-25' });
  });

  it('parses typed tuition: empty = not set, a number > 0 = minor units, anything else is invalid', () => {
    expect(parseTuitionText('')).toBeNull();
    expect(parseTuitionText(' 1,234.5 ')).toBe(123450);
    expect(parseTuitionText('0')).toBeUndefined();
    expect(parseTuitionText('abc')).toBeUndefined();
    expect(parseTuitionText('-5')).toBeUndefined();
  });

  it('editing one semester writes only that semester into byPool; the other semester keeps the default', () => {
    setPoolText('2026-S2', '440000');
    const view = settingsView.value;
    expect(view.dirty).toBe(true);
    expect(view.candidate.tuition).toEqual({ defaultMinor: 39_800_000, byPool: { '2026-S2': 44_000_000 } });
    expect(view.pools.map((p) => p.text)).toEqual(['398,000.00', '440000']);
  });

  it('typing the saved amount again is not a change', () => {
    setPoolText('2026-S1', '398000');
    expect(settingsView.value.dirty).toBe(false);
  });

  it('invalid dates and amounts are reported and nothing is saved', async () => {
    editDraft({ splitDate: '13-45' });
    setPoolText('2026-S1', 'many');
    const { errors } = settingsView.value;
    expect(errors.splitDate).toBe(true);
    expect(errors.pools).toEqual(['2026-S1']);
    expect(await saveSettings()).toBe('invalid');
    expect(server.puts('config')).toHaveLength(0);
  });

  it('keeps the other config fields untouched', () => {
    const base = fixtureConfig();
    const next = buildDraftConfig(base, { ...draftFromConfig(base), currency: 'USD' }, ['2026-S1', '2026-S2']);
    expect(next.courses).toBe(base.courses);
    expect(next.calendars).toEqual(base.calendars);
    expect(next.currency).toBe('USD');
    expect(isDirty(base, next)).toBe(true);
  });
});

describe('settings: unit-price preview before saving', () => {
  it('changing the tuition opens the dialog with the old and new unit price from core, and sends nothing until confirmed', async () => {
    const oldRate = rateOf('2026-S1');
    setPoolText('2026-S1', '440000');
    setPoolText('2026-S2', '440000');
    expect(await saveSettings()).toBe('needs-confirmation');
    expect(server.puts('config')).toHaveLength(0);

    const changes = pendingChanges.value!;
    expect(changes.map((c) => c.poolKey)).toEqual(['2026-S1', '2026-S2']);
    // what core says for the new tuition
    const newPools = buildPools(billableSessions.value, billingConfigOf(settingsView.value.candidate));
    expect(changes[0].fromText).toBe(oldRate);
    expect(changes[0].fromText).toBe('HK$1.2708');
    expect(changes[0].toText).toBe(rateText(newPools[0].averageRatePerSec, 'HKD'));
    expect(changes[0].toText).not.toBe(changes[0].fromText);
    expect(Number(changes[0].toText!.slice(3))).toBeCloseTo((440000 / 398000) * 1.2708, 3);

    cancelSave();
    expect(pendingChanges.value).toBeNull();
    expect(server.puts('config')).toHaveLength(0); // cancel sends nothing
    expect(settingsView.value.dirty).toBe(true); // the draft is still there

    expect(await saveSettings()).toBe('needs-confirmation');
    await confirmSave();
    expect(server.puts('config')).toHaveLength(1); // confirm sends exactly once
    const saved = (server.puts('config')[0].json as { doc: { tuition: unknown } }).doc.tuition;
    expect(saved).toEqual({ defaultMinor: 39_800_000, byPool: { '2026-S1': 44_000_000, '2026-S2': 44_000_000 } });
    expect(rateOf('2026-S1')).toBe(changes[0].toText);
    expect(settingsView.value.dirty).toBe(false);
    expect(pendingChanges.value).toBeNull();
  });

  it('changing the second semester does not change the first semester\'s unit price', async () => {
    const s1Before = rateOf('2026-S1');
    const s2Before = rateOf('2026-S2');
    setPoolText('2026-S2', '500000');
    expect(await saveSettings()).toBe('needs-confirmation');
    expect(pendingChanges.value!.map((c) => c.poolKey)).toEqual(['2026-S2']); // only the changed semester is listed
    await confirmSave();
    expect(rateOf('2026-S1')).toBe(s1Before);
    expect(rateOf('2026-S2')).not.toBe(s2Before);
    // consumed + remaining is still the tuition of the pools, at any instant
    const st = billingStateAt(pools.value, Date.parse('2026-11-12T03:00:00Z'));
    expect(st.tuitionMinor).toBe(39_800_000 + 50_000_000);
    expect(st.consumedMinor + st.remainingMinor).toBe(st.tuitionMinor);
  });

  it('a change that moves no price (split date inside the winter break) saves at once', async () => {
    editDraft({ splitDate: '12-30' });
    expect(await saveSettings()).toBe('saved');
    expect(pendingChanges.value).toBeNull();
    expect(server.puts('config')).toHaveLength(1);
    expect(config.value.academic?.splitDate).toBe('12-30');
  });

  it('a split date that moves sessions between the semesters changes unit prices and asks', async () => {
    editDraft({ splitDate: '11-01' });
    expect(await saveSettings()).toBe('needs-confirmation');
    expect(pendingChanges.value!.length).toBeGreaterThan(0);
  });

  it('switching to per-year billing compares with the old overall price and shows the new year price', async () => {
    editDraft({ billingPeriod: 'year' });
    const view = settingsView.value;
    expect(view.pools.map((p) => p.key)).toEqual(['2026']);
    expect(await saveSettings()).toBe('needs-confirmation');
    const [change] = pendingChanges.value!;
    expect(change.poolKey).toBe('2026');
    expect(change.fromText).toBe('HK$1.2708'); // the same tuition over twice the class hours halves the price...
    expect(Number(change.toText!.slice(3))).toBeCloseTo(1.2708 / 2, 3);
    await confirmSave();
    expect(config.value.academic?.billingPeriod).toBe('year');
    expect(config.value.tuition).toEqual({ defaultMinor: 39_800_000 });
  });

  it('a currency change is listed too (the unit price text changes)', async () => {
    editDraft({ currency: 'CNY' });
    expect(await saveSettings()).toBe('needs-confirmation');
    expect(pendingChanges.value![0].fromText).toBe('HK$1.2708');
    expect(pendingChanges.value![0].toText).toMatch(/1\.2708$/);
    expect(pendingChanges.value![0].toText).not.toContain('HK$');
  });

  it('rateChanges is empty when nothing changed', () => {
    expect(rateChanges(pools.value, 'HKD', pools.value, 'HKD')).toEqual([]);
  });
});

describe('settings: a semester without tuition', () => {
  const cfgWithUnsetS2 = () => {
    const cfg = fixtureConfig();
    return { ...cfg, tuition: { defaultMinor: 39_800_000, byPool: { '2026-S2': null } } };
  };

  it('shows "not set" for that semester only, and its figures are zero', async () => {
    const s1Before = rateOf('2026-S1');
    await boot(cfgWithUnsetS2());
    const view = settingsView.value;
    expect(view.pools.map((p) => [p.key, p.unset])).toEqual([['2026-S1', false], ['2026-S2', true]]);
    expect(view.pools[1].text).toBe('');
    expect(rateOf('2026-S1')).toBe(s1Before); // the other semester is not affected
    expect(unsetPools.value.map((p) => p.key)).toEqual(['2026-S2']);
    expect(unsetBannerText.value).toContain('第 2 学期');
    const s2 = pools.value.find((p) => p.key === '2026-S2')!;
    expect(s2.tuitionMinor).toBeNull();
    expect(billingStateAt(pools.value, Date.parse('2027-05-01T00:00:00Z')).unsetPoolKeys).toEqual(['2026-S2']);
  });

  it('filling it in works like any other change and clears the hint', async () => {
    await boot(cfgWithUnsetS2());
    setPoolText('2026-S2', '398000');
    expect(await saveSettings()).toBe('needs-confirmation'); // the semester gets a price: that is a unit-price change
    expect(pendingChanges.value![0].fromText).toBeNull();
    expect(rateChangeText(pendingChanges.value![0], false)).toMatch(/^单价将从 未设置 变为 HK\$\d\.\d{4} \/ 秒$/);
    await confirmSave();
    expect(unsetPools.value).toEqual([]);
    expect(unsetBannerText.value).toBeNull();
  });

  it('clearing a semester\'s field makes it "not set"', async () => {
    setPoolText('2026-S2', '');
    expect(settingsView.value.candidate.tuition?.byPool).toEqual({ '2026-S2': null });
    expect(await saveSettings()).toBe('needs-confirmation');
    expect(rateChangeText(pendingChanges.value![0], true)).toBe('2026 学年 · 第 2 学期：单价将从 HK$1.2708 变为 未设置（不再计价）');
    await confirmSave();
    expect(unsetPools.value.map((p) => p.key)).toEqual(['2026-S2']);
  });
});
