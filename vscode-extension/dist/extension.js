"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/extension.ts
var extension_exports = {};
__export(extension_exports, {
  activate: () => activate,
  deactivate: () => deactivate
});
module.exports = __toCommonJS(extension_exports);
var vscode4 = __toESM(require("vscode"));

// src/sidebarProvider.ts
var vscode = __toESM(require("vscode"));
var PersonalCodexSidebarProvider = class {
  constructor(context, backend, resolver) {
    this.context = context;
    this.backend = backend;
    this.resolver = resolver;
    this.pendingMessages = [];
    this.currentWorkspaceId = null;
  }
  resolveWebviewView(webviewView) {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = webviewHtml(webviewView.webview, this.context.extensionUri);
    webviewView.webview.onDidReceiveMessage((data) => this.handleMessage(data));
    this.initialize();
  }
  async reveal() {
    if (!this.view) {
      await vscode.commands.executeCommand("workbench.view.extension.personalCodex");
    }
    this.view?.show?.(true);
  }
  async createNewChat() {
    await this.send({ command: "newChat", payload: {} });
  }
  async handleSelectionCommand(action) {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      vscode.window.showWarningMessage("No selection available.");
      return;
    }
    const context = await this.resolver.resolveSelection(editor);
    await this.send({ command: action, payload: context });
  }
  async handleFileCommand(action) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage("Open a file first.");
      return;
    }
    const context = await this.resolver.resolveFile(editor);
    await this.send({ command: action, payload: context });
  }
  async reviewChanges() {
    const workspace4 = this.getActiveWorkspaceFolder();
    if (!workspace4) {
      vscode.window.showWarningMessage("Open a workspace folder first.");
      return;
    }
    const diff = await this.resolver.resolveGitDiff(workspace4);
    await this.send({ command: "reviewChanges", payload: diff });
  }
  async registerWorkspace() {
    const folder = this.getActiveWorkspaceFolder();
    if (!folder) {
      vscode.window.showWarningMessage("Open a workspace folder first.");
      return;
    }
    const accept = await vscode.window.showInformationMessage(
      `Register '${folder.name}' with Personal Codex backend?`,
      "Register",
      "Cancel"
    );
    if (accept !== "Register") {
      return;
    }
    const workspaceId = await this.backend.registerWorkspace(folder.uri.fsPath, folder.name);
    this.currentWorkspaceId = workspaceId;
    await this.send({ command: "workspaceRegistered", payload: { workspaceId, rootPath: folder.uri.fsPath } });
  }
  async refreshWorkspaceState() {
    if (!this.view) {
      return;
    }
    const folder = this.getActiveWorkspaceFolder();
    const status = { workspace: folder?.name ?? null, folders: vscode.workspace.workspaceFolders?.length ?? 0 };
    await this.send({ command: "workspaceState", payload: status });
  }
  async updateConfiguration() {
    await this.backend.updateSettings(vscode.workspace.getConfiguration("personalCodex"));
    await this.initialize();
  }
  getActiveWorkspaceFolder() {
    return vscode.workspace.workspaceFolders?.[0];
  }
  async initialize() {
    await this.backend.checkConnection(false);
    await this.refreshWorkspaceState();
    await this.flushPendingMessages();
  }
  async send(message) {
    if (!this.view) {
      this.pendingMessages.push(message);
      return;
    }
    this.view.webview.postMessage(message);
  }
  async flushPendingMessages() {
    while (this.pendingMessages.length > 0) {
      const message = this.pendingMessages.shift();
      if (message) {
        await this.send(message);
      }
    }
  }
  async handleMessage(data) {
    if (!this.view) {
      return;
    }
    const payload = data;
    if (!payload.command) {
      return;
    }
    switch (payload.command) {
      case "healthCheck":
        await this.backend.checkConnection(true);
        break;
      case "startChat":
        if (payload.args && typeof payload.args === "object" && payload.args !== null) {
          await this.handleChatRequest(payload.args);
        }
        break;
      case "cancelStream":
        this.backend.cancel();
        break;
      default:
        console.warn("Unknown command from webview", payload.command);
    }
  }
  async handleChatRequest(args) {
    const conversationId = await this.backend.createConversation("Personal Codex Chat");
    const messages = [{ role: "user", content: args.prompt }];
    await this.backend.streamChat(
      conversationId,
      messages,
      (chunk) => this.send({ command: "streamChunk", payload: chunk }),
      () => this.send({ command: "streamComplete", payload: null }),
      (error) => this.send({ command: "streamError", payload: { message: error.message } })
    );
  }
};

