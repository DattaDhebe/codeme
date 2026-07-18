import { marked } from 'marked';
import Prism from 'prismjs';
import 'prismjs/components/prism-markup';
import 'prismjs/components/prism-css';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-java';
import 'prismjs/components/prism-csharp';
import 'prismjs/components/prism-go';
import 'prismjs/components/prism-rust';
import 'prismjs/components/prism-sql';
import 'prismjs/components/prism-markdown';
import 'prismjs/components/prism-diff';

declare const acquireVsCodeApi: any;

type Role = 'user' | 'assistant' | 'system' | 'tool';

interface Attachment {
  kind: string;
  label: string;
  detail?: string;
  content: string;
  language?: string;
}

interface ChatMessage {
  id?: number;
  role: Role;
  content: string;
  attachments?: Attachment[];
  error?: boolean;
  activities?: AgentActivity[];
  proposals?: AgentProposal[];
}

interface AgentActivity {
  name: string;
  summary: string;
  status: 'running' | 'complete';
}

interface AgentProposal {
  kind: 'file_change' | 'command';
  path?: string;
  content?: string;
  command?: string;
  explanation: string;
  applied?: boolean;
}

interface Conversation {
  id: number;
  title: string;
  created_at: string;
  updated_at: string;
}

interface UiState {
  messages: ChatMessage[];
  conversations: Conversation[];
  currentConversationId: number | null;
  composer: string;
  attachments: Attachment[];
  selectedModel: string;
  models: string[];
  online: boolean;
  ollama: boolean;
  workspace: string | null;
  rootPath: string | null;
  streaming: boolean;
  loadingConversation: boolean;
  historyOpen: boolean;
  contextMenuOpen: boolean;
  conversationSearch: string;
  mode: 'ask' | 'agent';
  workspaceRegistered: boolean;
}

const vscode = acquireVsCodeApi();
const app = document.getElementById('app');
const persisted = (vscode.getState?.() || {}) as Partial<UiState>;
const state: UiState = {
  messages: persisted.messages || [],
  conversations: persisted.conversations || [],
  currentConversationId: persisted.currentConversationId || null,
  composer: persisted.composer || '',
  attachments: [],
  selectedModel: persisted.selectedModel || 'qwen2.5-coder:7b',
  models: persisted.models || ['qwen2.5-coder:7b'],
  online: false,
  ollama: false,
  workspace: persisted.workspace || null,
  rootPath: persisted.rootPath || null,
  streaming: false,
  loadingConversation: false,
  historyOpen: false,
  contextMenuOpen: false,
  conversationSearch: '',
  mode: persisted.mode || 'agent',
  workspaceRegistered: false,
};

let toastTimer: number | undefined;

const icons: Record<string, string> = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/>',
  send: '<path d="m22 2-7 20-4-9-9-4 20-7Z"/><path d="M22 2 11 13"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="1"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8M8 17h6"/>',
  code: '<path d="m8 9-4 3 4 3M16 9l4 3-4 3M14 5l-4 14"/>',
  git: '<circle cx="6" cy="6" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="18" cy="18" r="2"/><path d="M8 6h6a4 4 0 0 1 4 4v6M6 8v10"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 15H6L5 6M10 11v6M14 11v6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  paperclip: '<path d="m21.4 11.6-8.9 8.9a6 6 0 0 1-8.5-8.5l9.6-9.6a4 4 0 0 1 5.7 5.7l-9.6 9.6a2 2 0 0 1-2.8-2.8l8.9-8.9"/>',
  refresh: '<path d="M20 6v5h-5M4 18v-5h5"/><path d="M6.1 9a7 7 0 0 1 11.5-2.6L20 11M4 13l2.4 4.6A7 7 0 0 0 17.9 15"/>',
  spark: '<path d="m12 3 1.5 4.2L18 9l-4.5 1.8L12 15l-1.5-4.2L6 9l4.5-1.8L12 3Z"/><path d="m19 15 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z"/>',
  folder: '<path d="M3 6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  pencil: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/>',
  external: '<path d="M14 3h7v7M10 14 21 3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>',
  apply: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  terminal: '<path d="m4 17 6-6-6-6M12 19h8"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
};

