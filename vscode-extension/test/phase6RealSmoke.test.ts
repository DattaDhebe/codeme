import { ChildProcess, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { BackendSettings } from '../src/backendClient';
import { ChangeSet } from '../src/changeSet';
import { ChangeSetManager, sha256Text } from '../src/changeSetManager';
import { evaluateCommandPolicy } from '../src/commandPolicy';
import { CommandExecutionResult, CommandRun } from '../src/commandRun';
import { ControlledProcessRunner } from '../src/processRunner';
import { VerificationSession, VerificationStepStart } from '../src/verification';

const enabled = process.env.PERSONAL_CODEX_PHASE6_REAL_SMOKE === '1';
const extensionRoot = resolve(__dirname, '..');
const repositoryRoot = resolve(extensionRoot, '..');

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolvePort(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

async function request<T>(baseUrl: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

async function waitForBackend(baseUrl: string, backend: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (backend.exitCode !== null) throw new Error(`Temporary backend exited with ${backend.exitCode}`);
    try { if ((await fetch(`${baseUrl}/health`)).ok) return; } catch { /* starting */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error('Temporary Phase 6 backend did not start');
}

function settings(python: string): BackendSettings {
  return { get: <T>(key: string, fallback: T) => key === 'pythonExecutable' ? python as T : fallback };
}

async function executeStep(baseUrl: string, root: string, python: string, session: VerificationSession): Promise<VerificationSession> {
  const pending = session.steps.find((step) => step.status === 'PENDING');
  if (!pending) throw new Error('No pending exact-plan step');
  const started = await request<VerificationStepStart>(
    baseUrl, `/api/verification-sessions/${session.id}/steps/${pending.step_id}/start`,
    { plan_fingerprint: session.plan_fingerprint },
  );
  let command = started.command_run;
  const policy = await evaluateCommandPolicy(command, root, root, settings(python), { PATH: process.env.PATH, TEMP: tmpdir() });
  expect(policy.network).toBe(false);
  command = await request<CommandRun>(baseUrl, `/api/command-runs/${command.id}/decision`, {
    decision: 'approve', calculated_risk: policy.risk, risk_explanation: policy.explanation,
    resolved_executable_name: policy.executableName, environment_keys: policy.environmentKeys,
  });
  command = await request<CommandRun>(baseUrl, `/api/command-runs/${command.id}/events`, { status: 'starting', detail: 'Phase 6 smoke starting' });
  const runner = new ControlledProcessRunner();
  const resultPromise = runner.run(command, policy, () => undefined);
  await request<CommandRun>(baseUrl, `/api/command-runs/${command.id}/events`, { status: 'running', detail: 'Phase 6 smoke running' });
  const result: CommandExecutionResult = await resultPromise;
  await request<CommandRun>(baseUrl, `/api/command-runs/${command.id}/result`, {
    status: result.status, exit_code: result.exitCode, termination_reason: result.terminationReason,
    started_at: result.startedAt, completed_at: result.completedAt, duration_ms: result.durationMs,
    stdout_tail: result.stdoutTail, stderr_tail: result.stderrTail, output_truncated: result.outputTruncated,
    timed_out: result.timedOut, cancelled: result.cancelled, failure_reason: result.failureReason,
  });
  return request<VerificationSession>(
    baseUrl, `/api/verification-sessions/${session.id}/steps/${pending.step_id}/result`,
    { plan_fingerprint: session.plan_fingerprint, command_run_id: command.id },
  );
}

describe.skipIf(!enabled)('Phase 6 isolated real Ollama verification and repair', () => {
  it('fails, prepares and applies a Qwen repair, reruns the exact plan, then restores', async () => {
    const root = mkdtempSync(join(tmpdir(), 'personal-codex-phase6-smoke-'));
    const storage = mkdtempSync(join(tmpdir(), 'personal-codex-phase6-checkpoints-'));
    const python = join(repositoryRoot, '.venv', 'Scripts', 'python.exe');
    const database = join(root, 'phase6.db').replace(/\\/g, '/');
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    let backendLog = '';
    const backend = spawn(python, ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', String(port)], {
      cwd: repositoryRoot,
      env: { ...process.env, DATABASE_URL: `sqlite:///${database}`, DEFAULT_MODEL: 'qwen2.5-coder:7b' },
      shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    backend.stdout?.on('data', (chunk: Buffer) => { backendLog = (backendLog + chunk.toString()).slice(-12_000); });
    backend.stderr?.on('data', (chunk: Buffer) => { backendLog = (backendLog + chunk.toString()).slice(-12_000); });
    try {
      writeFileSync(join(root, 'math_utils.py'), 'def answer():\n    return 1\n', 'utf8');
      writeFileSync(join(root, 'test_math_utils.py'), "from math_utils import answer\n\ndef test_answer():\n    assert answer() == 2\n", 'utf8');
      writeFileSync(join(root, 'pytest.ini'), '[pytest]\ntestpaths = .\n', 'utf8');
      expect(spawnSync('git', ['init'], { cwd: root, shell: false, windowsHide: true }).status).toBe(0);
      const originalHash = sha256Text(readFileSync(join(root, 'math_utils.py'), 'utf8'));
      await waitForBackend(baseUrl, backend);
      const workspace = await request<{ id: number }>(baseUrl, '/api/workspaces', { path: root, display_name: 'Phase 6 smoke' });
      const conversation = await request<{ id: number }>(baseUrl, '/api/conversations', { title: 'Phase 6 real smoke' });
      let session = await request<VerificationSession>(baseUrl, '/api/verification-sessions', {
        conversation_id: conversation.id, workspace_id: workspace.id, original_request: 'Make answer return 2',
        mode: 'quick', maximum_repair_attempts: 2, maximum_reruns: 2, total_time_budget_seconds: 600,
      });
      expect(session.steps.map((step) => step.profile)).toEqual(['pytest']);
      const approvedFingerprint = session.plan_fingerprint;
      session = await request<VerificationSession>(baseUrl, `/api/verification-sessions/${session.id}/decision`, {
        decision: 'approve', plan_fingerprint: approvedFingerprint,
      });
      session = await executeStep(baseUrl, root, python, session);
      expect(session.state).toBe('VERIFICATION_FAILED');
      session = await request<VerificationSession>(baseUrl, `/api/verification-sessions/${session.id}/repair`, { model: 'qwen2.5-coder:7b' });
      if (session.state !== 'AWAITING_REPAIR_APPROVAL') {
        throw new Error(`Repair did not reach approval: ${JSON.stringify(session.repair_attempts.at(-1))}`);
      }
      const attempt = session.repair_attempts.at(-1)!;
      expect(attempt.repair_change_set_id).toBeTruthy();
      const repair = await request<ChangeSet>(baseUrl, `/api/change-sets/${attempt.repair_change_set_id}`);
      expect(repair.operations.every((operation) => !operation.relative_path.includes('test'))).toBe(true);

      const manager = new ChangeSetManager({ globalStorageUri: vscode.Uri.file(storage) } as vscode.ExtensionContext);
      const folder = { name: 'smoke', uri: vscode.Uri.file(root) } as vscode.WorkspaceFolder;
      await manager.assertPreviewable(repair, folder);
      const approvedRepair = await request<ChangeSet>(baseUrl, `/api/change-sets/${repair.id}/decision`, { decision: 'approve' });
      const applied = await manager.apply(approvedRepair, folder);
      const durableRepair = await request<ChangeSet>(baseUrl, `/api/change-sets/${repair.id}/result`, {
        status: 'applied', result_hashes: applied.resultHashes, checkpoint_reference: applied.checkpointReference,
      });
      expect(durableRepair.checkpoint_reference).toBeTruthy();
      session = await request<VerificationSession>(baseUrl, `/api/verification-sessions/${session.id}/repair-result`, {
        status: 'applied', change_set_id: repair.id,
      });
      expect(session.state).toBe('REVERIFYING');
      expect(session.plan_fingerprint).toBe(approvedFingerprint);
      session = await executeStep(baseUrl, root, python, session);
      expect(session.state).toBe('COMPLETED');
      expect(session.events?.some((event) => event.event_type === 'verification_completed')).toBe(true);

      await manager.restore(durableRepair, folder);
      await request<ChangeSet>(baseUrl, `/api/change-sets/${repair.id}/restore`, { status: 'restored' });
      session = await request<VerificationSession>(baseUrl, `/api/verification-sessions/${session.id}/repair-result`, {
        status: 'restored', change_set_id: repair.id,
      });
      expect(session.state).toBe('REPAIR_RESTORED');
      expect(sha256Text(readFileSync(join(root, 'math_utils.py'), 'utf8'))).toBe(originalHash);
    } catch (error) {
      throw new Error(`${(error as Error).message}\nTemporary backend tail:\n${backendLog}`);
    } finally {
      backend.kill();
      await new Promise((resolveWait) => setTimeout(resolveWait, 300));
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      rmSync(storage, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 360_000);
});
