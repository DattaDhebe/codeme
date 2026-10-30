import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackendClient, localBackendUrl } from '../src/backendClient';
import { readEventStream } from '../src/eventStream';
import { safeMarkdown } from '../src/webview/safeMarkdown';
import { PersonalCodexSidebarProvider } from '../src/sidebarProvider';

const settings = (values: Record<string, unknown> = {}) => ({
  get<T>(key: string, fallback: T): T { return (values[key] ?? fallback) as T; },
});
const encode = new TextEncoder();
function responseFrom(parts: Uint8Array[]): Response {
  return new Response(new ReadableStream({ start(controller) { parts.forEach((part) => controller.enqueue(part)); controller.close(); } }));
}
const sseResponse = (value: string) => responseFrom([encode.encode(value)]);
afterEach(() => { vi.unstubAllGlobals(); });

describe('local backend configuration', () => {
  it('uses scoped VS Code model and backend settings', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('[]'));
    vi.stubGlobal('fetch', fetchMock);
    const client = new BackendClient(settings({ backendUrl: 'http://localhost:8123/', defaultModel: 'local-coder:latest' }));
    expect(client.configuredModel).toBe('local-coder:latest');
    await client.listConversations();
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:8123/api/conversations', expect.objectContaining({ redirect: 'error' }));
  });
  it.each(['https://localhost.attacker.test', 'http://127.0.0.1.attacker.test', 'https://example.com', 'file:///tmp/api', 'http://user:secret@localhost', 'http://localhost?redirect=1', 'not a url'])('rejects non-local or ambiguous URL %s', (value) => {
    expect(() => localBackendUrl(value)).toThrow();
  });
  it.each(['http://127.0.0.1:8000', 'http://localhost:8000', 'http://[::1]:8000'])('accepts loopback URL %s', (value) => {
    expect(localBackendUrl(value)).toBe(value);
  });
  it('never sends chat or workspace data to a remote endpoint', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const client = new BackendClient(settings({ backendUrl: 'https://example.com' }));
    await expect(client.registerWorkspace('C:/private', 'private')).rejects.toThrow(/only connects/);
    const failure = vi.fn();
    await client.streamChat(1, [{ role: 'user', content: 'private code' }], undefined, vi.fn(), vi.fn(), failure);
    expect(failure).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/only connects/) }));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('SSE transport', () => {
  it('reports a stalled response as an actionable timeout rather than a user cancellation', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal('fetch', vi.fn().mockImplementation((_url, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })));
      const failed = vi.fn(); const done = vi.fn();
      const pending = new BackendClient(settings(), 100).streamChat(1, [], undefined, vi.fn(), done, failed);
      await vi.advanceTimersByTimeAsync(101);
      await pending;
      expect(failed).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('stopped responding'), name: 'Error' }));
      expect(done).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('decodes split UTF-8, fragmented CRLF, multiple records and the final frame', async () => {
    const bytes = encode.encode('data: "नमस्ते"\r\n\r\nevent: message\r\ndata: {"type":\r\ndata: "message", "content": "ok"}\r\n\r\nevent: done\r\ndata: [DONE]');
    const frames: Array<{ event: string; data: string }> = [];
    await readEventStream(responseFrom(Array.from(bytes, (byte) => new Uint8Array([byte]))), (frame) => { frames.push(frame); });
    expect(frames).toEqual([
      { event: 'message', data: '"नमस्ते"' },
      { event: 'message', data: '{"type":\n"message", "content": "ok"}' },
      { event: 'done', data: '[DONE]' },
    ]);
  });
  it('stops at the completion record and releases the stream', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(encode.encode('data: [DONE]\n\ndata: "ignore"\n\n')); }, cancel }));
    const seen: string[] = [];
    await readEventStream(response, (event) => { seen.push(event.data); return false; });
    expect(seen).toEqual(['[DONE]']);
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('reports an early EOF instead of a successful response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse('data: "partial"\n\n')));
    const chunks = vi.fn(); const complete = vi.fn(); const error = vi.fn();
    await new BackendClient(settings()).streamChat(1, [], undefined, chunks, complete, error);
    expect(chunks).toHaveBeenCalledWith('partial');
    expect(complete).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/ended early/) }));
  });
  it('handles CRLF agent completion and structured errors', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(sseResponse('event: message\r\ndata: {"type":"message","content":"ready"}\r\n\r\nevent: done\r\ndata: [DONE]\r\n\r\n'))
      .mockResolvedValueOnce(sseResponse('event: error\n' + 'data: {"error":"Model unavailable"}\n\n'));
    vi.stubGlobal('fetch', fetchMock);
    const client = new BackendClient(settings()); const event = vi.fn(); const complete = vi.fn(); const error = vi.fn();
    await client.streamAgent(1, 'inspect', 2, undefined, undefined, event, complete, error);
    expect(event).toHaveBeenCalledWith({ type: 'message', content: 'ready' });
    expect(complete).toHaveBeenCalledOnce();
    await client.streamAgent(1, 'inspect', 2, undefined, undefined, event, complete, error);
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ message: 'Model unavailable' }));
  });
  it('keeps the new request cancellable after an older stream exits', async () => {
    const signals: AbortSignal[] = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      const signal = init.signal as AbortSignal; signals.push(signal);
      return Promise.resolve(new Response(new ReadableStream({ start(controller) {
        signal.addEventListener('abort', () => controller.error(new DOMException('stopped', 'AbortError')));
      } })));
    }));
    const client = new BackendClient(settings()); const firstError = vi.fn(); const secondError = vi.fn();
    const first = client.streamChat(1, [], undefined, vi.fn(), vi.fn(), firstError);
    await Promise.resolve();
    const second = client.streamChat(2, [], undefined, vi.fn(), vi.fn(), secondError);
    await first;
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    client.cancel(); await second;
    expect(signals[1].aborted).toBe(true);
    expect(firstError).toHaveBeenCalledWith(expect.objectContaining({ name: 'AbortError' }));
    expect(secondError).toHaveBeenCalledWith(expect.objectContaining({ name: 'AbortError' }));
  });
  it('bounds an unterminated event to protect the UI process', async () => {
    await expect(readEventStream(sseResponse('data: ' + 'x'.repeat(4_194_305)), vi.fn())).rejects.toThrow(/4 MB/);
  });
});

