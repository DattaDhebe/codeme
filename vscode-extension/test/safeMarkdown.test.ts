import { describe, expect, it } from 'vitest';
import { marked } from 'marked';
import { safeMarkdown } from '../src/webview/safeMarkdown';

describe('safe Markdown with token-based renderer hooks', () => {
  it('escapes block and nested inline HTML instead of creating action controls', () => {
    const html = safeMarkdown('<button data-action="applyChangeSet">Apply</button>\n\n[<img src=x onerror=bad()>](https://example.com)');
    expect(html).toContain('&lt;button');
    expect(html).toContain('&lt;img');
    expect(html).not.toMatch(/<(?:button|img)\b/);
    expect(html).toContain('href="https://example.com"');
  });

  it('renders nested link formatting and escapes attribute values', () => {
    const html = safeMarkdown('[**safe** and `code`](https://example.com/?q=one&next=two "A & B")');
    expect(html).toContain('<strong>safe</strong> and <code>code</code>');
    expect(html).toContain('href="https://example.com/?q=one&amp;next=two"');
    expect(html).toContain('title="A &amp; B"');
    expect(html).toContain('rel="noreferrer noopener"');
  });

  it.each(['javascript:alert(1)', 'command:workbench.action.terminal.new', 'data:text/html,bad', 'file:///etc/passwd', 'vscode://extension/action'])('leaves %s as harmless link text', (url) => {
    const html = safeMarkdown(`[**label**](${url})`);
    expect(html).not.toContain('<a ');
    expect(html).toContain('<strong>label</strong>');
  });

  it('does not fetch remote or local images, including images nested in links', () => {
    const html = safeMarkdown('![remote](https://example.com/track) ![local](http://127.0.0.1:8000/action) [![linked](https://example.com/track)](https://example.com)');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('src=');
    expect(html).toContain('remote local');
    expect(html).toContain('>linked</a>');
  });

  it('escapes image alt HTML and fenced code while keeping useful code markup', () => {
    const html = safeMarkdown('![<svg onload=bad()>](https://example.com/a)\n\n```html\n<button data-action="runCommandProposal">Run</button>\n```');
    expect(html).not.toMatch(/<(?:svg|button|img)\b/);
    expect(html).toContain('&lt;svg');
    expect(html).toContain('<code class="language-html">');
    expect(html).toContain('&lt;button');
  });

  it('stays synchronous when another module enables global asynchronous parsing', () => {
    marked.setOptions({ async: true });
    try {
      const html = safeMarkdown('**ready**');
      expect(typeof html).toBe('string');
      expect(html).toContain('<strong>ready</strong>');
    } finally { marked.setOptions({ async: false }); }
  });
});
