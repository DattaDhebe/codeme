import { defineConfig } from 'vitest/config';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');

export default defineConfig({
  resolve: {
    alias: {
      vscode: resolve(__dirname, 'src', 'vscodeStub.ts')
    }
  },
  test: {
    include: ['test/**/*.ts'],
    exclude: ['src/test/**']
  }
});
