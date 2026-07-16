import { describe, it } from 'vitest';
import * as assert from 'assert';
import * as vscode from 'vscode';

describe('Personal Codex Extension', () => {
  it('activates without error', async () => {
    const extension = vscode.extensions.getExtension('personal-codex-local.personal-codex');
    assert.ok(extension, 'Extension should be present');
    await extension.activate();
  });
});
