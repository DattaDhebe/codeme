import { Marked, Renderer } from 'marked';

export function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character] || character);
}

const renderer = new Renderer();
// Model output is content. It must never create webview controls or action attributes.
renderer.html = ({ text }) => escapeHtml(text);
renderer.link = function ({ href, title, tokens }) {
  const text = this.parser.parseInline(tokens);
  if (!href || /[\u0000-\u0020\u007f]/.test(href)) return text;
  try {
    const url = new URL(href);
    if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) return text;
  } catch { return text; }
  return '<a href="' + escapeHtml(href) + '" rel="noreferrer noopener"' +
    (title ? ' title="' + escapeHtml(title) + '"' : '') + '>' + text + '</a>';
};
// Do not load model-supplied images, even from another service on this machine.
renderer.image = ({ text }) => escapeHtml(text || 'Image');

// Keep the untrusted-content policy separate from any global Marked extensions.
const markdown = new Marked({ gfm: true, breaks: true, renderer, async: false });

export function safeMarkdown(text: string): string {
  return markdown.parse(text || '', { async: false });
}
