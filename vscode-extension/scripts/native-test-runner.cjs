/* Run real extension-host checks against an explicitly selected installed editor. */
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const esbuild = require('esbuild');
const { runTests } = require('@vscode/test-electron');

async function main() {
  const executable = process.env.CODEME_VSCODE_EXECUTABLE;
  if (!executable || !path.isAbsolute(executable) || !fs.statSync(executable, { throwIfNoEntry: false })?.isFile()) {
    throw new Error('Set CODEME_VSCODE_EXECUTABLE to the absolute path of your installed VS Code executable. This test does not download an editor.');
  }
  const extensionRoot = path.resolve(__dirname, '..');
  const runtimeRoot = path.join(extensionRoot, '..', '.runtime');
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const runDirectory = fs.mkdtempSync(path.join(runtimeRoot, 'native-vscode-'));
  const workspace = path.join(runDirectory, 'workspace');
  const userData = path.join(runDirectory, 'user-data');
  const extensions = path.join(runDirectory, 'extensions');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
  fs.mkdirSync(extensions, { recursive: true });
  fs.writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify({
    'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'extensions.autoUpdate': false,
    'extensions.autoCheckUpdates': false, 'workbench.startupEditor': 'none', 'window.restoreWindows': 'none',
    'files.autoSave': 'off', 'files.eol': '\n', 'editor.formatOnSave': false,
    'chat.disableAIFeatures': true, 'workbench.enableExperiments': false, 'extensions.ignoreRecommendations': true,
    'personalCodex.showNotifications': false, 'personalCodex.autoRegisterWorkspace': false,
  }, null, 2));
  esbuild.buildSync({ entryPoints: [path.join(extensionRoot, 'src/extension.ts')], bundle: true,
    platform: 'node', target: 'node18', outfile: path.join(extensionRoot, 'dist/extension.js'), external: ['vscode'], sourcemap: true });
  const suite = path.join(runDirectory, 'suite.js');
  esbuild.buildSync({ entryPoints: [path.join(extensionRoot, 'src/test/suite/index.ts')], bundle: true,
    platform: 'node', target: 'node18', outfile: suite, external: ['vscode'], sourcemap: true });
  console.log('Isolated native test artifacts: ' + runDirectory);
  let ownedChild;
  let ownedChildExited = false;
  const logPath = path.join(runDirectory, 'editor.log');
  const originalSpawn = cp.spawn;
  // test-electron owns the launch; capture only its direct child for bounded cleanup.
  cp.spawn = function (...arguments_) {
    const command = String(arguments_[0]).replace(/^"|"$/g, '');
    const editorLaunch = path.resolve(command).toLowerCase() === path.resolve(executable).toLowerCase();
    // test-electron 2.x uses a Windows shell. The selected executable needs no
    // shell, and literal argument arrays preserve spaces in installation paths.
    if (editorLaunch) {
      arguments_[0] = command;
      arguments_[2] = { ...arguments_[2], shell: false, windowsHide: true };
    }
    const child = originalSpawn.apply(this, arguments_);
    if (editorLaunch) {
      ownedChild = child;
      child.on('exit', () => { ownedChildExited = true; });
      child.stdout?.on('data', bytes => fs.appendFileSync(logPath, bytes));
      child.stderr?.on('data', bytes => fs.appendFileSync(logPath, bytes));
    }
    return child;
  };
  let timer;
  let timedOut = false;
  const stopOwnedChild = () => {
    if (!ownedChild?.pid || ownedChildExited || ownedChild.exitCode !== null) return;
    if (process.platform === 'win32') {
      cp.spawnSync('taskkill', ['/PID', String(ownedChild.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else ownedChild.kill('SIGKILL');
  };
  try {
    await Promise.race([
      runTests({ vscodeExecutablePath: executable, extensionDevelopmentPath: extensionRoot, extensionTestsPath: suite,
        reuseMachineInstall: false, extensionTestsEnv: { CODEME_NATIVE_RUN_DIRECTORY: runDirectory, ELECTRON_RUN_AS_NODE: undefined },
        launchArgs: [workspace, '--new-window', '--disable-extensions', '--disable-gpu', '--disable-telemetry',
          '--user-data-dir=' + userData, '--extensions-dir=' + extensions] }),
      new Promise((_, reject) => { timer = setTimeout(() => { timedOut = true; stopOwnedChild(); reject(new Error('Native VS Code test timed out after five minutes. Inspect isolated logs in ' + runDirectory)); }, 300000); }),
    ]);
    if (!fs.existsSync(path.join(runDirectory, 'result.json'))) throw new Error('Editor exited without recording the native test result. Inspect ' + runDirectory);
    console.log(fs.readFileSync(path.join(runDirectory, 'result.json'), 'utf8'));
  } finally {
    clearTimeout(timer);
    cp.spawn = originalSpawn;
    if (timedOut) stopOwnedChild();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
