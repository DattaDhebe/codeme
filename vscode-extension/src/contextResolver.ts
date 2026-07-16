import * as vscode from 'vscode';

export interface SelectionContext {
  text: string;
  language: string;
  filePath: string;
  range: vscode.Range;
  workspaceFolder: string | null;
}

export interface GitDiffContext {
  branch: string | null;
  changes: string;
}

export class ContextReferenceResolver {
  public async resolveSelection(editor: vscode.TextEditor): Promise<SelectionContext> {
    const document = editor.document;
    const text = document.getText(editor.selection);
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath ?? null;
    return {
      text,
      language: document.languageId,
      filePath: document.uri.fsPath,
      range: editor.selection,
      workspaceFolder,
    };
  }

  public async resolveFile(editor: vscode.TextEditor): Promise<SelectionContext> {
    const document = editor.document;
    const selection = new vscode.Range(0, 0, 0, 0);
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath ?? null;
    return {
      text: document.getText(),
      language: document.languageId,
      filePath: document.uri.fsPath,
      range: selection,
      workspaceFolder,
    };
  }

  public async resolveGitDiff(workspaceFolder: vscode.WorkspaceFolder): Promise<GitDiffContext> {
    const repo = await this.getGitRepository(workspaceFolder);
    const branch = repo?.state.HEAD?.name ?? null;
    const changes = repo ? await this.getDiffFromRepository(repo) : '';
    return { branch, changes };
  }

  private async getGitRepository(workspaceFolder: vscode.WorkspaceFolder): Promise<vscode.SourceControlResourceGroup | undefined> {
    const gitExtension = vscode.extensions.getExtension('vscode.git')?.exports;
    if (!gitExtension) {
      return undefined;
    }
    const api = gitExtension.getAPI(1);
    const repo = api.repositories.find((repository: any) => repository.rootUri.fsPath === workspaceFolder.uri.fsPath);
    return repo;
  }

  private async getDiffFromRepository(repo: any): Promise<string> {
    const diffs = await Promise.all(repo.state.workingTreeChanges.map(async (change: any) => change.uri.fsPath));
    return diffs.join('\n');
  }
}
