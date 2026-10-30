// Honor an explicit browser; otherwise find a system installation on Windows.
const fs = require('node:fs');
const path = require('node:path');
if (!process.env.CHROME_BIN && process.platform === 'win32') {
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const browser = [
    path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].find(candidate => fs.existsSync(candidate));
  if (browser) process.env.CHROME_BIN = browser;
}

module.exports = function (config) {
  config.set({
    basePath: '',
    frameworks: ['jasmine'],
    plugins: [
      require('karma-jasmine'),
      require('karma-chrome-launcher'),
      require('karma-jasmine-html-reporter'),
      require('karma-coverage'),
    ],
    client: { clearContext: false },
    reporters: ['progress', 'kjhtml'],
    browsers: ['ChromeHeadlessCodeme'],
    customLaunchers: {
      ChromeHeadlessCodeme: {
        base: 'ChromeHeadless',
        flags: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
      },
    },
  });
};