function icon(name: string, size = 16): string {
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || ''}</svg>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character] || character);
}

function render(): void {
  if (!app) {
    return;
  }
  const shouldStickToBottom = isNearBottom();
  app.innerHTML = `
    <div class="codeme-shell">
      ${renderHeader()}
      ${renderHistoryDrawer()}
      <main class="chat-scroll" id="chat-scroll">
        ${renderChat()}
      </main>
      ${renderComposer()}
      <div class="toast" id="toast" role="status"></div>
    </div>
  `;
  if (shouldStickToBottom || state.streaming) {
    requestAnimationFrame(scrollToBottom);
  }
  persistState();
}

function renderHeader(): string {
  const statusLabel = state.online ? state.selectedModel : 'Backend offline';
  return `
    <header class="topbar">
      <div class="brand">
        <div class="brand-mark">${icon('spark', 18)}</div>
        <div class="brand-copy"><strong>CODEME</strong><span>Local coding agent</span></div>
      </div>
      <div class="topbar-actions">
        <button class="icon-button" data-action="newChat" title="New chat">${icon('plus')}</button>
        <button class="icon-button ${state.historyOpen ? 'active' : ''}" data-action="toggleHistory" title="Chat history">${icon('history')}</button>
        <button class="icon-button" data-action="settings" title="Settings">${icon('settings')}</button>
      </div>
    </header>
    <button class="status-strip ${state.online ? 'online' : 'offline'}" data-action="health" title="Check backend connection">
      <span class="status-dot"></span>
      <span class="status-model">${escapeHtml(statusLabel)}</span>
      <span class="status-via">${state.online && state.ollama ? 'via Ollama' : 'click to check'}</span>
      <span class="status-workspace">${icon('folder', 13)} ${escapeHtml(state.workspace || 'No workspace')}</span>
    </button>
  `;
}

function renderHistoryDrawer(): string {
  if (!state.historyOpen) {
    return '';
  }
  const conversations = state.conversations.map((conversation) => `
    <div class="history-item ${conversation.id === state.currentConversationId ? 'active' : ''}">
      <button class="history-main" data-action="loadConversation" data-id="${conversation.id}">
        <span class="history-title">${escapeHtml(conversation.title)}</span>
        <span class="history-date">${formatRelativeDate(conversation.updated_at)}</span>
      </button>
      <button class="history-action" data-action="renameConversation" data-id="${conversation.id}" data-title="${escapeHtml(conversation.title)}" title="Rename">${icon('pencil', 14)}</button>
      <button class="history-action danger" data-action="deleteConversation" data-id="${conversation.id}" title="Delete">${icon('trash', 14)}</button>
    </div>
  `).join('');
  return `
    <div class="drawer-backdrop" data-action="toggleHistory"></div>
    <aside class="history-drawer" aria-label="Chat history">
      <div class="drawer-header">
        <div><strong>Chats</strong><span>${state.conversations.length} conversations</span></div>
        <button class="icon-button" data-action="toggleHistory">${icon('close')}</button>
      </div>
      <label class="search-box">${icon('search', 15)}<input id="history-search" value="${escapeHtml(state.conversationSearch)}" placeholder="Search chats" /></label>
      <div class="history-list">
        ${conversations || '<div class="history-empty">No conversations yet</div>'}
      </div>
    </aside>
  `;
}

function renderChat(): string {
  if (state.loadingConversation) {
    return '<div class="loading-stack"><i></i><i></i><i></i></div>';
  }
  if (state.messages.length === 0) {
    return renderEmptyState();
  }
  return `<div class="message-list">${state.messages.map(renderMessage).join('')}</div>`;
}

