import { escapeHtml, safeMarkdown } from './safeMarkdown';
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
import { inferCodeBlockTargets } from '../editTarget';
import type { ChangeSet } from '../changeSet';
import type { CommandRun } from '../commandRun';
import type { VerificationSession } from '../verification';
import type { AgentRun } from '../backendClient';

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
  model?: string;
  attachments?: Attachment[];
  error?: boolean;
  activities?: AgentActivity[];
  proposals?: AgentProposal[];
}

interface AgentActivity {
  name: string;
  summary: string;
  status: 'running' | 'complete' | 'error' | 'stopped';
}

interface AgentProposal {
  kind: 'file_change' | 'command' | 'change_set' | 'command_proposal';
  path?: string;
  content?: string;
  command?: string;
  explanation?: string;
  applied?: boolean;
  changeSet?: ChangeSet;
  commandRun?: CommandRun;
  stdout?: string;
  stderr?: string;
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
  provider: string;
  agentRuns: AgentRun[];
  workspace: string | null;
  rootPath: string | null;
  streaming: boolean;
  loadingConversation: boolean;
  historyOpen: boolean;
  contextMenuOpen: boolean;
  conversationSearch: string;
  mode: 'ask' | 'agent';
  workspaceRegistered: boolean;
  workspaceFolders: number;
  taskStatus: 'idle' | 'working' | 'complete' | 'stopped' | 'error';
  lastError: string | null;
  verifications: VerificationSession[];
}

const vscode = acquireVsCodeApi();
const app = document.getElementById('app');
const persisted = (vscode.getState?.() || {}) as Partial<UiState>;
const state: UiState = {
  messages: persisted.messages || [],
  conversations: persisted.conversations || [],
  currentConversationId: persisted.currentConversationId || null,
  composer: persisted.composer || '',
  attachments: persisted.attachments || [],
  selectedModel: persisted.selectedModel || 'qwen2.5-coder:7b',
  models: persisted.models || ['qwen2.5-coder:7b'],
  online: false,
  ollama: false,
  provider: persisted.provider || 'Local provider',
  agentRuns: persisted.agentRuns || [],
  workspace: persisted.workspace || null,
  rootPath: persisted.rootPath || null,
  streaming: false,
  loadingConversation: false,
  historyOpen: false,
  contextMenuOpen: false,
  conversationSearch: '',
  mode: persisted.mode || 'agent',
  workspaceRegistered: false,
  workspaceFolders: 0,
  taskStatus: 'idle',
  lastError: null,
  verifications: persisted.verifications || [],
};

let toastTimer: number | undefined;
let renderFrame: number | undefined;
let activeRequestId: string | null = null;
let requestSequence = 0;
let historySearchTimer: number | undefined;

function scheduleRender(): void {
  if (renderFrame !== undefined) return;
  renderFrame = requestAnimationFrame(() => { renderFrame = undefined; render(); });
}

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

function render(): void {
  if (!app) return;
  const previousScroller = document.getElementById('chat-scroll');
  const previousScrollTop = previousScroller?.scrollTop || 0;
  const shouldStickToBottom = isNearBottom();
  const focused = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
  const focusedId = focused?.id;
  const selection = focused && ['prompt', 'history-search'].includes(focused.id)
    ? [focused.selectionStart, focused.selectionEnd] : null;
  const outputScroll = Array.from(app.querySelectorAll<HTMLElement>('pre')).map((element) => [element.scrollTop, element.scrollLeft]);
  app.innerHTML = `
    <div class="codeme-shell">
      ${renderHeader()}
      ${renderHistoryDrawer()}
      <main class="chat-scroll" id="chat-scroll" aria-label="Conversation" aria-busy="${state.streaming || state.loadingConversation}">
        ${renderChat()}
        <div class="jump-wrap"><button class="jump-latest" data-action="scrollLatest" aria-label="Jump to latest response">${icon('chevron', 13)} Latest</button></div>
      </main>
      ${renderComposer()}
      <div class="toast" id="toast" role="status" aria-live="polite"></div>
    </div>
  `;
  const scroller = document.getElementById('chat-scroll');
  if (scroller) {
    scroller.scrollTop = state.messages.length === 0 ? 0 : shouldStickToBottom ? scroller.scrollHeight : previousScrollTop;
    scroller.classList.toggle('is-scrolled-up', !shouldStickToBottom);
  }
  app.querySelectorAll<HTMLElement>('pre').forEach((element, index) => {
    const position = outputScroll[index];
    if (position) { element.scrollTop = position[0]; element.scrollLeft = position[1]; }
  });
  const replacement = focusedId ? document.getElementById(focusedId) as HTMLInputElement | HTMLTextAreaElement | null : null;
  if (replacement) {
    replacement.focus({ preventScroll: true });
    if (selection && selection[0] !== null && selection[1] !== null) replacement.setSelectionRange(selection[0], selection[1]);
  }
  resizeComposer(document.getElementById('prompt') as HTMLTextAreaElement | null);
  persistState();
}

function renderHeader(): string {
  const statusLabel = !state.online ? 'Backend offline' : !state.ollama ? 'Local model unavailable' : 'Local model ready';
  return `
    <header class="topbar">
      <div class="brand">
        <div class="brand-mark">${icon('spark', 18)}</div>
        <div class="brand-copy"><strong>CODEME</strong><span>Local coding agent</span></div>
      </div>
      <div class="topbar-actions">
        <button class="icon-button" data-action="newChat" title="New chat" aria-label="New chat">${icon('plus')}</button>
        <button class="icon-button ${state.historyOpen ? 'active' : ''}" data-action="toggleHistory" title="Chat history" aria-label="Chat history" aria-expanded="${state.historyOpen}">${icon('history')}</button>
        <button class="icon-button" data-action="settings" title="Settings" aria-label="Settings">${icon('settings')}</button>
      </div>
    </header>
    <button class="status-strip ${state.online && state.ollama ? 'online' : 'offline'}" data-action="health" title="Check backend connection">
      <span class="status-dot"></span>
      <span class="status-model">${escapeHtml(statusLabel)}</span>
      <span class="status-via">${state.online && state.ollama ? escapeHtml(state.provider) : 'Check connection'}</span>
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
    <aside class="history-drawer" role="dialog" aria-modal="true" aria-label="Chat history">
      <div class="drawer-header">
        <div><strong>Chats</strong><span>${state.conversations.length} conversations</span></div>
        <button class="icon-button" data-action="toggleHistory" aria-label="Close chat history">${icon('close')}</button>
      </div>
      <label class="search-box">${icon('search', 15)}<input id="history-search" aria-label="Search chats" value="${escapeHtml(state.conversationSearch)}" placeholder="Search chats" /></label>
      <div class="history-list">
        ${conversations || `<div class="history-empty">${state.conversationSearch ? 'No matching chats' : 'No conversations yet'}</div>`}
      </div>
    </aside>
  `;
}

