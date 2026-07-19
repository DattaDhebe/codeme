import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BackendClient } from '../src/backendClient';
import manifest from '../package.json';
import { inferCodeBlockTargets, workspacePathScore } from '../src/editTarget';
import { ChangeSet, validateChangeSet, validateRelativePath } from '../src/changeSet';
import { sha256Text } from '../src/changeSetManager';

const sampleChangeSet = (): ChangeSet => ({
  id: '11111111-1111-1111-1111-111111111111',
  schema_version: 1,
  conversation_id: 1,
  workspace_id: 1,
  summary: 'Update two files',
  status: 'proposed',
  created_at: '2026-01-01',
  updated_at: '2026-01-01',
  operations: [
    {
      operation_id: 'one', type: 'modify', relative_path: 'src/app.ts', summary: 'Modify',
      base_sha256: '1'.repeat(64), proposed_sha256: sha256Text('new'), encoding: 'utf-8',
      line_ending: 'lf', edits: [], proposed_content: 'new', diff: 'diff',
    },
    {
      operation_id: 'two', type: 'create', relative_path: '.editorconfig', summary: 'Create',
      base_sha256: null, proposed_sha256: sha256Text('root=true'), encoding: 'utf-8',
      line_ending: 'none', edits: [], proposed_content: 'root=true', diff: 'diff',
    },
  ],
});

class FakeConfig {
  get<T>(section: string, defaultValue: T): T {
    if (section === 'personalCodex.backendUrl') {
      return 'http://127.0.0.1:8000' as unknown as T;
    }
    if (section === 'personalCodex.defaultModel') {
      return 'qwen2.5-coder:7b' as unknown as T;
    }
    return defaultValue;
  }
}

