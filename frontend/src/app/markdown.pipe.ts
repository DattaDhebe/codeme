import { DOCUMENT } from '@angular/common';
import { Inject, Pipe, PipeTransform, SecurityContext } from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';
import { marked } from 'marked';
import Prism from 'prismjs';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-bash';

@Pipe({
  name: 'markdown',
  standalone: true,
})
export class MarkdownPipe implements PipeTransform {
  constructor(
    private readonly sanitizer: DomSanitizer,
    @Inject(DOCUMENT) private readonly document: Document,
  ) {}

  transform(value: string): string {
    const rendered = marked.parse(value || '') as string;
    const sanitized = this.sanitizer.sanitize(SecurityContext.HTML, rendered) || '';
    // Templates keep model-supplied media inert while the allowlist is applied.
    const template = this.document.createElement('template');
    template.innerHTML = sanitized;
    const container = template.content;
    container.querySelectorAll('img, audio, video, source, picture').forEach((node) => {
      const alternative = node.getAttribute('alt');
      node.replaceWith(this.document.createTextNode(alternative ? '[Image: ' + alternative + ']' : '[Media omitted]'));
    });
    container.querySelectorAll('script, style, iframe, object, embed, svg, math, link, meta, form').forEach((node) => node.remove());
    container.querySelectorAll<HTMLElement>('*').forEach((element) => {
      for (const attribute of Array.from(element.attributes)) {
        const name = attribute.name.toLowerCase();
        const value = attribute.value.trim();
        if (name.startsWith('on') || name === 'style' || name === 'srcdoc') {
          element.removeAttribute(attribute.name);
          continue;
        }
        if (name === 'href' || name === 'src') {
          if (!this.isSafeResourceUrl(value, name === 'href')) {
            element.removeAttribute(attribute.name);
          }
        }
      }
      if (element.tagName === 'A') {
        element.setAttribute('rel', 'noopener noreferrer nofollow');
        element.setAttribute('referrerpolicy', 'no-referrer');
        const href = element.getAttribute('href');
        if (href && this.isExternalUrl(href)) element.setAttribute('target', '_blank');
      }
    });
    // Marked 9 no longer supports the former highlight option. Highlight only
    // sanitized code text using locally installed language grammars.
    const aliases: Record<string, string> = { js: 'javascript', ts: 'typescript', py: 'python', sh: 'bash', shell: 'bash' };
    container.querySelectorAll<HTMLElement>('pre code').forEach(element => {
      const name = /(?:^|\s)language-([\w-]+)/.exec(element.className)?.[1] || '';
      const language = aliases[name] || name;
      const grammar = Prism.languages[language];
      if (grammar) element.innerHTML = Prism.highlight(element.textContent || '', grammar, language);
    });
    return template.innerHTML;
  }

  private isSafeResourceUrl(value: string, isLink: boolean): boolean {
    const normalized = value.trim().toLowerCase();
    if (!normalized || normalized.startsWith('javascript:') || normalized.startsWith('data:') || normalized.startsWith('vbscript:')) {
      return false;
    }
    try {
      const parsed = new URL(value, this.document.baseURI || 'http://localhost/');
      return ['http:', 'https:'].includes(parsed.protocol) || (isLink && parsed.protocol === 'mailto:');
    } catch {
      return false;
    }
  }

  private isExternalUrl(value: string): boolean {
    try {
      const base = new URL(this.document.baseURI || 'http://localhost/');
      return new URL(value, base).origin !== base.origin;
    } catch {
      return false;
    }
  }
}
