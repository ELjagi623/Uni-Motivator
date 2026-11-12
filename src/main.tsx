// Phase 0 smoke-test page: one text box + a save button that round-trips a `config` document
// through the local server (data/config.json). Replaced by the real app shell in a later phase.
import { render } from 'preact';
import { signal } from '@preact/signals';

interface Doc {
  schemaVersion: number;
  rev: number;
  note?: string;
  [key: string]: unknown;
}

const config = signal<Doc | null>(null);
const draft = signal('');
const status = signal('加载中…');

async function load(): Promise<void> {
  try {
    const res = await fetch('/api/data');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { config: Doc };
    config.value = data.config;
    draft.value = typeof data.config.note === 'string' ? data.config.note : '';
    status.value = `已读取（rev ${data.config.rev}）`;
  } catch (err) {
    status.value = `读取失败：${(err as Error).message}`;
  }
}

async function save(): Promise<void> {
  const current = config.value;
  if (!current) return;
  try {
    const res = await fetch('/api/docs/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Tuition-Ticker': '1' },
      body: JSON.stringify({ rev: current.rev, doc: { ...current, note: draft.value } }),
    });
    if (res.status === 409) {
      await load();
      status.value = '数据在别的标签页被改过，已刷新';
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { rev } = (await res.json()) as { rev: number };
    config.value = { ...current, note: draft.value, rev };
    status.value = `已保存（rev ${rev}）`;
  } catch (err) {
    status.value = `保存失败：${(err as Error).message}`;
  }
}

function App() {
  return (
    <main style={{ maxWidth: '32rem', margin: '3rem auto', padding: '0 1rem', fontFamily: 'system-ui, sans-serif' }}>
      <h1>学费计价器</h1>
      <p>P0 测试页：输入一段文字并保存，刷新页面或重启服务后应仍然保留。</p>
      <label for="note-input">备注</label>
      <input
        id="note-input"
        type="text"
        style={{ display: 'block', width: '100%', margin: '0.5rem 0', padding: '0.5rem', boxSizing: 'border-box' }}
        value={draft.value}
        onInput={(e) => {
          draft.value = (e.target as HTMLInputElement).value;
        }}
      />
      <button id="save-btn" type="button" onClick={() => void save()} disabled={config.value === null}>
        保存
      </button>
      <p id="status" role="status">
        {status.value}
      </p>
    </main>
  );
}

render(<App />, document.getElementById('app')!);
void load();