describe('model Markdown isolation', () => {
  it('escapes injected buttons, SVG, forms and event handlers', () => {
    const html = safeMarkdown('<button data-action="applyChangeSet" onclick="bad()">Apply</button>\n<svg onload="bad()"></svg>\n<form><input autofocus></form>');
    expect(html).not.toMatch(/<(?:button|svg|form|input)\b/i);
    expect(html).toContain('&lt;button');
  });
  it('rejects executable links and image requests while retaining useful Markdown', () => {
    const html = safeMarkdown('[bad](command:workbench.action.terminal.new) [bad](javascript:alert) [safe](https://example.com) ![diagram](http://localhost:9999/action)\n\n**bold**');
    expect(html).not.toContain('href="command:');
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('<img');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('<strong>bold</strong>');
  });
  it('renders code as inert text', () => {
    expect(safeMarkdown('\x60\x60\x60html\n<button data-action="runCommandProposal">run</button>\n\x60\x60\x60')).toContain('&lt;button');
  });
});

function providerFor(backend: Record<string, unknown>): any {
  const provider = Object.create(PersonalCodexSidebarProvider.prototype);
  Object.assign(provider, { backend, chatGeneration: 0, conversationLoadGeneration: 0, historyGeneration: 0, conversationQuery: '', send: vi.fn().mockResolvedValue(undefined), legacyChangeSets: new Map() });
  return provider;
}

