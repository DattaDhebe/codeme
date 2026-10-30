import { AfterViewChecked, Component, DestroyRef, ElementRef, OnDestroy, OnInit, ViewChild, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { firstValueFrom, Subscription } from 'rxjs';
import { ApiService } from './api.service';
import { ConversationSummary, MessageRead, ChatRequest, HealthRead, ModelSetupStatus, CodingModel, ModelCatalog } from './models';
import { MarkdownPipe } from './markdown.pipe';
import { SseEvent, SseParser } from './sse-parser';
import { ModelSetupComponent } from './model-setup.component';
import { ModelCatalogComponent } from './model-catalog.component';

@Component({
  selector: 'app-chat-shell',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule, MarkdownPipe, ModelSetupComponent, ModelCatalogComponent],
  templateUrl: './chat-shell.component.html',
  styleUrls: ['./chat-shell.component.scss'],
})
export class ChatShellComponent implements OnInit, OnDestroy, AfterViewChecked {
  @ViewChild('messageList') private messageList?: ElementRef<HTMLElement>;
  @ViewChild('composer') private composer?: ElementRef<HTMLTextAreaElement>;
  conversations: ConversationSummary[] = [];
  activeConversation: ConversationSummary | null = null;
  messages: MessageRead[] = [];
  inputText = '';
  model: string;
  models: string[] = [];
  streaming = false;
  creating = false;
  loadingConversations = false;
  loadingMessages = false;
  healthChecking = false;
  connection: 'checking' | 'ready' | 'offline' | 'model-missing' = 'checking';
  connectionDetail = 'Connecting to your local model service…';
  provider: 'ollama' | 'openai_compatible' = 'ollama';
  error: string | null = null;
  notice = '';
  searchQuery = '';
  sidebarOpen = false;
  renameId: number | null = null;
  renameTitle = '';
  deleteId: number | null = null;
  conversationBusy = false;
  showJumpToLatest = false;
  modelSetup: ModelSetupStatus | null = null;
  setupRequestPending = false;
  setupError = '';
  catalogOpen = false;
  modelCatalog: ModelCatalog | null = null;
  catalogLoading = false;
  catalogError = '';
  private readonly destroyRef = inject(DestroyRef);
  private abortController: AbortController | null = null;
  private messageLoadId = 0;
  private conversationLoadId = 0;
  private streamingMessageId: number | null = null;
  private nextMessageId = -1;
  private pendingScroll = false;
  private followStream = true;
  private destroyed = false;
  private healthTimer?: ReturnType<typeof setInterval>;
  private setupTimer?: ReturnType<typeof setTimeout>;
  private setupRequestId = 0;
  private setupRevision = 0;
  private setupSubscription?: Subscription;
  private setupAction: 'check' | 'start' | 'cancel' = 'check';
  private automaticSetupAttempted = false;
  private catalogRequestId = 0;
  private readonly drafts = new Map<number | 'new', string>();

  constructor(private readonly api: ApiService) {
    this.model = api.defaultModel;
  }

  get filteredConversations(): ConversationSummary[] {
    const query = this.searchQuery.trim().toLocaleLowerCase();
    return this.conversations.filter(item => item.title.toLocaleLowerCase().includes(query));
  }

  get canSend(): boolean {
    return !!this.inputText.trim() && !this.streaming && !this.creating && !this.loadingMessages && !this.setupBusy && !this.setupError && this.connection === 'ready';
  }

  get connectionLabel(): string {
    return { checking: 'Connecting', ready: 'Local model ready', offline: 'Connection unavailable', 'model-missing': 'Model setup needed' }[this.connection];
  }

  get setupBusy(): boolean {
    return this.setupRequestPending || !!this.modelSetup && ['checking', 'downloading', 'loading'].includes(this.modelSetup.state);
  }

  get showModelSetup(): boolean {
    return !!this.setupError || !!this.modelSetup && this.modelSetup.state !== 'ready' || this.setupRequestPending;
  }

