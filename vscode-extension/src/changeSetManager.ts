import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ChangeOperation, ChangeSet, validateChangeSet, validateRelativePath } from './changeSet';

interface CheckpointFile {
  relativePath: string;
  existed: boolean;
  originalBase64: string;
  originalSha256: string | null;
  appliedSha256: string;
}

interface Checkpoint {
  schemaVersion: 1;
  changeSetId: string;
  workspaceRoot: string;
  createdAt: string;
  files: CheckpointFile[];
  createdDirectories?: string[];
}

export interface ApplyResult {
  checkpointReference: string;
  resultHashes: Record<string, string>;
}

export class ChangeSetConflictError extends Error {}

export function sha256Bytes(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function sha256Text(value: string): string {
  return sha256Bytes(Buffer.from(value, 'utf8'));
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? path.normalize(left).toLowerCase() === path.normalize(right).toLowerCase()
    : path.normalize(left) === path.normalize(right);
}

export class ChangeSetManager {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async assertPreviewable(changeSet: ChangeSet, folder: vscode.WorkspaceFolder): Promise<void> {
    validateChangeSet(changeSet);
    const root = await fs.realpath(folder.uri.fsPath);
    for (const operation of changeSet.operations) {
      this.reviewedEndOfLine(operation.proposed_content);
      const target = await this.resolveTarget(root, operation);
      const openDocument = this.findOpenDocument(vscode.Uri.file(target));
      if (openDocument?.isDirty) {
        throw new ChangeSetConflictError(`Unsaved changes block preview for ${operation.relative_path}.`);
      }
      if (operation.type === 'create') {
        if (await this.exists(target)) throw new ChangeSetConflictError(`Create target now exists: ${operation.relative_path}`);
      } else {
        const document = openDocument || await vscode.workspace.openTextDocument(vscode.Uri.file(target));
        if (sha256Text(document.getText()) !== operation.base_sha256
          || sha256Bytes(await fs.readFile(target)) !== operation.base_sha256) {
          throw new ChangeSetConflictError(`The file changed after proposal: ${operation.relative_path}`);
        }
      }
    }
  }

  async apply(changeSet: ChangeSet, folder: vscode.WorkspaceFolder): Promise<ApplyResult> {
    validateChangeSet(changeSet);
    const root = await fs.realpath(folder.uri.fsPath);
    const documents = new Map<string, vscode.TextDocument>();
    const checkpoint: Checkpoint = {
      schemaVersion: 1,
      changeSetId: changeSet.id,
      workspaceRoot: root,
      createdAt: new Date().toISOString(),
      files: [],
      createdDirectories: [],
    };

    for (const operation of changeSet.operations) {
      this.reviewedEndOfLine(operation.proposed_content);
      const target = await this.resolveTarget(root, operation);
      const uri = vscode.Uri.file(target);
      const openDocument = this.findOpenDocument(uri);
      if (openDocument?.isDirty) {
        throw new ChangeSetConflictError(`Unsaved changes block ${operation.relative_path}. Save or revert them before applying.`);
      }
      if (operation.type === 'create') {
        if (await this.exists(target)) throw new ChangeSetConflictError(`Create target now exists: ${operation.relative_path}`);
        checkpoint.files.push({
          relativePath: operation.relative_path,
          existed: false,
          originalBase64: '',
          originalSha256: null,
          appliedSha256: operation.proposed_sha256,
        });
      } else {
        const document = openDocument || await vscode.workspace.openTextDocument(uri);
        const current = document.getText();
        if (sha256Text(current) !== operation.base_sha256) {
          throw new ChangeSetConflictError(`The file changed after preview: ${operation.relative_path}`);
        }
        if (sha256Bytes(await fs.readFile(target)) !== operation.base_sha256) {
          throw new ChangeSetConflictError(`The disk file changed after preview: ${operation.relative_path}`);
        }
        documents.set(operation.relative_path, document);
        checkpoint.files.push({
          relativePath: operation.relative_path,
          existed: true,
          originalBase64: Buffer.from(current, 'utf8').toString('base64'),
          originalSha256: operation.base_sha256,
          appliedSha256: operation.proposed_sha256,
        });
      }
      if (sha256Text(operation.proposed_content) !== operation.proposed_sha256) {
        throw new ChangeSetConflictError(`Proposed content hash is invalid: ${operation.relative_path}`);
      }
    }

    const checkpointReference = await this.writeCheckpoint(checkpoint);
    let editStarted = false;
    let completeEditApplied = false;
    try {
      for (const operation of changeSet.operations) {
        if (operation.type === 'create') await this.createParents(root, operation.relative_path, checkpoint);
      }
      await this.writeCheckpoint(checkpoint);
      const edit = new vscode.WorkspaceEdit();
      for (const operation of changeSet.operations) {
        await this.resolveTarget(root, operation);
        const target = vscode.Uri.file(path.join(root, validateRelativePath(operation.relative_path)));
        if (operation.type === 'create') {
          edit.createFile(target, { overwrite: false, ignoreIfExists: false });
          edit.insert(target, new vscode.Position(0, 0), operation.proposed_content);
        } else {
          const document = documents.get(operation.relative_path)!;
          if (document.isDirty || sha256Text(document.getText()) !== operation.base_sha256
            || sha256Bytes(await fs.readFile(target.fsPath)) !== operation.base_sha256) {
            throw new ChangeSetConflictError(`The file changed while preparing application: ${operation.relative_path}`);
          }
          edit.replace(target, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), operation.proposed_content);
        }
        this.setReviewedEndOfLine(edit, target, operation.proposed_content);
      }

      editStarted = true;
      const applied = await vscode.workspace.applyEdit(edit);
      completeEditApplied = applied;
      if (!applied) throw new Error('VS Code rejected the complete WorkspaceEdit.');
      await this.saveFiles(changeSet.operations.map((operation) => ({
        relativePath: operation.relative_path, expectedHash: operation.proposed_sha256,
      })), root);
      const resultHashes = await this.verifyApplied(changeSet, root);
      return { checkpointReference, resultHashes };
    } catch (error) {
      try {
        if (editStarted) await this.rollbackCheckpoint(checkpoint, completeEditApplied);
      } catch (rollbackError) {
        throw new Error(`${(error as Error).message} Automatic rollback stopped: ${(rollbackError as Error).message} Recovery checkpoint: ${checkpointReference}`);
      } finally {
        await this.removeCreatedDirectories(checkpoint);
      }
      throw error;
    }
  }

  async restore(changeSet: ChangeSet, folder: vscode.WorkspaceFolder): Promise<void> {
    const checkpointReference = changeSet.checkpoint_reference;
    if (!checkpointReference) throw new ChangeSetConflictError('This change set has no checkpoint.');
    const checkpoint = await this.readCheckpoint(checkpointReference);
    const root = await fs.realpath(folder.uri.fsPath);
    if (!samePath(checkpoint.workspaceRoot, root)) {
      throw new ChangeSetConflictError('The checkpoint belongs to a different workspace.');
    }

    for (const file of checkpoint.files) {
      const operation = changeSet.operations.find((item) => item.relative_path === file.relativePath);
      if (!operation) throw new ChangeSetConflictError(`Checkpoint operation is missing: ${file.relativePath}`);
      const target = await this.resolveTarget(root, operation, true);
      if (!(await this.exists(target))) throw new ChangeSetConflictError(`Applied file is missing: ${file.relativePath}`);
      const document = this.findOpenDocument(vscode.Uri.file(target)) || await vscode.workspace.openTextDocument(vscode.Uri.file(target));
      if (document.isDirty || sha256Text(document.getText()) !== file.appliedSha256
        || sha256Bytes(await fs.readFile(target)) !== file.appliedSha256) {
        throw new ChangeSetConflictError(`Restore conflict: ${file.relativePath} changed after application.`);
      }
    }

    const edit = new vscode.WorkspaceEdit();
    for (const file of checkpoint.files) {
      const uri = vscode.Uri.file(path.join(root, validateRelativePath(file.relativePath)));
      this.assertInside(root, await fs.realpath(uri.fsPath), file.relativePath);
      if (!file.existed) {
        edit.deleteFile(uri, { ignoreIfNotExists: false, recursive: false });
      } else {
        const document = this.findOpenDocument(uri) || await vscode.workspace.openTextDocument(uri);
        const original = Buffer.from(file.originalBase64, 'base64').toString('utf8');
        edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), original);
        this.setReviewedEndOfLine(edit, uri, original);
      }
    }
    if (!(await vscode.workspace.applyEdit(edit))) throw new Error('VS Code rejected the restore WorkspaceEdit.');
    await this.saveFiles(checkpoint.files.filter((file) => file.existed).map((file) => ({
      relativePath: file.relativePath, expectedHash: file.originalSha256!,
    })), root);

    for (const file of checkpoint.files) {
      const target = path.join(root, validateRelativePath(file.relativePath));
      if (!file.existed) {
        if (await this.exists(target)) throw new Error(`Restore verification failed for ${file.relativePath}`);
      } else {
        const document = this.findOpenDocument(vscode.Uri.file(target)) || await vscode.workspace.openTextDocument(vscode.Uri.file(target));
        if (sha256Text(document.getText()) !== file.originalSha256
          || sha256Bytes(await fs.readFile(target)) !== file.originalSha256) throw new Error(`Restore verification failed for ${file.relativePath}`);
      }
    }
    await this.removeCreatedDirectories(checkpoint);
  }

  private async saveFiles(files: Array<{ relativePath: string; expectedHash: string }>, root: string): Promise<void> {
    for (const file of files) {
      const uri = vscode.Uri.file(path.join(root, validateRelativePath(file.relativePath)));
      this.assertInside(root, await fs.realpath(uri.fsPath), file.relativePath);
      const document = this.findOpenDocument(uri) || await vscode.workspace.openTextDocument(uri);
      if (sha256Text(document.getText()) !== file.expectedHash) throw new ChangeSetConflictError(`Editor content changed before saving: ${file.relativePath}`);
      if (!(await document.save())) throw new Error(`Could not save ${file.relativePath}. The change cannot be reported as applied.`);
      if (document.isDirty || sha256Text(document.getText()) !== file.expectedHash
        || sha256Bytes(await fs.readFile(uri.fsPath)) !== file.expectedHash) {
        throw new ChangeSetConflictError(`Saved content differs from the reviewed change: ${file.relativePath}`);
      }
    }
  }

  private reviewedEndOfLine(content: string): vscode.EndOfLine | undefined {
    if (/\r(?!\n)/.test(content) || /\r\n/.test(content) && /(^|[^\r])\n/.test(content)) {
      throw new ChangeSetConflictError('Mixed or bare-CR line endings cannot be preserved by the editor. Request a consistent LF or CRLF proposal.');
    }
    return content.includes('\r\n') ? vscode.EndOfLine.CRLF : content.includes('\n') ? vscode.EndOfLine.LF : undefined;
  }

  private setReviewedEndOfLine(edit: vscode.WorkspaceEdit, uri: vscode.Uri, content: string): void {
    const eol = this.reviewedEndOfLine(content);
    // The native extension-host implementation appends nonempty set() arrays.
    // Re-adding get(uri) duplicates edits and causes overlapping-range failures.
    if (eol !== undefined) edit.set(uri, [vscode.TextEdit.setEndOfLine(eol)]);
  }

  private async verifyApplied(changeSet: ChangeSet, root: string): Promise<Record<string, string>> {
    const hashes: Record<string, string> = {};
    for (const operation of changeSet.operations) {
      await this.resolveTarget(root, operation, true);
      const uri = vscode.Uri.file(path.join(root, validateRelativePath(operation.relative_path)));
      const document = this.findOpenDocument(uri) || await vscode.workspace.openTextDocument(uri);
      const hash = sha256Text(document.getText());
      if (hash !== operation.proposed_sha256) throw new Error(`Application verification failed for ${operation.relative_path}`);
      if (sha256Bytes(await fs.readFile(uri.fsPath)) !== operation.proposed_sha256) throw new Error(`Disk verification failed for ${operation.relative_path}`);
      hashes[operation.relative_path] = hash;
    }
    return hashes;
  }

  private async rollbackCheckpoint(checkpoint: Checkpoint, completeEditApplied: boolean): Promise<void> {
    // A failed save/formatter or a concurrent user edit must never be overwritten
    // just because application failed. Recover only known original/proposed bytes.
    for (const file of checkpoint.files) {
      const target = await this.resolveTarget(checkpoint.workspaceRoot, {
        relative_path: file.relativePath, type: file.existed ? 'modify' : 'create',
      }, true);
      if (!(await this.exists(target))) {
        if (file.existed) throw new ChangeSetConflictError(`Rollback conflict: ${file.relativePath} was removed.`);
        continue;
      }
      const allowed = new Set([file.appliedSha256, file.originalSha256 || sha256Text('')]);
      const document = this.findOpenDocument(vscode.Uri.file(target));
      const diskHash = sha256Bytes(await fs.readFile(target));
      const knownPendingCreate = document?.isDirty && file.appliedSha256 !== sha256Text('') && sha256Text(document.getText()) === file.appliedSha256;
      if (!file.existed && !completeEditApplied && diskHash === sha256Text('') && !knownPendingCreate) {
        throw new ChangeSetConflictError(`Rollback conflict: ownership of empty ${file.relativePath} is uncertain; the file was preserved.`);
      }
      if (!allowed.has(diskHash)
        || document && !allowed.has(sha256Text(document.getText()))) {
        throw new ChangeSetConflictError(`Rollback conflict: ${file.relativePath} contains newer changes.`);
      }
    }
    const edit = new vscode.WorkspaceEdit();
    for (const file of checkpoint.files) {
      const uri = vscode.Uri.file(path.join(checkpoint.workspaceRoot, validateRelativePath(file.relativePath)));
      if (!file.existed) {
        edit.deleteFile(uri, { ignoreIfNotExists: true, recursive: false });
        continue;
      }
      try {
        const document = this.findOpenDocument(uri) || await vscode.workspace.openTextDocument(uri);
        const original = Buffer.from(file.originalBase64, 'base64').toString('utf8');
        edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), original);
        this.setReviewedEndOfLine(edit, uri, original);
      } catch {
        edit.createFile(uri, { ignoreIfExists: true });
        edit.insert(uri, new vscode.Position(0, 0), Buffer.from(file.originalBase64, 'base64').toString('utf8'));
      }
    }
    if (!(await vscode.workspace.applyEdit(edit))) throw new Error('Rollback failed. The saved checkpoint is available for recovery.');
    await this.saveFiles(checkpoint.files.filter((file) => file.existed).map((file) => ({
      relativePath: file.relativePath, expectedHash: file.originalSha256!,
    })), checkpoint.workspaceRoot);
  }

  private async resolveTarget(root: string, operation: Pick<ChangeOperation, 'relative_path' | 'type'>, allowExistingCreate = false): Promise<string> {
    const relativePath = validateRelativePath(operation.relative_path);
    const target = path.resolve(root, relativePath);
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new ChangeSetConflictError(`Path escapes the workspace: ${relativePath}`);
    }
    if (await this.exists(target)) {
      const realTarget = await fs.realpath(target);
      this.assertInside(root, realTarget, relativePath);
      if (operation.type === 'create' && !allowExistingCreate) {
        throw new ChangeSetConflictError(`Create target already exists: ${relativePath}`);
      }
    } else {
      let parent = path.dirname(target);
      while (!(await this.exists(parent))) {
        const next = path.dirname(parent);
        if (next === parent) throw new ChangeSetConflictError(`No safe parent exists for ${relativePath}`);
        parent = next;
      }
      const realParent = await fs.realpath(parent);
      this.assertInside(root, realParent, relativePath);
      if (!(await fs.stat(parent)).isDirectory()) {
        throw new ChangeSetConflictError(`Create parent is not a directory: ${relativePath}`);
      }
      if (operation.type !== 'create' && path.normalize(parent) !== path.normalize(path.dirname(target))) {
        throw new ChangeSetConflictError(`Create parent does not exist: ${relativePath}`);
      }
    }
    return target;
  }

  private async createParents(root: string, relativePath: string, checkpoint: Checkpoint): Promise<void> {
    const components = validateRelativePath(relativePath).split(/[\\/]/).slice(0, -1);
    let parent = root;
    for (const component of components) {
      parent = path.join(parent, component);
      this.assertInside(root, parent, relativePath);
      try {
        await fs.mkdir(parent);
        checkpoint.createdDirectories!.push(path.relative(root, parent).split(path.sep).join('/'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      this.assertInside(root, await fs.realpath(parent), relativePath);
      if (!(await fs.stat(parent)).isDirectory()) throw new ChangeSetConflictError(`Create parent is not a directory: ${relativePath}`);
    }
  }

  private async removeCreatedDirectories(checkpoint: Checkpoint): Promise<void> {
    for (const relativePath of [...(checkpoint.createdDirectories || [])].reverse()) {
      const target = path.resolve(checkpoint.workspaceRoot, validateRelativePath(relativePath));
      this.assertInside(checkpoint.workspaceRoot, target, relativePath);
      try {
        if ((await fs.lstat(target)).isSymbolicLink()) continue;
        this.assertInside(checkpoint.workspaceRoot, await fs.realpath(target), relativePath);
        // Remove only empty directories created by this application; user files survive.
        await fs.rmdir(target);
      } catch (error) {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code || '')) throw error;
      }
    }
  }

  private assertInside(root: string, target: string, relativePath: string): void {
    const relative = path.relative(root, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new ChangeSetConflictError(`Symlink or junction escapes the workspace: ${relativePath}`);
    }
  }

  private findOpenDocument(uri: vscode.Uri): vscode.TextDocument | undefined {
    return vscode.workspace.textDocuments.find((document) => samePath(document.uri.fsPath, uri.fsPath));
  }

  private async exists(target: string): Promise<boolean> {
    try {
      await fs.lstat(target);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  private checkpointUri(reference: string): vscode.Uri {
    return vscode.Uri.joinPath(this.context.globalStorageUri, 'change-set-checkpoints', reference);
  }

  private async writeCheckpoint(checkpoint: Checkpoint): Promise<string> {
    const reference = `${checkpoint.changeSetId}.json`;
    const directory = vscode.Uri.joinPath(this.context.globalStorageUri, 'change-set-checkpoints');
    await vscode.workspace.fs.createDirectory(directory);
    await vscode.workspace.fs.writeFile(this.checkpointUri(reference), Buffer.from(JSON.stringify(checkpoint), 'utf8'));
    return reference;
  }

  private async readCheckpoint(reference: string): Promise<Checkpoint> {
    if (!/^[a-zA-Z0-9._-]+\.json$/.test(reference)) throw new ChangeSetConflictError('Invalid checkpoint reference.');
    const bytes = await vscode.workspace.fs.readFile(this.checkpointUri(reference));
    const checkpoint = JSON.parse(Buffer.from(bytes).toString('utf8')) as Checkpoint;
    if (checkpoint.schemaVersion !== 1) throw new ChangeSetConflictError('Unsupported checkpoint version.');
    return checkpoint;
  }
}