function renderChat(): string {
  if (state.loadingConversation) {
    return '<div class="loading-stack"><i></i><i></i><i></i></div>';
  }
  const verificationCards = state.verifications
    .filter((session) => Boolean(state.currentConversationId) && session.conversation_id === state.currentConversationId)
    .map(renderVerification).join('');
  const taskCard = renderAgentTask();
  if (state.messages.length === 0 && !verificationCards && !taskCard) {
    return renderEmptyState();
  }
  return `${renderSetupCard()}<div class="message-list">${state.messages.map(renderMessage).join('')}${verificationCards}${taskCard}</div>`;
}

function currentAgentRun(): AgentRun | undefined {
  return state.agentRuns.find((run) => run.conversation_id === state.currentConversationId);
}

function updateAgentRun(run: AgentRun): void {
  const index = state.agentRuns.findIndex((item) => item.conversation_id === run.conversation_id);
  if (index >= 0) {
    const previous = state.agentRuns[index];
    if (previous.id !== run.id && previous.created_at > run.created_at) return;
    if (previous.id === run.id && previous.updated_at > run.updated_at) return;
    state.agentRuns[index] = run;
  }
  else state.agentRuns.push(run);
}

function renderAgentTask(): string {
  const run = currentAgentRun();
  if (!run) return '';
  const labels: Record<AgentRun['status'], string> = {
    running: state.streaming ? 'Working locally' : 'Interrupted · resume to continue',
    awaiting_approval: 'Waiting for your review', completed: 'Task completed',
    blocked: 'Task needs attention', exhausted: 'Task budget reached',
    cancelled: 'Task cancelled', interrupted: 'Interrupted · resume to continue',
  };
  const active = !['completed', 'cancelled', 'exhausted'].includes(run.status);
  const steps = (run.plan || []).map((step, index) => `<li class="agent-plan-step ${escapeHtml(step.status)}"><span>${step.status === 'completed' ? icon('check', 12) : step.status === 'in_progress' ? '<i></i>' : index + 1}</span><div>${escapeHtml(step.description)}<small>${step.status.replace('_', ' ')}</small></div></li>`).join('');
  const detail = run.summary || (run.status === 'awaiting_approval'
    ? 'Review proposals and approve verification after applying changes. The task will continue from recorded results.'
    : run.status === 'interrupted' || (run.status === 'running' && !state.streaming)
      ? 'The last session ended. Review saved actions, then resume when ready.' : 'Inspecting the workspace and checking the next step.');
  return `<section class="agent-task-card" aria-label="Agent task" data-run-id="${escapeHtml(run.id)}">
    <div class="agent-task-heading"><div><strong>${escapeHtml(labels[run.status])}</strong><span>Cycle ${run.cycle_count}/${run.max_cycles} · ${Math.ceil(run.elapsed_ms / 1000)}s / ${run.time_budget_seconds}s</span></div><span class="local-task-badge">Local task</span></div>
    <p class="agent-task-goal">${escapeHtml(run.goal)}</p>
    ${steps ? `<ol class="agent-plan">${steps}</ol>` : ''}
    <p class="agent-task-detail">${escapeHtml(detail)}</p>
    ${active ? `<div class="proposal-actions">${!state.streaming ? `<button class="secondary" data-action="cancelAgentRun" data-run-id="${escapeHtml(run.id)}">Cancel task</button><button data-action="resumeAgentRun" data-run-id="${escapeHtml(run.id)}" ${!state.online || !state.ollama || !state.workspaceRegistered ? 'disabled' : ''}>Resume task</button>` : '<span>Use Stop to cancel this task.</span>'}</div>` : ''}
  </section>`;
}

function renderVerification(session: VerificationSession): string {
  const attempt = session.repair_attempts.at(-1);
  const running = session.state === 'RUNNING' || session.state === 'REVERIFYING';
  const rows = session.steps.map((step) => `<div class="verification-step ${escapeHtml(step.status.toLowerCase())}">
    <span class="verification-step-state">${step.status === 'STEP_PASSED' ? icon('check', 12) : step.status === 'RUNNING' ? '<i></i>' : step.position + 1}</span>
    <div><strong>${escapeHtml(step.purpose)}</strong><small>${escapeHtml(step.profile)} ${escapeHtml(JSON.stringify(step.arguments))}</small>
      <small>cwd ${escapeHtml(step.cwd_relative)} / ${step.timeout_seconds}s / ${step.required ? 'required' : 'optional'} / ${escapeHtml(step.calculated_risk || 'evaluating')}</small>
      ${step.risk_explanation ? `<small>${escapeHtml(step.risk_explanation)}</small>` : ''}
      ${step.output ? `<pre class="command-output">${escapeHtml(step.output)}</pre>` : ''}
    </div>
  </div>`).join('');
  let actions = '';
  if (session.state === 'AWAITING_PLAN_APPROVAL') actions = `<button class="secondary" data-action="rejectVerification" data-session-id="${session.id}">Reject</button><button data-action="approveVerification" data-session-id="${session.id}">Approve complete plan</button>`;
  else if (running) actions = `<button data-action="cancelVerification" data-session-id="${session.id}">Cancel verification</button>`;
  else if (session.state === 'AWAITING_REPAIR_APPROVAL' && attempt?.repair_change_set_id) actions = `
    <button class="secondary" data-action="previewVerificationRepair" data-session-id="${session.id}" data-change-set-id="${attempt.repair_change_set_id}">Preview repair</button>
    <button class="secondary" data-action="rejectVerificationRepair" data-session-id="${session.id}">Reject repair</button>
    <button data-action="applyVerificationRepair" data-session-id="${session.id}">Apply repair</button>`;
  else if (attempt?.result === 'applied' && !running) actions = `<button class="secondary" data-action="restoreVerificationRepair" data-session-id="${session.id}">${icon('refresh', 12)} Restore repair</button>`;
  const detail = session.failure_reason || session.final_summary || session.cancellation_reason || (session.state === 'VERIFICATION_FAILED' ? 'Preparing a bounded repair proposal…' : '');
  return `<section class="verification-card" data-verification-id="${session.id}">
    <div class="verification-heading"><div class="proposal-icon">${icon('check', 15)}</div><div><strong>${escapeHtml(session.summary)}</strong><span>${escapeHtml(session.state)} · plan ${session.plan_fingerprint.slice(0, 10)}</span></div></div>
    <div class="verification-limits"><span>${session.mode}</span><span>${session.total_time_budget_seconds}s budget</span><span>repair ${session.current_attempt}/${session.maximum_repair_attempts}</span><span>rerun ${session.current_rerun}/${session.maximum_reruns}</span></div>
    <div class="verification-steps">${rows}</div>
    ${detail ? `<div class="verification-detail">${escapeHtml(detail)}</div>` : ''}
    ${actions ? `<div class="proposal-actions">${actions}</div>` : ''}
  </section>`;
}

