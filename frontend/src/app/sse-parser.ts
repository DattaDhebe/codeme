export interface SseEvent {
  event: string;
  data: string;
}

export class SseParser {
  private buffer = '';

  feed(chunk: string): SseEvent[] {
    this.buffer += chunk;
    return this.drain(false);
  }

  finish(): SseEvent[] {
    return this.drain(true);
  }

  private drain(final: boolean): SseEvent[] {
    const events: SseEvent[] = [];
    while (this.buffer) {
      const separator = /\r\n\r\n|\n\n|\r\r/.exec(this.buffer);
      if (!separator) {
        break;
      }
      const block = this.buffer.slice(0, separator.index);
      this.buffer = this.buffer.slice(separator.index + separator[0].length);
      const event = this.parseBlock(block);
      if (event) events.push(event);
    }
    if (final && this.buffer.trim()) {
      const event = this.parseBlock(this.buffer);
      this.buffer = '';
      if (event) events.push(event);
    }
    return events;
  }

  private parseBlock(rawBlock: string): SseEvent | null {
    const data: string[] = [];
    let event = 'message';
    for (const rawLine of rawBlock.replace(/\r\n|\r/g, '\n').split('\n')) {
      if (!rawLine || rawLine.startsWith(':')) continue;
      const colon = rawLine.indexOf(':');
      const field = colon < 0 ? rawLine : rawLine.slice(0, colon);
      let value = colon < 0 ? '' : rawLine.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value || 'message';
      if (field === 'data') data.push(value);
    }
    return data.length ? { event, data: data.join('\n') } : null;
  }
}
