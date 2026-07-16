import { describe, expect, it } from 'vitest';
import { BackendClient } from '../src/backendClient';

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
});
