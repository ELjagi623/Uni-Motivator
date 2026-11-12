// Application shell: loading / error screens, the notices, and either the onboarding wizard or the dashboard
// (the dashboard also serves demo mode). The slacking layer sits on top of everything.

import { t } from '../i18n';
import { isOnboarded } from '../state/config';
import { config, dismissNotice, loadAll, loadError, loadStatus, notice } from '../state/data';
import { demoActive, exitDemo } from '../state/demo';
import { route, type RoutePath } from '../state/router';
import { dismissToast, toasts } from '../state/reminders';
import { privacyOn, togglePrivacy } from '../state/privacy';
import { unsetBannerText } from '../state/settings';
import { Button, Notice } from './components/controls';
import { Dashboard } from './pages/Dashboard';
import { Onboarding } from './pages/Onboarding';
import { Sessions } from './pages/Sessions';
import { Stats } from './pages/Stats';
import { Settings } from './pages/Settings';
import { SlackLayer } from './pages/Slack';

function DemoBanner() {
  return (
    <div class="demo-banner" id="demo-banner" role="status">
      <span class="grow">{t('demo.banner')}</span>
      <Button small variant="ghost" id="demo-exit" onClick={exitDemo}>
        {t('demo.exit')}
      </Button>
    </div>
  );
}

const NAV: ReadonlyArray<{ path: RoutePath; label: 'nav.dashboard' | 'nav.sessions' | 'nav.stats' | 'nav.settings'; id: string }> = [
  { path: '/', label: 'nav.dashboard', id: 'nav-dashboard' },
  { path: '/sessions', label: 'nav.sessions', id: 'nav-sessions' },
  { path: '/stats', label: 'nav.stats', id: 'nav-stats' },
  { path: '/settings', label: 'nav.settings', id: 'nav-settings' },
];

/** The peek-proof switch: blurs every amount (also on the key B). Not saved: it is off whenever the page opens. */
function PrivacyToggle() {
  const on = privacyOn.value;
  return (
    <>
      <button type="button" id="privacy-toggle" class="shell-nav__link shell-nav__privacy" aria-pressed={on} aria-label={t('privacy.toggleAria')} onClick={togglePrivacy}>
        {t('privacy.toggle')} <kbd class="kbd">B</kbd>
      </button>
      <span class="sr-only" id="privacy-status" role="status">
        {on ? t('privacy.statusOn') : t('privacy.statusOff')}
      </span>
    </>
  );
}

/** The page links (hash routes). Not shown in demo mode, which only has the dashboard. */
function ShellNav({ current }: { current: RoutePath }) {
  return (
    <nav class="shell-nav" aria-label={t('nav.aria')}>
      {NAV.map((item) => (
        <a key={item.path} id={item.id} class="shell-nav__link" href={`#${item.path}`} aria-current={current === item.path ? 'page' : undefined}>
          {t(item.label)}
        </a>
      ))}
      <PrivacyToggle />
    </nav>
  );
}

/** Shown while a tuition pool has no tuition: the amounts for it are 0, and the way to fix it is one click away. */
function UnsetBanner() {
  const text = unsetBannerText.value;
  if (text === null) return null;
  return (
    <div class="notice unset-banner" id="unset-banner" role="status">
      <span class="grow">{text}</span>
      <a class="btn btn--small btn--ghost" href="#/settings">
        {t('shell.unsetGo')}
      </a>
    </div>
  );
}

/** Class reminders that could not be shown as browser notifications (no permission): they appear here instead. */
function ReminderToasts() {
  const list = toasts.value;
  if (list.length === 0) return null;
  return (
    <div class="toasts" id="reminder-toasts" role="status" aria-label={t('notify.aria')}>
      {list.map((toast) => (
        <div class="notice toast" key={toast.id} data-toast-key={toast.id}>
          <span class="grow money">
            {toast.text}
            {toast.note ? <span class="muted small toast__note"> {toast.note}</span> : null}
          </span>
          <Button small variant="ghost" onClick={() => dismissToast(toast.id)}>
            {t('notice.dismiss')}
          </Button>
        </div>
      ))}
    </div>
  );
}

function Shell() {
  const path = demoActive.value ? '/' : route.value;
  return (
    <div class="shell" id="shell">
      {demoActive.value ? null : <ShellNav current={path} />}
      <ReminderToasts />
      {demoActive.value || path === '/settings' ? null : <UnsetBanner />}
      <div class="panel" id="shell-panel">
        {path === '/sessions' ? <Sessions /> : path === '/settings' ? <Settings /> : path === '/stats' ? <Stats /> : <Dashboard />}
      </div>
    </div>
  );
}

export function App() {
  const status = loadStatus.value;
  const demo = demoActive.value;
  let content;
  if (demo) {
    content = <Shell />;
  } else if (status === 'idle' || status === 'loading') {
    content = (
      <div class="centered" role="status">
        <span class="muted">{t('app.loading')}</span>
      </div>
    );
  } else if (status === 'error') {
    content = (
      <div class="centered" role="alert">
        <p>{t('app.loadError', { message: loadError.value ?? '' })}</p>
        <Button variant="primary" onClick={() => void loadAll()}>
          {t('app.retry')}
        </Button>
      </div>
    );
  } else {
    content = isOnboarded(config.value) ? <Shell /> : <Onboarding />;
  }
  return (
    <div class="app">
      {demo ? <DemoBanner /> : null}
      {notice.value ? <Notice message={notice.value} onDismiss={dismissNotice} /> : null}
      {content}
      <SlackLayer />
    </div>
  );
}
