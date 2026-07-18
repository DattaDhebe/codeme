import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BackendClient } from '../src/backendClient';
import manifest from '../package.json';

class FakeConfig {
  get<T>(section: string, defaultValue: T): T {
    if (section === 'personalCodex.backendUrl') {
      return 'http://127.0.0.1:8000' as unknown as T;
    }
    if (section === 'personalCodex.defaultModel') {
      return 'qwen2.5-coder:7b' as unknown as T;
    }
    return defaultValue;
  }
}

describe('BackendClient', () => {
  it('builds correct backend url', async () => {
    const client = new BackendClient(new FakeConfig());
    expect((client as any).backendUrl).toBe('http://127.0.0.1:8000');
  });

  it('loads persisted conversations from the backend', async () => {
    const conversations = [{ id: 7, title: 'Fix parser', created_at: '2026-01-01', updated_at: '2026-01-01' }];
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => conversations,
      text: async () => '',
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new BackendClient(new FakeConfig());
    await expect(client.listConversations()).resolves.toEqual(conversations);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8000/api/conversations',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it('supports deleting a conversation with an empty response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204, text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);

    const client = new BackendClient(new FakeConfig());
    await expect(client.deleteConversation(9)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8000/api/conversations/9',
      expect.objectContaining({ method: 'DELETE' })
    );
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('extension manifest', () => {
  it('contributes the sidebar as a webview', () => {
    expect(manifest.activationEvents).toContain('onView:personalCodemeSidebar');
    expect(manifest.contributes.views.personalCodeme).toContainEqual({
      id: 'personalCodemeSidebar',
      name: 'Personal Codeme',
      type: 'webview',
    });
  });
});

describe('Copilot-style webview', () => {
  it('includes the core chat, history, context, and code-action controls', () => {
    const source = readFileSync(resolve(__dirname, '../src/webview/webview.ts'), 'utf8');
    for (const capability of [
      'toggleHistory',
      'loadConversation',
      'requestContext',
      'cancelStream',
      'code-apply',
      'code-open',
      'model-select',
    ]) {
      expect(source).toContain(capability);
    }
  });
});