function renderSetupCard(): string {
  if (!state.online) return '<section class="setup-card"><div><strong>Connect your local backend</strong><span>Start the API, then check the connection.</span></div><button data-action="startBackend">Start backend</button><button class="secondary" data-action="health">Check</button></section>';
  if (!state.ollama) return '<section class="setup-card"><div><strong>Local model needs attention</strong><span>Start your local model provider and load a coding model, then check again.</span></div><button data-action="health">Check connection</button></section>';
  if (state.models.length === 0) return '<section class="setup-card"><div><strong>Install a local model</strong><span>No local models were found. Load a coding model in your local provider, then check again.</span></div><button data-action="health">Check models</button></section>';
  if (state.mode === 'agent' && state.workspaceFolders !== 1) return '<section class="setup-card"><div><strong>Open one workspace folder</strong><span>Agent mode inspects one local repository. Use Ask with attached context for other files.</span></div></section>';
  if (state.mode === 'agent' && !state.workspaceRegistered) return '<section class="setup-card"><div><strong>Connect this workspace</strong><span>Allow local repository inspection. Changes and commands need your review.</span></div><button data-action="registerWorkspace">Register workspace</button></section>';
  return '';
}

function renderEmptyState(): string {
  return `
    <section class="empty-state">
      <div class="hero-mark"><span></span>${icon('spark', 30)}</div>
      <div class="local-badge">On your machine · Local models</div>
      <h1>What should we build?</h1>
      <p>Explore your repository, make a focused change, and review every step.</p>
      ${renderSetupCard()}
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
      <div class="user-message">${attachments}<div>${renderMarkdown(message.content, false)}</div></div>
    </article>`;
  }
  if (message.role === 'system' || message.role === 'tool') {
    return `<div class="system-message">${icon('paperclip', 13)} ${renderMarkdown(message.content)}</div>`;
  }
  const streaming = isLast && state.streaming;
  const activities = message.activities?.length ? `<div class="agent-activity">
    <div class="agent-activity-title">${icon('spark', 13)} Working in ${escapeHtml(state.workspace || 'workspace')}</div>
    ${message.activities.map((item) => `<div class="agent-step ${item.status}"><span>${item.status === 'complete' ? icon('check', 12) : item.status === 'error' ? icon('close', 12) : item.status === 'stopped' ? icon('stop', 12) : '<i></i>'}</span><strong>${escapeHtml(toolLabel(item.name))}</strong><small>${escapeHtml(item.summary)}</small></div>`).join('')}
  </div>` : '';
  const proposals = message.proposals?.map((proposal, proposalIndex) => renderProposal(proposal, index, proposalIndex)).join('') || '';
  return `<article class="message-row assistant-row ${message.error ? 'has-error' : ''}" data-message-index="${index}">
    <div class="assistant-avatar">${icon('spark', 15)}</div>
    <div class="assistant-content">
      <div class="assistant-label">CODEME <span>${escapeHtml(message.model || 'Local model')}</span></div>
      ${activities}
      <div class="markdown-body">${renderMarkdown(message.content)}${streaming ? '<span class="stream-cursor"></span>' : ''}</div>
      ${proposals ? `<div class="proposal-list">${proposals}</div>` : ''}
      ${!streaming && message.content ? `<div class="message-actions"><button data-action="copyMessage" data-index="${index}" title="Copy response">${icon('copy', 13)} Copy</button><button data-action="reusePrompt" data-index="${index}" title="Edit and resend the previous prompt">${icon('refresh', 13)} Edit request</button></div>` : ''}
    </div>
  </article>`;
}