function renderEmptyState(): string {
  const offlineAction = state.online ? '' : `
    <div class="offline-card">
      <div><strong>Backend is offline</strong><span>Start the local API to chat with Qwen.</span></div>
      <button data-action="startBackend">Start backend</button>
    </div>`;
  return `
    <section class="empty-state">
      <div class="hero-mark"><span></span>${icon('spark', 30)}</div>
      <h1>Build with your code</h1>
      <p>Ask Qwen to explain, fix, refactor, test, or review your workspace.</p>
      ${offlineAction}
      <div class="suggestion-grid">
        <button class="suggestion" data-action="quickPrompt" data-context="selection" data-prompt="Explain the selected code. Focus on behavior, assumptions, and edge cases.">
          <span class="suggestion-icon violet">${icon('code')}</span><span><strong>Explain code</strong><small>Understand a selection</small></span>${icon('chevron', 14)}
        </button>
        <button class="suggestion" data-action="quickPrompt" data-context="selection" data-prompt="Find and fix bugs in the selected code. Explain the root cause and return corrected code.">
          <span class="suggestion-icon blue">${icon('spark')}</span><span><strong>Fix a bug</strong><small>Diagnose selected code</small></span>${icon('chevron', 14)}
        </button>
        <button class="suggestion" data-action="quickPrompt" data-context="file" data-prompt="Generate comprehensive tests for this file, including edge cases.">
          <span class="suggestion-icon green">${icon('file')}</span><span><strong>Generate tests</strong><small>Cover the current file</small></span>${icon('chevron', 14)}
        </button>
        <button class="suggestion" data-action="quickPrompt" data-context="changes" data-prompt="Review my current changes for correctness, regressions, security issues, and missing tests.">
          <span class="suggestion-icon amber">${icon('git')}</span><span><strong>Review changes</strong><small>Inspect the working tree</small></span>${icon('chevron', 14)}
        </button>
      </div>
    </section>
  `;
}

function renderMessage(message: ChatMessage, index: number): string {
  const isLast = index === state.messages.length - 1;
  const attachments = message.attachments?.length ? `
    <div class="message-attachments">${message.attachments.map((item) => `<span>${contextIcon(item.kind)}${escapeHtml(item.label)}</span>`).join('')}</div>` : '';
  if (message.role === 'user') {
    return `<article class="message-row user-row" data-message-index="${index}">
      <div class="user-message">${attachments}<div>${renderMarkdown(message.content)}</div></div>
    </article>`;
  }
  if (message.role === 'system' || message.role === 'tool') {
    return `<div class="system-message">${icon('paperclip', 13)} ${renderMarkdown(message.content)}</div>`;
  }
  const streaming = isLast && state.streaming;
  const activities = message.activities?.length ? `<div class="agent-activity">
    <div class="agent-activity-title">${icon('spark', 13)} Working in ${escapeHtml(state.workspace || 'workspace')}</div>
    ${message.activities.map((item) => `<div class="agent-step ${item.status}"><span>${item.status === 'complete' ? icon('check', 12) : '<i></i>'}</span><strong>${escapeHtml(toolLabel(item.name))}</strong><small>${escapeHtml(item.summary)}</small></div>`).join('')}
  </div>` : '';
  const proposals = message.proposals?.map((proposal, proposalIndex) => renderProposal(proposal, index, proposalIndex)).join('') || '';
  return `<article class="message-row assistant-row ${message.error ? 'has-error' : ''}" data-message-index="${index}">
    <div class="assistant-avatar">${icon('spark', 15)}</div>
    <div class="assistant-content">
      <div class="assistant-label">CODEME <span>${escapeHtml(state.selectedModel)}</span></div>
      ${activities}
      <div class="markdown-body">${renderMarkdown(message.content)}${streaming ? '<span class="stream-cursor"></span>' : ''}</div>
      ${proposals ? `<div class="proposal-list">${proposals}</div>` : ''}
      ${!streaming && message.content ? `<div class="message-actions"><button data-action="copyMessage" data-index="${index}" title="Copy response">${icon('copy', 13)} Copy</button><button data-action="reusePrompt" data-index="${index}" title="Reuse previous prompt">${icon('refresh', 13)} Retry</button></div>` : ''}
    </div>
  </article>`;
}

