import * as vscode from 'vscode';
import { PersonalCodexSidebarProvider } from './sidebarProvider';
import { BackendClient } from './backendClient';
import { ContextReferenceResolver } from './contextResolver';

export function activate(context: vscode.ExtensionContext): void {
  const config = vscode.workspace.getConfiguration('personalCodex');
  if (config.get('enableUnsafeCommandExecution', false)) {
    void vscode.window.showWarningMessage(
      'personalCodex.enableUnsafeCommandExecution is deprecated. Raw command proposals remain display-only and cannot bypass the controlled runner.'
    );
  }
  const backendClient = new BackendClient(config);
  const resolver = new ContextReferenceResolver();

  const sidebarProvider = new PersonalCodexSidebarProvider(context, backendClient, resolver);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('personalCodemeSidebar', sidebarProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  const registerCommand = (command: string, callback: (...args: unknown[]) => Promise<void> | void) => {
    context.subscriptions.push(vscode.commands.registerCommand(command, callback));
  };

  registerCommand('personalCodeme.openChat', async () => sidebarProvider.reveal());
  registerCommand('personalCodex.newChat', async () => sidebarProvider.createNewChat());
  registerCommand('personalCodex.explainSelection', async () => sidebarProvider.handleSelectionCommand('explain'));
  registerCommand('personalCodex.fixSelection', async () => sidebarProvider.handleSelectionCommand('fix'));
  registerCommand('personalCodex.refactorSelection', async () => sidebarProvider.handleSelectionCommand('refactor'));
  registerCommand('personalCodex.generateTests', async () => sidebarProvider.handleSelectionCommand('tests'));
  registerCommand('personalCodex.askCurrentFile', async () => sidebarProvider.handleFileCommand('ask'));
  registerCommand('personalCodex.reviewChanges', async () => sidebarProvider.reviewChanges());
  registerCommand('personalCodex.registerWorkspace', async () => sidebarProvider.registerWorkspace());
  registerCommand('personalCodex.checkBackend', async () => {
    await backendClient.checkConnection(true);
  });
  registerCommand('personalCodex.startBackend', async () => sidebarProvider.startBackend());

  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => sidebarProvider.refreshWorkspaceState()));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    sidebarProvider.updateConfiguration();
    if (
      event.affectsConfiguration('personalCodex.enableUnsafeCommandExecution')
      && vscode.workspace.getConfiguration('personalCodex').get('enableUnsafeCommandExecution', false)
    ) {
      void vscode.window.showWarningMessage(
        'personalCodex.enableUnsafeCommandExecution is deprecated. Raw commands remain display-only.'
      );
    }
  }));
}

export function deactivate(): void {
  // no-op
}
