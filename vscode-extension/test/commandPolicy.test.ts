import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BackendSettings } from '../src/backendClient';
import { CommandRun } from '../src/commandRun';
import { CommandPolicyError, evaluateCommandPolicy, filteredEnvironment, quoteWindowsWrapperArgument } from '../src/commandPolicy';

const roots: string[] = [];

function tempRoot(prefix = 'codeme-policy-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function config(values: Record<string, unknown> = {}): BackendSettings {
  return { get: <T>(section: string, defaultValue: T) => (section in values ? values[section] as T : defaultValue) };
}

function command(overrides: Partial<CommandRun> = {}): CommandRun {
  return {
    id: '33333333-3333-3333-3333-333333333333', schema_version: 1,
    conversation_id: 1, workspace_id: 1, profile: 'git_status', arguments: ['--short'],
    cwd_relative: '.', purpose: 'Inspect status', requested_timeout_seconds: 120,
    status: 'proposed', created_at: '2026-01-01', updated_at: '2026-01-01', ...overrides,
  };
}

async function evaluate(run: CommandRun, values: Record<string, unknown> = {}) {
  const root = tempRoot();
  return evaluateCommandPolicy(run, root, root, config(values), { PATH: 'safe', TEMP: tmpdir() });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('command policy', () => {
  it('classifies every risk category independently', async () => {
    expect((await evaluate(command())).risks).toContain('READ_ONLY');
    expect((await evaluate(command({ profile: 'pytest', arguments: [] }))).risks).toContain('BUILD_OR_TEST');
    expect((await evaluate(command({ profile: 'npm_build', arguments: [] }))).risks).toContain('WRITES_WORKSPACE');
    expect((await evaluate(command({ profile: 'maven_test', arguments: [] }))).risks).toContain('NETWORK');
    expect((await evaluate(command({ profile: 'python_module', arguments: ['pip', 'install', 'demo'] }))).risks).toContain('PACKAGE_INSTALL');
    expect((await evaluate(command({ profile: 'pytest', arguments: [], requested_timeout_seconds: 300 }))).risks).toContain('LONG_RUNNING');
    expect((await evaluate(command({ profile: 'python_module', arguments: ['compileall'] }))).risks).toContain('SENSITIVE');
    const blocked = await evaluate(command({ profile: 'custom_executable', arguments: ['git', 'reset', '--hard'] }), {
      customExecutableAllowlist: { git: 'git' },
    });
    expect(blocked.risk).toBe('BLOCKED');
  });

  it('treats explicitly offline Maven and Gradle verification as non-networked', async () => {
    const maven = await evaluate(command({ profile: 'maven_test', arguments: ['--offline'] }));
    const gradle = await evaluate(command({ profile: 'gradle_build', arguments: ['--offline'] }));
    expect(maven.risks).not.toContain('NETWORK');
    expect(gradle.risks).not.toContain('NETWORK');
    expect(maven.risks).toContain('BUILD_OR_TEST');
    expect(gradle.risks).toContain('WRITES_WORKSPACE');
  });

  it('blocks shells, inline interpreters, destructive Git, and shell metacharacters', async () => {
    await expect(evaluate(command({ profile: 'custom_executable', arguments: ['shell'] }), {
      customExecutableAllowlist: { shell: 'powershell.exe' },
    })).rejects.toThrow(/Shell and system/);
    expect((await evaluate(command({ profile: 'custom_executable', arguments: ['python', '-c', 'print(1)'] }), {
      customExecutableAllowlist: { python: 'python' },
    })).risk).toBe('BLOCKED');
    expect((await evaluate(command({ profile: 'custom_executable', arguments: ['node', '-e', 'process.exit()'] }), {
      customExecutableAllowlist: { node: 'node' },
    })).risk).toBe('BLOCKED');
    expect((await evaluate(command({ profile: 'git_status', arguments: ['reset', '--hard'] }))).risk).toBe('BLOCKED');
    expect((await evaluate(command({ profile: 'custom_executable', arguments: ['git', 'push', '--force=origin'] }), {
      customExecutableAllowlist: { git: 'git' },
    })).risk).toBe('BLOCKED');
    await expect(evaluate(command({ profile: 'pytest', arguments: ['tests && whoami'] }))).rejects.toThrow(/metacharacters/);
    await expect(evaluate(command({ profile: 'pytest', arguments: ['../outside/test.py'] }))).rejects.toThrow(/argument paths/);
    await expect(evaluate(command({ profile: 'pytest', arguments: ['C:\\outside\\test.py'] }))).rejects.toThrow(/argument paths/);
  });

  it('disables custom executables by default and permits explicit user aliases', async () => {
    await expect(evaluate(command({ profile: 'custom_executable', arguments: ['fixture'] }))).rejects.toThrow(/allowlisted/);
    const allowed = await evaluate(command({ profile: 'custom_executable', arguments: ['fixture', '--safe'] }), {
      customExecutableAllowlist: { fixture: process.execPath },
    });
    expect(allowed.executable).toBe(process.execPath);
    expect(allowed.args).toEqual(['--safe']);
  });

  it('rejects traversal, root mismatch, UNC paths, and symlink or junction escapes', async () => {
    const root = tempRoot();
    const other = tempRoot('codeme-other-');
    await expect(evaluateCommandPolicy(command({ cwd_relative: '../other' }), root, root, config())).rejects.toThrow(/traversal/);
    await expect(evaluateCommandPolicy(command(), root, other, config())).rejects.toThrow(/does not match/);
    await expect(evaluateCommandPolicy(command({ cwd_relative: '\\\\server\\share' }), root, root, config())).rejects.toThrow(/UNC/);
    const link = join(root, 'linked');
    try {
      symlinkSync(other, link, process.platform === 'win32' ? 'junction' : 'dir');
      await expect(evaluateCommandPolicy(command({ cwd_relative: 'linked' }), root, root, config())).rejects.toThrow(/escapes/);
    } catch (error) {
      if (!(error instanceof CommandPolicyError)) return;
      throw error;
    }
  });

  it('handles Windows drive-letter casing and wrapper quoting safely', async () => {
    if (process.platform === 'win32') {
      const root = tempRoot();
      const toggled = root[0] === root[0].toLowerCase() ? root[0].toUpperCase() + root.slice(1) : root[0].toLowerCase() + root.slice(1);
      await expect(evaluateCommandPolicy(command(), root, toggled, config())).resolves.toBeTruthy();
    }
    expect(quoteWindowsWrapperArgument('two words')).toBe('"two words"');
    expect(() => quoteWindowsWrapperArgument('safe & whoami')).toThrow(/Unsafe/);
  });

  it('filters secret environment keys and reports inherited non-secret keys', () => {
    const environment = filteredEnvironment('pytest', {
      PATH: 'safe', TEMP: 'temp', API_KEY: 'secret', AUTH_TOKEN: 'secret', PASSWORD: 'secret', RANDOM: 'omit',
    });
    expect(environment).toEqual({ PATH: 'safe', TEMP: 'temp' });
  });
});
