import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackendClient, ModelSetupStatus } from '../src/backendClient';
import { ModelSetupMonitor } from '../src/modelSetupMonitor';

const status = (overrides: Partial<ModelSetupStatus> = {}): ModelSetupStatus => ({
  state: 'checking', provider: 'ollama', model: 'local-coder:7b', available_models: [],
  message: 'Checking local models', completed_bytes: 0, total_bytes: 0, percent: null,
  error: null, can_retry: true, auto_setup_enabled: true, ...overrides,
});
const harness = () => {
  const backend = {
    getModelSetup: vi.fn().mockResolvedValue(status()),
    startModelSetup: vi.fn().mockResolvedValue(status({ state: 'downloading', percent: 23 })),
    cancelModelSetup: vi.fn().mockResolvedValue(status({ state: 'cancelled' })),
  };
  const update = vi.fn().mockResolvedValue(undefined);
  const failure = vi.fn().mockResolvedValue(undefined);
  return { backend, update, failure, monitor: new ModelSetupMonitor(backend, update, failure) };
};
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('automatic local model setup monitor', () => {
  it('starts an idle setup once and polls until the downloaded model is ready', async () => {
    vi.useFakeTimers();
    const { backend, update, monitor } = harness();
    backend.getModelSetup.mockResolvedValueOnce(status({ state: 'idle' }))
      .mockResolvedValueOnce(status({ state: 'loading' }))
      .mockResolvedValue(status({ state: 'ready', available_models: ['local-coder:7b'] }));
    await monitor.refresh();
    expect(backend.startModelSetup).toHaveBeenCalledOnce();
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'downloading', percent: 23 }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'ready' }));
    const requests = backend.getModelSetup.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(backend.getModelSetup).toHaveBeenCalledTimes(requests);
  });

  it('honors automatic setup opt-out while allowing an explicit setup action', async () => {
    const { backend, monitor } = harness();
    backend.getModelSetup.mockResolvedValue(status({ state: 'idle', auto_setup_enabled: false }));
    await monitor.refresh();
    expect(backend.startModelSetup).not.toHaveBeenCalled();
    await monitor.refresh('start');
    expect(backend.startModelSetup).toHaveBeenCalledOnce();
    monitor.stop();
  });

  it('does not restart failed or cancelled downloads during status checks', async () => {
    const { backend, monitor } = harness();
    for (const state of ['error', 'cancelled', 'runtime_missing', 'server_unavailable'] as const) {
      backend.getModelSetup.mockResolvedValue(status({ state }));
      await monitor.refresh();
    }
    expect(backend.startModelSetup).not.toHaveBeenCalled();
  });

  it('ignores a stale response after the view is closed', async () => {
    const { backend, update, monitor } = harness();
    let finish!: (value: ModelSetupStatus) => void;
    backend.getModelSetup.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const request = monitor.refresh();
    monitor.stop(); finish(status()); await request;
    expect(update).not.toHaveBeenCalled();
  });

  it('cancels the shared job and clears pending polling', async () => {
    vi.useFakeTimers();
    const { backend, monitor, update } = harness();
    await monitor.refresh();
    await monitor.refresh('cancel');
    expect(backend.cancelModelSetup).toHaveBeenCalledOnce();
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'cancelled' }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(backend.getModelSetup).toHaveBeenCalledOnce();
  });

  it('reports an offline API without creating an uncontrolled retry loop', async () => {
    vi.useFakeTimers();
    const { backend, monitor, failure } = harness();
    backend.getModelSetup.mockRejectedValue(new Error('API offline'));
    await monitor.refresh(); await vi.advanceTimersByTimeAsync(10000);
    expect(failure).toHaveBeenCalledWith(expect.objectContaining({ message: 'API offline' }));
    expect(backend.getModelSetup).toHaveBeenCalledOnce();
  });
});

describe('model setup transport', () => {
  it('checks the explicitly selected model using encoded installed inventory identity', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ model: 'local/coder:7b', agent_ready: true })));
    vi.stubGlobal('fetch', fetchMock);
    const client = new BackendClient({ get: (_key, value) => value });
    await expect(client.getModelCapabilities('local/coder:7b')).resolves.toEqual({ model: 'local/coder:7b', agent_ready: true });
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8000/api/model-capabilities?model=local%2Fcoder%3A7b', expect.objectContaining({ redirect: 'error' }));
  });

  it('uses bodyless local setup endpoints without sending conversation content', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify(status()))));
    vi.stubGlobal('fetch', fetchMock);
    const client = new BackendClient({ get: (_key, value) => value });
    await client.getModelSetup(); await client.startModelSetup(); await client.cancelModelSetup();
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init.method])).toEqual([
      ['http://127.0.0.1:8000/api/model-setup', undefined],
      ['http://127.0.0.1:8000/api/model-setup', 'POST'],
      ['http://127.0.0.1:8000/api/model-setup', 'DELETE'],
    ]);
    expect(fetchMock.mock.calls.every(([, init]) => !init.body && init.redirect === 'error')).toBe(true);
  });
});
