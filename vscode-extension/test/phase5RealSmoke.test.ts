import { ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BackendSettings } from '../src/backendClient';
import { evaluateCommandPolicy } from '../src/commandPolicy';
import { CommandPolicyDecision, CommandRun } from '../src/commandRun';
import { ControlledProcessRunner } from '../src/processRunner';

const enabled = process.env.PERSONAL_CODEX_REAL_SMOKE === '1';
const extensionRoot = resolve(__dirname, '..');
const repositoryRoot = resolve(extensionRoot, '..');

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

async function waitForBackend(baseUrl: string, backend: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (backend.exitCode !== null) throw new Error(`Temporary backend exited with ${backend.exitCode}.`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch { /* starting */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error('Temporary backend did not become ready.');
}

async function jsonRequest<T>(baseUrl: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

function parseCommandProposal(sse: string): CommandRun {
  for (const block of sse.split('\n\n')) {
    const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('');
    if (!data || data === '[DONE]') continue;
    const event = JSON.parse(data) as { kind?: string; command_run?: CommandRun };
    if (event.kind === 'command_proposal' && event.command_run) return event.command_run;
  }
  throw new Error(`The real model did not emit a structured command proposal. SSE tail: ${sse.slice(-2000)}`);
}

function settings(values: Record<string, unknown>): BackendSettings {
  return { get: <T>(key: string, fallback: T) => key in values ? values[key] as T : fallback };
}

function syntheticRun(id: string, profile: CommandRun['profile'], args: string[], timeout = 2): CommandRun {
  return {
    id, schema_version: 1, conversation_id: 1, workspace_id: 1, profile, arguments: args,
    cwd_relative: '.', purpose: id, requested_timeout_seconds: timeout,
    decision: 'approve', status: 'starting', created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
}

async function runFixture(
  root: string,
  record: CommandRun,
  policy: CommandPolicyDecision,
  limits?: { displayLimitBytes: number; tailLimitBytes: number },
) {
  let stdout = '';
  let stderr = '';
  const runner = new ControlledProcessRunner(limits);
  const result = await runner.run(record, policy, (event) => {
    if (event.stream === 'stdout') stdout += event.text;
    if (event.stream === 'stderr') stderr += event.text;
  });
  return { result, stdout, stderr, runner };
}

describe.skipIf(!enabled)('Phase 5 real local Ollama smoke', () => {
  it('persists a Qwen proposal and safely exercises the isolated controlled runner', async () => {
    const root = mkdtempSync(join(tmpdir(), 'personal-codex-phase5-smoke-'));
    const database = join(root, 'smoke.db').replace(/\\/g, '/');
    const python = join(repositoryRoot, '.venv', 'Scripts', 'python.exe');
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    let backendLog = '';
    const backend = spawn(python, ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', String(port)], {
      cwd: repositoryRoot,
      env: { ...process.env, DATABASE_URL: `sqlite:///${database}`, DEFAULT_MODEL: 'qwen2.5-coder:7b' },
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    backend.stdout?.on('data', (chunk: Buffer) => { backendLog = (backendLog + chunk.toString()).slice(-8000); });
    backend.stderr?.on('data', (chunk: Buffer) => { backendLog = (backendLog + chunk.toString()).slice(-8000); });
    try {
      writeFileSync(join(root, 'smoke_fixture.py'), "import sys\nprint('smoke stdout')\nprint('smoke stderr', file=sys.stderr)\n", 'utf8');
      await waitForBackend(baseUrl, backend);
      const workspace = await jsonRequest<{ id: number }>(baseUrl, '/api/workspaces', { path: root, display_name: 'Phase 5 smoke' });
      const conversation = await jsonRequest<{ id: number }>(baseUrl, '/api/conversations', { title: 'Phase 5 real smoke' });
      const agentResponse = await fetch(`${baseUrl}/api/conversations/${conversation.id}/agent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({
          workspace_id: workspace.id, model: 'qwen2.5-coder:7b',
          prompt: 'Call propose_command exactly once. Propose profile python_module with arguments ["smoke_fixture"], cwd_relative ".", purpose "Run isolated Phase 5 smoke fixture", requested_timeout_seconds 30, and model_risk_hint BUILD_OR_TEST. Do not call another tool and do not execute anything.',
        }),
      });
      expect(agentResponse.ok).toBe(true);
      const proposal = parseCommandProposal(await agentResponse.text());
      expect(proposal.profile).toBe('python_module');
      expect(proposal.arguments).toEqual(['smoke_fixture']);
      expect(proposal.cwd_relative).toBe('.');
      expect(proposal.status).toBe('proposed');
      const persisted = await jsonRequest<CommandRun>(baseUrl, `/api/command-runs/${proposal.id}`);
      expect(persisted.id).toBe(proposal.id);

      const configValues = { pythonExecutable: python, customExecutableAllowlist: { node: process.execPath, git: 'git' } };
      const policy = await evaluateCommandPolicy(proposal, root, root, settings(configValues));
      expect(policy.args).toEqual(['-m', 'smoke_fixture']);
      expect(policy.cwdRelative).toBe('.');
      expect(policy.timeoutSeconds).toBe(30);
      expect(policy.executableName).toBe('python.exe');
      expect(policy.risk).toBe('SENSITIVE');
      await expect(new ControlledProcessRunner().run(proposal, policy, () => undefined)).rejects.toThrow(/approval/);

      let approved = await jsonRequest<CommandRun>(baseUrl, `/api/command-runs/${proposal.id}/decision`, {
        decision: 'approve', calculated_risk: policy.risk, risk_explanation: policy.explanation,
        resolved_executable_name: policy.executableName, environment_keys: policy.environmentKeys,
      });
      approved = await jsonRequest<CommandRun>(baseUrl, `/api/command-runs/${proposal.id}/events`, { status: 'starting', detail: 'Real smoke starting' });
      const realRunner = new ControlledProcessRunner();
      let liveStdout = '';
      let liveStderr = '';
      const realPending = realRunner.run(approved, policy, (event) => {
        if (event.stream === 'stdout') liveStdout += event.text;
        if (event.stream === 'stderr') liveStderr += event.text;
      });
      await jsonRequest<CommandRun>(baseUrl, `/api/command-runs/${proposal.id}/events`, { status: 'running', detail: 'Real smoke running' });
      const realResult = await realPending;
      const durable = await jsonRequest<CommandRun>(baseUrl, `/api/command-runs/${proposal.id}/result`, {
        status: realResult.status, exit_code: realResult.exitCode, termination_reason: realResult.terminationReason,
        started_at: realResult.startedAt, completed_at: realResult.completedAt, duration_ms: realResult.durationMs,
        stdout_tail: realResult.stdoutTail, stderr_tail: realResult.stderrTail,
        output_truncated: realResult.outputTruncated, timed_out: realResult.timedOut,
        cancelled: realResult.cancelled, failure_reason: realResult.failureReason,
      });
      expect(durable.status).toBe('completed');
      expect(durable.exit_code).toBe(0);
      expect(durable.duration_ms).toBeGreaterThanOrEqual(0);
      expect(liveStdout).toContain('smoke stdout');
      expect(liveStderr).toContain('smoke stderr');

      writeFileSync(join(root, 'nonzero.js'), "process.stderr.write('nonzero stderr'); process.exit(9);", 'utf8');
      writeFileSync(join(root, 'output.js'), "process.stdout.write('x'.repeat(50000)); setTimeout(()=>process.stdout.write('END'),20);", 'utf8');
      writeFileSync(join(root, 'timeout.js'), 'setInterval(()=>{},1000);', 'utf8');
      writeFileSync(join(root, 'child.js'), 'setInterval(()=>{},1000);', 'utf8');
      writeFileSync(join(root, 'parent.js'), `const {spawn}=require('child_process');const fs=require('fs');const c=spawn(process.execPath,['child.js']);fs.writeFileSync('child.pid',String(c.pid));setInterval(()=>{},1000);`, 'utf8');

      const nodeConfig = settings(configValues);
      const nonzeroRun = syntheticRun('nonzero', 'custom_executable', ['node', 'nonzero.js']);
      const nonzeroPolicy = await evaluateCommandPolicy(nonzeroRun, root, root, nodeConfig);
      expect((await runFixture(root, nonzeroRun, nonzeroPolicy)).result.exitCode).toBe(9);

      const outputRun = syntheticRun('output', 'custom_executable', ['node', 'output.js']);
      const outputPolicy = await evaluateCommandPolicy(outputRun, root, root, nodeConfig);
      const output = await runFixture(root, outputRun, outputPolicy, { displayLimitBytes: 16_384, tailLimitBytes: 8_192 });
      expect(output.result.outputTruncated).toBe(true);
      expect(output.result.stdoutTail.endsWith('END')).toBe(true);
      expect(Buffer.byteLength(output.stdout)).toBeLessThanOrEqual(16_384);

      const timeoutRun = syntheticRun('timeout', 'custom_executable', ['node', 'timeout.js'], 1);
      const timeoutPolicy = await evaluateCommandPolicy(timeoutRun, root, root, nodeConfig);
      expect((await runFixture(root, timeoutRun, timeoutPolicy)).result.status).toBe('timed_out');

      const childRun = syntheticRun('child-tree', 'custom_executable', ['node', 'parent.js'], 10);
      const childPolicy = await evaluateCommandPolicy(childRun, root, root, nodeConfig);
      const childRunner = new ControlledProcessRunner();
      const childPending = childRunner.run(childRun, childPolicy, () => undefined);
      const pidFile = join(root, 'child.pid');
      for (let attempt = 0; attempt < 80 && !existsSync(pidFile); attempt++) await new Promise((resolveWait) => setTimeout(resolveWait, 25));
      expect(existsSync(pidFile)).toBe(true);
      const childPid = Number(readFileSync(pidFile, 'utf8'));
      await childRunner.cancel(childRun.id);
      expect((await childPending).status).toBe('cancelled');
      await new Promise((resolveWait) => setTimeout(resolveWait, 150));
      expect(() => process.kill(childPid, 0)).toThrow();

      await expect(evaluateCommandPolicy({ ...proposal, cwd_relative: '../outside' }, root, root, settings(configValues))).rejects.toThrow(/traversal/);
      const destructive = syntheticRun('destructive', 'custom_executable', ['git', 'reset', '--hard']);
      expect((await evaluateCommandPolicy(destructive, root, root, nodeConfig)).risk).toBe('BLOCKED');
      await expect(evaluateCommandPolicy(
        syntheticRun('injection', 'custom_executable', ['node', 'output.js && whoami']), root, root, nodeConfig,
      )).rejects.toThrow(/metacharacters/);

      const finalRecord = await jsonRequest<CommandRun>(baseUrl, `/api/command-runs/${proposal.id}`);
      expect(finalRecord.status).toBe('completed');
      expect(finalRecord.stdout_tail).toContain('smoke stdout');
      expect(finalRecord.stderr_tail).toContain('smoke stderr');
    } catch (error) {
      throw new Error(`${(error as Error).message}\nTemporary backend tail:\n${backendLog}`);
    } finally {
      backend.kill();
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 240_000);
});
