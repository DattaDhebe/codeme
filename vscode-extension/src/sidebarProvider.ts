import * as vscode from 'vscode';
import { BackendClient } from './backendClient';
import { ContextReferenceResolver, SelectionContext } from './contextResolver';

interface PendingMessage {
  command: string;
  payload: unknown;
}

export class PersonalCodexSidebarProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private pendingMessages: PendingMessage[] = [];
  private currentWorkspaceId: number | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly backend: BackendClient,
    private readonly resolver: ContextReferenceResolver
  ) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = webviewHtml(webviewView.webview, this.context.extensionUri);
    webviewView.webview.onDidReceiveMessage((data) => this.handleMessage(data));
    this.initialize();
  }

  public async reveal(): Promise<void> {
    if (!this.view) {
      await vscode.commands.executeCommand('workbench.view.extension.personalCodex');
    }
    this.view?.show?.(true);
  }

  public async createNewChat(): Promise<void> {
    await this.send({ command: 'newChat', payload: {} });
  }

  public async handleSelectionCommand(action: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      vscode.window.showWarningMessage('No selection available.');
      return;
    }
    const context = await this.resolver.resolveSelection(editor);
    await this.send({ command: action, payload: context });
  }

  public async handleFileCommand(action: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('Open a file first.');
      return;
    }
    const context = await this.resolver.resolveFile(editor);
    await this.send({ command: action, payload: context });
  }

  public async reviewChanges(): Promise<void> {
    const workspace = this.getActiveWorkspaceFolder();
    if (!workspace) {
      vscode.window.showWarningMessage('Open a workspace folder first.');
      return;
    }
    const diff = await this.resolver.resolveGitDiff(workspace);
    await this.send({ command: 'reviewChanges', payload: diff });
  }

  public async registerWorkspace(): Promise<void> {
    const folder = this.getActiveWorkspaceFolder();
    if (!folder) {
      vscode.window.showWarningMessage('Open a workspace folder first.');
      return;
    }
    const accept = await vscode.window.showInformationMessage(
      `Register '${folder.name}' with Personal Codex backend?`,
      'Register',
      'Cancel'
    );
    if (accept !== 'Register') {
      return;
    }
    const workspaceId = await this.backend.registerWorkspace(folder.uri.fsPath, folder.name);
    this.currentWorkspaceId = workspaceId;
    await this.send({ command: 'workspaceRegistered', payload: { workspaceId, rootPath: folder.uri.fsPath } });
  }

  public async refreshWorkspaceState(): Promise<void> {
    if (!this.view) {
      return;
    }
    const folder = this.getActiveWorkspaceFolder();
    const status = { workspace: folder?.name ?? null, folders: vscode.workspace.workspaceFolders?.length ?? 0 };
    await this.send({ command: 'workspaceState', payload: status });
  }

  public async updateConfiguration(): Promise<void> {
    await this.backend.updateSettings(vscode.workspace.getConfiguration('personalCodex'));
    await this.initialize();
  }

  private getActiveWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
    return vscode.workspace.workspaceFolders?.[0];
  }

  private async initialize(): Promise<void> {
    await this.backend.checkConnection(false);
    await this.refreshWorkspaceState();
    await this.flushPendingMessages();
  }

  private async send(message: PendingMessage): Promise<void> {
    if (!this.view) {
      this.pendingMessages.push(message);
      return;
    }
    this.view.webview.postMessage(message);
  }

  private async flushPendingMessages(): Promise<void> {
    while (this.pendingMessages.length > 0) {
      const message = this.pendingMessages.shift();
      if (message) {
        await this.send(message);
      }
    }
  }

  private async handleMessage(data: unknown): Promise<void> {
    if (!this.view) {
      return;
    }
    const payload = data as { command?: string; args?: unknown };
    if (!payload.command) {
      return;
    }

    switch (payload.command) {
      case 'healthCheck':
        await this.backend.checkConnection(true);
        break;
      case 'startChat':
        if (payload.args && typeof payload.args === 'object' && payload.args !== null) {
          await this.handleChatRequest(payload.args as { prompt: string });
        }
        break;
      case 'cancelStream':
        this.backend.cancel();
        break;
      default:
        console.warn('Unknown command from webview', payload.command);
    }
  }

  private async handleChatRequest(args: { prompt: string }): Promise<void> {
    const conversationId = await this.backend.createConversation('Personal Codex Chat');
    const messages = [{ role: 'user', content: args.prompt }];
    await this.backend.streamChat(
      conversationId,
      messages,
      (chunk) => this.send({ command: 'streamChunk', payload: chunk }),
      () => this.send({ command: 'streamComplete', payload: null }),
      (error) => this.send({ command: 'streamError', payload: { message: error.message } })
    );
  }
}
