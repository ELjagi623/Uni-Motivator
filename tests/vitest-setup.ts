// Runs before every test file. The app starts in English; the tests were written against the Chinese interface, so they
// run in zh-CN unless a test chooses another language itself (tests/state/i18n-api.test.ts, tests/ui/onboarding.test.tsx).
import { beforeEach } from 'vitest';
import { setLocale } from '../src/i18n';

setLocale('zh-CN');
beforeEach(() => {
  setLocale('zh-CN');
});
