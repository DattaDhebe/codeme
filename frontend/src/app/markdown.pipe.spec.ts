import { TestBed } from '@angular/core/testing';
import { MarkdownPipe } from './markdown.pipe';

describe('MarkdownPipe', () => {
  let pipe: MarkdownPipe;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [MarkdownPipe] });
    pipe = TestBed.inject(MarkdownPipe);
  });

  it('keeps Markdown and highlighted code while removing executable HTML', () => {
    const html = pipe.transform('# Title\n\n```javascript\nconst value = 1;\n```\n<script>alert(1)</script><img src=x onerror=alert(1)>');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<code class="language-javascript">');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onerror');
  });

  it('blocks unsafe URLs, style injection, and SVG payloads', () => {
    const html = pipe.transform('[bad](javascript:alert(1))\n\n<img src="data:text/html,boom" style="background:url(javascript:alert(1))"><svg><script>alert(1)</script></svg>');
    expect(html.toLowerCase()).not.toContain('javascript:');
    expect(html.toLowerCase()).not.toContain('data:text');
    expect(html.toLowerCase()).not.toContain('style=');
    expect(html.toLowerCase()).not.toContain('<svg');
  });

  it('adds safe external-link attributes', () => {
    const html = pipe.transform('[Open](https://example.com)');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('target="_blank"');
  });
});