describe('sidebar request ownership', () => {
  it('rejects a known chat-only model before creating an Agent conversation', async () => {
    const provider = providerFor({ cancel: vi.fn(), getModelCapabilities: vi.fn().mockResolvedValue({ agent_ready: false }), createConversation: vi.fn(), streamAgent: vi.fn() });
    await provider.handleChatRequest({ prompt: 'Fix parser', requestId: 'chat-only', model: 'chat:small', mode: 'agent' });
    expect(provider.backend.createConversation).not.toHaveBeenCalled();
    expect(provider.backend.streamAgent).not.toHaveBeenCalled();
    expect(provider.send).toHaveBeenCalledWith({ command: 'streamError', payload: expect.objectContaining({ requestId: 'chat-only', message: expect.stringContaining('not Agent tools') }) });
  });

  it('drops outdated tool capability replies after a different model is selected', async () => {
    const replies: Array<(value: unknown) => void> = [];
    const provider = providerFor({ getModelCapabilities: vi.fn().mockImplementation(() => new Promise(resolve => { replies.push(resolve); })) });
    provider.modelCapabilityGeneration = 0;
    const first = provider.handleMessage({ command: 'checkModelCapabilities', args: { model: 'old', requestId: 1 } });
    const second = provider.handleMessage({ command: 'checkModelCapabilities', args: { model: 'new', requestId: 2 } });
    replies[1]({ model: 'new', agent_ready: true }); await second;
    replies[0]({ model: 'old', agent_ready: false }); await first;
    expect(provider.send).toHaveBeenCalledOnce();
    expect(provider.send).toHaveBeenCalledWith({ command: 'modelCapabilities', payload: { model: 'new', agent_ready: true, requestId: 2 } });
  });

  it('surfaces conversation-creation failures with the owning request ID', async () => {
    const provider = providerFor({ cancel: vi.fn(), createConversation: vi.fn().mockRejectedValue(new Error('API offline')) });
    await provider.handleChatRequest({ prompt: 'help', requestId: 'request-1', mode: 'ask' });
    expect(provider.send).toHaveBeenCalledWith({ command: 'streamError', payload: { conversationId: null, requestId: 'request-1', message: 'API offline' } });
  });
  it('does not start a stream when New chat supersedes conversation creation', async () => {
    let finish!: (value: { id: number }) => void;
    const streamChat = vi.fn();
    const provider = providerFor({ cancel: vi.fn(), createConversation: () => new Promise((resolve) => { finish = resolve; }), streamChat });
    const request = provider.handleChatRequest({ prompt: 'help', requestId: 'old', mode: 'ask' });
    provider.cancelActiveChat(); finish({ id: 1 }); await request;
    expect(streamChat).not.toHaveBeenCalled();
    expect(provider.send).not.toHaveBeenCalled();
  });
  it('discards old stream callbacks after switching conversations', async () => {
    const callbacks: Array<(text: string) => void> = [];
    const provider = providerFor({ cancel: vi.fn(), streamChat: vi.fn().mockImplementation(async (_id, _messages, _model, chunk) => { callbacks.push(chunk); }) });
    await provider.handleChatRequest({ prompt: 'first', requestId: 'old', conversationId: 1, mode: 'ask' });
    await provider.handleChatRequest({ prompt: 'second', requestId: 'new', conversationId: 2, mode: 'ask' });
    provider.send.mockClear(); callbacks[0]('stale'); callbacks[1]('current');
    expect(provider.send).toHaveBeenCalledOnce();
    expect(provider.send).toHaveBeenCalledWith({ command: 'streamChunk', payload: { conversationId: 2, requestId: 'new', chunk: 'current' } });
  });
  it('does not overwrite a newer conversation load with an older response', async () => {
    const finish: Array<(messages: unknown[]) => void> = [];
    const provider = providerFor({ getConversationMessages: () => new Promise((resolve) => { finish.push(resolve); }) });
    const first = provider.loadConversation(1); const second = provider.loadConversation(2);
    finish[1]([{ content: 'new' }]); await second; finish[0]([{ content: 'old' }]); await first;
    expect(provider.send).toHaveBeenCalledOnce();
    expect(provider.send).toHaveBeenCalledWith({ command: 'conversationLoaded', payload: { conversationId: 2, messages: [{ content: 'new' }] } });
  });
});


describe('conversation deletion during local work', () => {
  it('stops the owning generation and preserves the conversation when the backend rejects deletion', async () => {
    const provider = providerFor({ cancel: vi.fn(), deleteConversation: vi.fn().mockRejectedValue(new Error('Active controlled job: try again after completion')) });
    provider.activeChat = { requestId: 'active', conversationId: 7 };
    await expect(provider.handleMessage({ command: 'deleteConversation', args: { conversationId: 7 } })).rejects.toThrow(/Active controlled job/);
    expect(provider.backend.cancel).toHaveBeenCalledOnce();
    expect(provider.send).toHaveBeenCalledWith({ command: 'streamStopped', payload: { requestId: 'active', conversationId: 7 } });
    expect(provider.send.mock.calls.some(([message]: [{ command: string }]) => message.command === 'conversationDeleted')).toBe(false);
  });
});
