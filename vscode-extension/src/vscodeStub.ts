export const workspace = {
  getConfiguration: () => ({ get: (key: string, defaultValue: unknown) => defaultValue })
};

export const window = {
  showWarningMessage: async () => undefined,
  showInformationMessage: async () => undefined
};

export const commands = {
  registerCommand: () => ({ dispose: () => undefined })
};

export const extensions = {
  getExtension: () => undefined
};
