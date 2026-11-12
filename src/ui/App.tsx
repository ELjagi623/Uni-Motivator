// Application shell: loading / error screens, the notices, and either the onboarding wizard or the dashboard
// (the dashboard also serves demo mode). The slacking layer sits on top of everything.

import { t } from '../i18n';
import { isOnboarded } from '../state/config';
import { config, dismissNotice, loadAll, loadError, loadStatus, notice } from '../state/data';
import { demoActive, exitDemo } from '../state/demo';
import { Button, Notice } from './components/controls';
import { Dashboard } from './pages/Dashboard';
import { Onboarding } from './pages/Onboarding';
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

function Shell() {
  return (
    <div class="panel" id="shell">
      <Dashboard />
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
