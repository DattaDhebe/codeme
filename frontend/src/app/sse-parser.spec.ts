import { SseParser } from './sse-parser';

describe('SseParser', () => {
  it('handles fragmented and combined frames', () => {
    const parser = new SseParser();
    expect(parser.feed('data: "hel')).toEqual([]);
    const events = parser.feed('lo"\n\ndata: " world"\n\nevent: done\ndata: [DONE]\n\n');
    expect(events.map((event) => event.event)).toEqual(['message', 'message', 'done']);
    expect(events.slice(0, 2).map((event) => JSON.parse(event.data))).toEqual(['hello', ' world']);
  });

  it('preserves escaped newlines, quotes, unicode, and code blocks', () => {
    const parser = new SseParser();
    const payload = '```ts\\nconst text = "नमस्ते";\\n```';
    const [event] = parser.feed(`data: ${JSON.stringify(payload)}\n\n`);
    expect(JSON.parse(event.data)).toBe(payload);
  });

  it('ignores comments and processes a final unclosed frame', () => {
    const parser = new SseParser();
    expect(parser.feed(': keepalive\n\n')).toEqual([]);
    parser.feed('event: error\ndata: {"error":"failed"}');
    expect(parser.finish()).toEqual([{ event: 'error', data: '{"error":"failed"}' }]);
  });

  it('supports cancellation through the native AbortController contract', () => {
    const controller = new AbortController();
    controller.abort();
    expect(controller.signal.aborted).toBeTrue();
  });

  it('rejects oversized terminated and unterminated events instead of growing without a bound', () => {
    expect(() => new SseParser().feed('data: ' + 'x'.repeat(4_194_304))).toThrowError(/4 MB/);
    expect(() => new SseParser().feed('data: ' + 'x'.repeat(4_194_304) + '\n\n')).toThrowError(/4 MB/);
  });
});
