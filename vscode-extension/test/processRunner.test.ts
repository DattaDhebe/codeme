import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CommandPolicyDecision, CommandRun } from '../src/commandRun';
import { ControlledProcessRunner } from '../src/processRunner';

const roots: string[] = [];

function fixture(source: string): { root: string; script: string } {
  const root = mkdtempSync(join(tmpdir(), 'codeme-runner-'));
  roots.push(root);
  const script = join(root, 'fixture.js');
  writeFileSync(script, source, 'utf8');
  return { root, script };
}

function runRecord(): CommandRun {
  return {
    id: `run-${Math.random()}`, schema_version: 1, conversation_id: 1, workspace_id: 1,
    profile: 'custom_executable', arguments: [], cwd_relative: '.', purpose: 'Fixture',
    requested_timeout_seconds: 2, decision: 'approve', status: 'starting', created_at: '2026-01-01', updated_at: '2026-01-01',
  };
}

function decision(root: string, script: string, overrides: Partial<CommandPolicyDecision> = {}): CommandPolicyDecision {
  return {
    risk: 'SENSITIVE', risks: ['SENSITIVE'], explanation: 'Controlled fixture', blocked: false,
    network: false, writesWorkspace: false, executable: process.execPath, executableName: 'node',
    args: [script], cwd: root, cwdRelative: '.', timeoutSeconds: 2,
    environment: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP },
    environmentKeys: ['PATH'], windowsWrapper: false, ...overrides,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('controlled process runner', () => {
  it('refuses execution without a durable one-time approval or for a blocked decision', async () => {
    const item = fixture("process.stdout.write('must-not-run');");
    await expect(new ControlledProcessRunner().run(
      { ...runRecord(), status: 'proposed', decision: null }, decision(item.root, item.script), () => undefined,
    )).rejects.toThrow(/approval/);
    await expect(new ControlledProcessRunner().run(
      runRecord(), decision(item.root, item.script, { blocked: true, risk: 'BLOCKED', risks: ['BLOCKED'] }), () => undefined,
    )).rejects.toThrow(/blocked/);
  });

  it('captures successful stdout, stderr, exit code, and duration separately', async () => {
    const item = fixture("process.stdout.write('out\\u001b[31m-red\\u001b[0m\\u0000'); process.stderr.write('err');");
    const events: Array<{ stream: string; text: string }> = [];
    const result = await new ControlledProcessRunner().run(runRecord(), decision(item.root, item.script), (event) => events.push(event));
    expect(result.status).toBe('completed');
    expect(result.exitCode).toBe(0);
    expect(result.stdoutTail).toBe('out-red');
    expect(result.stderrTail).toBe('err');
    expect(events.some((event) => event.stream === 'stdout')).toBe(true);
    expect(events.some((event) => event.stream === 'stderr')).toBe(true);
    expect(events.map((event) => event.text).join('')).not.toContain('\u001b');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('reports non-zero exits and invalid executables', async () => {
    const item = fixture("process.stderr.write('failed'); process.exit(7);");
    const nonZero = await new ControlledProcessRunner().run(runRecord(), decision(item.root, item.script), () => undefined);
    expect(nonZero.status).toBe('failed');
    expect(nonZero.exitCode).toBe(7);
    const invalid = await new ControlledProcessRunner().run(
      runRecord(), decision(item.root, item.script, { executable: join(item.root, 'missing-executable'), args: [] }), () => undefined,
    );
    expect(invalid.status).toBe('failed');
    expect(invalid.terminationReason).toBe('spawn_error');
  });

  it('times out and terminates the process', async () => {
    const item = fixture("setInterval(() => process.stdout.write('.'), 20);");
    const result = await new ControlledProcessRunner().run(
      runRecord(), decision(item.root, item.script, { timeoutSeconds: 0.08 }), () => undefined,
    );
    expect(result.status).toBe('timed_out');
    expect(result.timedOut).toBe(true);
  });

  it('supports cancellation and cancellation races', async () => {
    const item = fixture("setInterval(() => process.stdout.write('.'), 20);");
    const runner = new ControlledProcessRunner();
    const record = runRecord();
    const pending = runner.run(record, decision(item.root, item.script), () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await runner.cancel(record.id)).toBe(true);
    expect((await pending).status).toBe('cancelled');
    expect(await runner.cancel(record.id)).toBe(false);
  });

  it('caps displayed output, retains bounded tails, and continues draining', async () => {
    const item = fixture("process.stdout.write('x'.repeat(40000)); setTimeout(() => process.stdout.write('END'), 20);");
    let displayed = '';
    const result = await new ControlledProcessRunner({ displayLimitBytes: 16_384, tailLimitBytes: 8_192 }).run(
      runRecord(), decision(item.root, item.script), (event) => { if (event.stream === 'stdout') displayed += event.text; },
    );
    expect(Buffer.byteLength(displayed)).toBeLessThanOrEqual(16_384);
    expect(result.outputTruncated).toBe(true);
    expect(Buffer.byteLength(result.stdoutTail)).toBeLessThanOrEqual(8_192);
    expect(result.stdoutTail.endsWith('END')).toBe(true);
  });

  it('terminates a spawned child process on cancellation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codeme-tree-'));
    roots.push(root);
    const childScript = join(root, 'child.js');
    const parentScript = join(root, 'parent.js');
    const pidFile = join(root, 'child.pid');
    writeFileSync(childScript, "setInterval(() => {}, 1000);", 'utf8');
    writeFileSync(parentScript, `const {spawn}=require('child_process'); const fs=require('fs'); const c=spawn(process.execPath,[${JSON.stringify(childScript)}]); fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid)); setInterval(()=>{},1000);`, 'utf8');
    const runner = new ControlledProcessRunner();
    const record = runRecord();
    const pending = runner.run(record, decision(root, parentScript), () => undefined);
    for (let index = 0; index < 30 && !existsSync(pidFile); index++) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(existsSync(pidFile)).toBe(true);
    const childPid = Number(readFileSync(pidFile, 'utf8'));
    await runner.cancel(record.id);
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 150));
    let alive = true;
    try { process.kill(childPid, 0); } catch { alive = false; }
    expect(alive).toBe(false);
  });

  it('cleans active runs during extension deactivation disposal', async () => {
    const item = fixture("setInterval(() => {}, 1000);");
    const runner = new ControlledProcessRunner();
    const record = runRecord();
    const pending = runner.run(record, decision(item.root, item.script), () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 30));
    runner.dispose();
    expect((await pending).status).toBe('cancelled');
  });
});