function renderProposal(proposal: AgentProposal, messageIndex: number, proposalIndex: number): string {
  if (proposal.kind === 'command_proposal' && proposal.commandRun) {
    const run = proposal.commandRun;
    const blocked = run.status === 'blocked' || run.policy_blocked || run.calculated_risk === 'BLOCKED';
    const active = run.status === 'starting' || run.status === 'running';
    const terminal = ['completed', 'failed', 'timed_out', 'cancelled', 'rejected', 'blocked'].includes(run.status);
    const arguments_ = run.resolved_arguments || run.arguments;
    const details = JSON.stringify({
      purpose: run.purpose, profile: run.profile, executable: run.resolved_executable_name,
      arguments: arguments_, cwd: run.cwd_relative, risk: run.calculated_risk,
      timeoutSeconds: run.requested_timeout_seconds, environmentKeys: run.environment_keys || [],
    }, null, 2);
    return `<section class="proposal-card command-run-card ${blocked ? 'blocked' : ''}">
      <div class="proposal-icon">${icon('terminal', 15)}</div>
      <div class="proposal-copy">
        <strong>${escapeHtml(run.purpose)}</strong>
        <span>${escapeHtml(run.profile)} / ${escapeHtml(run.status)} / ${escapeHtml(run.calculated_risk || 'evaluating')}</span>
        <div class="command-details">
          <span><b>Executable</b> ${escapeHtml(run.resolved_executable_name || 'policy evaluation pending')}</span>
          <span><b>Arguments</b> <code>${escapeHtml(JSON.stringify(arguments_))}</code></span>
          <span><b>Working directory</b> ${escapeHtml(run.cwd_relative)}</span>
          <span><b>Timeout</b> ${run.requested_timeout_seconds}s</span>
          <span><b>Network</b> ${run.network_access ? 'may occur' : 'not indicated'} / <b>Workspace writes</b> ${run.writes_workspace ? 'may occur' : 'not indicated'}</span>
          <span><b>Environment keys</b> ${escapeHtml((run.environment_keys || []).join(', ') || '(none)')}</span>
          <span><b>Policy</b> ${escapeHtml(run.risk_explanation || 'Pending independent evaluation')}</span>
        </div>
        ${proposal.stdout ? `<pre class="command-output stdout">${escapeHtml(proposal.stdout)}</pre>` : ''}
        ${proposal.stderr ? `<pre class="command-output stderr">${escapeHtml(proposal.stderr)}</pre>` : ''}
        ${run.output_truncated ? '<span class="truncation-warning">Output was truncated; the process pipes were still drained.</span>' : ''}
        ${run.exit_code !== undefined && run.exit_code !== null ? `<span>Exit code ${run.exit_code} / ${run.duration_ms || 0}ms</span>` : ''}
        ${run.failure_reason ? `<span class="command-failure">${escapeHtml(run.failure_reason)}</span>` : ''}
      </div>
      <div class="proposal-actions">
        <button class="secondary" data-action="copyCommandDetails" data-details="${escapeHtml(details)}">${icon('copy', 12)} Copy details</button>
        ${run.status === 'proposed' && !blocked ? `<button class="secondary" data-action="rejectCommandProposal" data-message-index="${messageIndex}" data-proposal-index="${proposalIndex}">Reject</button><button data-action="runCommandProposal" data-message-index="${messageIndex}" data-proposal-index="${proposalIndex}">Run once</button>` : ''}
        ${active ? `<button data-action="cancelCommandRun" data-message-index="${messageIndex}" data-proposal-index="${proposalIndex}">Cancel run</button>` : ''}
        ${terminal ? `<button class="secondary" data-action="copyCommandOutput" data-message-index="${messageIndex}" data-proposal-index="${proposalIndex}">Copy output</button>` : ''}
      </div>
    </section>`;
  }
  if (proposal.kind === 'change_set' && proposal.changeSet) {
    const changeSet = proposal.changeSet;
    const files = changeSet.operations.map((operation) => `<span><b>${escapeHtml(operation.type)}</b> ${escapeHtml(operation.relative_path)}</span>`).join('');
    const isApplied = changeSet.status === 'applied';
    const isTerminal = ['rejected', 'failed', 'restored', 'restore_failed'].includes(changeSet.status);
    return `<section class="proposal-card change-set-card ${isApplied ? 'applied' : ''}">
      <div class="proposal-icon">${icon('file', 15)}</div>
      <div class="proposal-copy"><strong>${escapeHtml(changeSet.summary)}</strong><span>${changeSet.operations.length} file operation(s) · ${escapeHtml(changeSet.status)}</span><div class="proposal-files">${files}</div></div>
      <div class="proposal-actions">
        <button class="secondary" data-action="previewChangeSet" data-message-index="${messageIndex}" data-proposal-index="${proposalIndex}">${icon('external', 12)} Preview files</button>
        ${changeSet.status === 'proposed' ? `<button class="secondary" data-action="rejectChangeSet" data-message-index="${messageIndex}" data-proposal-index="${proposalIndex}">Reject</button><button data-action="applyChangeSet" data-message-index="${messageIndex}" data-proposal-index="${proposalIndex}">Apply complete set</button>` : ''}
        ${isApplied ? `<button class="secondary" data-action="startVerification" data-message-index="${messageIndex}" data-proposal-index="${proposalIndex}">${icon('check', 12)} Verify</button><button data-action="restoreChangeSet" data-message-index="${messageIndex}" data-proposal-index="${proposalIndex}">${icon('refresh', 12)} Restore</button>` : ''}
        ${isTerminal ? `<button disabled>${escapeHtml(changeSet.status)}</button>` : ''}
      </div>
    </section>`;
  }
  const isFile = proposal.kind === 'file_change';
  const title = isFile ? proposal.path || 'File change' : proposal.command || 'Terminal command';
  return `<section class="proposal-card ${proposal.applied ? 'applied' : ''}">
    <div class="proposal-icon">${icon(isFile ? 'file' : 'terminal', 15)}</div>
    <div class="proposal-copy"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(proposal.explanation || '')}</span></div>
    <div class="proposal-actions">
      ${isFile ? `<button class="secondary" data-action="openProposal" data-message-index="${messageIndex}" data-proposal-index="${proposalIndex}" title="Open proposed diff">${icon('external', 12)} Open</button>` : ''}
      <button class="secondary" data-action="copyProposal" data-message-index="${messageIndex}" data-proposal-index="${proposalIndex}" title="Copy ${isFile ? 'proposed file' : 'command'}">${icon('copy', 12)} Copy</button>
      ${isFile
        ? `<button data-action="applyProposal" data-message-index="${messageIndex}" data-proposal-index="${proposalIndex}" ${proposal.applied ? 'disabled' : ''}>${proposal.applied ? `${icon('check', 12)} Applied` : 'Apply'}</button>`
        : '<button disabled title="Legacy raw commands cannot execute">Display only</button>'}
    </div>
  </section>`;
}

function toolLabel(name: string): string {
  const labels: Record<string, string> = {
    status: 'Planning', list_files: 'Listed files', read_file: 'Read file', search_code: 'Searched code',
    project_snapshot: 'Inspected project architecture',
    git_status: 'Checked Git status', git_diff: 'Read Git diff', read_instructions: 'Read instructions',
    propose_change_set: 'Prepared change set', propose_file_change: 'Prepared legacy file change', propose_command: 'Prepared command',
  };
  return labels[name] || name.replace(/_/g, ' ');
}

