import { ChildProcess, spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { CommandExecutionResult, CommandOutputEvent, CommandPolicyDecision, CommandRun } from './commandRun';
import { quoteWindowsWrapperArgument } from './commandPolicy';

const ANSI_PATTERN = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

export interface ProcessRunnerOptions {
  displayLimitBytes?: number;
  tailLimitBytes?: number;
}

interface ActiveRun {
  child: ChildProcess;
  cancellation: 'cancelled' | 'timed_out' | null;
}

function cleanOutput(value: string): string {
  return value.replace(ANSI_PATTERN, '').replace(/[^\x09\x0A\x0D\x20-\x7E\u0080-\uFFFF]/g, '');
}

function appendTail(current: string, value: string, limit: number): string {
  const bytes = Buffer.from(current + value, 'utf8');
  return (bytes.length <= limit ? bytes : bytes.subarray(bytes.length - limit)).toString('utf8');
}

export class ControlledProcessRunner {
  private readonly active = new Map<string, ActiveRun>();
  private readonly displayLimit: number;
  private readonly tailLimit: number;

  constructor(options: ProcessRunnerOptions = {}) {
    this.displayLimit = Math.min(Math.max(options.displayLimitBytes || 1_048_576, 16_384), 4_194_304);
    this.tailLimit = Math.min(Math.max(options.tailLimitBytes || 65_536, 8_192), 65_536);
  }

  async run(
    commandRun: CommandRun,
    decision: CommandPolicyDecision,
    onOutput: (event: CommandOutputEvent) => void,
  ): Promise<CommandExecutionResult> {
    if (commandRun.status !== 'starting' || commandRun.decision !== 'approve') {
      throw new Error('A controlled process can start only after a durable one-time approval and starting transition.');
    }
    if (decision.blocked || decision.risk === 'BLOCKED') {
      throw new Error('A blocked command cannot start.');
    }
    if (this.active.has(commandRun.id)) throw new Error('This command run is already active.');
    const started = new Date();
    let executable = decision.executable;
    let args = [...decision.args];
    if (decision.windowsWrapper) {
      const comspec = process.env.ComSpec || process.env.COMSPEC || 'C:\\Windows\\System32\\cmd.exe';
      const line = [decision.executable, ...decision.args].map(quoteWindowsWrapperArgument).join(' ');
      executable = comspec;
      args = ['/d', '/s', '/c', line];
    }
    let child: ChildProcess;
    try {
      child = spawn(executable, args, {
        cwd: decision.cwd,
        env: decision.environment,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      return this.spawnFailure(started, error as Error);
    }
    const active: ActiveRun = { child, cancellation: null };
    this.active.set(commandRun.id, active);
    onOutput({ commandRunId: commandRun.id, stream: 'status', text: 'Running' });
    return new Promise<CommandExecutionResult>((resolve) => {
      let stdoutTail = '';
      let stderrTail = '';
      let displayed = 0;
      let outputTruncated = false;
      let settled = false;
      let spawnError: Error | undefined;
      const stdoutDecoder = new StringDecoder('utf8');
      const stderrDecoder = new StringDecoder('utf8');
      const emit = (stream: 'stdout' | 'stderr', raw: string): void => {
        const value = cleanOutput(raw);
        if (stream === 'stdout') stdoutTail = appendTail(stdoutTail, value, this.tailLimit);
        else stderrTail = appendTail(stderrTail, value, this.tailLimit);
        const size = Buffer.byteLength(value, 'utf8');
        const remaining = Math.max(0, this.displayLimit - displayed);
        if (displayed < this.displayLimit) {
          const visible = size <= remaining ? value : Buffer.from(value, 'utf8').subarray(0, remaining).toString('utf8');
          if (visible) onOutput({ commandRunId: commandRun.id, stream, text: visible });
          displayed += Math.min(size, remaining);
        }
        if (size > remaining) outputTruncated = true;
      };
      child.stdout?.on('data', (chunk: Buffer) => emit('stdout', stdoutDecoder.write(chunk)));
      child.stderr?.on('data', (chunk: Buffer) => emit('stderr', stderrDecoder.write(chunk)));
      child.on('error', (error) => { spawnError = error; });

      const timeout = setTimeout(() => {
        const current = this.active.get(commandRun.id);
        if (!current || settled) return;
        current.cancellation = 'timed_out';
        onOutput({ commandRunId: commandRun.id, stream: 'status', text: 'Timed out; terminating process tree' });
        void this.terminateTree(current.child);
      }, decision.timeoutSeconds * 1000);

      child.on('close', (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        emit('stdout', stdoutDecoder.end());
        emit('stderr', stderrDecoder.end());
        const cancellation = active.cancellation;
        this.active.delete(commandRun.id);
        const completed = new Date();
        const durationMs = Math.max(0, completed.getTime() - started.getTime());
        const status = cancellation === 'timed_out'
          ? 'timed_out'
          : cancellation === 'cancelled'
            ? 'cancelled'
            : spawnError || code !== 0
              ? 'failed'
              : 'completed';
        resolve({
          status,
          exitCode: code,
          terminationReason: cancellation || signal || (spawnError ? 'spawn_error' : code === 0 ? 'exit' : 'non_zero_exit'),
          startedAt: started.toISOString(),
          completedAt: completed.toISOString(),
          durationMs,
          stdoutTail,
          stderrTail,
          outputTruncated,
          timedOut: cancellation === 'timed_out',
          cancelled: cancellation === 'cancelled',
          failureReason: spawnError?.message || (code && code !== 0 ? `Process exited with code ${code}` : undefined),
        });
      });
    });
  }

  async cancel(commandRunId: string): Promise<boolean> {
    const active = this.active.get(commandRunId);
    if (!active) return false;
    if (!active.cancellation) active.cancellation = 'cancelled';
    await this.terminateTree(active.child);
    return true;
  }

  dispose(): void {
    for (const [id] of this.active) void this.cancel(id);
  }

  private spawnFailure(started: Date, error: Error): CommandExecutionResult {
    const completed = new Date();
    return {
      status: 'failed',
      exitCode: null,
      terminationReason: 'spawn_error',
      startedAt: started.toISOString(),
      completedAt: completed.toISOString(),
      durationMs: Math.max(0, completed.getTime() - started.getTime()),
      stdoutTail: '',
      stderrTail: '',
      outputTruncated: false,
      timedOut: false,
      cancelled: false,
      failureReason: error.message,
    };
  }

  private async terminateTree(child: ChildProcess): Promise<void> {
    if (!child.pid) return;
    if (process.platform === 'win32') {
      await new Promise<void>((resolve) => {
        const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows';
        const taskkill = `${systemRoot}\\System32\\taskkill.exe`;
        const killer = spawn(taskkill, ['/pid', String(child.pid), '/t', '/f'], {
          shell: false,
          windowsHide: true,
          stdio: 'ignore',
        });
        const fallback = (): void => {
          try { child.kill(); } catch { /* already exited */ }
          resolve();
        };
        killer.once('error', fallback);
        killer.once('close', (code) => {
          if (code !== 0) {
            fallback();
          } else {
            resolve();
          }
        });
      });
      return;
    }
    try {
      process.kill(-child.pid, 'SIGTERM');
      setTimeout(() => {
        try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already exited */ }
      }, 1000).unref();
    } catch {
      try { child.kill('SIGTERM'); } catch { /* already exited */ }
    }
  }
}
