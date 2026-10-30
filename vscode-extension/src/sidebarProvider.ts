import * as path from 'path';
import * as vscode from 'vscode';
import { AgentEvent, AgentRun, BackendClient } from './backendClient';
import { ContextReferenceResolver } from './contextResolver';
import { webviewHtml } from './webviewHtml';
import { ChangeSet } from './changeSet';
import { ChangeSetManager } from './changeSetManager';
import { CommandPolicyDecision, CommandRun } from './commandRun';
import { CommandPolicyError, evaluateCommandPolicy } from './commandPolicy';
import { ControlledProcessRunner } from './processRunner';
import { VerificationMode, VerificationSession, verificationTerminalStates } from './verification';
import { ModelSetupMonitor } from './modelSetupMonitor';

interface WebviewMessage {
  command: string;
  payload: unknown;
}

interface ChatRequestArgs {
  prompt: string;
  requestId?: string;
  conversationId?: number | null;
  model?: string;
  context?: Array<{ label: string; kind: string; content: string; language?: string }>;
  mode?: 'ask' | 'agent';
}

export class PersonalCodexSidebarProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private webviewReady = false;
  private modelSetupMonitor?: ModelSetupMonitor;
  private modelCapabilityGeneration = 0;
  private pendingMessages: WebviewMessage[] = [];
  private currentWorkspaceId?: number;
  private chatGeneration = 0;
  private conversationLoadGeneration = 0;
  private activeChat?: { requestId?: string; conversationId: number | null; runId?: string; cancelled?: boolean };
  private selectedConversationId?: number;
  private readonly agentRuns = new Map<number, AgentRun>();
  private readonly continuingAgentRuns = new Set<string>();
  private readonly pendingTaskContinuations = new Map<string, number>();
  private readonly cancelledAgentRuns = new Set<string>();
  private readonly cancellingAgentRuns = new Set<string>();
  private readonly taskActiveCommands = new Map<string, { runId: string; conversationId: number }>();
  private readonly taskVerificationOwners = new Map<string, { runId: string; generation: number }>();
  private historyGeneration = 0;
  private conversationQuery = '';
  private readonly proposedDocuments = new Map<string, string>();
  private readonly legacyChangeSets = new Map<string, ChangeSet>();
  private readonly commandPolicies = new Map<string, CommandPolicyDecision>();
  private readonly changeSetManager: ChangeSetManager;
  private readonly processRunner: ControlledProcessRunner;
  private readonly activeVerificationCommands = new Map<string, string>();
  private readonly executingVerifications = new Set<string>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly backend: BackendClient,
    private readonly resolver: ContextReferenceResolver
  ) {
    this.changeSetManager = new ChangeSetManager(context);
    const configuration = vscode.workspace.getConfiguration('personalCodex');
    this.processRunner = new ControlledProcessRunner({
      displayLimitBytes: configuration.get('commandOutputLimitBytes', 1_048_576),
      tailLimitBytes: configuration.get('commandTailLimitBytes', 65_536),
    });
    this.context.subscriptions.push({ dispose: () => { this.modelSetupMonitor?.stop(); this.cancelActiveChat(); this.processRunner.dispose(); } });
    this.context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('codeme-proposed', {
      provideTextDocumentContent: (uri) => this.proposedDocuments.get(uri.toString()) || '',
    }));
  }

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    this.webviewReady = false;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
      ],
    };
    webviewView.webview.html = webviewHtml(webviewView.webview, this.context.extensionUri);
    this.context.subscriptions.push(
      webviewView.webview.onDidReceiveMessage((data) => {
        void this.handleMessage(data).catch((error: unknown) => this.send({
          command: 'operationError', payload: { message: error instanceof Error ? error.message : String(error) },
        }));
      }),
      webviewView.onDidDispose(() => {
        this.modelSetupMonitor?.stop();
        this.cancelActiveChat();
        this.view = undefined;
        this.webviewReady = false;
      })
    );
  }

  private cancelActiveChat(notify = false, cancelTask = false): void {
    const active = this.activeChat;
    this.chatGeneration += 1;
    this.conversationLoadGeneration += 1;
    this.activeChat = undefined;
    this.backend.cancel();
    if (cancelTask && active) {
      active.cancelled = true;
      if (active.runId) void this.cancelTask(active.runId);
    }
    if (notify && active) void this.send({ command: 'streamStopped', payload: active });
  }

  public async workspaceChanged(): Promise<void> {
    this.cancelActiveChat(true);
    this.currentWorkspaceId = undefined;
    await this.syncActiveWorkspaceRegistration();
    await this.refreshWorkspaceState();
  }

  public async reveal(): Promise<void> {
    if (!this.view) {
      await vscode.commands.executeCommand('workbench.view.extension.personalCodeme');
    }
    this.view?.show?.(true);
  }

  public async createNewChat(): Promise<void> {
    this.cancelActiveChat();
    this.selectedConversationId = undefined;
    await this.reveal();
    await this.send({ command: 'newChat', payload: {} });
  }

  public async handleSelectionCommand(action: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      void vscode.window.showWarningMessage('Select code before running this action.');
      return;
    }
    const selection = await this.resolver.resolveSelection(editor);
    await this.reveal();
    await this.send({
      command: 'contextAction',
      payload: {
        action,
        context: {
          kind: 'selection',
          label: `${path.basename(selection.filePath)} · selected code`,
          detail: selection.filePath,
          content: selection.text,
          language: selection.language,
        },
      },
    });
  }

  public async handleFileCommand(action: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showWarningMessage('Open a file first.');
      return;
    }
    const file = await this.resolver.resolveFile(editor);
    await this.reveal();
    await this.send({
      command: 'contextAction',
      payload: {
        action,
        context: {
          kind: 'file',
          label: path.basename(file.filePath),
          detail: file.filePath,
          content: file.text,
          language: file.language,
        },
      },
    });
  }

  public async reviewChanges(): Promise<void> {
    const workspace = this.getActiveWorkspaceFolder();
    if (!workspace) {
      void vscode.window.showWarningMessage('Open a workspace folder first.');
      return;
    }
    const diff = await this.resolver.resolveGitDiff(workspace);
    await this.reveal();
    await this.send({
      command: 'contextAction',
      payload: {
        action: 'reviewChanges',
        context: {
          kind: 'changes',
          label: diff.branch ? `Changes on ${diff.branch}` : 'Working tree changes',
          detail: workspace.uri.fsPath,
          content: diff.changes,
          language: 'diff',
        },
      },
    });
  }

  public async registerWorkspace(): Promise<void> {
    const folder = this.getActiveWorkspaceFolder();
    if (!folder) {
      void vscode.window.showWarningMessage('Open a workspace folder first.');
      return;
    }
    const accept = await vscode.window.showInformationMessage(
      `Register '${folder.name}' with CodeMe?`,
      'Register',
      'Cancel'
    );
    if (accept !== 'Register') {
      return;
    }
    const workspaceId = await this.backend.registerWorkspace(folder.uri.fsPath, folder.name);
    this.currentWorkspaceId = workspaceId;
    await this.context.workspaceState.update(this.workspaceConsentKey(folder), true);
    await this.send({ command: 'workspaceRegistered', payload: { workspaceId, rootPath: folder.uri.fsPath } });
    await this.refreshWorkspaceState();
  }

  public async startBackend(): Promise<void> {
    try {
      await this.backend.checkConnection(false);
      void vscode.window.showInformationMessage('CodeMe backend is already running.');
      await this.refreshBackendStatus(false);
      return;
    } catch {
      // Continue and launch the configured workspace task.
    }

    const tasks = await vscode.tasks.fetchTasks();
    const backendTask = tasks.find((task) => task.name === 'Run Codeme API');
    if (!backendTask) {
      void vscode.window.showInformationMessage("Run python start.py --backend-only from your CodeMe installation folder, then check the connection. For first-time setup, run python install.py.");
      return;
    }
    await vscode.tasks.executeTask(backendTask);
    void vscode.window.showInformationMessage('Starting the CodeMe backend…');
    setTimeout(() => void this.refreshBackendStatus(false), 2500);
  }

  public async refreshWorkspaceState(): Promise<void> {
    const folder = this.getActiveWorkspaceFolder();
    await this.send({
      command: 'workspaceState',
      payload: {
        workspace: folder?.name ?? null,
        rootPath: folder?.uri.fsPath ?? null,
        folders: vscode.workspace.workspaceFolders?.length ?? 0,
        workspaceId: this.currentWorkspaceId ?? null,
        registered: Boolean(this.currentWorkspaceId),
      },
    });
  }

  public async updateConfiguration(): Promise<void> {
    this.modelCapabilityGeneration++;
    this.modelSetupMonitor?.stop();
    this.backend.updateSettings(vscode.workspace.getConfiguration('personalCodex'));
    if (this.webviewReady) {
      await this.initialize();
    }
  }

  private getActiveWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
    return vscode.workspace.workspaceFolders?.[0];
  }

  private async initialize(conversationId?: number | null): Promise<void> {
    await this.refreshBackendStatus(false);
    await this.syncActiveWorkspaceRegistration();
    const autoRegister = vscode.workspace.getConfiguration('personalCodex').get('autoRegisterWorkspace', false);
    if (!this.currentWorkspaceId && autoRegister) {
      await this.requestWorkspaceRegistration();
    }
    await Promise.all([this.refreshWorkspaceState(), this.refreshConversations()]);
    await this.recoverVerificationSessions();
    if (conversationId) {
      await this.loadConversation(conversationId);
    }
  }

  private workspaceConsentKey(folder: vscode.WorkspaceFolder): string {
    return `personalCodex.workspaceRegistrationConsent:${folder.uri.toString()}`;
  }

  private async syncActiveWorkspaceRegistration(): Promise<void> {
    const folder = this.getActiveWorkspaceFolder();
    if (!folder) {
      this.currentWorkspaceId = undefined;
      return;
    }
    try {
      const normalizedRoot = path.resolve(folder.uri.fsPath).toLowerCase();
      const existing = (await this.backend.listWorkspaces()).find(
        (item) => item.root_path && path.resolve(item.root_path).toLowerCase() === normalizedRoot
      );
      this.currentWorkspaceId = existing?.id;
    } catch {
      this.currentWorkspaceId = undefined;
    }
  }

  private async requestWorkspaceRegistration(): Promise<boolean> {
    const folder = this.getActiveWorkspaceFolder();
    if (!folder) return false;
    const rememberedConsent = this.context.workspaceState.get<boolean>(this.workspaceConsentKey(folder), false);
    if (!rememberedConsent) {
      const choice = await vscode.window.showInformationMessage(
        `CodeMe needs permission to register '${folder.name}' before Agent mode can inspect it.`,
        { modal: true },
        'Register workspace'
      );
      if (choice !== 'Register workspace') return false;
      await this.context.workspaceState.update(this.workspaceConsentKey(folder), true);
    }
    try {
      this.currentWorkspaceId = await this.backend.registerWorkspace(folder.uri.fsPath, folder.name);
      await this.send({ command: 'workspaceRegistered', payload: { workspaceId: this.currentWorkspaceId, rootPath: folder.uri.fsPath } });
      await this.refreshWorkspaceState();
      return true;
    } catch (error) {
      await this.send({ command: 'operationError', payload: { message: (error as Error).message } });
      return false;
    }
  }

  private async refreshBackendStatus(userTriggered: boolean): Promise<void> {
    // Setup status stays reachable while the daemon/model is being prepared.
    // A provider's 503 readiness response must not label the API itself offline.
    await this.setupMonitor().refresh();
  }

  private setupMonitor(): ModelSetupMonitor {
    if (!this.modelSetupMonitor) this.modelSetupMonitor = new ModelSetupMonitor(this.backend, async (status) => {
      // One snapshot keeps setup, readiness, and model selection in the same generation.
      await this.send({ command: 'modelSetupStatus', payload: status });
    }, async (error) => {
      await this.send({ command: 'backendStatus', payload: {
        online: false, models: [], ollama: false, error: error.message,
      } });
    });
    return this.modelSetupMonitor;
  }

  private async refreshConversations(query?: string): Promise<void> {
    const generation = ++this.historyGeneration;
    if (query !== undefined) this.conversationQuery = query;
    try {
      const conversations = await this.backend.listConversations(this.conversationQuery);
      if (generation !== this.historyGeneration) return;
      await this.send({ command: 'conversationsUpdated', payload: conversations });
    } catch (error) {
      console.warn('Unable to load CodeMe conversations.', error);
    }
  }

  private async loadConversation(conversationId: number): Promise<void> {
    const generation = ++this.conversationLoadGeneration;
    this.selectedConversationId = conversationId;
    try {
      const [messages, runs] = await Promise.all([
        this.backend.getConversationMessages(conversationId),
        this.backend.listAgentRuns?.(conversationId).catch(() => []) || Promise.resolve([]),
      ]);
      if (generation !== this.conversationLoadGeneration) return;
      const run = runs.sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
      if (run) this.agentRuns.set(conversationId, run);
      await this.send({ command: 'conversationLoaded', payload: { conversationId, messages } });
      if (run) {
        await this.send({ command: 'agentRunUpdated', payload: run });
        await this.restoreTaskProposals(run, generation);
      }
    } catch (error) {
      if (generation !== this.conversationLoadGeneration) return;
      await this.send({ command: 'operationError', payload: { message: (error as Error).message } });
    }
  }

  private async restoreTaskProposals(run: AgentRun, generation: number): Promise<void> {
    const changes = await Promise.allSettled(run.pending_change_set_ids.map((id) => this.backend.getChangeSet(id)));
    const commands = await Promise.allSettled(run.pending_command_run_ids.map((id) => this.backend.getCommandRun(id)));
    if (generation !== this.conversationLoadGeneration || this.selectedConversationId !== run.conversation_id) return;
    for (const result of changes) if (result.status === 'fulfilled') {
      await this.send({ command: 'agentProposalRecovered', payload: { conversationId: run.conversation_id, changeSet: result.value } });
    }
    for (const result of commands) if (result.status === 'fulfilled') {
      await this.prepareCommandProposalEvent(run.conversation_id, result.value, undefined, this.chatGeneration, true);
    }
  }

  private taskForAction(conversationId: number, actionId?: string): AgentRun | undefined {
    const run = this.agentRuns.get(conversationId);
    if (!run || run.workspace_id !== this.currentWorkspaceId || this.selectedConversationId !== conversationId) return undefined;
    if (['completed', 'cancelled', 'exhausted'].includes(run.status)) return undefined;
    if (actionId && !run.pending_change_set_ids.includes(actionId) && !run.pending_command_run_ids.includes(actionId)) return undefined;
    return run;
  }

  private ownsTask(runId: string, conversationId: number, generation: number): boolean {
    return !this.cancelledAgentRuns.has(runId) && generation === this.chatGeneration && this.selectedConversationId === conversationId
      && this.agentRuns.get(conversationId)?.id === runId;
  }

  private acceptAgentEvent(event: AgentEvent, conversationId: number, requestId: string | undefined, generation: number,
    active = this.activeChat): void {
    if (event.type === 'task') {
      if (active) active.runId = event.run.id;
      if (active?.cancelled) { void this.cancelTask(event.run.id); return; }
    }
    if (generation !== this.chatGeneration) return;
    if (event.type === 'task') this.agentRuns.set(conversationId, event.run);
    if (event.type === 'proposal' && event.kind === 'verification_plan') {
      const runId = active?.runId || this.agentRuns.get(conversationId)?.id;
      if (runId) this.taskVerificationOwners.set(event.verification_session.id, { runId, generation });
      void this.publishVerification(event.verification_session).catch((error: Error) => {
        if (generation === this.chatGeneration) void this.send({ command: 'operationError', payload: { message: error.message } });
      });
      return;
    }
    if (event.type === 'proposal' && event.kind === 'file_change' && event.change_set) this.legacyChangeSets.set(event.path, event.change_set);
    if (event.type === 'proposal' && event.kind === 'command_proposal') {
      void this.prepareCommandProposalEvent(conversationId, event.command_run, requestId, generation);
      return;
    }
    void this.send({ command: 'agentEvent', payload: { conversationId, requestId, event } });
  }

  private async cancelTask(runId: string): Promise<void> {
    if (this.cancellingAgentRuns.has(runId)) return;
    this.cancellingAgentRuns.add(runId);
    this.cancelledAgentRuns.add(runId);
    this.pendingTaskContinuations.delete(runId);
    const known = [...this.agentRuns.values()].find((item) => item.id === runId);
    try {
      for (const [commandId, owner] of this.taskActiveCommands) {
        if (owner.runId === runId && (!known || owner.conversationId === known.conversation_id)) await this.processRunner.cancel(commandId);
      }
      if (known && this.backend.listVerificationSessions) {
        const sessions = await this.backend.listVerificationSessions(known.workspace_id, true).catch(() => []);
        for (const session of sessions) {
          if (session.conversation_id === known.conversation_id && session.source_change_set_id
            && known.pending_change_set_ids.includes(session.source_change_set_id)) {
            this.taskVerificationOwners.set(session.id, { runId, generation: this.chatGeneration });
          }
        }
      }
      for (const [sessionId, owner] of this.taskVerificationOwners) {
        if (owner.runId !== runId) continue;
        this.taskVerificationOwners.delete(sessionId);
        await this.cancelVerification(sessionId);
      }
      const run = await this.backend.cancelAgentRun(runId);
      const current = this.agentRuns.get(run.conversation_id);
      if (!current || current.id === runId) this.agentRuns.set(run.conversation_id, run);
      await this.send({ command: 'agentRunUpdated', payload: run });
    } catch (error) {
      await this.send({ command: 'operationError', payload: { message: `Unable to cancel task: ${(error as Error).message}` } });
    } finally {
      this.cancellingAgentRuns.delete(runId);
    }
  }

  private async continueTask(runId: string, requestId?: string, automatic = false, ownerGeneration = this.chatGeneration): Promise<void> {
    const stopResume = async (message: string, conversationId = this.selectedConversationId): Promise<void> => {
      if (automatic) return;
      if (requestId) await this.send({ command: 'streamStopped', payload: { conversationId, requestId } });
      await this.send({ command: 'taskNotice', payload: { conversationId, message } });
    };
    if (this.continuingAgentRuns.has(runId) || this.activeChat) {
      if (automatic && this.activeChat?.runId === runId) this.pendingTaskContinuations.set(runId, ownerGeneration);
      await stopResume('A local request is already running. Wait for it to finish before resuming.');
      return;
    }
    const known = [...this.agentRuns.values()].find((item) => item.id === runId);
    if (!automatic && known && this.selectedConversationId === known.conversation_id && ownerGeneration === this.chatGeneration) this.cancelledAgentRuns.delete(runId);
    if (!known || !this.ownsTask(runId, known.conversation_id, ownerGeneration) || known.workspace_id !== this.currentWorkspaceId) {
      await stopResume('Reload this conversation and register its workspace before resuming the saved task.');
      return;
    }
    this.continuingAgentRuns.add(runId);
    try {
      const run = await this.backend.getAgentRun(runId);
      if (!this.ownsTask(runId, run.conversation_id, ownerGeneration)) return;
      this.agentRuns.set(run.conversation_id, run);
      await this.send({ command: 'agentRunUpdated', payload: run });
      if (['completed', 'cancelled', 'exhausted'].includes(run.status)) {
        await stopResume(run.summary || `Task is ${run.status}.`, run.conversation_id);
        return;
      }
      if (automatic && ['interrupted', 'blocked'].includes(run.status)) return;
      if (run.model && this.backend.getModelCapabilities) {
        const capabilities = await this.backend.getModelCapabilities(run.model);
        if (!this.ownsTask(runId, run.conversation_id, ownerGeneration)) return;
        if (capabilities.agent_ready === false) {
          await stopResume('This task model does not support Agent tools. Start a new task with a tool-capable local model.', run.conversation_id);
          return;
        }
      }
      const generation = this.chatGeneration;
      const active = { requestId, conversationId: run.conversation_id, runId };
      this.activeChat = active;
      await this.send({ command: 'streamStarted', payload: active });
      await this.backend.continueAgentRun(runId,
        (event) => this.acceptAgentEvent(event, run.conversation_id, requestId, generation, active),
        () => { if (generation === this.chatGeneration) void this.send({ command: 'streamComplete', payload: active }); },
        (error) => {
          if (generation !== this.chatGeneration) return;
          if (error.message.includes('409')) {
            void this.send({ command: 'streamStopped', payload: active });
            void this.send({ command: 'taskNotice', payload: { conversationId: run.conversation_id, message: 'Review pending changes, commands, or the verification plan before resuming.' } });
          } else void this.send({ command: error.name === 'AbortError' ? 'streamStopped' : 'streamError', payload: { ...active, message: error.message } });
        });
      if (generation === this.chatGeneration) this.activeChat = undefined;
    } catch (error) {
      if (this.ownsTask(runId, known.conversation_id, ownerGeneration)) {
        this.activeChat = undefined;
        await this.send({ command: 'streamError', payload: { conversationId: known.conversation_id, requestId, message: (error as Error).message } });
      }
    } finally {
      this.continuingAgentRuns.delete(runId);
      void this.drainTaskContinuation();
    }
  }

  private async drainTaskContinuation(): Promise<void> {
    if (this.activeChat) return;
    const pending = this.pendingTaskContinuations?.entries().next().value;
    if (!pending) return;
    this.pendingTaskContinuations.delete(pending[0]);
    await this.continueTask(pending[0], undefined, true, pending[1]);
  }

  private async send(message: WebviewMessage): Promise<void> {
    if (!this.view || !this.webviewReady) {
      this.pendingMessages.push(message);
      return;
    }
    await this.view.webview.postMessage(message);
  }

  private async flushPendingMessages(): Promise<void> {
    const pending = this.pendingMessages.splice(0);
    for (const message of pending) {
      await this.send(message);
    }
  }

  private async handleMessage(data: unknown): Promise<void> {
    const message = data as { command?: string; args?: Record<string, unknown> };
    if (!message.command) {
      return;
    }

    switch (message.command) {
      case 'ready': {
        this.webviewReady = true;
        const conversationId = typeof message.args?.conversationId === 'number' ? message.args.conversationId : null;
        await this.initialize(conversationId);
        await this.flushPendingMessages();
        break;
      }
      case 'healthCheck':
        await this.refreshBackendStatus(true);
        break;
      case 'setupModel':
        await this.setupMonitor().refresh('start');
        break;
      case 'getModelCatalog': {
        const requestId = message.args?.requestId;
        try {
          await this.send({ command: 'modelCatalog', payload: { catalog: await this.backend.getModelCatalog(), requestId } });
        } catch (error) {
          await this.send({ command: 'modelCatalogError', payload: { message: (error as Error).message, requestId } });
        }
        break;
      }
      case 'chooseCatalogModel': {
        const catalogId = message.args?.catalogId;
        if (typeof catalogId !== 'string' || !/^[a-z0-9-]{1,80}$/.test(catalogId)) {
          await this.send({ command: 'modelCatalogActionDone', payload: { error: 'Choose a model from the catalog.' } });
          break;
        }
        const monitor = this.setupMonitor();
        monitor.stop();
        try {
          const status = await this.backend.startModelSetup(catalogId);
          await this.send({ command: 'modelSetupStatus', payload: status });
          await this.send({ command: 'modelCatalogActionDone', payload: {} });
        } catch (error) {
          await this.send({ command: 'modelCatalogActionDone', payload: { error: (error as Error).message } });
        }
        // A catalog rejection does not make the existing backend/model offline.
        await monitor.refresh();
        break;
      }
      case 'cancelModelSetup':
        await this.setupMonitor().refresh('cancel');
        break;
      case 'checkModelCapabilities': {
        const model = message.args?.model;
        const requestId = message.args?.requestId;
        if (typeof model !== 'string' || model.length > 250) break;
        const generation = ++this.modelCapabilityGeneration;
        try {
          const capabilities = await this.backend.getModelCapabilities(model);
          if (generation === this.modelCapabilityGeneration) await this.send({ command: 'modelCapabilities', payload: { ...capabilities, requestId } });
        } catch (error) {
          if (generation === this.modelCapabilityGeneration) await this.send({ command: 'modelCapabilityError', payload: { model, requestId, message: (error as Error).message } });
        }
        break;
      }
      case 'startChat':
        await this.handleChatRequest(message.args as unknown as ChatRequestArgs);
        break;
      case 'cancelStream':
        this.cancelActiveChat(true, true);
        break;
      case 'abandonChat':
        this.cancelActiveChat();
        this.selectedConversationId = undefined;
        break;
      case 'resumeAgentRun':
        if (typeof message.args?.runId === 'string') await this.continueTask(message.args.runId, typeof message.args.requestId === 'string' ? message.args.requestId : undefined);
        break;
      case 'cancelAgentRun':
        if (typeof message.args?.runId === 'string') {
          if (this.activeChat?.runId === message.args.runId) this.cancelActiveChat(true);
          await this.cancelTask(message.args.runId);
        }
        break;
      case 'registerWorkspace':
        await this.registerWorkspace();
        break;
      case 'loadConversation':
        this.cancelActiveChat();
        if (typeof message.args?.conversationId === 'number') {
          await this.loadConversation(message.args.conversationId);
        }
        break;
      case 'deleteConversation':
        if (typeof message.args?.conversationId === 'number') {
          if (this.activeChat?.conversationId === message.args.conversationId) this.cancelActiveChat(true);
          await this.backend.deleteConversation(message.args.conversationId);
          await this.send({ command: 'conversationDeleted', payload: { conversationId: message.args.conversationId } });
          await this.refreshConversations();
        }
        break;
      case 'renameConversation':
        if (typeof message.args?.conversationId === 'number' && typeof message.args?.title === 'string') {
          await this.backend.renameConversation(message.args.conversationId, message.args.title.trim());
          await this.refreshConversations();
        }
        break;
      case 'searchConversations':
        await this.refreshConversations(typeof message.args?.query === 'string' ? message.args.query : undefined);
        break;
      case 'requestContext':
        await this.handleContextRequest(String(message.args?.kind || ''));
        break;
      case 'copyText':
        if (typeof message.args?.text === 'string') {
          await vscode.env.clipboard.writeText(message.args.text);
        }
        break;
      case 'openCode':
        if (typeof message.args?.text === 'string') {
          const targetPath = typeof message.args?.path === 'string' ? message.args.path : undefined;
          await this.openGeneratedCode(message.args.text, targetPath, typeof message.args?.language === 'string' ? message.args.language : undefined);
        }
        break;
      case 'applyCode':
        if (typeof message.args?.text === 'string') {
          await this.applyCodeToEditor(message.args.text, typeof message.args?.path === 'string' ? message.args.path : undefined);
        }
        break;
      case 'applyFileChange':
        if (typeof message.args?.path === 'string' && typeof message.args?.content === 'string') {
          await this.applyFileChange(message.args.path, message.args.content, String(message.args?.explanation || ''));
        }
        break;
      case 'previewChangeSet':
        if (message.args?.changeSet) {
          await this.previewChangeSet(message.args.changeSet as unknown as ChangeSet);
        }
        break;
      case 'applyChangeSet':
        if (message.args?.changeSet) {
          await this.applyTaskChangeSet(message.args.changeSet as unknown as ChangeSet);
        }
        break;
      case 'rejectChangeSet':
        if (message.args?.changeSet) {
          await this.rejectChangeSet(message.args.changeSet as unknown as ChangeSet);
        }
        break;
      case 'restoreChangeSet':
        if (message.args?.changeSet) {
          await this.restoreChangeSet(message.args.changeSet as unknown as ChangeSet);
        }
        break;
      case 'previewFileChange':
        if (typeof message.args?.path === 'string' && typeof message.args?.content === 'string') {
          await this.previewFileChange(message.args.path, message.args.content);
        }
        break;
      case 'runProposedCommand':
        if (typeof message.args?.command === 'string') {
          await this.runProposedCommand(message.args.command, String(message.args?.explanation || ''));
        }
        break;
      case 'runCommandProposal':
        if (message.args?.commandRun) {
          await this.runControlledCommand(message.args.commandRun as unknown as CommandRun);
        }
        break;
      case 'rejectCommandProposal':
        if (message.args?.commandRun) {
          await this.rejectControlledCommand(message.args.commandRun as unknown as CommandRun);
        }
        break;
      case 'cancelCommandRun':
        if (typeof message.args?.commandRunId === 'string') {
          await this.processRunner.cancel(message.args.commandRunId);
        }
        break;
      case 'startVerification':
        if (typeof message.args?.conversationId === 'number') {
          await this.startVerification(
            message.args.conversationId,
            String(message.args.originalRequest || 'Verify the applied changes'),
            typeof message.args.sourceChangeSetId === 'string' ? message.args.sourceChangeSetId : undefined,
            message.args.mode === 'full' ? 'full' : 'quick',
          );
        }
        break;
      case 'approveVerification':
        if (typeof message.args?.sessionId === 'string') await this.approveVerification(message.args.sessionId);
        break;
      case 'rejectVerification':
        if (typeof message.args?.sessionId === 'string') await this.rejectVerification(message.args.sessionId);
        break;
      case 'cancelVerification':
        if (typeof message.args?.sessionId === 'string') await this.cancelVerification(message.args.sessionId);
        break;
      case 'previewVerificationRepair':
        if (typeof message.args?.changeSetId === 'string') await this.previewChangeSet(await this.backend.getChangeSet(message.args.changeSetId));
        break;
      case 'applyVerificationRepair':
        if (typeof message.args?.sessionId === 'string') await this.applyVerificationRepair(message.args.sessionId);
        break;
      case 'rejectVerificationRepair':
        if (typeof message.args?.sessionId === 'string') await this.rejectVerificationRepair(message.args.sessionId);
        break;
      case 'restoreVerificationRepair':
        if (typeof message.args?.sessionId === 'string') await this.restoreVerificationRepair(message.args.sessionId);
        break;
      case 'openSettings':
        await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:personal-codex-local.personal-codeme');
        break;
      case 'startBackend':
        await this.startBackend();
        break;
      default:
        console.warn('Unknown command from CodeMe webview:', message.command);
    }
  }

  private async handleContextRequest(kind: string): Promise<void> {
    if (kind === 'selection') {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        void vscode.window.showWarningMessage('Select code in the editor first.');
        return;
      }
      const selection = await this.resolver.resolveSelection(editor);
      await this.send({
        command: 'contextAdded',
        payload: {
          kind: 'selection',
          label: `${path.basename(selection.filePath)} · selection`,
          detail: selection.filePath,
          content: selection.text,
          language: selection.language,
        },
      });
      return;
    }

    if (kind === 'file') {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showWarningMessage('Open a file first.');
        return;
      }
      const file = await this.resolver.resolveFile(editor);
      await this.send({
        command: 'contextAdded',
        payload: {
          kind: 'file',
          label: path.basename(file.filePath),
          detail: file.filePath,
          content: file.text,
          language: file.language,
        },
      });
      return;
    }

    if (kind === 'changes') {
      const workspace = this.getActiveWorkspaceFolder();
      if (!workspace) {
        void vscode.window.showWarningMessage('Open a workspace folder first.');
        return;
      }
      const diff = await this.resolver.resolveGitDiff(workspace);
      await this.send({
        command: 'contextAdded',
        payload: {
          kind: 'changes',
          label: diff.branch ? `Changes on ${diff.branch}` : 'Working tree changes',
          detail: workspace.uri.fsPath,
          content: diff.changes,
          language: 'diff',
        },
      });
    }
  }

  private async handleChatRequest(args: ChatRequestArgs): Promise<void> {
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
    if (!prompt) return;
    this.cancelActiveChat();
    const generation = this.chatGeneration;
    let conversationId = args.conversationId || null;
    this.activeChat = { requestId: args.requestId, conversationId };
    this.selectedConversationId = conversationId || undefined;
    const active = this.activeChat;
    const sendCurrent = (command: string, detail: Record<string, unknown> = {}): void => {
      if (generation !== this.chatGeneration) return;
      void this.send({ command, payload: { conversationId, requestId: args.requestId, ...detail } });
    };
    try {
      if (prompt.length > 100_000) throw new Error('Keep the request below 100,000 characters. Attach a focused selection for context.');
      const contextText = (args.context || []).map((item) => {
        if (typeof item.content !== 'string') throw new Error('The attached context is invalid.');
        return 'Context: ' + item.label + ' (' + item.kind + ')\n\x60\x60\x60' + (item.language || 'text') + '\n' + item.content + '\n\x60\x60\x60';
      }).join('\n\n');
      if (contextText.length > 180_000) throw new Error('Attached context is too large. Remove a file or attach a smaller selection.');
      if (args.mode === 'agent' && args.model && this.backend.getModelCapabilities) {
        const capabilities = await this.backend.getModelCapabilities(args.model);
        if (generation !== this.chatGeneration) return;
        if (capabilities.agent_ready === false) throw new Error('This model supports chat but not Agent tools. Choose Ask mode or select a tool-capable local model.');
      }
      if (!conversationId) {
        const conversation = await this.backend.createConversation(this.createTitle(prompt));
        if (generation !== this.chatGeneration) return;
        conversationId = conversation.id;
        active.conversationId = conversationId;
        this.selectedConversationId = conversationId;
        sendCurrent('conversationCreated', { ...conversation });
      }
      sendCurrent('streamStarted');
      if (args.mode === 'agent') {
        if ((vscode.workspace.workspaceFolders?.length || 0) !== 1) {
          throw new Error('Open one workspace folder to use Agent mode. Ask mode works with explicitly attached context.');
        }
        await this.syncActiveWorkspaceRegistration();
        if (generation !== this.chatGeneration) return;
        if (!this.currentWorkspaceId) await this.requestWorkspaceRegistration();
        if (generation !== this.chatGeneration) return;
        if (!this.currentWorkspaceId) throw new Error('Register the workspace to let Agent mode inspect your local files.');
        await this.backend.streamAgent(conversationId, prompt, this.currentWorkspaceId, contextText || undefined, args.model,
          (event: AgentEvent) => this.acceptAgentEvent(event, conversationId!, args.requestId, generation, active),
          () => { sendCurrent('streamComplete'); void this.refreshConversations(); },
          (error) => { sendCurrent(error.name === 'AbortError' ? 'streamStopped' : 'streamError', { message: error.message }); void this.refreshConversations(); },
        );
      } else {
        const content = contextText ? prompt + '\n\n' + contextText : prompt;
        await this.backend.streamChat(conversationId, [{ role: 'user', content }], args.model,
          (chunk) => sendCurrent('streamChunk', { chunk }),
          () => { sendCurrent('streamComplete'); void this.refreshConversations(); },
          (error) => { sendCurrent(error.name === 'AbortError' ? 'streamStopped' : 'streamError', { message: error.message }); void this.refreshConversations(); },
        );
      }
    } catch (error) {
      sendCurrent('streamError', { message: error instanceof Error ? error.message : String(error) });
    } finally {
      if (generation === this.chatGeneration) this.activeChat = undefined;
      void this.drainTaskContinuation();
    }
  }

  private createTitle(prompt: string): string {
    const title = prompt.replace(/\s+/g, ' ').trim();
    return title.length > 52 ? `${title.slice(0, 49)}…` : title;
  }

  private normalizeLanguage(language?: string): string {
    const aliases: Record<string, string> = {
      js: 'javascript', ts: 'typescript', py: 'python', sh: 'shellscript', bash: 'shellscript',
      cs: 'csharp', md: 'markdown', yml: 'yaml', text: 'plaintext', code: 'plaintext',
    };
    return aliases[language || ''] || language || 'plaintext';
  }

  private async openGeneratedCode(code: string, relativePath?: string, language?: string): Promise<void> {
    if (relativePath && this.resolveWorkspaceFile(relativePath)) {
      await this.previewFileChange(relativePath, code);
      return;
    }
    const document = await vscode.workspace.openTextDocument({ content: code, language: this.normalizeLanguage(language) });
    await vscode.window.showTextDocument(document, { preview: true });
  }

  private async applyCodeToEditor(code: string, relativePath?: string): Promise<void> {
    if (relativePath && this.resolveWorkspaceFile(relativePath)) {
      await this.applyFileChange(relativePath, code, `Replace the complete contents of ${relativePath}`);
      return;
    }
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      const document = await vscode.workspace.openTextDocument({ content: code });
      await vscode.window.showTextDocument(document, { preview: true });
      return;
    }

    let replaceWholeDocument = false;
    if (editor.selection.isEmpty) {
      const choice = await vscode.window.showWarningMessage(
        `No target filename was found. How should the generated code be applied to ${path.basename(editor.document.fileName)}?`,
        { modal: true },
        'Replace entire file',
        'Insert at cursor'
      );
      if (!choice) return;
      replaceWholeDocument = choice === 'Replace entire file';
    } else {
      const requireApproval = vscode.workspace.getConfiguration('personalCodex').get('requireWriteApproval', true);
      if (requireApproval) {
        const choice = await vscode.window.showWarningMessage('Replace the selected code with the generated block?', { modal: true }, 'Apply');
        if (choice !== 'Apply') return;
      }
    }

    const applied = await editor.edit((builder) => {
      if (replaceWholeDocument) {
        builder.replace(new vscode.Range(editor.document.positionAt(0), editor.document.positionAt(editor.document.getText().length)), code);
      } else if (editor.selection.isEmpty) {
        builder.insert(editor.selection.active, code);
      } else {
        builder.replace(editor.selection, code);
      }
    });
    if (!applied) {
      void vscode.window.showErrorMessage('Unable to apply the generated code.');
    }
  }

  private resolveWorkspaceFile(relativePath: string): vscode.Uri | undefined {
    const folder = this.getActiveWorkspaceFolder();
    if (!folder || !relativePath || path.isAbsolute(relativePath) || relativePath.includes('\0')) return undefined;
    const root = path.resolve(folder.uri.fsPath);
    const target = path.resolve(root, relativePath);
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
    return vscode.Uri.file(target);
  }

  private async applyFileChange(relativePath: string, content: string, explanation: string): Promise<void> {
    const changeSet = this.legacyChangeSets.get(relativePath);
    const operation = changeSet?.operations.find((item) => item.relative_path === relativePath);
    if (!changeSet || !operation || operation.proposed_content !== content) {
      void vscode.window.showWarningMessage(
        `The legacy proposal for ${relativePath} has no verified base hash. Ask Agent mode to regenerate it as a transactional change set before applying.`
      );
      return;
    }
    await this.applyTaskChangeSet(changeSet);
  }

  private async previewChangeSet(changeSet: ChangeSet): Promise<void> {
    const folder = this.getActiveWorkspaceFolder();
    if (!folder) {
      void vscode.window.showErrorMessage('Open the registered workspace before previewing this change set.');
      return;
    }
    try {
      await this.changeSetManager.assertPreviewable(changeSet, folder);
      for (const operation of changeSet.operations) {
        await this.previewFileChange(operation.relative_path, operation.proposed_content);
      }
    } catch (error) {
      void vscode.window.showErrorMessage((error as Error).message);
    }
  }

  private async applyTaskChangeSet(changeSet: ChangeSet): Promise<void> {
    const owner = this.taskForAction(changeSet.conversation_id, changeSet.id);
    const generation = this.chatGeneration;
    const applied = await this.applyChangeSet(changeSet);
    if (applied && owner && this.ownsTask(owner.id, owner.conversation_id, generation)) {
      await this.startVerification(owner.conversation_id, owner.goal, applied.id, 'quick', owner.id);
    }
  }

  private async applyChangeSet(changeSet: ChangeSet): Promise<ChangeSet | undefined> {
    const folder = this.getActiveWorkspaceFolder();
    if (!folder) {
      void vscode.window.showErrorMessage('Open the registered workspace before applying this change set.');
      return undefined;
    }
    const files = changeSet.operations.map((operation) => `${operation.type}: ${operation.relative_path}`).join('\n');
    const choice = await vscode.window.showWarningMessage(
      `Apply the complete change set?\n\n${changeSet.summary}\n\n${files}`,
      { modal: true },
      'Apply complete change set'
    );
    if (choice !== 'Apply complete change set') return undefined;

    let approved: ChangeSet | undefined;
    let localResult: { checkpointReference: string; resultHashes: Record<string, string> } | undefined;
    try {
      approved = await this.backend.decideChangeSet(changeSet.id, 'approve', 'Approved as a complete change set in VS Code');
      localResult = await this.changeSetManager.apply(approved, folder);
      const applied = await this.backend.reportChangeSetResult(
        approved.id,
        'applied',
        localResult.resultHashes,
        localResult.checkpointReference,
      );
      await this.send({ command: 'changeSetUpdated', payload: applied });
      void vscode.window.showInformationMessage(`Applied ${applied.operations.length} file change(s). A restore checkpoint is available.`);
      return applied;
    } catch (error) {
      let failure = error as Error;
      if (approved && localResult) {
        try {
          await this.changeSetManager.restore(
            { ...approved, checkpoint_reference: localResult.checkpointReference },
            folder,
          );
          failure = new Error(`Backend result reporting failed, so the local change was rolled back: ${failure.message}`);
        } catch (rollbackError) {
          failure = new Error(
            `Backend result reporting failed and local rollback also failed: ${failure.message}; ${(rollbackError as Error).message}`,
          );
        }
      }
      try {
        if (approved) {
          const failed = await this.backend.reportChangeSetResult(approved.id, 'failed', {}, undefined, failure.message);
          await this.send({ command: 'changeSetUpdated', payload: failed });
        }
      } catch {
        // The original error is more actionable than a secondary reporting failure.
      }
      void vscode.window.showErrorMessage(`Change set was not applied: ${failure.message}`);
      return undefined;
    }
  }

  private async rejectChangeSet(changeSet: ChangeSet): Promise<void> {
    try {
      const rejected = await this.backend.decideChangeSet(changeSet.id, 'reject', 'Rejected in VS Code');
      await this.send({ command: 'changeSetUpdated', payload: rejected });
    } catch (error) {
      void vscode.window.showErrorMessage(`Unable to reject change set: ${(error as Error).message}`);
    }
  }

  private async restoreChangeSet(changeSet: ChangeSet): Promise<ChangeSet | undefined> {
    const folder = this.getActiveWorkspaceFolder();
    if (!folder) return undefined;
    const choice = await vscode.window.showWarningMessage(
      `Restore only the files changed by '${changeSet.summary}'? Newer user changes will cause a conflict.`,
      { modal: true },
      'Restore change set'
    );
    if (choice !== 'Restore change set') return undefined;
    try {
      await this.changeSetManager.restore(changeSet, folder);
      const restored = await this.backend.reportChangeSetRestore(changeSet.id, 'restored');
      await this.send({ command: 'changeSetUpdated', payload: restored });
      void vscode.window.showInformationMessage('Change set restored from its checkpoint.');
      return restored;
    } catch (error) {
      try {
        const failed = await this.backend.reportChangeSetRestore(changeSet.id, 'restore_failed', (error as Error).message);
        await this.send({ command: 'changeSetUpdated', payload: failed });
      } catch {
        // Preserve the local restore error.
      }
      void vscode.window.showErrorMessage(`Restore stopped: ${(error as Error).message}`);
      return undefined;
    }
  }

  private async previewFileChange(relativePath: string, content: string): Promise<void> {
    const target = this.resolveWorkspaceFile(relativePath);
    if (!target) {
      void vscode.window.showErrorMessage('The proposed file path is outside the active workspace.');
      return;
    }
    let exists = true;
    try {
      await vscode.workspace.fs.stat(target);
    } catch {
      exists = false;
    }
    if (!exists) {
      const document = await vscode.workspace.openTextDocument({ content, language: this.normalizeLanguage(path.extname(relativePath).slice(1)) });
      await vscode.window.showTextDocument(document, { preview: true });
      return;
    }
    const proposedUri = vscode.Uri.from({
      scheme: 'codeme-proposed',
      path: `/${relativePath.replace(/\\/g, '/')}`,
      query: `v=${Date.now()}-${Math.random().toString(36).slice(2)}`,
    });
    this.proposedDocuments.set(proposedUri.toString(), content);
    await vscode.commands.executeCommand('vscode.diff', target, proposedUri, `${relativePath} ↔ Codeme proposal`, { preview: true });
  }

  private async evaluateCommand(commandRun: CommandRun): Promise<CommandPolicyDecision> {
    const folders = vscode.workspace.workspaceFolders || [];
    if (folders.length !== 1) {
      throw new CommandPolicyError('Controlled execution requires exactly one active VS Code workspace folder.');
    }
    if (!this.currentWorkspaceId || commandRun.workspace_id !== this.currentWorkspaceId) {
      throw new CommandPolicyError('The command proposal does not belong to the active registered workspace.');
    }
    const registered = (await this.backend.listWorkspaces()).find((item) => item.id === commandRun.workspace_id);
    if (!registered?.root_path) throw new CommandPolicyError('The backend workspace registration is unavailable.');
    return evaluateCommandPolicy(
      commandRun,
      registered.root_path,
      folders[0].uri.fsPath,
      vscode.workspace.getConfiguration('personalCodex'),
    );
  }

  private withPolicy(commandRun: CommandRun, policy: CommandPolicyDecision): CommandRun {
    return {
      ...commandRun,
      calculated_risk: policy.risk,
      risk_explanation: policy.explanation,
      resolved_executable_name: policy.executableName,
      resolved_arguments: policy.args,
      environment_keys: policy.environmentKeys,
      network_access: policy.network,
      writes_workspace: policy.writesWorkspace,
      policy_blocked: policy.blocked,
    };
  }

  private async prepareCommandProposalEvent(conversationId: number, commandRun: CommandRun, requestId?: string, generation = this.chatGeneration, recovered = false): Promise<void> {
    const sendProposal = (run: CommandRun): Promise<void> => {
      if (generation !== this.chatGeneration) return Promise.resolve();
      return recovered
        ? this.send({ command: 'agentProposalRecovered', payload: { conversationId, commandRun: run } })
        : this.send({ command: 'agentEvent', payload: { conversationId, requestId, event: { type: 'proposal', kind: 'command_proposal', command_run: run } } });
    };
    try {
      const policy = await this.evaluateCommand(commandRun);
      this.commandPolicies.set(commandRun.id, policy);
      if (policy.blocked) {
        const blocked = await this.backend.decideCommandRun(
          commandRun.id, 'block', 'BLOCKED', policy.explanation, policy.executableName, policy.environmentKeys,
        );
        await sendProposal(this.withPolicy(blocked, policy));
        return;
      }
      await sendProposal(this.withPolicy(commandRun, policy));
    } catch (error) {
      const explanation = `Blocked by extension policy: ${(error as Error).message}`;
      let blocked: CommandRun = { ...commandRun, status: 'blocked', calculated_risk: 'BLOCKED', risk_explanation: explanation, policy_blocked: true };
      try {
        blocked = {
          ...await this.backend.decideCommandRun(commandRun.id, 'block', 'BLOCKED', explanation),
          policy_blocked: true,
        };
      } catch {
        // Still render the local policy block if persistence is temporarily unavailable.
      }
      await sendProposal(blocked);
    }
  }

  private approvalText(commandRun: CommandRun, policy: CommandPolicyDecision): string {
    const warning = policy.risks.some((risk) => ['NETWORK', 'PACKAGE_INSTALL', 'LONG_RUNNING'].includes(risk))
      ? '\n\nStrong warning: this request may access the network, install packages, or run longer than the safe default.'
      : '';
    return [
      commandRun.purpose,
      `Profile: ${commandRun.profile}`,
      `Executable: ${policy.executableName}`,
      `Arguments: ${JSON.stringify(policy.args)}`,
      `Working directory: ${policy.cwdRelative}`,
      `Risk: ${policy.risk}`,
      policy.explanation,
      `Timeout: ${policy.timeoutSeconds}s`,
      `Environment keys: ${policy.environmentKeys.join(', ') || '(none)'}`,
    ].join('\n') + warning;
  }

  private async runControlledCommand(commandRun: CommandRun): Promise<void> {
    const owner = this.taskForAction(commandRun.conversation_id, commandRun.id);
    const ownerGeneration = this.chatGeneration;
    let fresh = await this.backend.getCommandRun(commandRun.id);
    let processStarted = false;
    if (fresh.status !== 'proposed') {
      void vscode.window.showWarningMessage(`This command is already ${fresh.status}.`);
      return;
    }
    let policy: CommandPolicyDecision;
    try {
      policy = await this.evaluateCommand(fresh);
    } catch (error) {
      const explanation = `Blocked by extension policy: ${(error as Error).message}`;
      const blocked = await this.backend.decideCommandRun(fresh.id, 'block', 'BLOCKED', explanation);
      await this.send({ command: 'commandRunUpdated', payload: blocked });
      return;
    }
    if (policy.blocked) {
      const blocked = await this.backend.decideCommandRun(fresh.id, 'block', 'BLOCKED', policy.explanation, policy.executableName, policy.environmentKeys);
      await this.send({ command: 'commandRunUpdated', payload: this.withPolicy(blocked, policy) });
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      this.approvalText(fresh, policy),
      { modal: true },
      'Run once',
    );
    if (choice !== 'Run once') return;

    fresh = await this.backend.decideCommandRun(
      fresh.id, 'approve', policy.risk, policy.explanation, policy.executableName, policy.environmentKeys,
    );
    await this.send({ command: 'commandRunUpdated', payload: this.withPolicy(fresh, policy) });
    fresh = await this.backend.reportCommandEvent(fresh.id, 'starting', 'Approved process is starting');
    await this.send({ command: 'commandRunUpdated', payload: this.withPolicy(fresh, policy) });

    try {
      policy = await this.evaluateCommand(fresh);
      if (owner) this.taskActiveCommands.set(fresh.id, { runId: owner.id, conversationId: owner.conversation_id });
      const resultPromise = this.processRunner.run(fresh, policy, (event) => {
        void this.send({ command: 'commandRunOutput', payload: event });
      });
      processStarted = true;
      fresh = await this.backend.reportCommandEvent(fresh.id, 'running', 'Controlled process started');
      await this.send({ command: 'commandRunUpdated', payload: this.withPolicy(fresh, policy) });
      const result = await resultPromise;
      const completed = await this.backend.reportCommandResult(fresh.id, result);
      await this.send({ command: 'commandRunUpdated', payload: this.withPolicy(completed, policy) });
    } catch (error) {
      if (processStarted) {
        await this.processRunner.cancel(fresh.id);
      }
      const now = new Date().toISOString();
      const failed = await this.backend.reportCommandResult(fresh.id, {
        status: 'failed', exitCode: null, terminationReason: 'runner_error',
        startedAt: fresh.started_at || now, completedAt: now, durationMs: 0,
        stdoutTail: '', stderrTail: '', outputTruncated: false, timedOut: false, cancelled: false,
        failureReason: (error as Error).message,
      });
      await this.send({ command: 'commandRunUpdated', payload: failed });
    } finally {
      this.taskActiveCommands.delete(commandRun.id);
    }
    if (owner && this.ownsTask(owner.id, owner.conversation_id, ownerGeneration)) await this.continueTask(owner.id, undefined, true, ownerGeneration);
  }

  private async rejectControlledCommand(commandRun: CommandRun): Promise<void> {
    try {
      const policy = this.commandPolicies.get(commandRun.id) || await this.evaluateCommand(commandRun);
      const rejected = await this.backend.decideCommandRun(
        commandRun.id, 'reject', policy.risk, policy.explanation, policy.executableName, policy.environmentKeys,
      );
      await this.send({ command: 'commandRunUpdated', payload: this.withPolicy(rejected, policy) });
    } catch (error) {
      void vscode.window.showErrorMessage(`Unable to reject command: ${(error as Error).message}`);
    }
  }

  private verificationSettings(): { maximumRepairAttempts: number; maximumReruns: number; totalTimeBudgetSeconds: number } {
    const configuration = vscode.workspace.getConfiguration('personalCodex');
    return {
      maximumRepairAttempts: configuration.get('verificationMaximumRepairAttempts', 2),
      maximumReruns: configuration.get('verificationMaximumReruns', 2),
      totalTimeBudgetSeconds: configuration.get('verificationTimeBudgetSeconds', 600),
    };
  }

  private async publishVerification(session: VerificationSession): Promise<void> {
    const steps = await Promise.all(session.steps.map(async (step) => {
      const preview: CommandRun = {
        id: `verification-preview-${session.id}-${step.step_id}`, schema_version: 1,
        conversation_id: session.conversation_id, workspace_id: session.workspace_id,
        profile: step.profile, arguments: step.arguments, cwd_relative: step.cwd_relative,
        purpose: step.purpose, requested_timeout_seconds: step.timeout_seconds,
        status: 'proposed', created_at: session.created_at, updated_at: session.updated_at,
      };
      try {
        const policy = await this.evaluateCommand(preview);
        return { ...step, calculated_risk: policy.risk, risk_explanation: policy.explanation };
      } catch (error) {
        return { ...step, calculated_risk: 'BLOCKED' as const, risk_explanation: (error as Error).message };
      }
    }));
    await this.send({ command: 'verificationSessionUpdated', payload: { ...session, steps } });
    if (verificationTerminalStates.has(session.state) && this.taskVerificationOwners.has(session.id)) {
      const owner = this.taskVerificationOwners.get(session.id)!;
      this.taskVerificationOwners.delete(session.id);
      if (this.ownsTask(owner.runId, session.conversation_id, owner.generation)) {
        await this.continueTask(owner.runId, undefined, true, owner.generation);
      }
    }
  }

  private async recoverVerificationSessions(): Promise<void> {
    if (!this.currentWorkspaceId) return;
    try {
      const active = await this.backend.listVerificationSessions(this.currentWorkspaceId, true);
      for (let session of active) {
        if (session.state === 'RUNNING' && session.steps.some((step) => step.status === 'RUNNING')) {
          session = await this.backend.cancelVerification(session.id, 'Extension reloaded while a controlled process was active', true);
        }
        await this.publishVerification(session);
      }
    } catch (error) {
      console.warn('Unable to recover verification sessions.', error);
    }
  }

  private async startVerification(
    conversationId: number, originalRequest: string, sourceChangeSetId: string | undefined, mode: VerificationMode, ownerRunId?: string,
  ): Promise<void> {
    if (!this.currentWorkspaceId) {
      void vscode.window.showWarningMessage('Register the active workspace before starting verification.');
      return;
    }
    try {
      const owner = this.taskForAction(conversationId, sourceChangeSetId);
      const ownerGeneration = this.chatGeneration;
      const session = await this.backend.createVerificationSession({
        conversationId, workspaceId: this.currentWorkspaceId, originalRequest, mode, sourceChangeSetId,
        ...this.verificationSettings(),
      });
      if (ownerRunId || owner?.id) this.taskVerificationOwners.set(session.id, { runId: ownerRunId || owner!.id, generation: ownerGeneration });
      await this.publishVerification(session);
    } catch (error) {
      void vscode.window.showErrorMessage(`Unable to create verification plan: ${(error as Error).message}`);
    }
  }

  private async approveVerification(sessionId: string): Promise<void> {
    const session = await this.backend.getVerificationSession(sessionId);
    if (session.state !== 'AWAITING_PLAN_APPROVAL') return;
    const owner = this.taskForAction(session.conversation_id, session.source_change_set_id || undefined);
    if (owner) this.taskVerificationOwners.set(session.id, { runId: owner.id, generation: this.chatGeneration });
    await this.publishVerification(session);
    const plan = session.steps.map((step, index) => [
      `${index + 1}. ${step.purpose}${step.required ? ' (required)' : ' (optional)'}`,
      `   ${step.profile} ${JSON.stringify(step.arguments)} / cwd ${step.cwd_relative} / ${step.timeout_seconds}s`,
    ].join('\n')).join('\n');
    const choice = await vscode.window.showWarningMessage(
      `Run this immutable verification plan once?\n\n${plan}\n\nSession budget: ${session.total_time_budget_seconds}s; repairs: ${session.maximum_repair_attempts}; reruns: ${session.maximum_reruns}.`,
      { modal: true }, 'Approve complete plan',
    );
    if (choice !== 'Approve complete plan') return;
    const approved = await this.backend.decideVerificationPlan(session.id, 'approve', session.plan_fingerprint);
    await this.publishVerification(approved);
    await this.executeVerification(approved);
  }

  private async rejectVerification(sessionId: string): Promise<void> {
    const session = await this.backend.getVerificationSession(sessionId);
    const rejected = await this.backend.decideVerificationPlan(session.id, 'reject', session.plan_fingerprint);
    await this.publishVerification(rejected);
  }

  private async cancelVerification(sessionId: string): Promise<void> {
    const commandId = this.activeVerificationCommands.get(sessionId);
    if (commandId) await this.processRunner.cancel(commandId);
    const cancelled = await this.backend.cancelVerification(sessionId, 'Cancelled by user');
    await this.publishVerification(cancelled);
  }

  private async executeVerification(initial: VerificationSession): Promise<void> {
    if (this.executingVerifications.has(initial.id)) return;
    this.executingVerifications.add(initial.id);
    let session = initial;
    try {
      while (session.state === 'RUNNING') {
        const step = session.steps.find((item) => item.status === 'PENDING');
        if (!step) break;
        const started = await this.backend.startVerificationStep(session.id, step.step_id, session.plan_fingerprint);
        session = started.session;
        let command = started.command_run;
        let policy: CommandPolicyDecision;
        try {
          policy = await this.evaluateCommand(command);
          if (policy.blocked || policy.network || policy.risks.some((risk) => ['PACKAGE_INSTALL', 'SENSITIVE'].includes(risk))) {
            throw new CommandPolicyError(`Verification step is outside the offline bounded policy: ${policy.explanation}`);
          }
        } catch (error) {
          await this.backend.decideCommandRun(command.id, 'block', 'BLOCKED', (error as Error).message);
          session = await this.backend.cancelVerification(session.id, `Policy blocked: ${(error as Error).message}`, true);
          await this.publishVerification(session);
          return;
        }
        command = await this.backend.decideCommandRun(
          command.id, 'approve', policy.risk, policy.explanation, policy.executableName, policy.environmentKeys,
        );
        command = await this.backend.reportCommandEvent(command.id, 'starting', 'Approved verification step is starting');
        this.activeVerificationCommands.set(session.id, command.id);
        const resultPromise = this.processRunner.run(command, policy, (event) => {
          void this.send({ command: 'verificationStepOutput', payload: { sessionId: session.id, stepId: step.step_id, ...event } });
        });
        command = await this.backend.reportCommandEvent(command.id, 'running', 'Controlled verification process started');
        await this.publishVerification(session);
        const result = await resultPromise;
        await this.backend.reportCommandResult(command.id, result);
        session = await this.backend.reportVerificationStep(session.id, step.step_id, session.plan_fingerprint, command.id);
        this.activeVerificationCommands.delete(session.id);
        await this.publishVerification(session);
      }
      if (session.state === 'VERIFICATION_FAILED' && session.maximum_repair_attempts > session.current_attempt) {
        await this.send({ command: 'verificationRepairStarted', payload: { sessionId: session.id } });
        const owner = this.taskVerificationOwners.get(session.id);
        const taskModel = owner ? [...this.agentRuns.values()].find((run) => run.id === owner.runId)?.model : undefined;
        session = await this.backend.prepareVerificationRepair(session.id, taskModel || undefined);
        await this.publishVerification(session);
      }
    } catch (error) {
      const commandId = this.activeVerificationCommands.get(session.id);
      if (commandId) await this.processRunner.cancel(commandId);
      this.activeVerificationCommands.delete(session.id);
      await this.send({ command: 'operationError', payload: { message: `Verification stopped safely: ${(error as Error).message}` } });
      try {
        const fresh = await this.backend.getVerificationSession(session.id);
        await this.publishVerification(fresh);
      } catch { /* preserve the original failure */ }
    } finally {
      this.executingVerifications.delete(session.id);
    }
  }

  private async applyVerificationRepair(sessionId: string): Promise<void> {
    let session = await this.backend.getVerificationSession(sessionId);
    const attempt = session.repair_attempts.at(-1);
    if (!attempt?.repair_change_set_id || session.state !== 'AWAITING_REPAIR_APPROVAL') return;
    const changeSet = await this.backend.getChangeSet(attempt.repair_change_set_id);
    const applied = await this.applyChangeSet(changeSet);
    if (!applied) return;
    session = await this.backend.reportVerificationRepair(session.id, 'applied', applied.id, 'Applied through the Phase 4 transactional manager');
    await this.publishVerification(session);
    await this.executeVerification(session);
  }

  private async rejectVerificationRepair(sessionId: string): Promise<void> {
    const session = await this.backend.getVerificationSession(sessionId);
    const attempt = session.repair_attempts.at(-1);
    if (!attempt?.repair_change_set_id) return;
    await this.backend.decideChangeSet(attempt.repair_change_set_id, 'reject', 'Repair rejected in VS Code');
    const stopped = await this.backend.reportVerificationRepair(session.id, 'rejected', attempt.repair_change_set_id, 'Repair rejected by user');
    await this.publishVerification(stopped);
  }

  private async restoreVerificationRepair(sessionId: string): Promise<void> {
    const session = await this.backend.getVerificationSession(sessionId);
    const attempt = session.repair_attempts.at(-1);
    if (!attempt?.repair_change_set_id || attempt.result !== 'applied') return;
    const changeSet = await this.backend.getChangeSet(attempt.repair_change_set_id);
    const restored = await this.restoreChangeSet(changeSet);
    if (!restored) return;
    const updated = await this.backend.reportVerificationRepair(session.id, 'restored', restored.id, 'Repair restored through the Phase 4 checkpoint');
    await this.publishVerification(updated);
  }

  private async runProposedCommand(command: string, explanation: string): Promise<void> {
    const folder = this.getActiveWorkspaceFolder();
    if (!folder || !command.trim() || /[\r\n]/.test(command) || command.length > 2_000) {
      void vscode.window.showErrorMessage('The proposed terminal command is invalid.');
      return;
    }
    const unsafeEnabled = vscode.workspace.getConfiguration('personalCodex').get('enableUnsafeCommandExecution', false);
    if (!unsafeEnabled) {
      const action = await vscode.window.showWarningMessage(
        'This is a deprecated raw command proposal. Raw command text is display-only; ask the agent for a structured Phase 5 command profile.',
        'Open setting'
      );
      if (action === 'Open setting') {
        await vscode.commands.executeCommand('workbench.action.openSettings', 'personalCodex.enableUnsafeCommandExecution');
      }
      return;
    }
    void vscode.window.showWarningMessage(
      `Deprecated raw command proposals are display-only and cannot execute, even when personalCodex.enableUnsafeCommandExecution is enabled. Ask the agent for a structured command profile instead.\n\n${command}${explanation ? `\n\n${explanation}` : ''}`
    );
  }
}
