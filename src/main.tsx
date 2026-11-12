// Entry point: styles, clock, router, initial data load, render.
import { render } from 'preact';
import './styles/tokens.css';
import './styles/fonts.css';
import './styles/base.css';
import './styles/components.css';
import './styles/dashboard.css';
import './styles/pages.css';
import { clock } from './state/clock';
import { installLeaveFlush, loadAll } from './state/data';
import { startRouter } from './state/router';
import { installPrivacyShortcut } from './state/privacy';
import { installLanguage } from './state/language';
import { installScale } from './state/scale';
import { installDebug } from './state/debug';
import { startReminders } from './state/reminders';
import { startSlackWatcher } from './state/slack';
import { startTitleUpdates } from './state/title';
import { App } from './ui/App';

startRouter();
installLanguage(); // the saved language once the config is loaded (a localStorage mirror covers the first render)
installScale(); // the saved interface size (zoom): the localStorage mirror right away, the config once it is loaded
installPrivacyShortcut(); // key B: blur every amount
installLeaveFlush(); // pending edits are sent when the page is hidden or closed, not 0.5 s later
clock.start();
startSlackWatcher();
startReminders();
startTitleUpdates();
// Development builds only: Vite replaces `import.meta.env.DEV` with false in production and drops this branch.
if (import.meta.env.DEV) installDebug(clock);

render(<App />, document.getElementById('app')!);
void loadAll();
