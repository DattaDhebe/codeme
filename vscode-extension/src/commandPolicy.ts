import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { BackendSettings } from './backendClient';
import { CommandPolicyDecision, CommandProfile, CommandRisk, CommandRun } from './commandRun';

const PROFILES = new Set<CommandProfile>([
  'pytest', 'python_module', 'npm_test', 'npm_build', 'npm_lint', 'dotnet_test', 'dotnet_build',
  'maven_test', 'maven_package', 'gradle_test', 'gradle_build', 'git_status', 'git_diff', 'custom_executable',
]);
const SECRET_ENV = /(TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|CONNECTION_STRING|CREDENTIAL|AUTH|COOKIE)/i;
const SHELL_META = /[|&;<>`\r\n]|\$\(|\|\||&&/;
const WINDOWS_WRAPPER_META = /[&|<>^%!()"\r\n]/;
const BLOCKED_EXECUTABLES = new Set([
  'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe', 'cmd', 'cmd.exe', 'bash', 'bash.exe', 'sh', 'sh.exe',
  'diskpart', 'diskpart.exe', 'format', 'format.com', 'shutdown', 'shutdown.exe', 'reg', 'reg.exe',
  'sc', 'sc.exe', 'schtasks', 'schtasks.exe', 'rm', 'rmdir', 'del', 'remove-item',
]);
const BLOCKED_TOKENS = new Set([
  'reset', 'clean', 'checkout', 'restore', '--hard', '--force', '--delete', '-d', '-D',
  'remove-item', 'rm', 'rmdir', 'del', 'diskpart', 'format', 'shutdown', 'restart-computer',
  'reg', 'regedit', 'sc', 'schtasks', 'credential', 'credentials', 'keychain', 'private_key',
  'id_rsa', 'id_ed25519', 'known_hosts', 'history', '.bash_history', 'cookies', 'login data',
  'env', 'set', 'printenv', 'get-childitem env:', '-encodedcommand', '-enc', '-command',
  '--eval', 'eval', '--force-with-lease', '--mirror',
]);

const RISK_PRIORITY: CommandRisk[] = [
  'BLOCKED', 'PACKAGE_INSTALL', 'NETWORK', 'LONG_RUNNING', 'SENSITIVE',
  'WRITES_WORKSPACE', 'BUILD_OR_TEST', 'READ_ONLY',
];

export class CommandPolicyError extends Error {}

export function filteredEnvironment(profile: CommandProfile, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const baseKeys = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'LANG', 'LC_ALL'];
  if (profile.startsWith('dotnet')) baseKeys.push('DOTNET_ROOT', 'DOTNET_CLI_HOME');
  if (profile.startsWith('maven') || profile.startsWith('gradle')) baseKeys.push('JAVA_HOME');
  const environment: NodeJS.ProcessEnv = {};
  for (const key of baseKeys) {
    if (SECRET_ENV.test(key)) continue;
    const actualKey = Object.keys(source).find((item) => item.toLowerCase() === key.toLowerCase());
    if (actualKey && source[actualKey] !== undefined) environment[actualKey] = source[actualKey];
  }
  return environment;
}

function validateArguments(arguments_: string[]): void {
  if (arguments_.length > 50) throw new CommandPolicyError('Too many command arguments.');
  for (const argument of arguments_) {
    if (typeof argument !== 'string' || argument.length > 500 || argument.includes('\0')) {
      throw new CommandPolicyError('Command arguments must be bounded literal strings.');
    }
    if (SHELL_META.test(argument)) throw new CommandPolicyError('Shell metacharacters are not allowed.');
    const normalized = argument.replace(/\\/g, '/');
    if (
      path.isAbsolute(argument)
      || /^[\\/]{2}/.test(argument)
      || /^[A-Za-z]:/.test(argument)
      || normalized.split('/').includes('..')
    ) {
      throw new CommandPolicyError('Absolute, UNC, and traversal argument paths are not allowed.');
    }
  }
}

function profileCommand(profile: CommandProfile, arguments_: string[], config: BackendSettings): { executable: string; args: string[] } {
  const python = config.get('pythonExecutable', process.platform === 'win32' ? 'python' : 'python3');
  const configuredNpm = config.get('npmExecutable', 'npm');
  const npm = process.platform === 'win32' && configuredNpm === 'npm' ? 'npm.cmd' : configuredNpm;
  const dotnet = config.get('dotnetExecutable', 'dotnet');
  const configuredMaven = config.get('mavenExecutable', 'mvn');
  const maven = process.platform === 'win32' && configuredMaven === 'mvn' ? 'mvn.cmd' : configuredMaven;
  const configuredGradle = config.get('gradleExecutable', 'gradle');
  const gradle = process.platform === 'win32' && configuredGradle === 'gradle' ? 'gradle.bat' : configuredGradle;
  const git = config.get('gitExecutable', 'git');
  switch (profile) {
    case 'pytest': return { executable: python, args: ['-m', 'pytest', ...arguments_] };
    case 'python_module': {
      if (!arguments_.length || !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(arguments_[0])) {
        throw new CommandPolicyError('python_module requires a dotted module name.');
      }
      return { executable: python, args: ['-m', ...arguments_] };
    }
    case 'npm_test': return { executable: npm, args: ['test', ...arguments_] };
    case 'npm_build': return { executable: npm, args: ['run', 'build', ...arguments_] };
    case 'npm_lint': return { executable: npm, args: ['run', 'lint', ...arguments_] };
    case 'dotnet_test': return { executable: dotnet, args: ['test', ...arguments_] };
    case 'dotnet_build': return { executable: dotnet, args: ['build', ...arguments_] };
    case 'maven_test': return { executable: maven, args: ['test', ...arguments_] };
    case 'maven_package': return { executable: maven, args: ['package', ...arguments_] };
    case 'gradle_test': return { executable: gradle, args: ['test', ...arguments_] };
    case 'gradle_build': return { executable: gradle, args: ['build', ...arguments_] };
    case 'git_status': return { executable: git, args: ['status', ...arguments_] };
    case 'git_diff': return { executable: git, args: ['diff', ...arguments_] };
    case 'custom_executable': {
      const [alias, ...rest] = arguments_;
      const allowlist = config.get<Record<string, string>>('customExecutableAllowlist', {});
      if (!alias || !Object.prototype.hasOwnProperty.call(allowlist, alias)) {
        throw new CommandPolicyError('Custom executable aliases are disabled unless explicitly allowlisted by the user.');
      }
      const executable = allowlist[alias];
      if (!executable || typeof executable !== 'string') throw new CommandPolicyError('The custom executable alias is invalid.');
      return { executable, args: rest };
    }
  }
}

function classify(profile: CommandProfile, args: string[], timeout: number, executable: string): { risks: CommandRisk[]; reasons: string[] } {
  const risks = new Set<CommandRisk>();
  const reasons: string[] = [];
  const baseName = path.basename(executable).toLowerCase();
  const lowered = args.map((argument) => argument.trim().toLowerCase());
  const joined = lowered.join(' ');
  const destructiveGit = baseName.replace(/\.exe$/, '') === 'git' && (
    /(^|\s)(reset|clean|checkout|restore)(\s|$)/.test(joined)
    || /(^|\s)push(\s|$)/.test(joined) && /(^|\s)(--force|-f|--force-with-lease|--mirror)(\s|=|$)/.test(joined)
    || /(^|\s)branch(\s|$)/.test(joined) && /(^|\s)(-d|-D|--delete)(\s|=|$)/.test(joined)
  );
  const protectedDataAccess = /(id_rsa|id_ed25519|private[_ -]?key|\.ssh(?:[\\/]|$)|browser.{0,20}(profile|cookie|login)|\.bash_history|credential|keychain)/.test(joined);
  if (
    BLOCKED_EXECUTABLES.has(baseName)
    || lowered.some((token) => BLOCKED_TOKENS.has(token))
    || destructiveGit
    || protectedDataAccess
  ) {
    risks.add('BLOCKED');
    reasons.push('The executable or argument requests a prohibited shell, destructive, system, credential, or inline-evaluation operation.');
  }
  if ((baseName.startsWith('python') && lowered.includes('-c')) || (baseName.startsWith('node') && lowered.includes('-e'))) {
    risks.add('BLOCKED');
    reasons.push('Inline interpreter evaluation is prohibited.');
  }
  if (profile === 'git_status' || profile === 'git_diff') {
    risks.add('READ_ONLY');
    reasons.push('The selected Git profile is read-only.');
  } else if (['pytest', 'npm_test', 'dotnet_test', 'maven_test', 'gradle_test'].includes(profile)) {
    risks.add('BUILD_OR_TEST');
    reasons.push('The profile executes project tests and may run repository-provided code.');
  } else if (['npm_build', 'npm_lint', 'dotnet_build', 'maven_package', 'gradle_build'].includes(profile)) {
    risks.add('WRITES_WORKSPACE');
    reasons.push('The build profile may create or update workspace artifacts.');
  } else {
    risks.add('SENSITIVE');
    reasons.push('The profile executes a configured runtime or custom executable.');
  }
  if (/\b(install|add|restore|upgrade|update)\b/.test(joined)) {
    risks.add('PACKAGE_INSTALL');
    reasons.push('Arguments may install or restore packages.');
  }
  const offlineBuild = profile.startsWith('maven')
    ? lowered.includes('--offline') || lowered.includes('-o')
    : profile.startsWith('gradle')
      ? lowered.includes('--offline')
      : false;
  if (/https?:\/\//.test(joined) || (['maven_test', 'maven_package', 'gradle_test', 'gradle_build'].includes(profile) && !offlineBuild)) {
    risks.add('NETWORK');
    reasons.push('The profile or arguments may access the network.');
  }
  if (timeout > 120) {
    risks.add('LONG_RUNNING');
    reasons.push('The requested timeout exceeds the two-minute default.');
  }
  return { risks: [...risks], reasons };
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export async function evaluateCommandPolicy(
  commandRun: CommandRun,
  registeredRoot: string,
  activeFolderRoot: string,
  config: BackendSettings,
  sourceEnvironment: NodeJS.ProcessEnv = process.env,
): Promise<CommandPolicyDecision> {
  if (commandRun.schema_version !== 1 || !PROFILES.has(commandRun.profile)) throw new CommandPolicyError('Unsupported command proposal.');
  validateArguments(commandRun.arguments);
  if (/^[\\/]{2}/.test(registeredRoot) || /^[\\/]{2}/.test(activeFolderRoot)) {
    throw new CommandPolicyError('UNC workspaces are not supported for controlled execution.');
  }
  if (path.isAbsolute(commandRun.cwd_relative) || /^[\\/]{2}/.test(commandRun.cwd_relative) || /^[A-Za-z]:/.test(commandRun.cwd_relative)) {
    throw new CommandPolicyError('Absolute and UNC working directories are not allowed.');
  }
  const cwdParts = commandRun.cwd_relative.replace(/\\/g, '/').split('/');
  if (cwdParts.some((part) => !part || part === '..') && commandRun.cwd_relative !== '.') {
    throw new CommandPolicyError('Working-directory traversal is not allowed.');
  }
  const registeredReal = await fs.realpath(registeredRoot);
  const activeReal = await fs.realpath(activeFolderRoot);
  const registeredComparable = process.platform === 'win32' ? path.normalize(registeredReal).toLowerCase() : path.normalize(registeredReal);
  const activeComparable = process.platform === 'win32' ? path.normalize(activeReal).toLowerCase() : path.normalize(activeReal);
  if (registeredComparable !== activeComparable) {
    throw new CommandPolicyError('The command workspace does not match the active registered workspace.');
  }
  const cwd = await fs.realpath(path.resolve(registeredReal, commandRun.cwd_relative));
  if (!inside(registeredReal, cwd)) throw new CommandPolicyError('The working directory escapes through traversal, symlink, or junction.');
  if (!(await fs.stat(cwd)).isDirectory()) throw new CommandPolicyError('The command working directory does not exist.');
  const timeoutSeconds = Math.max(1, Math.min(commandRun.requested_timeout_seconds || 120, 900));
  const resolved = profileCommand(commandRun.profile, commandRun.arguments, config);
  const baseName = path.basename(resolved.executable).toLowerCase();
  if (BLOCKED_EXECUTABLES.has(baseName)) throw new CommandPolicyError('Shell and system executables cannot be used by a controlled profile.');
  const windowsWrapper = process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolved.executable);
  if (windowsWrapper && resolved.args.some((argument) => WINDOWS_WRAPPER_META.test(argument))) {
    throw new CommandPolicyError('A Windows wrapper argument contains expansion or shell metacharacters.');
  }
  const classification = classify(commandRun.profile, resolved.args, timeoutSeconds, resolved.executable);
  const risk = RISK_PRIORITY.find((item) => classification.risks.includes(item)) || 'SENSITIVE';
  const environment = filteredEnvironment(commandRun.profile, sourceEnvironment);
  return {
    risk,
    risks: classification.risks,
    explanation: classification.reasons.join(' '),
    blocked: risk === 'BLOCKED',
    network: classification.risks.includes('NETWORK'),
    writesWorkspace: classification.risks.includes('WRITES_WORKSPACE') || classification.risks.includes('PACKAGE_INSTALL'),
    executable: resolved.executable,
    executableName: path.basename(resolved.executable),
    args: resolved.args,
    cwd,
    cwdRelative: commandRun.cwd_relative,
    timeoutSeconds,
    environment,
    environmentKeys: Object.keys(environment).sort(),
    windowsWrapper,
  };
}

export function quoteWindowsWrapperArgument(value: string): string {
  if (WINDOWS_WRAPPER_META.test(value)) throw new CommandPolicyError('Unsafe Windows wrapper argument.');
  return `"${value.replace(/\\*(?=")/g, (slashes) => `${slashes}${slashes}`)}"`;
}
