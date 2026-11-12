// Entry point: styles, clock, router, initial data load, render.
import { render } from 'preact';
import './styles/tokens.css';
import './styles/fonts.css';
import './styles/base.css';
import './styles/components.css';
import './styles/dashboard.css';
import { clock } from './state/clock';
import { loadAll } from './state/data';
import { startRouter } from './state/router';
import { installDebug } from './state/debug';
import { startSlackWatcher } from './state/slack';
import { startTitleUpdates } from './state/title';
import { App } from './ui/App';

startRouter();
clock.start();
startSlackWatcher();
startTitleUpdates();
// Development builds only: Vite replaces `import.meta.env.DEV` with false in production and drops this branch.
if (import.meta.env.DEV) installDebug(clock);

render(<App />, document.getElementById('app')!);
void loadAll();
