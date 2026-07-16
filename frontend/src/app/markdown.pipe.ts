import { Pipe, PipeTransform } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
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
  constructor(private readonly sanitizer: DomSanitizer) {}

  transform(value: string): SafeHtml {
    const html = marked.parse(value || '');
    return this.sanitizer.bypassSecurityTrustHtml(html);
  }
}