  get canCancelSetup(): boolean {
    return !!this.modelSetup && ['checking', 'downloading', 'loading'].includes(this.modelSetup.state)
      && (!this.setupRequestPending || this.setupAction === 'check');
  }

  ngOnInit(): void {
    if (!this.api.isBrowser) return;
    this.restoreDrafts();
    this.loadConversations();
    this.refreshModelSetup();
    this.refreshHealth();
    this.healthTimer = setInterval(() => this.refreshHealth(), 30000);
  }

  ngOnDestroy(): void {
    this.saveDraft();
    this.destroyed = true;
    this.stopGeneration(false);
    if (this.healthTimer) clearInterval(this.healthTimer);
    if (this.setupTimer) clearTimeout(this.setupTimer);
    this.setupRequestId++;
    this.setupSubscription?.unsubscribe();
  }

  ngAfterViewChecked(): void {
    if (this.pendingScroll) {
      this.pendingScroll = false;
      const element = this.messageList?.nativeElement;
      if (element) element.scrollTop = element.scrollHeight;
    }
  }

  refreshHealth(): void {
    if (this.healthChecking) return;
    const setupRevision = this.setupRevision;
    this.healthChecking = true;
    this.api.getHealth().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: health => {
        if (setupRevision !== this.setupRevision) { this.healthChecking = false; return; }
        this.applyHealth(health);
      },
      error: (failure: HttpErrorResponse) => {
        if (setupRevision !== this.setupRevision) { this.healthChecking = false; return; }
        if (failure.status > 0 && this.setupError) this.refreshModelSetup();
        if (failure.error && typeof failure.error === 'object' && failure.error.ollama === 'ok') {
          this.applyHealth(failure.error as HealthRead);
        } else if (!this.setupBusy) {
          this.models = [];
          this.connection = failure.status === 0 ? 'offline' : 'model-missing';
          this.connectionDetail = failure.status === 0
            ? 'Start the CodeMe backend, then reconnect. Your draft will stay here.'
            : 'Your local model server is unavailable. Retry setup to reconnect your model.';
          if (failure.status > 0 && this.modelSetup?.state === 'ready') {
            this.modelSetup = { ...this.modelSetup, state: 'server_unavailable', message: this.connectionDetail, error: null, can_retry: true };
          }
          this.healthChecking = false;
        } else this.healthChecking = false;
      },
    });
  }

  private applyHealth(health: HealthRead): void {
    if (this.setupError) this.refreshModelSetup();
    this.provider = health.provider || 'ollama';
    if (this.setupBusy || this.modelSetup && this.modelSetup.state !== 'ready') {
      this.healthChecking = false;
      return;
    }
    this.models = (health.models || []).filter((value): value is string => typeof value === 'string' && !!value.trim());
    if (!this.models.includes(this.model)) this.model = this.models.includes(health.model || '') ? health.model! : this.models[0] || this.api.defaultModel;
    this.connection = this.models.length && health.ollama !== 'unavailable' ? 'ready' : 'model-missing';
    this.connectionDetail = this.connection === 'ready'
      ? 'Responses run through ' + (this.provider === 'ollama' ? 'Ollama' : 'your local model server') + ' on your machine.'
      : this.provider === 'ollama'
        ? 'Install a coding model with ollama pull ' + this.api.defaultModel + ', then reconnect.'
        : 'Load a local coding model in your model server, then reconnect.';
    this.healthChecking = false;
  }

  refreshModelSetup(): void {
    this.requestModelSetup(false);
  }

  startModelSetup(): void {
    this.automaticSetupAttempted = true;
    this.requestModelSetup(true);
  }

  toggleModelCatalog(): void {
    this.catalogOpen = !this.catalogOpen;
    if (this.catalogOpen) this.loadModelCatalog();
  }

  loadModelCatalog(): void {
    if (this.destroyed) return;
    const request = ++this.catalogRequestId;
    this.catalogLoading = true;
    this.catalogError = '';
    this.api.getModelCatalog().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: catalog => {
        if (this.destroyed || request !== this.catalogRequestId) return;
        this.modelCatalog = catalog;
        this.catalogLoading = false;
      },
      error: () => {
        if (this.destroyed || request !== this.catalogRequestId) return;
        this.catalogLoading = false;
        this.catalogError = 'Could not load model choices. Your current chat model is unchanged. Check the backend and try again.';
      },
    });
  }

  chooseCatalogModel(model: CodingModel): void {
    if (this.provider !== 'ollama' || !this.modelCatalog?.download_supported || this.modelCatalog.setup_active || this.setupBusy || this.streaming
        || !this.modelCatalog.models.some(item => item.id === model.id)) return;
    this.automaticSetupAttempted = true;
    this.catalogError = '';
    this.requestModelSetup(true, false, model.id);
  }

  cancelModelSetup(): void {
    this.requestModelSetup(false, true);
  }

  reconnect(): void {
    this.refreshModelSetup();
    this.refreshHealth();
  }

  private requestModelSetup(start: boolean, cancel = false, catalogId?: string): void {
    if (this.destroyed || this.setupRequestPending && !cancel) return;
    if (cancel) this.setupSubscription?.unsubscribe();
    if (this.setupTimer) { clearTimeout(this.setupTimer); this.setupTimer = undefined; }
    const request = ++this.setupRequestId;
    this.setupAction = cancel ? 'cancel' : start ? 'start' : 'check';
    this.setupRevision++;
    this.setupRequestPending = true;
    this.setupError = '';
    const previousConnection = this.connection;
    if (this.connection !== 'ready' || start) this.connection = 'checking';
    const source = cancel ? this.api.cancelModelSetup() : start ? catalogId ? this.api.startModelSetup(catalogId) : this.api.startModelSetup() : this.api.getModelSetup();
    this.setupSubscription = source.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: status => {
        if (this.destroyed || request !== this.setupRequestId) return;
        this.setupRevision++;
        this.setupRequestPending = false;
        const previous = this.modelSetup;
        this.modelSetup = status;
        if (catalogId && catalogId === status.catalog_id) this.catalogError = '';
        this.provider = status.provider;
        this.connectionDetail = status.message;
        if (status.state === 'ready') {
          this.automaticSetupAttempted = false;
          this.models = status.available_models;
          const requestedSelectionReady = !!catalogId && catalogId === status.catalog_id;
          const newlyPreparedSelection = status.explicit_selection && (requestedSelectionReady || previous?.state !== 'ready'
            || previous.catalog_id !== status.catalog_id || previous.model !== status.model);
          if (newlyPreparedSelection || !this.models.includes(this.model)) this.model = status.model || this.models[0] || this.api.defaultModel;
          if (newlyPreparedSelection) this.notice = status.preference_saved === false ? status.message : `Ready to use ${this.model}.`;
          this.connection = this.models.includes(this.model) ? 'ready' : 'model-missing';
          if (this.catalogOpen && (start || cancel || previous?.state !== 'ready')) this.loadModelCatalog();
          return;
        }
        if (this.catalogOpen && ['error', 'cancelled'].includes(status.state) && (start || cancel || previous?.state !== status.state)) this.loadModelCatalog();
        this.connection = 'model-missing';
        if (status.state === 'idle' && status.auto_setup_enabled && !this.automaticSetupAttempted) {
          this.automaticSetupAttempted = true;
          this.requestModelSetup(true);
        } else if (['checking', 'downloading', 'loading'].includes(status.state) || status.state === 'cancelled' && !status.can_retry) {
          this.setupTimer = setTimeout(() => this.refreshModelSetup(), 1000);
        }
      },
      error: (failure: HttpErrorResponse) => {
        if (this.destroyed || request !== this.setupRequestId) return;
        this.setupRequestPending = false;
        if (catalogId && start) {
          this.connection = previousConnection;
          this.catalogError = failure.status === 409
            ? 'Another model setup is running. Finish or cancel it, then choose your model again.'
            : 'Could not prepare that model. Your current chat model is unchanged. Check model setup and try again.';
          // The POST may have reached the server even if its response was lost.
          // Recover its real job state so progress and cancellation stay usable.
          this.requestModelSetup(false, false, catalogId);
          return;
        }
        this.setupError = 'CodeMe could not check model setup. Make sure the local backend is running, then reconnect.';
        this.connection = 'offline';
        this.connectionDetail = this.setupError;
      },
    });
  }

  loadConversations(): void {
    this.loadingConversations = true;
    const requestId = ++this.conversationLoadId;
    this.api.listConversations().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: conversations => { if (requestId !== this.conversationLoadId) return; this.conversations = conversations;
        if (this.activeConversation) this.activeConversation = conversations.find(item => item.id === this.activeConversation?.id) || this.activeConversation;
        this.loadingConversations = false; },
      error: () => { if (requestId !== this.conversationLoadId) return; this.error = 'Could not load conversation history. Check the local backend and retry.'; this.loadingConversations = false; },
    });
  }

  createConversation(): void {
    if (this.creating) return;
    this.saveDraft();
    this.stopGeneration(false);
    this.messageLoadId++;
    this.activeConversation = null;
    this.messages = [];
    this.loadingMessages = false;
    this.inputText = this.drafts.get('new') || '';
    this.error = null;
    this.notice = '';
    this.sidebarOpen = false;
    this.followStream = true;
    this.showJumpToLatest = false;
    this.composer?.nativeElement.focus();
  }

  selectConversation(conversation: ConversationSummary): void {
    if (this.creating || this.activeConversation?.id === conversation.id) { this.sidebarOpen = false; return; }
    this.saveDraft();
    this.stopGeneration(false);
    const requestId = ++this.messageLoadId;
    this.activeConversation = conversation;
    this.messages = [];
    this.inputText = this.drafts.get(conversation.id) || '';
    this.error = null;
    this.notice = '';
    this.loadingMessages = true;
    this.sidebarOpen = false;
    this.followStream = true;
    this.showJumpToLatest = false;
    this.api.getMessages(conversation.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: messages => {
        if (requestId !== this.messageLoadId) return;
        this.messages = messages.filter(message => message.role === 'user' || message.role === 'assistant');
        this.loadingMessages = false;
        this.pendingScroll = true;
      },
      error: () => {
        if (requestId !== this.messageLoadId) return;
        this.error = 'Could not load this conversation. Select it again to retry.';
        this.loadingMessages = false;
        this.activeConversation = null;
      },
    });
  }

  rememberDraft(): void {
    this.saveDraft();
  }

  private saveDraft(): void {
    const key = this.activeConversation?.id || 'new';
    this.drafts.delete(key);
    if (this.inputText) this.drafts.set(key, this.inputText.slice(0, 100000));
    while (this.drafts.size > 20) this.drafts.delete(this.drafts.keys().next().value!);
    if (!this.api.isBrowser) return;
    try {
      // Session storage survives navigation/reload without keeping source drafts permanently.
      const entries = [...this.drafts.entries()].reverse();
      let remaining = 200000;
      const bounded = entries.filter(([, value]) => { remaining -= value.length; return remaining >= 0; }).reverse();
      sessionStorage.setItem(this.draftStorageKey, JSON.stringify(bounded));
    } catch { /* In-memory drafts still work when browser storage is unavailable. */ }
  }

  private get draftStorageKey(): string {
    return 'codeme:drafts:v1:' + this.api.chatStreamUrl(0);
  }

  private restoreDrafts(): void {
    try {
      const entries: unknown = JSON.parse(sessionStorage.getItem(this.draftStorageKey) || '[]');
      if (!Array.isArray(entries)) return;
      for (const entry of entries.slice(-20)) {
        if (!Array.isArray(entry) || entry.length !== 2) continue;
        const [key, value] = entry;
        if ((key === 'new' || typeof key === 'number' && Number.isSafeInteger(key) && key > 0)
          && typeof value === 'string' && value.length <= 100000) this.drafts.set(key, value);
      }
      this.inputText = this.drafts.get('new') || '';
    } catch { /* Invalid/private-mode storage must not stop chat startup. */ }
  }

  get modelCapabilityNotice(): string {
    return this.modelSetup?.state === 'ready' && this.modelSetup.model === this.model && this.modelSetup.tool_support === 'unsupported'
      ? 'Chat is ready. Agent tasks in VS Code require a model that supports tools.' : '';
  }

  startRename(conversation: ConversationSummary): void {
    this.renameId = conversation.id;
    this.renameTitle = conversation.title;
    this.deleteId = null;
  }

  renameConversation(conversation: ConversationSummary): void {
    const title = this.renameTitle.trim();
    if (!title || this.conversationBusy) return;
    this.conversationBusy = true;
    this.api.renameConversation(conversation.id, title).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: updated => {
        this.conversations = this.conversations.map(item => item.id === updated.id ? updated : item);
        if (this.activeConversation?.id === updated.id) this.activeConversation = updated;
        this.renameId = null;
        this.conversationBusy = false;
      },
      error: () => { this.error = 'Could not rename this conversation.'; this.conversationBusy = false; },
    });
  }

  deleteConversation(conversation: ConversationSummary): void {
    if (this.conversationBusy || this.creating || (this.streaming && this.activeConversation?.id === conversation.id)) return;
    this.conversationBusy = true;
    this.api.deleteConversation(conversation.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.conversations = this.conversations.filter(item => item.id !== conversation.id);
        this.drafts.delete(conversation.id);
        if (this.activeConversation?.id === conversation.id) { this.inputText = ''; this.createConversation(); }
        else this.saveDraft();
        this.deleteId = null;
        this.conversationBusy = false;
      },
      error: () => { this.error = 'Could not delete this conversation.'; this.conversationBusy = false; },
    });
  }

  usePrompt(prompt: string): void {
    this.inputText = prompt;
    this.composer?.nativeElement.focus();
  }

  onComposerKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      if (this.canSend) void this.sendMessage();
    }
  }

  onMessagesScroll(): void {
    const element = this.messageList?.nativeElement;
    if (!element) return;
    this.followStream = element.scrollHeight - element.scrollTop - element.clientHeight < 100;
    this.showJumpToLatest = !this.followStream;
  }

  jumpToLatest(): void {
    this.followStream = true;
    this.showJumpToLatest = false;
    this.pendingScroll = true;
  }

  async copyMessage(message: MessageRead): Promise<void> {
    try { await navigator.clipboard.writeText(message.content); this.notice = 'Response copied.'; }
    catch { this.notice = 'Clipboard unavailable. Select the response text to copy it.'; }
  }

  stopGeneration(showNotice = true): void {
    if (!this.abortController) return;
    const controller = this.abortController;
    this.abortController = null;
    controller.abort();
    this.messages = this.messages.filter(message => message.id !== this.streamingMessageId || !!message.content);
    this.streamingMessageId = null;
    this.streaming = false;
    if (showNotice) this.notice = 'Response stopped. Your partial response is kept.';
  }

  async sendMessage(): Promise<void> {
    if (!this.canSend) return;
    const content = this.inputText.trim();
    if (content.length > 100000) {
      this.error = 'Keep your message below 100,000 characters. Your draft is still in the composer.';
      return;
    }
    this.error = null;
    this.notice = '';
    if (!this.activeConversation) {
      this.creating = true;
      try {
        const conversation = await firstValueFrom(this.api.createConversation().pipe(takeUntilDestroyed(this.destroyRef)));
        if (this.destroyed) return;
        this.conversations = [conversation, ...this.conversations];
        this.activeConversation = conversation;
        this.messages = [];
        this.drafts.delete('new');
      } catch {
        if (!this.destroyed) this.error = 'Could not start a conversation. Your message is still in the composer.';
        return;
      } finally { this.creating = false; }
    }
    if (this.destroyed || !this.activeConversation) return;
    const conversationId = this.activeConversation.id;
    const now = new Date().toISOString();
    const userMessage: MessageRead = { id: this.nextMessageId--, role: 'user', content, created_at: now };
    let assistantMessage: MessageRead = { id: this.nextMessageId--, role: 'assistant', content: '', created_at: now };
    this.messages = [...this.messages, userMessage, assistantMessage];
    this.streamingMessageId = assistantMessage.id;
    this.inputText = '';
    this.drafts.delete(conversationId);
    this.saveDraft();
    this.streaming = true;
    this.jumpToLatest();
    const controller = new AbortController();
    this.abortController = controller;
    const isCurrent = () => !this.destroyed && this.abortController === controller && this.activeConversation?.id === conversationId;
    const request: ChatRequest = { model: this.model, messages: [{ role: 'user', content }] };
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timedOut = false;
    let streamTimer: ReturnType<typeof setTimeout> | undefined;
    const resetStreamTimeout = () => {
      if (streamTimer) clearTimeout(streamTimer);
      streamTimer = setTimeout(() => { timedOut = true; controller.abort(); }, 180000);
    };
    resetStreamTimeout();
    try {
      const response = await fetch(this.api.chatStreamUrl(conversationId), {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify(request), signal: controller.signal, redirect: 'error',
      });
      if (!response.ok) {
        const failure = await response.json().catch(() => null);
        throw new Error(typeof failure?.detail === 'string' ? failure.detail : 'The local backend could not start a response (' + response.status + ').');
      }
      reader = response.body?.getReader();
      if (!reader) throw new Error('The local backend did not provide a response stream.');
      const decoder = new TextDecoder();
      const parser = new SseParser();
      let completed = false;
      const handleEvent = (event: SseEvent): void => {
        if (completed || !isCurrent()) return;
        if (event.event === 'done' || event.data === '[DONE]') { completed = true; return; }
        const decoded = JSON.parse(event.data) as string | { error?: string };
        if (event.event === 'error' || typeof decoded !== 'string') {
          throw new Error(typeof decoded === 'object' && decoded?.error ? decoded.error : 'Unexpected response from the local backend.');
        }
        assistantMessage = { ...assistantMessage, content: assistantMessage.content + decoded };
        this.messages = this.messages.map(message => message.id === assistantMessage.id ? assistantMessage : message);
        this.pendingScroll = this.followStream;
      };
      while (!completed && isCurrent()) {
        const chunk = await reader.read();
        if (chunk.done) break;
        resetStreamTimeout();
        parser.feed(decoder.decode(chunk.value, { stream: true })).forEach(handleEvent);
      }
      if (isCurrent() && !completed) {
        parser.feed(decoder.decode()).forEach(handleEvent);
        parser.finish().forEach(handleEvent);
        if (!completed) throw new Error('The response ended before completion. The partial response is kept; you can try again.');
      }
      if (isCurrent()) this.loadConversations();
    } catch (failure) {
      if (isCurrent() && timedOut) this.error = 'The local model did not respond for three minutes. Your partial reply is kept; check the model server and retry.';
      else if (isCurrent() && !controller.signal.aborted) this.error = failure instanceof Error ? failure.message : 'Could not connect to the local backend.';
    } finally {
      if (streamTimer) clearTimeout(streamTimer);
      if (reader) { try { await reader.cancel(); } catch { /* The network may already be closed. */ } reader.releaseLock(); }
      if (isCurrent()) {
        this.streaming = false;
        this.abortController = null;
        this.streamingMessageId = null;
        if (!assistantMessage.content) this.messages = this.messages.filter(message => message.id !== assistantMessage.id);
        this.composer?.nativeElement.focus();
      }
    }
  }
}
