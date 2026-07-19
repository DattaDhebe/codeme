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

marked.setOptions({
  highlight: ((code: string, lang: string) => {
    const language = (Prism.languages as any)[lang] || Prism.languages['javascript'];
    return Prism.highlight(code, language, lang);
  }) as any,
} as any);

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
    const container = this.document.createElement('div');
    container.innerHTML = sanitized;
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
        element.setAttribute('rel', 'noopener noreferrer');
        const href = element.getAttribute('href');
        if (href && this.isExternalUrl(href)) element.setAttribute('target', '_blank');
      }
    });
    return container.innerHTML;
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