function renderProposal(proposal: AgentProposal, messageIndex: number, proposalIndex: number): string {
  const isFile = proposal.kind === 'file_change';
  const title = isFile ? proposal.path || 'File change' : proposal.command || 'Terminal command';
  return `<section class="proposal-card ${proposal.applied ? 'applied' : ''}">
    <div class="proposal-icon">${icon(isFile ? 'file' : 'terminal', 15)}</div>
    <div class="proposal-copy"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(proposal.explanation)}</span></div>
    <button data-action="${isFile ? 'applyProposal' : 'runProposal'}" data-message-index="${messageIndex}" data-proposal-index="${proposalIndex}" ${proposal.applied ? 'disabled' : ''}>${proposal.applied ? `${icon('check', 12)} Applied` : isFile ? 'Apply' : 'Run'}</button>
  </section>`;
}

function toolLabel(name: string): string {
  const labels: Record<string, string> = {
    status: 'Planning', list_files: 'Listed files', read_file: 'Read file', search_code: 'Searched code',
    project_snapshot: 'Inspected project architecture',
    git_status: 'Checked Git status', git_diff: 'Read Git diff', read_instructions: 'Read instructions',
    propose_file_change: 'Prepared file change', propose_command: 'Prepared command',
  };
  return labels[name] || name.replace(/_/g, ' ');
}

function renderComposer(): string {
  const attachments = state.attachments.map((item, index) => `
    <span class="attachment-chip" title="${escapeHtml(item.detail || item.label)}">${contextIcon(item.kind)}<span>${escapeHtml(item.label)}</span><button data-action="removeAttachment" data-index="${index}">${icon('close', 12)}</button></span>
  `).join('');
  const contextMenu = state.contextMenuOpen ? `
    <div class="context-menu">
      <button data-action="requestContext" data-kind="selection">${icon('code')}<span><strong>Selection</strong><small>Selected editor code</small></span></button>
      <button data-action="requestContext" data-kind="file">${icon('file')}<span><strong>Current file</strong><small>Entire active file</small></span></button>
      <button data-action="requestContext" data-kind="changes">${icon('git')}<span><strong>Git changes</strong><small>Working tree diff</small></span></button>
    </div>` : '';
  return `
    <footer class="composer-wrap">
      <div class="mode-switch" role="tablist" aria-label="Chat mode">
        <button data-action="setMode" data-mode="ask" class="${state.mode === 'ask' ? 'active' : ''}">Ask</button>
        <button data-action="setMode" data-mode="agent" class="${state.mode === 'agent' ? 'active' : ''}">${icon('spark', 12)} Agent</button>
        <span>${state.mode === 'agent' ? (state.workspaceRegistered ? 'Can inspect and propose changes' : 'Needs an open workspace') : 'Chat with attached context'}</span>
      </div>
      ${attachments ? `<div class="attachment-list">${attachments}</div>` : ''}
      <div class="composer ${state.streaming ? 'streaming' : ''}">
        <textarea id="prompt" rows="1" placeholder="Ask Codeme about your code…" ${state.streaming ? 'disabled' : ''}>${escapeHtml(state.composer)}</textarea>
        <div class="composer-toolbar">
          <div class="composer-left">
            <button class="tool-button ${state.contextMenuOpen ? 'active' : ''}" data-action="toggleContext" title="Add context">${icon('paperclip', 15)}<span>Context</span></button>
            <select id="model-select" title="Model" ${state.streaming ? 'disabled' : ''}>${state.models.map((model) => `<option value="${escapeHtml(model)}" ${model === state.selectedModel ? 'selected' : ''}>${escapeHtml(shortModelName(model))}</option>`).join('')}</select>
          </div>
          ${state.streaming
            ? `<button class="send-button stop" data-action="stop" title="Stop generation">${icon('stop', 16)}</button>`
            : `<button class="send-button" data-action="send" title="Send message" ${!state.online || !state.composer.trim() ? 'disabled' : ''}>${icon('send', 16)}</button>`}
        </div>
        ${contextMenu}
      </div>
      <div class="composer-hint"><span>Enter to send · Shift+Enter for new line</span><span>Local · private</span></div>
    </footer>
  `;
}

