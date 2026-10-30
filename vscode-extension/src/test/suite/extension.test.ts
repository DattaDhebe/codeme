import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ChangeOperation, ChangeSet } from '../../changeSet';
import { ChangeSetManager, sha256Text } from '../../changeSetManager';

function operation(type: 'create' | 'modify', relativePath: string, before: string | null, after: string): ChangeOperation {
  return {
    operation_id: type + '-' + relativePath, type, relative_path: relativePath, summary: 'Native fixture',
    base_sha256: before === null ? null : sha256Text(before), proposed_sha256: sha256Text(after),
    proposed_content: after, encoding: 'utf-8', line_ending: after.includes('\r\n') ? 'crlf' : after.includes('\n') ? 'lf' : 'none',
    edits: [], diff: 'Native fixture exact-content check',
  };
}

function proposal(id: string, operations: ChangeOperation[]): ChangeSet {
  return {
    id, schema_version: 1, conversation_id: 1, workspace_id: 1, summary: 'Native change-set fixture',
    status: 'approved', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), operations,
  };
}

export async function runNativeChangeSetTests(): Promise<void> {
  const runDirectory = process.env.CODEME_NATIVE_RUN_DIRECTORY;
  assert.ok(runDirectory, 'Tests must be launched through scripts/native-test-runner.cjs');
  const expectedWorkspace = path.join(runDirectory, 'workspace');
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'The isolated fixture workspace must be open');
  assert.equal(vscode.workspace.workspaceFolders?.length, 1);
  const actualPath = await fs.realpath(folder.uri.fsPath);
  const expectedPath = await fs.realpath(expectedWorkspace);
  assert.equal(process.platform === 'win32' ? actualPath.toLowerCase() : actualPath,
    process.platform === 'win32' ? expectedPath.toLowerCase() : expectedPath, 'Refusing to touch a non-fixture workspace');
  const extension = vscode.extensions.getExtension('personal-codex-local.personal-codeme');
  assert.ok(extension, 'The real development extension must be loaded');
  await extension.activate();
  assert.ok(extension.isActive, 'Extension activation completed');
  console.log('PASS native extension activation');

  const manager = new ChangeSetManager({ globalStorageUri: vscode.Uri.file(path.join(runDirectory, 'checkpoints')) } as vscode.ExtensionContext);
  const original = 'नमस्ते\r\noriginal line\r\n';
  const changed = 'नमस्ते दुनिया\r\napproved line\r\n';
  const existingPath = path.join(expectedWorkspace, 'existing-unicode.txt');
  await fs.writeFile(existingPath, original, 'utf8');
  await vscode.workspace.openTextDocument(vscode.Uri.file(existingPath));
  const changeSet = proposal('native-apply-restore', [
    operation('modify', 'existing-unicode.txt', original, changed),
    operation('create', 'generated/deep/new-lf.ts', null, 'export const greeting = "नमस्ते 🚀";\n'),
    operation('create', 'generated/deep/new-crlf.txt', null, 'Unicode Ελληνικά\r\nsecond line\r\n'),
  ]);
  await manager.assertPreviewable(changeSet, folder);
  assert.equal(await fs.stat(path.join(expectedWorkspace, 'generated')).catch(() => null), null, 'Preview must not create directories');
  const result = await manager.apply(changeSet, folder);
  for (const item of changeSet.operations) {
    const target = path.join(expectedWorkspace, item.relative_path);
    assert.equal(await fs.readFile(target, 'utf8'), item.proposed_content, 'Disk must match reviewed bytes: ' + item.relative_path);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
    assert.equal(document.getText(), item.proposed_content, 'Editor must match reviewed bytes: ' + item.relative_path);
    assert.equal(document.isDirty, false, 'Editor must be saved: ' + item.relative_path);
    assert.equal(result.resultHashes[item.relative_path], item.proposed_sha256);
  }
  console.log('PASS native apply persists modify/create, Unicode, LF and CRLF to editor and disk');
  changeSet.checkpoint_reference = result.checkpointReference;
  await manager.restore(changeSet, folder);
  assert.equal(await fs.readFile(existingPath, 'utf8'), original);
  assert.equal((await vscode.workspace.openTextDocument(vscode.Uri.file(existingPath))).isDirty, false);
  assert.equal(await fs.stat(path.join(expectedWorkspace, 'generated')).catch(() => null), null, 'Restore removes only owned empty directories');
  console.log('PASS native restore preserves original bytes and removes created files');

  const dirtyDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(existingPath));
  const userEdit = new vscode.WorkspaceEdit();
  userEdit.insert(dirtyDocument.uri, new vscode.Position(0, 0), 'unsaved user edit\r\n');
  assert.equal(await vscode.workspace.applyEdit(userEdit), true);
  assert.equal(dirtyDocument.isDirty, true);
  await assert.rejects(manager.apply(proposal('native-dirty-conflict', [operation('modify', 'existing-unicode.txt', original, changed)]), folder), /Unsaved changes/);
  assert.equal(await fs.readFile(existingPath, 'utf8'), original, 'Rejected dirty editor must not change disk');
  await vscode.window.showTextDocument(dirtyDocument, { preview: false });
  await vscode.commands.executeCommand('workbench.action.files.revert');
  console.log('PASS native dirty editor conflict protects unsaved work');

  // Exercise a real save hook, rather than a fake document.save implementation.
  let rewriteOnce = true;
  const hook = vscode.workspace.onWillSaveTextDocument(event => {
    const isTarget = process.platform === 'win32' ? event.document.uri.fsPath.toLowerCase() === existingPath.toLowerCase()
      : event.document.uri.fsPath === existingPath;
    if (rewriteOnce && isTarget) {
      rewriteOnce = false;
      event.waitUntil(Promise.resolve([vscode.TextEdit.insert(new vscode.Position(0, 0), 'save hook rewrite\r\n')]));
    }
  });
  try {
    await assert.rejects(manager.apply(proposal('native-save-transform', [operation('modify', 'existing-unicode.txt', original, changed)]), folder), /Saved content differs|Editor content changed|Recovery checkpoint/);
    assert.match(await fs.readFile(existingPath, 'utf8'), /^save hook rewrite/, 'Changed-on-save content is preserved for explicit recovery');
    console.log('PASS native save-hook rewrite cannot be reported as reviewed application success');
  } finally {
    hook.dispose();
  }
  await fs.writeFile(path.join(runDirectory, 'result.json'), JSON.stringify({ status: 'passed', checks: 5, vscode: vscode.version }, null, 2));
}
