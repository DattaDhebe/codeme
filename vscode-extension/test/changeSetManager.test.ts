import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { ChangeSet } from '../src/changeSet';
import { ChangeSetManager, sha256Text } from '../src/changeSetManager';
import { __failWorkspaceEditAfter, __resetDocuments, __setDirty } from '../src/vscodeStub';

const temporaryRoots: string[] = [];

function tempDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(directory);
  return directory;
}

function managerFixture() {
  const root = tempDirectory('codeme-workspace-');
  const storage = tempDirectory('codeme-storage-');
  const context = { globalStorageUri: vscode.Uri.file(storage) } as vscode.ExtensionContext;
  const folder = { name: 'workspace', uri: vscode.Uri.file(root) } as vscode.WorkspaceFolder;
  return { root, storage, folder, manager: new ChangeSetManager(context) };
}

function changeSet(operations: ChangeSet['operations']): ChangeSet {
  return {
    id: '22222222-2222-2222-2222-222222222222',
    schema_version: 1,
    conversation_id: 1,
    workspace_id: 1,
    summary: 'Transactional update',
    status: 'proposed',
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    operations,
  };
}

function modifyOperation(relativePath: string, base: string, proposed: string): ChangeSet['operations'][number] {
  return {
    operation_id: `modify-${relativePath}`,
    type: 'modify',
    relative_path: relativePath,
    summary: `Modify ${relativePath}`,
    base_sha256: sha256Text(base),
    proposed_sha256: sha256Text(proposed),
    encoding: 'utf-8',
    line_ending: base.includes('\r\n') ? 'crlf' : 'lf',
    edits: [],
    proposed_content: proposed,
    diff: 'diff',
  };
}

function createOperation(relativePath: string, content: string): ChangeSet['operations'][number] {
  return {
    operation_id: `create-${relativePath}`,
    type: 'create',
    relative_path: relativePath,
    summary: `Create ${relativePath}`,
    base_sha256: null,
    proposed_sha256: sha256Text(content),
    encoding: 'utf-8',
    line_ending: content.includes('\r\n') ? 'crlf' : content.includes('\n') ? 'lf' : 'none',
    edits: [],
    proposed_content: content,
    diff: 'diff',
  };
}

afterEach(() => {
  __resetDocuments();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('ChangeSetManager', () => {
  it('atomically applies and restores modify and create operations', async () => {
    const { root, folder, manager } = managerFixture();
    writeFileSync(join(root, 'app.txt'), 'before\n', 'utf8');
    const proposal = changeSet([
      modifyOperation('app.txt', 'before\n', 'after\n'),
      createOperation('.editorconfig', 'root=true\n'),
    ]);

    const result = await manager.apply(proposal, folder);
    expect(readFileSync(join(root, 'app.txt'), 'utf8')).toBe('after\n');
    expect(readFileSync(join(root, '.editorconfig'), 'utf8')).toBe('root=true\n');
    expect(result.resultHashes['app.txt']).toBe(sha256Text('after\n'));

    proposal.status = 'applied';
    proposal.checkpoint_reference = result.checkpointReference;
    await manager.restore(proposal, folder);
    expect(readFileSync(join(root, 'app.txt'), 'utf8')).toBe('before\n');
    expect(existsSync(join(root, '.editorconfig'))).toBe(false);
  });

  it('rejects a base-hash conflict and dirty editor', async () => {
    const { root, folder, manager } = managerFixture();
    const target = join(root, 'app.txt');
    writeFileSync(target, 'different', 'utf8');
    const proposal = changeSet([modifyOperation('app.txt', 'expected', 'after')]);
    await expect(manager.assertPreviewable(proposal, folder)).rejects.toThrow(/changed after proposal/);

    writeFileSync(target, 'expected', 'utf8');
    __resetDocuments();
    await vscode.workspace.openTextDocument(vscode.Uri.file(target));
    __setDirty(target, true);
    await expect(manager.apply(proposal, folder)).rejects.toThrow(/Unsaved changes/);
  });

  it('rolls back when the complete WorkspaceEdit fails', async () => {
    const { root, folder, manager } = managerFixture();
    writeFileSync(join(root, 'one.txt'), 'one', 'utf8');
    const proposal = changeSet([
      modifyOperation('one.txt', 'one', 'changed'),
      createOperation('two.txt', 'two'),
    ]);
    __failWorkspaceEditAfter(1);
    await expect(manager.apply(proposal, folder)).rejects.toThrow(/rejected/);
    expect(readFileSync(join(root, 'one.txt'), 'utf8')).toBe('one');
    expect(existsSync(join(root, 'two.txt'))).toBe(false);
  });

  it('refuses restore after a later user change', async () => {
    const { root, folder, manager } = managerFixture();
    const target = join(root, 'app.txt');
    writeFileSync(target, 'before', 'utf8');
    const proposal = changeSet([modifyOperation('app.txt', 'before', 'after')]);
    const result = await manager.apply(proposal, folder);
    proposal.status = 'applied';
    proposal.checkpoint_reference = result.checkpointReference;
    writeFileSync(target, 'user change', 'utf8');
    __resetDocuments();
    await expect(manager.restore(proposal, folder)).rejects.toThrow(/Restore conflict/);
    expect(readFileSync(target, 'utf8')).toBe('user change');
  });

  it('preserves Unicode, CRLF, LF, dotfiles, and extensionless files', async () => {
    const { root, folder, manager } = managerFixture();
    writeFileSync(join(root, 'unicode.txt'), 'नमस्ते\r\n', 'utf8');
    const proposal = changeSet([
      modifyOperation('unicode.txt', 'नमस्ते\r\n', 'नमस्ते दुनिया\r\n'),
      createOperation('.gitignore', 'dist/\n'),
      createOperation('LICENSE', 'Local\n'),
    ]);
    await manager.apply(proposal, folder);
    expect(readFileSync(join(root, 'unicode.txt'), 'utf8')).toBe('नमस्ते दुनिया\r\n');
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('dist/\n');
    expect(readFileSync(join(root, 'LICENSE'), 'utf8')).toBe('Local\n');
  });

  it('rejects a junction or symlink that resolves outside the workspace', async () => {
    const { root, folder, manager } = managerFixture();
    const outside = tempDirectory('codeme-outside-');
    const link = join(root, 'linked');
    try {
      symlinkSync(outside, link, 'junction');
    } catch {
      return;
    }
    const proposal = changeSet([createOperation('linked/new.txt', 'outside')]);
    await expect(manager.assertPreviewable(proposal, folder)).rejects.toThrow(/escapes the workspace/);
  });
});
