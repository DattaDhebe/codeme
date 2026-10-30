import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackendClient, ModelCatalog, ModelSetupStatus } from '../src/backendClient';
import { PersonalCodexSidebarProvider } from '../src/sidebarProvider';
import { catalogSourceUrl, readyCatalogModel, renderModelCatalog } from '../src/webview/modelCatalog';

const status = (extra: Partial<ModelSetupStatus> = {}): ModelSetupStatus => ({
  state: 'ready', provider: 'ollama', model: 'old:7b', available_models: ['old:7b'], message: 'Ready',
  completed_bytes: 0, total_bytes: 0, percent: 100, error: null, can_retry: true, auto_setup_enabled: false, ...extra,
});
const catalog: ModelCatalog = {
  provider: 'ollama', download_supported: true, setup_active: false, inventory_available: true,
  researched_at: '2026-10-30', models: [{ id: 'coder', name: 'Local coder', ollama_model: 'coder:30b',
    hugging_face_url: 'https://huggingface.co/author/coder', ollama_url: 'https://ollama.com/library/coder:30b',
    license: 'Apache-2.0', download_size_gb: 19, memory_guidance: 'Plan for 32 GB-class memory', tier: 'Workstation',
    description: 'Coding and tools', validation_note: 'Not evaluated locally', recommended: true, installed: false, active: false }],
};
const options = { loading: false, pending: false, streaming: false, error: '' };
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('coding model catalog', () => {
  it('lists optional downloads with memory, license, and research limits', () => {
    const html = renderModelCatalog(catalog, status(), options);
    expect(html).toContain('Download and use'); expect(html).toContain('19 GB');
    expect(html).toContain('32 GB-class'); expect(html).toContain('Apache-2.0');
    expect(html).toContain('Not evaluated locally'); expect(html).toContain('not RAM or VRAM');
    expect(html).toContain('data-catalog-id="coder"');
  });
  it('reuses the installed model and disables choices during setup or unsupported providers', () => {
    expect(renderModelCatalog(catalog, status({ available_models: ['coder:30b'] }), options)).toContain('Use installed model');
    expect(renderModelCatalog(catalog, status({ state: 'downloading' }), options)).toContain('data-catalog-id="coder" disabled');
    expect(renderModelCatalog({ ...catalog, download_supported: false }, status(), options)).toContain('current server');
    expect(renderModelCatalog({ ...catalog, download_supported: false }, status(), options)).toContain('data-catalog-id="coder" disabled');
  });
  it('escapes catalog text and only permits official HTTPS source links', () => {
    const altered = { ...catalog, models: [{ ...catalog.models[0], name: '<script>alert(1)</script>', hugging_face_url: 'javascript:alert(1)' }] };
    const html = renderModelCatalog(altered, status(), options);
    expect(html).not.toContain('<script>'); expect(html).not.toContain('javascript:');
    expect(catalogSourceUrl('https://huggingface.co.evil.test/a', 'huggingface.co')).toBeNull();
    expect(catalogSourceUrl('https://user:secret@huggingface.co/a', 'huggingface.co')).toBeNull();
  });
  it('selects only the explicitly requested model when it becomes ready', () => {
    const ready = status({ catalog_id: 'coder', explicit_selection: true, model: 'coder:30b', available_models: ['old:7b', 'coder:30b'] });
    expect(readyCatalogModel('coder', ready)).toBe('coder:30b');
    expect(readyCatalogModel('other', ready)).toBeNull();
    expect(readyCatalogModel(null, ready)).toBeNull();
    expect(readyCatalogModel('coder', { ...ready, state: 'loading' })).toBeNull();
    expect(readyCatalogModel('coder', { ...ready, available_models: [] })).toBeNull();
  });
  it('keeps catalog failures isolated from conversation content and sends only the catalog ID', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify(status()))));
    vi.stubGlobal('fetch', fetchMock);
    const client = new BackendClient({ get: (_key, fallback) => fallback });
    await client.getModelCatalog(); await client.startModelSetup('coder');
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:8000/api/model-catalog');
    expect(fetchMock.mock.calls[1][1]).toEqual(expect.objectContaining({ method: 'POST', body: '{"catalog_id":"coder"}', headers: { 'Content-Type': 'application/json' }, redirect: 'error' }));
  });
  it('reports a download rejection without declaring the existing backend offline', async () => {
    const monitor = { stop: vi.fn(), refresh: vi.fn().mockResolvedValue(undefined) };
    const provider = Object.create(PersonalCodexSidebarProvider.prototype) as any;
    Object.assign(provider, { backend: { startModelSetup: vi.fn().mockRejectedValue(new Error('Another setup is active')) },
      setupMonitor: () => monitor, send: vi.fn().mockResolvedValue(undefined) });
    await provider.handleMessage({ command: 'chooseCatalogModel', args: { catalogId: 'coder' } });
    expect(provider.backend.startModelSetup).toHaveBeenCalledWith('coder');
    expect(provider.send).toHaveBeenCalledWith({ command: 'modelCatalogActionDone', payload: { error: 'Another setup is active' } });
    expect(provider.send.mock.calls.some(([message]: any[]) => message.command === 'backendStatus')).toBe(false);
    expect(monitor.refresh).toHaveBeenCalledOnce();
  });
});
