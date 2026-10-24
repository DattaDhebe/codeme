import { marked } from 'marked';

export function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character] || character);
}

const renderer = new marked.Renderer();
// Model output is content. It must never create webview controls or action attributes.
renderer.html = (html) => escapeHtml(html);
renderer.link = (href, title, text) => {
  if (!href || /[\u0000-\u0020\u007f]/.test(href)) return text;
  try {
    const url = new URL(href);
    if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) return text;
  } catch { return text; }
  return '<a href="' + escapeHtml(href) + '" rel="noreferrer noopener"' +
    (title ? ' title="' + escapeHtml(title) + '"' : '') + '>' + text + '</a>';
};
// Do not load model-supplied images, even from another service on this machine.
renderer.image = (_href, _title, text) => escapeHtml(text || 'Image');

export function safeMarkdown(text: string): string {
  return marked.parse(text || '', { gfm: true, breaks: true, renderer }) as string;
}