function renderTaskStatus(): string {
  const reviewCount = state.messages.reduce((count, message) => count + (message.proposals || []).filter((item) => item.changeSet?.status === 'proposed' || item.commandRun?.status === 'proposed').length, 0);
  const run = currentAgentRun();
  const label = !state.online ? 'Connect your local backend' : !state.ollama ? 'Connect a local model' : state.streaming ? 'Working locally' : run?.status === 'awaiting_approval' ? 'Waiting for review or verification' : run?.status === 'blocked' ? 'Task needs attention' : run?.status === 'exhausted' ? 'Task budget reached' : run?.status === 'cancelled' ? 'Task cancelled' : (run?.status === 'interrupted' || run?.status === 'running') ? 'Task interrupted · resume available' : reviewCount ? 'Ready for your review' : state.taskStatus === 'error' ? 'Request needs attention' : state.taskStatus === 'stopped' ? 'Generation stopped' : state.taskStatus === 'complete' ? 'Response complete' : 'Ready when you are';
  const activities = state.messages.at(-1)?.activities || [];
  const active = [...activities].reverse().find((item) => item.status === 'running');
  return `<div class="task-status ${state.streaming ? 'working' : state.taskStatus}" role="status" aria-live="polite"><span class="task-indicator">${state.streaming ? '<i></i>' : icon(reviewCount ? 'file' : state.taskStatus === 'error' ? 'close' : 'check', 13)}</span><div><strong>${label}</strong>${state.lastError ? `<span class="task-error">${escapeHtml(state.lastError)}</span>` : active && state.streaming ? `<span>${escapeHtml(active.summary)}</span>` : ''}</div>${reviewCount ? `<button data-action="reviewPending">${reviewCount} to review</button>` : ''}</div>`;
}

function renderComposer(): string {
  const attachments = state.attachments.map((item, index) => `
    <span class="attachment-chip" title="${escapeHtml(item.detail || item.label)}">${contextIcon(item.kind)}<span>${escapeHtml(item.label)}</span><button data-action="removeAttachment" data-index="${index}" aria-label="Remove ${escapeHtml(item.label)} context">${icon('close', 12)}</button></span>
  `).join('');
  const contextMenu = state.contextMenuOpen ? `
    <div class="context-menu">
      <button data-action="requestContext" data-kind="selection">${icon('code')}<span><strong>Selection</strong><small>Selected editor code</small></span></button>
      <button data-action="requestContext" data-kind="file">${icon('file')}<span><strong>Current file</strong><small>Entire active file</small></span></button>
      <button data-action="requestContext" data-kind="changes">${icon('git')}<span><strong>Git changes</strong><small>Working tree diff</small></span></button>
    </div>` : '';
  return `
    <footer class="composer-wrap">
      ${renderTaskStatus()}
      <div class="mode-switch" role="group" aria-label="Chat mode">
        <button data-action="setMode" data-mode="ask" aria-pressed="${state.mode === 'ask'}" ${state.streaming ? 'disabled' : ''} class="${state.mode === 'ask' ? 'active' : ''}">Ask</button>
        <button data-action="setMode" data-mode="agent" aria-pressed="${state.mode === 'agent'}" ${state.streaming ? 'disabled' : ''} class="${state.mode === 'agent' ? 'active' : ''}">${icon('spark', 12)} Agent</button>
        <span>${state.mode === 'agent' ? (state.workspaceRegistered ? 'Inspect · propose · review · verify' : state.workspace ? 'Register to inspect local files' : 'Open one workspace folder') : 'Chat with attached context'}</span>
      </div>
      ${attachments ? `<div class="attachment-list">${attachments}</div>` : ''}
      <div class="composer ${state.streaming ? 'streaming' : ''}">
        <textarea id="prompt" rows="1" aria-label="Message Codeme" maxlength="100000" placeholder="${state.streaming ? 'Draft your next request…' : state.mode === 'agent' ? 'Describe a task for this workspace…' : 'Ask about your code…'}">${escapeHtml(state.composer)}</textarea>
        <div class="composer-toolbar">
          <div class="composer-left">
            <button class="tool-button ${state.contextMenuOpen ? 'active' : ''}" data-action="toggleContext" title="Add context" aria-expanded="${state.contextMenuOpen}">${icon('paperclip', 15)}<span>Context</span></button>
            <select id="model-select" title="Local model" aria-label="Local model" ${state.streaming || !state.models.length ? 'disabled' : ''}>${!state.models.length ? '<option value="">No local models installed</option>' : ''}${state.models.map((model) => `<option value="${escapeHtml(model)}" ${model === state.selectedModel ? 'selected' : ''}>${escapeHtml(shortModelName(model))}</option>`).join('')}</select>
          </div>
          ${state.streaming
            ? `<button class="send-button stop" data-action="stop" title="Stop generation (Esc)" aria-label="Stop generation">${icon('stop', 16)}</button>`
            : `<button class="send-button" data-action="send" title="Send message" aria-label="Send message" ${!state.online || !state.ollama || !state.selectedModel || !state.composer.trim() ? 'disabled' : ''}>${icon('send', 16)}</button>`}
        </div>
        ${contextMenu}
      </div>
      <div class="composer-hint"><span>Enter to send · Shift+Enter for new line</span><span>${state.attachments.length ? `${Math.ceil(state.attachments.reduce((size, item) => size + item.content.length, 0) / 1024)} KB context · ` : ''}Local only</span></div>
    </footer>
  `;
}

function renderMarkdown(text: string, codeActions = true): string {
  const html = safeMarkdown(text);
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
  const codeTargets = inferCodeBlockTargets(text);
  let codeBlockIndex = 0;
  template.content.querySelectorAll('pre code').forEach((code) => {
    const targetPath = codeTargets[codeBlockIndex++];
    const languageClass = Array.from(code.classList).find((name) => name.startsWith('language-'));
    const language = languageClass?.slice('language-'.length) || 'code';
    const grammar = Prism.languages[language];
    const rawCode = code.textContent || '';
    if (grammar) {
      code.innerHTML = Prism.highlight(rawCode, grammar, language);
    }
    const pre = code.closest('pre');
    if (pre) {
      if (targetPath) pre.dataset.targetPath = targetPath;
      if (!codeActions) return;
      const toolbar = document.createElement('div');
      toolbar.className = 'code-toolbar';
      toolbar.innerHTML = `<span title="${escapeHtml(targetPath || language)}">${escapeHtml(targetPath || language)}</span><div><button class="code-apply" title="${targetPath ? `Replace ${escapeHtml(targetPath)}` : 'Choose where to apply'}">${icon('apply', 13)} Apply</button><button class="code-open" title="${targetPath ? 'Open proposed diff' : 'Open generated code'}">${icon('external', 13)} Open</button><button class="code-copy" title="Copy code">${icon('copy', 13)} Copy</button></div>`;
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
    attachments: state.attachments,
    conversations: state.conversations,
    currentConversationId: state.currentConversationId,
    composer: state.composer,
    selectedModel: state.selectedModel,
    models: state.models,
    workspace: state.workspace,
    rootPath: state.rootPath,
    mode: state.mode,
    verifications: state.verifications,
    agentRuns: state.agentRuns,
    provider: state.provider,
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
    scroller.classList.remove('is-scrolled-up');
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
  if (!state.online || !state.ollama) {
    showToast(!state.online ? 'Start the backend before sending a message.' : 'Connect Ollama before sending a message.');
    return;
  }
  if (!state.selectedModel || !state.models.includes(state.selectedModel)) { showToast('Install and select a local Ollama model before sending.'); return; }
  if (prompt.length > 100_000) { showToast('Keep your request below 100,000 characters.'); return; }
  const attachments = [...state.attachments];
  activeRequestId = `${Date.now()}-${++requestSequence}`;
  state.taskStatus = 'working';
  state.lastError = null;
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
      requestId: activeRequestId,
      conversationId: state.currentConversationId,
      model: state.selectedModel,
      context: attachments,
      mode: state.mode,
    },
  });
}