// src/backendClient.ts
var vscode2 = __toESM(require("vscode"));
var LOCALHOST_URLS = ["http://127.0.0.1", "http://localhost"];
var BackendClient = class {
  constructor(config) {
    this.config = config;
  }
  get backendUrl() {
    return this.config.get("personalCodex.backendUrl", "http://127.0.0.1:8000");
  }
  get defaultModel() {
    return this.config.get("personalCodex.defaultModel", "qwen2.5-coder:7b");
  }
  get showNotifications() {
    return this.config.get("personalCodex.showNotifications", true);
  }
  async checkConnection(userTriggered) {
    if (!LOCALHOST_URLS.some((host) => this.backendUrl.startsWith(host))) {
      vscode2.window.showWarningMessage("Personal Codex is configured to use a non-local backend URL.");
    }
    try {
      const response = await this.request("/health", void 0, 3e3, 3);
      if (response?.status === "ok" && this.showNotifications && userTriggered) {
        vscode2.window.showInformationMessage("Personal Codex backend is available.");
      }
    } catch (error) {
      if (userTriggered) {
        vscode2.window.showErrorMessage("Unable to connect to Personal Codex backend.");
      }
      throw error;
    }
  }
  async registerWorkspace(path, displayName) {
    const response = await this.post("/workspaces", {
      path,
      display_name: displayName
    });
    return response.id;
  }
  async createConversation(title) {
    const response = await this.post("/conversations", { title: title || "Personal Codex" });
    return response.id;
  }
  async streamChat(conversationId, messages, onChunk, onComplete, onError) {
    const url = this.getUrl(`/conversations/${conversationId}/chat`);
    this.controller = new AbortController();
    const signal = this.controller.signal;
    const requestInit = {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ model: this.defaultModel, messages }),
      signal
    };
    try {
      const response = await fetch(url, requestInit);
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Backend request failed: ${response.status} ${body}`);
      }
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("Stream is not available from backend");
      }
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          onComplete();
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.trim();
          if (!line) {
            continue;
          }
          if (line.startsWith("data:")) {
            const payload = line.slice(5).trim();
            if (payload === "[DONE]") {
              onComplete();
              return;
            }
            onChunk(payload);
          }
        }
      }
    } catch (error) {
      if (error?.name === "AbortError") {
        onError(new Error("Chat request cancelled"));
      } else {
        onError(error);
      }
    }
  }
  cancel() {
    this.controller?.abort();
  }
  async updateSettings(config) {
  }
  getUrl(path) {
    return `${this.backendUrl.replace(/\/+$/, "")}/api${path}`;
  }
  async request(path, init, timeout = 5e3, retries = 1) {
    const url = this.getUrl(path);
    const attempt = async (count) => {
      const controller = new AbortController();
      const signal = controller.signal;
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await fetch(url, { signal, ...init });
        clearTimeout(timer);
        if (!response.ok) {
          const body = await response.text();
          throw new Error(`Backend request failed: ${response.status} ${body}`);
        }
        return response.json();
      } catch (error) {
        clearTimeout(timer);
        if (count < retries && error.name !== "AbortError") {
          await new Promise((resolve) => setTimeout(resolve, 200 * count));
          return attempt(count + 1);
        }
        throw error;
      }
    };
    return attempt(1);
  }
  async post(path, body) {
    return this.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  }
};

// src/contextResolver.ts
var vscode3 = __toESM(require("vscode"));
var ContextReferenceResolver = class {
  async resolveSelection(editor) {
    const document = editor.document;
    const text = document.getText(editor.selection);
    const workspaceFolder = vscode3.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath ?? null;
    return {
      text,
      language: document.languageId,
      filePath: document.uri.fsPath,
      range: editor.selection,
      workspaceFolder
    };
  }
  async resolveFile(editor) {
    const document = editor.document;
    const selection = new vscode3.Range(0, 0, 0, 0);
    const workspaceFolder = vscode3.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath ?? null;
    return {
      text: document.getText(),
      language: document.languageId,
      filePath: document.uri.fsPath,
      range: selection,
      workspaceFolder
    };
  }
  async resolveGitDiff(workspaceFolder) {
    const repo = await this.getGitRepository(workspaceFolder);
    const branch = repo?.state.HEAD?.name ?? null;
    const changes = repo ? await this.getDiffFromRepository(repo) : "";
    return { branch, changes };
  }
  async getGitRepository(workspaceFolder) {
    const gitExtension = vscode3.extensions.getExtension("vscode.git")?.exports;
    if (!gitExtension) {
      return void 0;
    }
    const api = gitExtension.getAPI(1);
    const repo = api.repositories.find((repository) => repository.rootUri.fsPath === workspaceFolder.uri.fsPath);
    return repo;
  }
  async getDiffFromRepository(repo) {
    const diffs = await Promise.all(repo.state.workingTreeChanges.map(async (change) => change.uri.fsPath));
    return diffs.join("\n");
  }
};

// src/extension.ts
function activate(context) {
  const config = vscode4.workspace.getConfiguration("personalCodex");
  const backendClient = new BackendClient(config);
  const resolver = new ContextReferenceResolver();
  const sidebarProvider = new PersonalCodexSidebarProvider(context, backendClient, resolver);
  context.subscriptions.push(
    vscode4.window.registerWebviewViewProvider("personalCodexSidebar", sidebarProvider, {
      webviewOptions: { enableScripts: true, localResourceRoots: [vscode4.Uri.joinPath(context.extensionUri, "media")] }
    })
  );
  const registerCommand = (command, callback) => {
    context.subscriptions.push(vscode4.commands.registerCommand(command, callback));
  };
  registerCommand("personalCodeMe.openChat", async () => sidebarProvider.reveal());
  registerCommand("personalCodex.newChat", async () => sidebarProvider.createNewChat());
  registerCommand("personalCodex.explainSelection", async () => sidebarProvider.handleSelectionCommand("explain"));
  registerCommand("personalCodex.fixSelection", async () => sidebarProvider.handleSelectionCommand("fix"));
  registerCommand("personalCodex.refactorSelection", async () => sidebarProvider.handleSelectionCommand("refactor"));
  registerCommand("personalCodex.generateTests", async () => sidebarProvider.handleSelectionCommand("tests"));
  registerCommand("personalCodex.askCurrentFile", async () => sidebarProvider.handleFileCommand("ask"));
  registerCommand("personalCodex.reviewChanges", async () => sidebarProvider.reviewChanges());
  registerCommand("personalCodex.registerWorkspace", async () => sidebarProvider.registerWorkspace());
  registerCommand("personalCodex.checkBackend", async () => backendClient.checkConnection(true));
  registerCommand("personalCodex.startBackend", async () => vscode4.window.showInformationMessage("Personal Codex does not start backend processes in Phase 3.5."));
  context.subscriptions.push(vscode4.workspace.onDidChangeWorkspaceFolders(() => sidebarProvider.refreshWorkspaceState()));
  context.subscriptions.push(vscode4.workspace.onDidChangeConfiguration(() => sidebarProvider.updateConfiguration()));
}
function deactivate() {
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  activate,
  deactivate
});
//# sourceMappingURL=extension.js.map
