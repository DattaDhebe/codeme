export interface ServerEvent {
  event: string;
  data: string;
}

/** Decode SSE records independently of network chunk boundaries and newline style. */
export async function readEventStream(response: Response, consume: (event: ServerEvent) => boolean | void): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('The backend response stream is unavailable.');
  const decoder = new TextDecoder();
  let pending = '';
  let data: string[] = [];
  let event = 'message';
  let frameSize = 0;
  let stopped = false;
  const dispatch = (): void => {
    if (data.length) stopped = consume({ event, data: data.join('\n') }) === false;
    data = [];
    event = 'message';
    frameSize = 0;
  };
  const line = (value: string): void => {
    if (!value) { dispatch(); return; }
    if (value.startsWith(':')) return;
    frameSize += value.length;
    if (frameSize > 4_194_304) throw new Error('The backend event exceeded the 4 MB limit.');
    const colon = value.indexOf(':');
    const field = colon < 0 ? value : value.slice(0, colon);
    let content = colon < 0 ? '' : value.slice(colon + 1);
    if (content.startsWith(' ')) content = content.slice(1);
    if (field === 'data') data.push(content);
    else if (field === 'event') event = content;
  };
  try {
    while (!stopped) {
      const { done, value } = await reader.read();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      // A trailing CR may be the first half of CRLF in the next chunk.
      const lines = pending.split(/\r\n|\n|\r(?!$)/);
      pending = lines.pop() || '';
      for (const item of lines) { line(item); if (stopped) break; }
      if (pending.length + frameSize > 4_194_304) throw new Error('The backend event exceeded the 4 MB limit.');
      if (done) {
        if (!stopped && pending) line(pending.replace(/\r$/, ''));
        if (!stopped) dispatch();
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