function newChat(): void {
  activeRequestId = null;
  vscode.postMessage({ command: 'abandonChat' });
  state.taskStatus = 'idle';
  state.lastError = null;
  state.currentConversationId = null;
  state.messages = [];
  state.composer = '';
  state.attachments = [];
  state.streaming = false;
  state.loadingConversation = false;
  state.historyOpen = false;
  render();
  focusComposer();
}

function addAttachment(attachment: Attachment): void {
  const duplicate = state.attachments.some((item) => item.kind === attachment.kind && item.detail === attachment.detail && item.label === attachment.label);
  if (!duplicate) {
    if (state.attachments.reduce((size, item) => size + item.content.length, attachment.content.length) > 175_000) {
      showToast('Context is too large. Attach a smaller selection or remove a file.');
      return;
    }
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
      vscode.postMessage({ command: codeApply ? 'applyCode' : 'openCode', args: { text: code?.textContent || '', language, path: pre?.dataset.targetPath } });
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
    if (action === 'scrollLatest') scrollToBottom();
    if (action === 'reviewPending') {
      app.querySelector('[data-action="applyChangeSet"], [data-action="runCommandProposal"]')?.closest('section')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
    if (action === 'registerWorkspace') vscode.postMessage({ command: 'registerWorkspace' });
    if (action === 'toggleHistory') { state.historyOpen = !state.historyOpen; state.contextMenuOpen = false; render(); if (state.historyOpen) document.getElementById('history-search')?.focus(); else focusComposer(); }
    if (action === 'settings') vscode.postMessage({ command: 'openSettings' });
    if (action === 'health') vscode.postMessage({ command: 'healthCheck' });
    if (action === 'startBackend') vscode.postMessage({ command: 'startBackend' });
    if (action === 'toggleContext') { state.contextMenuOpen = !state.contextMenuOpen; render(); focusComposer(); }
    if (action === 'requestContext') vscode.postMessage({ command: 'requestContext', args: { kind: button.dataset.kind } });
    if (action === 'removeAttachment') { state.attachments.splice(Number(button.dataset.index), 1); render(); focusComposer(); }
    if (action === 'send') submitPrompt();
    if (action === 'setMode' && !state.streaming) { state.mode = button.dataset.mode === 'ask' ? 'ask' : 'agent'; render(); focusComposer(); }
    if (action === 'stop') vscode.postMessage({ command: 'cancelStream' });
    if (action === 'resumeAgentRun' && !state.streaming) {
      activeRequestId = 'resume-' + Date.now() + '-' + (++requestSequence);
      state.streaming = true;
      state.taskStatus = 'working';
      state.lastError = null;
      state.messages.push({ role: 'assistant', model: state.selectedModel, content: '', activities: [], proposals: [] });
      render();
      vscode.postMessage({ command: action, args: { runId: button.dataset.runId, requestId: activeRequestId } });
    }
    if (action === 'cancelAgentRun') vscode.postMessage({ command: action, args: { runId: button.dataset.runId } });
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
      activeRequestId = null;
      state.streaming = false;
      state.taskStatus = 'idle';
      state.lastError = null;
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
    if (action === 'applyProposal' || action === 'runProposal' || action === 'openProposal' || action === 'copyProposal') {
      const item = state.messages[Number(button.dataset.messageIndex)]?.proposals?.[Number(button.dataset.proposalIndex)];
      if (!item) return;
      if (action === 'copyProposal') {
        vscode.postMessage({ command: 'copyText', args: { text: item.kind === 'file_change' ? item.content || '' : item.command || '' } });
        showToast(item.kind === 'file_change' ? 'Proposed file copied' : 'Command copied');
        return;
      }
      if (action === 'openProposal') {
        vscode.postMessage({ command: 'previewFileChange', args: { path: item.path, content: item.content } });
        return;
      }
      vscode.postMessage({
        command: action === 'applyProposal' ? 'applyFileChange' : 'runProposedCommand',
        args: { path: item.path, content: item.content, command: item.command, explanation: item.explanation },
      });
    }
    if (action === 'previewChangeSet' || action === 'applyChangeSet' || action === 'rejectChangeSet' || action === 'restoreChangeSet') {
      const item = state.messages[Number(button.dataset.messageIndex)]?.proposals?.[Number(button.dataset.proposalIndex)];
      if (!item?.changeSet) return;
      vscode.postMessage({ command: action, args: { changeSet: item.changeSet } });
    }
    if (action === 'startVerification') {
      const messageIndex = Number(button.dataset.messageIndex);
      const item = state.messages[messageIndex]?.proposals?.[Number(button.dataset.proposalIndex)];
      const request = [...state.messages.slice(0, messageIndex)].reverse().find((message) => message.role === 'user')?.content
        || 'Verify the applied change set';
      if (item?.changeSet && state.currentConversationId) {
        vscode.postMessage({
          command: 'startVerification',
          args: { conversationId: state.currentConversationId, sourceChangeSetId: item.changeSet.id, originalRequest: request, mode: 'quick' },
        });
      }
    }
    if (['approveVerification', 'rejectVerification', 'cancelVerification', 'applyVerificationRepair', 'rejectVerificationRepair', 'restoreVerificationRepair'].includes(action || '')) {
      vscode.postMessage({ command: action, args: { sessionId: button.dataset.sessionId } });
    }
    if (action === 'previewVerificationRepair') {
      vscode.postMessage({ command: action, args: { sessionId: button.dataset.sessionId, changeSetId: button.dataset.changeSetId } });
    }
    if (action === 'runCommandProposal' || action === 'rejectCommandProposal' || action === 'cancelCommandRun' || action === 'copyCommandOutput') {
      const item = state.messages[Number(button.dataset.messageIndex)]?.proposals?.[Number(button.dataset.proposalIndex)];
      if (!item?.commandRun) return;
      if (action === 'copyCommandOutput') {
        vscode.postMessage({ command: 'copyText', args: { text: [item.stdout || '', item.stderr || ''].filter(Boolean).join('\n') } });
        showToast('Command output copied');
        return;
      }
      vscode.postMessage({
        command: action,
        args: action === 'cancelCommandRun' ? { commandRunId: item.commandRun.id } : { commandRun: item.commandRun },
      });
    }
    if (action === 'copyCommandDetails') {
      vscode.postMessage({ command: 'copyText', args: { text: button.dataset.details || '' } });
      showToast('Command details copied');
    }
  });

  app.addEventListener('input', (event) => {
    const input = event.target as HTMLInputElement | HTMLTextAreaElement;
    if (input.id === 'prompt') {
      state.composer = input.value;
      resizeComposer(input as HTMLTextAreaElement);
      const sendButton = app.querySelector<HTMLButtonElement>('[data-action="send"]');
      if (sendButton) sendButton.disabled = !state.online || !state.ollama || !state.composer.trim();
      persistState();
    }
    if (input.id === 'history-search') {
      state.conversationSearch = input.value;
      const query = input.value.trim();
      window.clearTimeout(historySearchTimer);
      historySearchTimer = window.setTimeout(() => vscode.postMessage({ command: 'searchConversations', args: { query } }), 180);
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
    if (keyboardEvent.key === 'Tab' && state.historyOpen) {
      const controls = Array.from(app.querySelectorAll<HTMLElement>('.history-drawer button, .history-drawer input'));
      const first = controls[0];
      const last = controls.at(-1);
      if (keyboardEvent.shiftKey && target === first) { keyboardEvent.preventDefault(); last?.focus(); }
      else if (!keyboardEvent.shiftKey && target === last) { keyboardEvent.preventDefault(); first?.focus(); }
    }
    if (keyboardEvent.key === 'Escape' && (state.historyOpen || state.contextMenuOpen)) {
      state.historyOpen = false;
      state.contextMenuOpen = false;
      render();
      focusComposer();
    } else if (keyboardEvent.key === 'Escape' && state.streaming) {
      vscode.postMessage({ command: 'cancelStream' });
    }
  });
  app.addEventListener('scroll', (event) => {
    const scroller = event.target as HTMLElement;
    if (scroller.id === 'chat-scroll') scroller.classList.toggle('is-scrolled-up', !isNearBottom());
  }, true);
}

window.addEventListener('message', (event) => {
  const message = event.data as { command?: string; payload?: any };
  const requestEvents = ['conversationCreated', 'streamStarted', 'streamChunk', 'agentEvent', 'streamComplete', 'streamStopped', 'streamError'];
  if (requestEvents.includes(message.command || '') && message.payload?.requestId && message.payload.requestId !== activeRequestId) return;
  if (requestEvents.includes(message.command || '') && !message.payload?.requestId && message.payload?.conversationId && message.payload.conversationId !== state.currentConversationId) return;
  switch (message.command) {
    case 'backendStatus':
      state.online = Boolean(message.payload?.online);
      state.ollama = Boolean(message.payload?.ollama);
      state.provider = String(message.payload?.provider || 'Ollama');
      if (!state.online && message.payload?.error) state.lastError = String(message.payload.error);
      else if (state.online && state.taskStatus !== 'error') state.lastError = null;
      state.models = Array.isArray(message.payload?.models) ? message.payload.models : state.models;
      state.selectedModel = state.models.includes(state.selectedModel) ? state.selectedModel : state.models.includes(message.payload?.model) ? message.payload.model : (state.models[0] || '');
      render();
      if (!state.online && message.payload?.error) showToast('Backend unavailable');
      break;
    case 'workspaceState':
      state.workspace = message.payload?.workspace || null;
      state.rootPath = message.payload?.rootPath || null;
      state.workspaceRegistered = Boolean(message.payload?.registered);
      state.workspaceFolders = Number(message.payload?.folders || 0);
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
    case 'conversationLoaded': {
      const cached = state.currentConversationId === message.payload?.conversationId ? state.messages : [];
      state.currentConversationId = message.payload?.conversationId || null;
      state.messages = (message.payload?.messages || []).map((item: ChatMessage) => {
        const previous = cached.find((saved) => saved.role === item.role && saved.content === item.content);
        return { ...previous, id: item.id, role: item.role, content: item.content };
      });
      state.loadingConversation = false;
      state.streaming = false;
      state.taskStatus = 'idle';
      state.lastError = null;
      render();
      requestAnimationFrame(scrollToBottom);
      break;
    }
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
      state.taskStatus = 'working';
      state.lastError = null;
      state.currentConversationId = message.payload?.conversationId || state.currentConversationId;
      state.streaming = true;
      render();
      break;
    case 'streamChunk': {
      const chunk = typeof message.payload?.chunk === 'string' ? message.payload.chunk : '';
      const last = state.messages[state.messages.length - 1];
      if (last?.role === 'assistant') last.content += chunk;
      else state.messages.push({ role: 'assistant', model: state.selectedModel, content: chunk });
      state.streaming = true;
      scheduleRender();
      break;
    }
    case 'agentRunUpdated': {
      updateAgentRun(message.payload as AgentRun);
      render();
      break;
    }
    case 'taskNotice':
      if (message.payload?.conversationId === state.currentConversationId) {
        state.streaming = false;
        render();
        showToast(message.payload?.message || 'Review saved actions before resuming.');
      }
      break;
    case 'agentProposalRecovered': {
      if (message.payload?.conversationId !== state.currentConversationId) break;
      const changeSet = message.payload?.changeSet as ChangeSet | undefined;
      const commandRun = message.payload?.commandRun as CommandRun | undefined;
      const exists = state.messages.some((item) => item.proposals?.some((proposal) =>
        changeSet ? proposal.changeSet?.id === changeSet.id : proposal.commandRun?.id === commandRun?.id));
      if (!exists) {
        let assistant = [...state.messages].reverse().find((item) => item.role === 'assistant');
        if (!assistant) { assistant = { role: 'assistant', content: '' }; state.messages.push(assistant); }
        assistant.proposals ||= [];
        if (changeSet) assistant.proposals.push({ kind: 'change_set', changeSet });
        if (commandRun) assistant.proposals.push({ kind: 'command_proposal', commandRun });
      }
      render();
      break;
    }
    case 'agentEvent': {
      const agentEvent = message.payload?.event;
      if (agentEvent?.type === 'task') {
        updateAgentRun(agentEvent.run);
        scheduleRender();
        break;
      }
      if (agentEvent?.type === 'plan') {
        const run = currentAgentRun();
        if (run) run.plan = agentEvent.steps || [];
        scheduleRender();
        break;
      }
      if (agentEvent?.type === 'outcome') {
        const run = currentAgentRun();
        if (run) { run.status = agentEvent.status; run.summary = agentEvent.summary; }
        scheduleRender();
        break;
      }
      let assistant = state.messages[state.messages.length - 1];
      if (assistant?.role !== 'assistant') {
        assistant = { role: 'assistant', model: state.selectedModel, content: '', activities: [], proposals: [] };
        state.messages.push(assistant);
      }
      if (agentEvent?.type === 'status') {
        assistant.activities ||= [];
        assistant.activities.push({ name: 'status', summary: agentEvent.label || 'Inspecting workspace', status: 'running' });
      } else if (agentEvent?.type === 'tool') {
        assistant.activities ||= [];
        const running = [...assistant.activities].reverse().find((item) => item.name === agentEvent.name && item.summary === agentEvent.summary && item.status === 'running');
        if (agentEvent.status !== 'running' && running) running.status = agentEvent.status;
        else assistant.activities.push({ name: agentEvent.name, summary: agentEvent.summary, status: agentEvent.status });
      } else if (agentEvent?.type === 'proposal') {
        assistant.proposals ||= [];
        if (agentEvent.command_run) {
          const duplicate = assistant.proposals.some((proposal) => proposal.commandRun?.id === agentEvent.command_run.id);
          if (!duplicate) assistant.proposals.push({ kind: 'command_proposal', commandRun: agentEvent.command_run });
        } else if (agentEvent.change_set) {
          const duplicate = assistant.proposals.some((proposal) => proposal.changeSet?.id === agentEvent.change_set.id);
          if (!duplicate) assistant.proposals.push({ kind: 'change_set', explanation: agentEvent.change_set.summary, changeSet: agentEvent.change_set });
        } else {
          assistant.proposals.push(agentEvent as AgentProposal);
        }
      } else if (agentEvent?.type === 'message') {
        assistant.content = agentEvent.content || '';
        assistant.activities?.forEach((item) => { if (item.status === 'running') item.status = 'complete'; });
      }
      state.streaming = true;
      scheduleRender();
      break;
    }
    case 'streamComplete':
    case 'streamStopped':
      state.streaming = false;
      state.taskStatus = message.command === 'streamStopped' ? 'stopped' : 'complete';
      state.messages.at(-1)?.activities?.forEach((item) => { if (item.status === 'running') item.status = message.command === 'streamStopped' ? 'stopped' : 'complete'; });
      render();
      focusComposer();
      break;
    case 'streamError': {
      state.streaming = false;
      const errorMessage = message.payload?.message || 'Unable to generate a response.';
      state.taskStatus = 'error';
      state.lastError = errorMessage;
      state.messages.at(-1)?.activities?.forEach((item) => { if (item.status === 'running') item.status = 'error'; });
      const last = state.messages[state.messages.length - 1];
      if (!last || last.role !== 'assistant' || !last.content) {
        state.messages.push({ role: 'assistant', content: errorMessage, error: true });
      }
      render();
      showToast(errorMessage);
      focusComposer();
      break;
    }
    case 'operationError':
      state.loadingConversation = false;
      state.lastError = message.payload?.message || 'Operation failed';
      state.taskStatus = 'error';
      render();
      showToast(message.payload?.message || 'Operation failed');
      break;
    case 'workspaceRegistered':
      state.workspaceRegistered = true;
      render();
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
    case 'changeSetUpdated': {
      const updated = message.payload as ChangeSet;
      for (const chatMessage of state.messages) {
        const proposal = chatMessage.proposals?.find((item) => item.changeSet?.id === updated.id);
        if (proposal) proposal.changeSet = updated;
      }
      render();
      showToast(`Change set ${updated.status}`);
      break;
    }
    case 'commandRunUpdated': {
      const updated = message.payload as CommandRun;
      for (const chatMessage of state.messages) {
        const proposal = chatMessage.proposals?.find((item) => item.commandRun?.id === updated.id);
        if (proposal) proposal.commandRun = { ...proposal.commandRun, ...updated };
      }
      render();
      showToast(`Command ${updated.status}`);
      break;
    }
    case 'commandRunOutput': {
      const output = message.payload as { commandRunId: string; stream: 'stdout' | 'stderr' | 'status'; text: string };
      for (const chatMessage of state.messages) {
        const proposal = chatMessage.proposals?.find((item) => item.commandRun?.id === output.commandRunId);
        if (!proposal) continue;
        if (output.stream === 'stdout') proposal.stdout = (proposal.stdout || '') + output.text;
        else if (output.stream === 'stderr') proposal.stderr = (proposal.stderr || '') + output.text;
      }
      scheduleRender();
      break;
    }
    case 'verificationSessionUpdated': {
      const updated = message.payload as VerificationSession;
      const index = state.verifications.findIndex((item) => item.id === updated.id);
      if (index >= 0) {
        const outputs = new Map(state.verifications[index].steps.map((step) => [step.step_id, step.output]));
        updated.steps.forEach((step) => { step.output = outputs.get(step.step_id); });
        state.verifications[index] = updated;
      } else {
        state.verifications.push(updated);
      }
      render();
      break;
    }
    case 'verificationStepOutput': {
      const session = state.verifications.find((item) => item.id === message.payload?.sessionId);
      const step = session?.steps.find((item) => item.step_id === message.payload?.stepId);
      if (step && ['stdout', 'stderr'].includes(message.payload?.stream)) {
        step.output = ((step.output || '') + String(message.payload?.text || '')).slice(-65_536);
      }
      scheduleRender();
      break;
    }
    case 'verificationRepairStarted':
      showToast('Preparing a bounded repair proposal with the local model');
      break;
  }
});

render();
resizeComposer(document.getElementById('prompt') as HTMLTextAreaElement | null);
vscode.postMessage({ command: 'ready', args: { conversationId: state.currentConversationId } });
