import { runNativeChangeSetTests } from './extension.test';

// This is the exported contract required by the real VS Code extension host.
export async function run(): Promise<void> {
  await runNativeChangeSetTests();
}