function renderMarkdown(text: string): string {
  const html = marked.parse(text || '', { gfm: true, breaks: true });
  const template = document.createElement('template');
  template.innerHTML = html;
  template.content.querySelectorAll('script, style, iframe, object, embed, link, meta, form').forEach((node) => node.remove());
  template.content.querySelectorAll('*').forEach((element) => {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim().toLowerCase();
      if (name.startsWith('on') || name === 'srcdoc' || ((name === 'href' || name === 'src') && value.startsWith('javascript:'))) {
        element.removeAttribute(attribute.name);
      }
    }
    if (element.tagName === 'A') {
      element.setAttribute('rel', 'noreferrer noopener');
    }
  });
  template.content.querySelectorAll('pre code').forEach((code) => {
    const languageClass = Array.from(code.classList).find((name) => name.startsWith('language-'));
    const language = languageClass?.slice('language-'.length) || 'code';
    const grammar = Prism.languages[language];
    const rawCode = code.textContent || '';
    if (grammar) {
      code.innerHTML = Prism.highlight(rawCode, grammar, language);
    }
    const pre = code.closest('pre');
    if (pre) {
      const toolbar = document.createElement('div');
      toolbar.className = 'code-toolbar';
      toolbar.innerHTML = `<span>${escapeHtml(language)}</span><div><button class="code-apply" title="Apply at selection or cursor">${icon('apply', 13)} Apply</button><button class="code-open" title="Open in editor">${icon('external', 13)} Open</button><button class="code-copy" title="Copy code">${icon('copy', 13)} Copy</button></div>`;
      pre.prepend(toolbar);
    }
  });
  return template.innerHTML;
}

function contextIcon(kind: string): string {
  return icon(kind === 'file' ? 'file' : kind === 'changes' ? 'git' : 'code', 13);
}

function shortModelName(model: string): string {
  return model.replace(':latest', '').replace('qwen2.5-coder', 'Qwen 2.5 Coder');
}

function formatRelativeDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const elapsed = Date.now() - date.getTime();
  const minutes = Math.floor(elapsed / 60000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days}d` : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function persistState(): void {
  vscode.setState?.({
    messages: state.messages,
    conversations: state.conversations,
    currentConversationId: state.currentConversationId,
    composer: state.composer,
    selectedModel: state.selectedModel,
    models: state.models,
    workspace: state.workspace,
    rootPath: state.rootPath,
    mode: state.mode,
  });
}

function isNearBottom(): boolean {
  const scroller = document.getElementById('chat-scroll');
  return !scroller || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 100;
}

function scrollToBottom(): void {
  const scroller = document.getElementById('chat-scroll');
  if (scroller) {
    scroller.scrollTop = scroller.scrollHeight;
  }
}

function focusComposer(): void {
  requestAnimationFrame(() => {
    const input = document.getElementById('prompt') as HTMLTextAreaElement | null;
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
    resizeComposer(input);
  });
}

function resizeComposer(input: HTMLTextAreaElement | null): void {
  if (!input) return;
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
}

function showToast(message: string): void {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add('visible');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('visible'), 2200);
}

function submitPrompt(): void {
  const prompt = state.composer.trim();
  if (!prompt || state.streaming) {
    return;
  }
  if (!state.online) {
    showToast('Start the backend before sending a message.');
    return;
  }
  const attachments = [...state.attachments];
  state.messages.push({ role: 'user', content: prompt, attachments });
  state.composer = '';
  state.attachments = [];
  state.contextMenuOpen = false;
  state.streaming = true;
  render();
  vscode.postMessage({
    command: 'startChat',
    args: {
      prompt,
      conversationId: state.currentConversationId,
      model: state.selectedModel,
      context: attachments,
      mode: state.mode,
    },
  });
}

function newChat(): void {
  state.currentConversationId = null;
  state.messages = [];
  state.composer = '';
  state.attachments = [];
  state.streaming = false;
  state.historyOpen = false;
  render();
  focusComposer();
}

function addAttachment(attachment: Attachment): void {
  const duplicate = state.attachments.some((item) => item.kind === attachment.kind && item.detail === attachment.detail && item.label === attachment.label);
  if (!duplicate) {
    state.attachments.push(attachment);
  }
  state.contextMenuOpen = false;
  render();
  focusComposer();
}

function applyContextAction(payload: { action: string; context: Attachment }): void {
  addAttachment(payload.context);
  const prompts: Record<string, string> = {
    explain: 'Explain this code clearly. Cover its behavior, assumptions, edge cases, and important implementation details.',
    fix: 'Find and fix bugs in this code. Explain the root cause, then provide corrected code.',
    refactor: 'Refactor this code for clarity, maintainability, and performance without changing its behavior.',
    tests: 'Generate comprehensive tests for this code, including edge cases and failure paths.',
    reviewChanges: 'Review these changes for correctness, regressions, security issues, and missing tests.',
  };
  if (payload.action === 'ask') {
    state.composer = 'What should I know about this file?';
    render();
    focusComposer();
    return;
  }
  state.composer = prompts[payload.action] || 'Analyze this context.';
  submitPrompt();
}

if (app) {
  app.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const button = target.closest<HTMLElement>('[data-action]');
    const codeCopy = target.closest<HTMLButtonElement>('.code-copy');
    const codeOpen = target.closest<HTMLButtonElement>('.code-open');
    const codeApply = target.closest<HTMLButtonElement>('.code-apply');
    if (codeOpen || codeApply) {
      const pre = (codeOpen || codeApply)?.closest('pre');
      const code = pre?.querySelector('code');
      const language = Array.from(code?.classList || []).find((name) => name.startsWith('language-'))?.slice(9) || 'plaintext';
      vscode.postMessage({ command: codeApply ? 'applyCode' : 'openCode', args: { text: code?.textContent || '', language } });
      if (codeApply) showToast('Review the apply confirmation in VS Code');
      return;
    }
    if (codeCopy) {
      const code = codeCopy.closest('pre')?.querySelector('code')?.textContent || '';
      vscode.postMessage({ command: 'copyText', args: { text: code } });
      showToast('Code copied');
      return;
    }
    if (!button) return;
    const action = button.dataset.action;
    if (action === 'newChat') newChat();
    if (action === 'toggleHistory') { state.historyOpen = !state.historyOpen; state.contextMenuOpen = false; render(); }
    if (action === 'settings') vscode.postMessage({ command: 'openSettings' });
    if (action === 'health') vscode.postMessage({ command: 'healthCheck' });
    if (action === 'startBackend') vscode.postMessage({ command: 'startBackend' });
    if (action === 'toggleContext') { state.contextMenuOpen = !state.contextMenuOpen; render(); focusComposer(); }
    if (action === 'requestContext') vscode.postMessage({ command: 'requestContext', args: { kind: button.dataset.kind } });
    if (action === 'removeAttachment') { state.attachments.splice(Number(button.dataset.index), 1); render(); focusComposer(); }
    if (action === 'send') submitPrompt();
    if (action === 'setMode') { state.mode = button.dataset.mode === 'ask' ? 'ask' : 'agent'; render(); focusComposer(); }
    if (action === 'stop') vscode.postMessage({ command: 'cancelStream' });
    if (action === 'quickPrompt') {
      state.composer = button.dataset.prompt || '';
      state.contextMenuOpen = false;
      render();
      if (button.dataset.context) {
        vscode.postMessage({ command: 'requestContext', args: { kind: button.dataset.context } });
      }
      focusComposer();
    }
    if (action === 'loadConversation') {
      const conversationId = Number(button.dataset.id);
      state.loadingConversation = true;
      state.historyOpen = false;
      render();
      vscode.postMessage({ command: 'loadConversation', args: { conversationId } });
    }
    if (action === 'deleteConversation') {
      const conversationId = Number(button.dataset.id);
      if (window.confirm('Delete this conversation?')) {
        vscode.postMessage({ command: 'deleteConversation', args: { conversationId } });
      }
    }
    if (action === 'renameConversation') {
      const conversationId = Number(button.dataset.id);
      const title = window.prompt('Rename conversation', button.dataset.title || '');
      if (title?.trim()) {
        vscode.postMessage({ command: 'renameConversation', args: { conversationId, title: title.trim() } });
      }
    }
    if (action === 'copyMessage') {
      const message = state.messages[Number(button.dataset.index)];
      if (message) {
        vscode.postMessage({ command: 'copyText', args: { text: message.content } });
        showToast('Response copied');
      }
    }
    if (action === 'reusePrompt') {
      const index = Number(button.dataset.index);
      const previous = [...state.messages.slice(0, index)].reverse().find((message) => message.role === 'user');
      if (previous) {
        state.composer = previous.content;
        render();
        focusComposer();
      }
    }
    if (action === 'applyProposal' || action === 'runProposal') {
      const item = state.messages[Number(button.dataset.messageIndex)]?.proposals?.[Number(button.dataset.proposalIndex)];
      if (!item) return;
      vscode.postMessage({
        command: action === 'applyProposal' ? 'applyFileChange' : 'runProposedCommand',
        args: { path: item.path, content: item.content, command: item.command, explanation: item.explanation },
      });
    }
  });

  app.addEventListener('input', (event) => {
    const input = event.target as HTMLInputElement | HTMLTextAreaElement;
    if (input.id === 'prompt') {
      state.composer = input.value;
      resizeComposer(input as HTMLTextAreaElement);
      const sendButton = app.querySelector<HTMLButtonElement>('[data-action="send"]');
      if (sendButton) sendButton.disabled = !state.online || !state.composer.trim();
      persistState();
    }
    if (input.id === 'history-search') {
      state.conversationSearch = input.value;
      vscode.postMessage({ command: 'searchConversations', args: { query: input.value.trim() } });
    }
  });

  app.addEventListener('change', (event) => {
    const select = event.target as HTMLSelectElement;
    if (select.id === 'model-select') {
      state.selectedModel = select.value;
      persistState();
    }
  });

  app.addEventListener('keydown', (event) => {
    const keyboardEvent = event as KeyboardEvent;
    const target = keyboardEvent.target as HTMLElement;
    if (target.id === 'prompt' && keyboardEvent.key === 'Enter' && !keyboardEvent.shiftKey && !keyboardEvent.isComposing) {
      keyboardEvent.preventDefault();
      submitPrompt();
    }
    if (keyboardEvent.key === 'Escape' && (state.historyOpen || state.contextMenuOpen)) {
      state.historyOpen = false;
      state.contextMenuOpen = false;
      render();
    }
  });
}

window.addEventListener('message', (event) => {
  const message = event.data as { command?: string; payload?: any };
  switch (message.command) {
    case 'backendStatus':
      state.online = Boolean(message.payload?.online);
      state.ollama = Boolean(message.payload?.ollama);
      state.models = message.payload?.models?.length ? message.payload.models : state.models;
      state.selectedModel = state.models.includes(state.selectedModel) ? state.selectedModel : (message.payload?.model || state.models[0]);
      render();
      if (!state.online && message.payload?.error) showToast('Backend unavailable');
      break;
    case 'workspaceState':
      state.workspace = message.payload?.workspace || null;
      state.rootPath = message.payload?.rootPath || null;
      state.workspaceRegistered = Boolean(message.payload?.registered);
      render();
      break;
    case 'conversationsUpdated':
      state.conversations = Array.isArray(message.payload) ? message.payload : [];
      render();
      break;
    case 'conversationCreated':
      state.currentConversationId = message.payload?.id || null;
      if (message.payload) state.conversations = [message.payload, ...state.conversations.filter((item) => item.id !== message.payload.id)];
      render();
      break;
    case 'conversationLoaded':
      state.currentConversationId = message.payload?.conversationId || null;
      state.messages = (message.payload?.messages || []).map((item: ChatMessage) => ({
        id: item.id,
        role: item.role,
        content: item.role === 'user' ? item.content.split('\n\nContext:')[0] : item.content,
      }));
      state.loadingConversation = false;
      state.streaming = false;
      render();
      requestAnimationFrame(scrollToBottom);
      break;
    case 'conversationDeleted':
      if (state.currentConversationId === message.payload?.conversationId) newChat();
      break;
    case 'newChat':
      newChat();
      break;
    case 'contextAdded':
      addAttachment(message.payload as Attachment);
      break;
    case 'contextAction':
      applyContextAction(message.payload as { action: string; context: Attachment });
      break;
    case 'streamStarted':
      state.currentConversationId = message.payload?.conversationId || state.currentConversationId;
      state.streaming = true;
      render();
      break;
    case 'streamChunk': {
      const chunk = typeof message.payload?.chunk === 'string' ? message.payload.chunk : '';
      const last = state.messages[state.messages.length - 1];
      if (last?.role === 'assistant') last.content += chunk;
      else state.messages.push({ role: 'assistant', content: chunk });
      state.streaming = true;
      render();
      break;
    }
    case 'agentEvent': {
      const agentEvent = message.payload?.event;
      let assistant = state.messages[state.messages.length - 1];
      if (assistant?.role !== 'assistant') {
        assistant = { role: 'assistant', content: '', activities: [], proposals: [] };
        state.messages.push(assistant);
      }
      if (agentEvent?.type === 'status') {
        assistant.activities ||= [];
        assistant.activities.push({ name: 'status', summary: agentEvent.label || 'Inspecting workspace', status: 'running' });
      } else if (agentEvent?.type === 'tool') {
        assistant.activities ||= [];
        const running = [...assistant.activities].reverse().find((item) => item.name === agentEvent.name && item.summary === agentEvent.summary && item.status === 'running');
        if (agentEvent.status === 'complete' && running) running.status = 'complete';
        else assistant.activities.push({ name: agentEvent.name, summary: agentEvent.summary, status: agentEvent.status });
      } else if (agentEvent?.type === 'proposal') {
        assistant.proposals ||= [];
        assistant.proposals.push(agentEvent as AgentProposal);
      } else if (agentEvent?.type === 'message') {
        assistant.content = agentEvent.content || '';
        assistant.activities?.forEach((item) => { item.status = 'complete'; });
      }
      state.streaming = true;
      render();
      break;
    }
    case 'streamComplete':
      state.streaming = false;
      render();
      break;
    case 'streamError': {
      state.streaming = false;
      const errorMessage = message.payload?.message || 'Unable to generate a response.';
      const last = state.messages[state.messages.length - 1];
      if (!last || last.role !== 'assistant' || !last.content) {
        state.messages.push({ role: 'assistant', content: errorMessage, error: true });
      }
      render();
      showToast(errorMessage);
      break;
    }
    case 'operationError':
      state.loadingConversation = false;
      render();
      showToast(message.payload?.message || 'Operation failed');
      break;
    case 'workspaceRegistered':
      state.workspaceRegistered = true;
      showToast('Workspace registered');
      break;
    case 'proposalApplied': {
      const kind = message.payload?.kind;
      for (const chatMessage of state.messages) {
        const proposal = chatMessage.proposals?.find((item) => item.kind === kind && (item.path === message.payload?.path || item.command === message.payload?.command));
        if (proposal) proposal.applied = true;
      }
      render();
      showToast(kind === 'command' ? 'Command started in terminal' : 'File change applied');
      break;
    }
  }
});

render();
resizeComposer(document.getElementById('prompt') as HTMLTextAreaElement | null);
vscode.postMessage({ command: 'ready', args: { conversationId: state.currentConversationId } });