describe('BackendClient', () => {
  it('builds correct backend url', async () => {
    const client = new BackendClient(new FakeConfig());
    expect((client as any).backendUrl).toBe('http://127.0.0.1:8000');
  });

  it('loads persisted conversations from the backend', async () => {
    const conversations = [{ id: 7, title: 'Fix parser', created_at: '2026-01-01', updated_at: '2026-01-01' }];
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => conversations,
      text: async () => '',
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new BackendClient(new FakeConfig());
    await expect(client.listConversations()).resolves.toEqual(conversations);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8000/api/conversations',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it('supports deleting a conversation with an empty response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204, text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);

    const client = new BackendClient(new FakeConfig());
    await expect(client.deleteConversation(9)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8000/api/conversations/9',
      expect.objectContaining({ method: 'DELETE' })
    );
  });

  it('reports a complete applied change set with hashes and checkpoint reference', async () => {
    const response = sampleChangeSet();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => response, text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);
    const client = new BackendClient(new FakeConfig());

    await client.reportChangeSetResult(response.id, 'applied', { 'src/app.ts': '2'.repeat(64), '.editorconfig': '3'.repeat(64) }, 'checkpoint.json');

    expect(fetchMock).toHaveBeenCalledWith(
      `http://127.0.0.1:8000/api/change-sets/${response.id}/result`,
      expect.objectContaining({ method: 'POST', body: expect.stringContaining('checkpoint.json') }),
    );
  });

  it('persists command decisions, lifecycle events, and bounded results through dedicated APIs', async () => {
    const response = {
      id: 'run-1', schema_version: 1, conversation_id: 1, workspace_id: 1,
      profile: 'pytest', arguments: ['-q'], cwd_relative: '.', purpose: 'Run tests',
      requested_timeout_seconds: 120, status: 'approved', created_at: '2026-01-01', updated_at: '2026-01-01',
    };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => response, text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);
    const client = new BackendClient(new FakeConfig());

    await client.decideCommandRun('run-1', 'approve', 'BUILD_OR_TEST', 'Runs repository tests', 'python', ['PATH']);
    await client.reportCommandEvent('run-1', 'starting', 'Starting');
    await client.reportCommandResult('run-1', {
      status: 'completed', exitCode: 0, terminationReason: 'exit',
      startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:00:01Z', durationMs: 1000,
      stdoutTail: 'ok', stderrTail: '', outputTruncated: false, timedOut: false, cancelled: false,
    });

    expect(fetchMock).toHaveBeenNthCalledWith(1, expect.stringMatching(/command-runs\/run-1\/decision$/), expect.objectContaining({
      method: 'POST', body: expect.stringContaining('BUILD_OR_TEST'),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, expect.stringMatching(/command-runs\/run-1\/events$/), expect.objectContaining({
      method: 'POST', body: expect.stringContaining('starting'),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, expect.stringMatching(/command-runs\/run-1\/result$/), expect.objectContaining({
      method: 'POST', body: expect.stringContaining('stdout_tail'),
    }));
  });

  it('uses dedicated versioned verification lifecycle APIs', async () => {
    const response = { id: 'verify-1', schema_version: 1, plan_fingerprint: 'a'.repeat(64), steps: [] };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => response, text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);
    const client = new BackendClient(new FakeConfig());

    await client.createVerificationSession({
      conversationId: 1, workspaceId: 2, originalRequest: 'Fix value', mode: 'quick', sourceChangeSetId: 'change-1',
      maximumRepairAttempts: 2, maximumReruns: 2, totalTimeBudgetSeconds: 600,
    });
    await client.decideVerificationPlan('verify-1', 'approve', 'a'.repeat(64));
    await client.startVerificationStep('verify-1', 'step-1', 'a'.repeat(64));
    await client.reportVerificationStep('verify-1', 'step-1', 'a'.repeat(64), 'run-1');
    await client.reportVerificationRepair('verify-1', 'applied', 'change-2');

    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual(expect.arrayContaining([
      expect.stringMatching(/verification-sessions$/),
      expect.stringMatching(/verification-sessions\/verify-1\/decision$/),
      expect.stringMatching(/verification-sessions\/verify-1\/steps\/step-1\/start$/),
      expect.stringMatching(/verification-sessions\/verify-1\/steps\/step-1\/result$/),
      expect.stringMatching(/verification-sessions\/verify-1\/repair-result$/),
    ]));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('extension manifest', () => {
  it('contributes the sidebar as a webview', () => {
    expect(manifest.activationEvents).toContain('onView:personalCodemeSidebar');
    expect(manifest.contributes.views.personalCodeme).toContainEqual({
      id: 'personalCodemeSidebar',
      name: 'Personal Codeme',
      type: 'webview',
    });
  });

  it('disables legacy raw command execution by default', () => {
    expect(manifest.contributes.configuration.properties['personalCodex.enableUnsafeCommandExecution'].default).toBe(false);
    expect(manifest.contributes.configuration.properties['personalCodex.enableUnsafeCommandExecution'].deprecationMessage).toMatch(/display-only/i);
  });
});

describe('transactional change-set contract', () => {
  it('accepts multi-file create and modify operations', () => {
    expect(() => validateChangeSet(sampleChangeSet())).not.toThrow();
  });

  it('rejects traversal, absolute paths, missing hashes, and duplicates', () => {
    expect(() => validateRelativePath('../outside.txt')).toThrow();
    expect(() => validateRelativePath('C:\\outside.txt')).toThrow();
    const missingHash = sampleChangeSet();
    missingHash.operations[0].base_sha256 = null;
    expect(() => validateChangeSet(missingHash)).toThrow(/base hash/);
    const duplicate = sampleChangeSet();
    duplicate.operations[1].relative_path = 'SRC/APP.TS';
    expect(() => validateChangeSet(duplicate)).toThrow(/Duplicate/);
  });

  it('hashes Unicode and line endings deterministically', () => {
    expect(sha256Text('नमस्ते\n')).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Text('a\n')).not.toBe(sha256Text('a\r\n'));
  });
});

describe('Copilot-style webview', () => {
  it('includes the core chat, history, context, and code-action controls', () => {
    const source = readFileSync(resolve(__dirname, '../src/webview/webview.ts'), 'utf8');
    for (const capability of [
      'toggleHistory',
      'loadConversation',
      'requestContext',
      'cancelStream',
      'code-apply',
      'code-open',
      'model-select',
      'previewChangeSet',
      'applyChangeSet',
      'restoreChangeSet',
      'runCommandProposal',
      'rejectCommandProposal',
      'cancelCommandRun',
      'copyCommandDetails',
      'copyCommandOutput',
      'Output was truncated',
      "escapeHtml(proposal.stdout)",
      'Approve complete plan',
      'previewVerificationRepair',
      'applyVerificationRepair',
      'rejectVerificationRepair',
      'verificationStepOutput',
    ]) {
      expect(source).toContain(capability);
    }
    for (const status of ['proposed', 'starting', 'running', 'completed', 'failed', 'timed_out', 'cancelled', 'blocked']) {
      expect(source).toContain(status);
    }
    expect(source).toContain('Legacy raw commands cannot execute');
    expect(source).not.toContain("isFile ? 'Apply' : 'Run'");
  });

  it('reuses the Phase 4 manager and Phase 5 runner for repair and verification', () => {
    const provider = readFileSync(resolve(__dirname, '../src/sidebarProvider.ts'), 'utf8');
    expect(provider).toContain('this.processRunner.run(command, policy');
    expect(provider).toContain('const applied = await this.applyChangeSet(changeSet)');
    expect(provider).toContain("'Extension reloaded while a controlled process was active'");
    expect(provider).not.toContain('exec(');
    expect(provider).not.toContain('spawn(');
  });

  it('targets named whole-file code blocks without mistaking an extension for a file', () => {
    const markdown = 'Here is the updated `.gitignore` file with only the addition of `.zip`:\n\n```plaintext\nnode_modules/\n*.zip\n```';
    expect(inferCodeBlockTargets(markdown)).toEqual(['.gitignore']);
    expect(workspacePathScore('.zip')).toBe(0);
  });

  it('uses explicit code-fence filenames before nearby text', () => {
    const markdown = 'Update `old.ts`:\n```typescript path=src/new.ts\nexport const value = 1;\n```';
    expect(inferCodeBlockTargets(markdown)).toEqual(['src/new.ts']);
  });
});
