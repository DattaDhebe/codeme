import * as path from 'path';
import * as vscode from 'vscode';
import { BackendClient } from './backendClient';
import { ContextReferenceResolver } from './contextResolver';
import { webviewHtml } from './webviewHtml';

interface WebviewMessage {
  command: string;
  payload: unknown;
}

interface ChatRequestArgs {
  prompt: string;
  conversationId?: number | null;
  model?: string;
  context?: Array<{ label: string; kind: string; content: string; language?: string }>;
}

export class PersonalCodexSidebarProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private webviewReady = false;
  private pendingMessages: WebviewMessage[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly backend: BackendClient,
    private readonly resolver: ContextReferenceResolver
  ) {}

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
      webviewView.webview.onDidReceiveMessage((data) => void this.handleMessage(data)),
      webviewView.onDidDispose(() => {
        this.view = undefined;
        this.webviewReady = false;
      })
    );
  }

  public async reveal(): Promise<void> {
    if (!this.view) {
      await vscode.commands.executeCommand('workbench.view.extension.personalCodeme');
    }
    this.view?.show?.(true);
  }

  public async createNewChat(): Promise<void> {
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
      `Register '${folder.name}' with Personal Codeme?`,
      'Register',
      'Cancel'
    );
    if (accept !== 'Register') {
      return;
    }
    const workspaceId = await this.backend.registerWorkspace(folder.uri.fsPath, folder.name);
    await this.send({ command: 'workspaceRegistered', payload: { workspaceId, rootPath: folder.uri.fsPath } });
    await this.refreshWorkspaceState();
  }

  public async startBackend(): Promise<void> {
    try {
      await this.backend.checkConnection(false);
      void vscode.window.showInformationMessage('Personal Codeme backend is already running.');
      await this.refreshBackendStatus(false);
      return;
    } catch {
      // Continue and launch the configured workspace task.
    }

    const tasks = await vscode.tasks.fetchTasks();
    const backendTask = tasks.find((task) => task.name === 'Run Codeme API');
    if (!backendTask) {
      void vscode.window.showWarningMessage("Task 'Run Codeme API' was not found in this workspace.");
      return;
    }
    await vscode.tasks.executeTask(backendTask);
    void vscode.window.showInformationMessage('Starting the Personal Codeme backend…');
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
      },
    });
  }

  public async updateConfiguration(): Promise<void> {
    this.backend.updateSettings(vscode.workspace.getConfiguration('personalCodex'));
    if (this.webviewReady) {
      await this.initialize();
    }
  }

  private getActiveWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
    return vscode.workspace.workspaceFolders?.[0];
  }

  private async initialize(conversationId?: number | null): Promise<void> {
    await Promise.all([
      this.refreshBackendStatus(false),
      this.refreshWorkspaceState(),
      this.refreshConversations(),
    ]);
    if (conversationId) {
      await this.loadConversation(conversationId);
    }
  }

  private async refreshBackendStatus(userTriggered: boolean): Promise<void> {
    try {
      const health = await this.backend.checkConnection(userTriggered);
      await this.send({
        command: 'backendStatus',
        payload: {
          online: true,
          model: health.model || this.backend.configuredModel,
          models: health.models || [this.backend.configuredModel],
          ollama: health.ollama === 'ok',
        },
      });
    } catch (error) {
      await this.send({
        command: 'backendStatus',
        payload: {
          online: false,
          model: this.backend.configuredModel,
          models: [this.backend.configuredModel],
          ollama: false,
          error: (error as Error).message,
        },
      });
    }
  }

  private async refreshConversations(query?: string): Promise<void> {
    try {
      const conversations = await this.backend.listConversations(query);
      await this.send({ command: 'conversationsUpdated', payload: conversations });
    } catch (error) {
      console.warn('Unable to load Personal Codeme conversations.', error);
    }
  }

  private async loadConversation(conversationId: number): Promise<void> {
    try {
      const messages = await this.backend.getConversationMessages(conversationId);
      await this.send({ command: 'conversationLoaded', payload: { conversationId, messages } });
    } catch (error) {
      await this.send({ command: 'operationError', payload: { message: (error as Error).message } });
    }
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
      case 'startChat':
        await this.handleChatRequest(message.args as unknown as ChatRequestArgs);
        break;
      case 'cancelStream':
        this.backend.cancel();
        break;
      case 'loadConversation':
        if (typeof message.args?.conversationId === 'number') {
          await this.loadConversation(message.args.conversationId);
        }
        break;
      case 'deleteConversation':
        if (typeof message.args?.conversationId === 'number') {
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
          const document = await vscode.workspace.openTextDocument({
            content: message.args.text,
            language: this.normalizeLanguage(typeof message.args?.language === 'string' ? message.args.language : undefined),
          });
          await vscode.window.showTextDocument(document, { preview: true });
        }
        break;
      case 'applyCode':
        if (typeof message.args?.text === 'string') {
          await this.applyCodeToEditor(message.args.text);
        }
        break;
      case 'openSettings':
        await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:personal-codex-local.personal-codeme');
        break;
      case 'startBackend':
        await this.startBackend();
        break;
      default:
        console.warn('Unknown command from Personal Codeme webview:', message.command);
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
    const prompt = args.prompt?.trim();
    if (!prompt) {
      return;
    }

    let conversationId = args.conversationId || null;
    if (!conversationId) {
      const conversation = await this.backend.createConversation(this.createTitle(prompt));
      conversationId = conversation.id;
      await this.send({ command: 'conversationCreated', payload: conversation });
    }

    const contextText = (args.context || [])
      .map((item) => {
        const language = item.language || 'text';
        return `Context: ${item.label} (${item.kind})\n\`\`\`${language}\n${item.content}\n\`\`\``;
      })
      .join('\n\n');
    const content = contextText ? `${prompt}\n\n${contextText}` : prompt;
    await this.send({ command: 'streamStarted', payload: { conversationId } });
    await this.backend.streamChat(
      conversationId,
      [{ role: 'user', content }],
      args.model,
      (chunk) => void this.send({ command: 'streamChunk', payload: { conversationId, chunk } }),
      () => {
        void this.send({ command: 'streamComplete', payload: { conversationId } });
        void this.refreshConversations();
      },
      (error) => {
        void this.send({ command: 'streamError', payload: { conversationId, message: error.message } });
        void this.refreshConversations();
      }
    );
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

  private async applyCodeToEditor(code: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      const document = await vscode.workspace.openTextDocument({ content: code });
      await vscode.window.showTextDocument(document, { preview: true });
      return;
    }

    const requireApproval = vscode.workspace.getConfiguration('personalCodex').get('requireWriteApproval', true);
    if (requireApproval) {
      const target = editor.selection.isEmpty ? 'insert at the cursor' : 'replace the selected code';
      const choice = await vscode.window.showWarningMessage(
        `Apply generated code and ${target}?`,
        { modal: true },
        'Apply'
      );
      if (choice !== 'Apply') {
        return;
      }
    }

    const applied = await editor.edit((builder) => {
      if (editor.selection.isEmpty) {
        builder.insert(editor.selection.active, code);
      } else {
        builder.replace(editor.selection, code);
      }
    });
    if (!applied) {
      void vscode.window.showErrorMessage('Unable to apply the generated code.');
    }
  }
}
