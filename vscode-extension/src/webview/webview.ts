import { marked } from 'marked';
import Prism from 'prismjs';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-bash';

declare const acquireVsCodeApi: any;

const vscode = acquireVsCodeApi();
const app = document.getElementById('app');

const state = {
  messages: [] as Array<{ role: string; content: string }>,
};

function render(): void {
  if (!app) {
    return;
  }
  app.innerHTML = `
    <div class="pc-shell">
      <div class="pc-header">
        <h1>Personal Codex</h1>
        <button id="health">Check backend</button>
      </div>
      <div class="pc-body">
        <div class="pc-chat">
          ${state.messages.map((message) => `<div class="message ${message.role}">${renderMarkdown(message.content)}</div>`).join('')}
        </div>
      </div>
      <div class="pc-input">
        <textarea id="prompt" placeholder="Ask code questions..."></textarea>
        <button id="send">Send</button>
      </div>
    </div>
  `;
  document.getElementById('send')?.addEventListener('click', onSend);
  document.getElementById('health')?.addEventListener('click', () => vscode.postMessage({ command: 'healthCheck' }));
}

function renderMarkdown(text: string): string {
  const html = marked.parse(text, {
    mangle: false,
    headerIds: false,
    sanitizer: false,
    smartLists: true,
    gfm: true,
  });
  const escaped = html.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return Prism.highlight(escaped, Prism.languages.javascript, 'javascript');
}

function onSend(): void {
  const input = document.getElementById('prompt') as HTMLTextAreaElement | null;
  if (!input || !input.value.trim()) {
    return;
  }
  const content = input.value.trim();
  state.messages.push({ role: 'user', content });
  render();
  vscode.postMessage({ command: 'startChat', args: { prompt: content } });
  input.value = '';
}

window.addEventListener('message', (event) => {
  const message = event.data;
  if (message.command === 'streamChunk') {
    state.messages.push({ role: 'assistant', content: message.payload });
    render();
  }
});

render();
