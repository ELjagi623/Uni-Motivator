// Runs once in the main Vitest process before workers are spawned; workers inherit the env.
export function setup(): void {
  process.env.TZ = 'Asia/Hong_Kong';
}
