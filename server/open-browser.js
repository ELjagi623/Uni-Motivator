// Open the default browser. The URL is always http://127.0.0.1:<port>, never user input.

import { spawn } from 'node:child_process';

/** Build the platform-specific command; separated from spawning so it can be unit-tested. */
export function getOpenCommand(url, platform = process.platform) {
  if (platform === 'win32') {
    // `start` treats the first quoted argument as a window title, hence the empty "" before the URL.
    return { command: 'cmd', args: ['/c', 'start', '""', url], options: { windowsVerbatimArguments: true } };
  }
  if (platform === 'darwin') return { command: 'open', args: [url], options: {} };
  return { command: 'xdg-open', args: [url], options: {} };
}

/** Fire-and-forget. Never throws; failures are reported through `onError`. */
export function openBrowser(url, { platform = process.platform, spawnFn = spawn, onError = () => {} } = {}) {
  try {
    const { command, args, options } = getOpenCommand(url, platform);
    const child = spawnFn(command, args, { ...options, detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', onError);
    child.unref();
    return true;
  } catch (err) {
    onError(err);
    return false;
  }
}
