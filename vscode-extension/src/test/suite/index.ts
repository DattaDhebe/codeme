import * as path from 'path';
import * as vscode from 'vscode';
import { describe, it } from 'vitest';

describe('Extension', () => {
  it('should load the extension', async () => {
    const extension = vscode.extensions.getExtension('personal-codex-local.personal-codeme');
    if (!extension) {
      throw new Error('Personal Codex extension not found');
    }
    await extension.activate();
  });
});
