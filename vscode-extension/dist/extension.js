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
var vscode5 = __toESM(require("vscode"));

// src/sidebarProvider.ts
var path = __toESM(require("path"));
var vscode2 = __toESM(require("vscode"));

// src/webviewHtml.ts
var vscode = __toESM(require("vscode"));
function webviewHtml(webview, extensionUri) {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "webview.js"));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "webview.css"));
  const nonce = getNonce();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Personal Codeme</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
function getNonce() {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

// src/sidebarProvider.ts
var PersonalCodexSidebarProvider = class {
  constructor(context, backend, resolver) {
    this.context = context;
    this.backend = backend;
    this.resolver = resolver;
    this.webviewReady = false;
    this.pendingMessages = [];
  }
  resolveWebviewView(webviewView) {
    this.view = webviewView;
    this.webviewReady = false;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode2.Uri.joinPath(this.context.extensionUri, "dist"),
        vscode2.Uri.joinPath(this.context.extensionUri, "media")
      ]
    };
    webviewView.webview.html = webviewHtml(webviewView.webview, this.context.extensionUri);
    this.context.subscriptions.push(
      webviewView.webview.onDidReceiveMessage((data) => void this.handleMessage(data)),
      webviewView.onDidDispose(() => {
        this.view = void 0;
        this.webviewReady = false;
      })
    );
  }
  async reveal() {
    if (!this.view) {
      await vscode2.commands.executeCommand("workbench.view.extension.personalCodeme");
    }
    this.view?.show?.(true);
  }
  async createNewChat() {
    await this.reveal();
    await this.send({ command: "newChat", payload: {} });
  }
  async handleSelectionCommand(action) {
    const editor = vscode2.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      void vscode2.window.showWarningMessage("Select code before running this action.");
      return;
    }
    const selection = await this.resolver.resolveSelection(editor);
    await this.reveal();
    await this.send({
      command: "contextAction",
      payload: {
        action,
        context: {
          kind: "selection",
          label: `${path.basename(selection.filePath)} \xB7 selected code`,
          detail: selection.filePath,
          content: selection.text,
          language: selection.language
        }
      }
    });
  }
  async handleFileCommand(action) {
    const editor = vscode2.window.activeTextEditor;
    if (!editor) {
      void vscode2.window.showWarningMessage("Open a file first.");
      return;
    }
    const file = await this.resolver.resolveFile(editor);
    await this.reveal();
    await this.send({
      command: "contextAction",
      payload: {
        action,
        context: {
          kind: "file",
          label: path.basename(file.filePath),
          detail: file.filePath,
          content: file.text,
          language: file.language
        }
      }
    });
  }
  async reviewChanges() {
    const workspace4 = this.getActiveWorkspaceFolder();
    if (!workspace4) {
      void vscode2.window.showWarningMessage("Open a workspace folder first.");
      return;
    }
    const diff = await this.resolver.resolveGitDiff(workspace4);
    await this.reveal();
    await this.send({
      command: "contextAction",
      payload: {
        action: "reviewChanges",
        context: {
          kind: "changes",
          label: diff.branch ? `Changes on ${diff.branch}` : "Working tree changes",
          detail: workspace4.uri.fsPath,
          content: diff.changes,
          language: "diff"
        }
      }
    });
  }
  async registerWorkspace() {
    const folder = this.getActiveWorkspaceFolder();
    if (!folder) {
      void vscode2.window.showWarningMessage("Open a workspace folder first.");
      return;
    }
    const accept = await vscode2.window.showInformationMessage(
      `Register '${folder.name}' with Personal Codeme?`,
      "Register",
      "Cancel"
    );
    if (accept !== "Register") {
      return;
    }
    const workspaceId = await this.backend.registerWorkspace(folder.uri.fsPath, folder.name);
    await this.send({ command: "workspaceRegistered", payload: { workspaceId, rootPath: folder.uri.fsPath } });
    await this.refreshWorkspaceState();
  }
  async startBackend() {
    try {
      await this.backend.checkConnection(false);
      void vscode2.window.showInformationMessage("Personal Codeme backend is already running.");
      await this.refreshBackendStatus(false);
      return;
    } catch {
    }
    const tasks2 = await vscode2.tasks.fetchTasks();
    const backendTask = tasks2.find((task) => task.name === "Run Codeme API");
    if (!backendTask) {
      void vscode2.window.showWarningMessage("Task 'Run Codeme API' was not found in this workspace.");
      return;
    }
    await vscode2.tasks.executeTask(backendTask);
    void vscode2.window.showInformationMessage("Starting the Personal Codeme backend\u2026");
    setTimeout(() => void this.refreshBackendStatus(false), 2500);
  }
  async refreshWorkspaceState() {
    const folder = this.getActiveWorkspaceFolder();
    await this.send({
      command: "workspaceState",
      payload: {
        workspace: folder?.name ?? null,
        rootPath: folder?.uri.fsPath ?? null,
        folders: vscode2.workspace.workspaceFolders?.length ?? 0
      }
    });
  }
  async updateConfiguration() {
    this.backend.updateSettings(vscode2.workspace.getConfiguration("personalCodex"));
    if (this.webviewReady) {
      await this.initialize();
    }
  }
  getActiveWorkspaceFolder() {
    return vscode2.workspace.workspaceFolders?.[0];
  }
  async initialize(conversationId) {
    await Promise.all([
      this.refreshBackendStatus(false),
      this.refreshWorkspaceState(),
      this.refreshConversations()
    ]);
    if (conversationId) {
      await this.loadConversation(conversationId);
    }
  }
  async refreshBackendStatus(userTriggered) {
    try {
      const health = await this.backend.checkConnection(userTriggered);
      await this.send({
        command: "backendStatus",
        payload: {
          online: true,
          model: health.model || this.backend.configuredModel,
          models: health.models || [this.backend.configuredModel],
          ollama: health.ollama === "ok"
        }
      });
    } catch (error) {
      await this.send({
        command: "backendStatus",
        payload: {
          online: false,
          model: this.backend.configuredModel,
          models: [this.backend.configuredModel],
          ollama: false,
          error: error.message
        }
      });
    }
  }
  async refreshConversations(query) {
    try {
      const conversations = await this.backend.listConversations(query);
      await this.send({ command: "conversationsUpdated", payload: conversations });
    } catch (error) {
      console.warn("Unable to load Personal Codeme conversations.", error);
    }
  }
  async loadConversation(conversationId) {
    try {
      const messages = await this.backend.getConversationMessages(conversationId);
      await this.send({ command: "conversationLoaded", payload: { conversationId, messages } });
    } catch (error) {
      await this.send({ command: "operationError", payload: { message: error.message } });
    }
  }
  async send(message) {
    if (!this.view || !this.webviewReady) {
      this.pendingMessages.push(message);
      return;
    }
    await this.view.webview.postMessage(message);
  }
  async flushPendingMessages() {
    const pending = this.pendingMessages.splice(0);
    for (const message of pending) {
      await this.send(message);
    }
  }
  async handleMessage(data) {
    const message = data;
    if (!message.command) {
      return;
    }
    switch (message.command) {
      case "ready": {
        this.webviewReady = true;
        const conversationId = typeof message.args?.conversationId === "number" ? message.args.conversationId : null;
        await this.initialize(conversationId);
        await this.flushPendingMessages();
        break;
      }
      case "healthCheck":
        await this.refreshBackendStatus(true);
        break;
      case "startChat":
        await this.handleChatRequest(message.args);
        break;
      case "cancelStream":
        this.backend.cancel();
        break;
      case "loadConversation":
        if (typeof message.args?.conversationId === "number") {
          await this.loadConversation(message.args.conversationId);
        }
        break;
      case "deleteConversation":
        if (typeof message.args?.conversationId === "number") {
          await this.backend.deleteConversation(message.args.conversationId);
          await this.send({ command: "conversationDeleted", payload: { conversationId: message.args.conversationId } });
          await this.refreshConversations();
        }
        break;
      case "renameConversation":
        if (typeof message.args?.conversationId === "number" && typeof message.args?.title === "string") {
          await this.backend.renameConversation(message.args.conversationId, message.args.title.trim());
          await this.refreshConversations();
        }
        break;
      case "searchConversations":
        await this.refreshConversations(typeof message.args?.query === "string" ? message.args.query : void 0);
        break;
      case "requestContext":
        await this.handleContextRequest(String(message.args?.kind || ""));
        break;
      case "copyText":
        if (typeof message.args?.text === "string") {
          await vscode2.env.clipboard.writeText(message.args.text);
        }
        break;
      case "openCode":
        if (typeof message.args?.text === "string") {
          const document = await vscode2.workspace.openTextDocument({
            content: message.args.text,
            language: this.normalizeLanguage(typeof message.args?.language === "string" ? message.args.language : void 0)
          });
          await vscode2.window.showTextDocument(document, { preview: true });
        }
        break;
      case "applyCode":
        if (typeof message.args?.text === "string") {
          await this.applyCodeToEditor(message.args.text);
        }
        break;
      case "openSettings":
        await vscode2.commands.executeCommand("workbench.action.openSettings", "@ext:personal-codex-local.personal-codeme");
        break;
      case "startBackend":
        await this.startBackend();
        break;
      default:
        console.warn("Unknown command from Personal Codeme webview:", message.command);
    }
  }
  async handleContextRequest(kind) {
    if (kind === "selection") {
      const editor = vscode2.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        void vscode2.window.showWarningMessage("Select code in the editor first.");
        return;
      }
      const selection = await this.resolver.resolveSelection(editor);
      await this.send({
        command: "contextAdded",
        payload: {
          kind: "selection",
          label: `${path.basename(selection.filePath)} \xB7 selection`,
          detail: selection.filePath,
          content: selection.text,
          language: selection.language
        }
      });
      return;
    }
    if (kind === "file") {
      const editor = vscode2.window.activeTextEditor;
      if (!editor) {
        void vscode2.window.showWarningMessage("Open a file first.");
        return;
      }
      const file = await this.resolver.resolveFile(editor);
      await this.send({
        command: "contextAdded",
        payload: {
          kind: "file",
          label: path.basename(file.filePath),
          detail: file.filePath,
          content: file.text,
          language: file.language
        }
      });
      return;
    }
    if (kind === "changes") {
      const workspace4 = this.getActiveWorkspaceFolder();
      if (!workspace4) {
        void vscode2.window.showWarningMessage("Open a workspace folder first.");
        return;
      }
      const diff = await this.resolver.resolveGitDiff(workspace4);
      await this.send({
        command: "contextAdded",
        payload: {
          kind: "changes",
          label: diff.branch ? `Changes on ${diff.branch}` : "Working tree changes",
          detail: workspace4.uri.fsPath,
          content: diff.changes,
          language: "diff"
        }
      });
    }
  }
  async handleChatRequest(args) {
    const prompt = args.prompt?.trim();
    if (!prompt) {
      return;
    }
    let conversationId = args.conversationId || null;
    if (!conversationId) {
      const conversation = await this.backend.createConversation(this.createTitle(prompt));
      conversationId = conversation.id;
      await this.send({ command: "conversationCreated", payload: conversation });
    }
    const contextText = (args.context || []).map((item) => {
      const language = item.language || "text";
      return `Context: ${item.label} (${item.kind})
\`\`\`${language}
${item.content}
\`\`\``;
    }).join("\n\n");
    const content = contextText ? `${prompt}

${contextText}` : prompt;
    await this.send({ command: "streamStarted", payload: { conversationId } });
    await this.backend.streamChat(
      conversationId,
      [{ role: "user", content }],
      args.model,
      (chunk) => void this.send({ command: "streamChunk", payload: { conversationId, chunk } }),
      () => {
        void this.send({ command: "streamComplete", payload: { conversationId } });
        void this.refreshConversations();
      },
      (error) => {
        void this.send({ command: "streamError", payload: { conversationId, message: error.message } });
        void this.refreshConversations();
      }
    );
  }
  createTitle(prompt) {
    const title = prompt.replace(/\s+/g, " ").trim();
    return title.length > 52 ? `${title.slice(0, 49)}\u2026` : title;
  }
  normalizeLanguage(language) {
    const aliases = {
      js: "javascript",
      ts: "typescript",
      py: "python",
      sh: "shellscript",
      bash: "shellscript",
      cs: "csharp",
      md: "markdown",
      yml: "yaml",
      text: "plaintext",
      code: "plaintext"
    };
    return aliases[language || ""] || language || "plaintext";
  }
  async applyCodeToEditor(code) {
    const editor = vscode2.window.activeTextEditor;
    if (!editor) {
      const document = await vscode2.workspace.openTextDocument({ content: code });
      await vscode2.window.showTextDocument(document, { preview: true });
      return;
    }
    const requireApproval = vscode2.workspace.getConfiguration("personalCodex").get("requireWriteApproval", true);
    if (requireApproval) {
      const target = editor.selection.isEmpty ? "insert at the cursor" : "replace the selected code";
      const choice = await vscode2.window.showWarningMessage(
        `Apply generated code and ${target}?`,
        { modal: true },
        "Apply"
      );
      if (choice !== "Apply") {
        return;
      }
    }
    const applied = await editor.edit((builder) => {
      if (editor.selection.isEmpty) {
        builder.insert(editor.selection.active, code);
      } else {
        builder.replace(editor.selection, code);
      }
    });
    if (!applied) {
      void vscode2.window.showErrorMessage("Unable to apply the generated code.");
    }
  }
};

// src/backendClient.ts
var vscode3 = __toESM(require("vscode"));
var LOCALHOST_URLS = ["http://127.0.0.1", "http://localhost"];
var BackendClient = class {
  constructor(config) {
    this.config = config;
  }
  get configuredModel() {
    return this.config.get("personalCodex.defaultModel", "qwen2.5-coder:7b");
  }
  get backendUrl() {
    return this.config.get("personalCodex.backendUrl", "http://127.0.0.1:8000");
  }
  get showNotifications() {
    return this.config.get("personalCodex.showNotifications", true);
  }
  async checkConnection(userTriggered) {
    if (!LOCALHOST_URLS.some((host) => this.backendUrl.startsWith(host))) {
      void vscode3.window.showWarningMessage("Personal Codeme is configured to use a non-local backend URL.");
    }
    try {
      const response = await this.request("/health", void 0, 3e3, 3);
      if (response.status === "ok" && this.showNotifications && userTriggered) {
        const target = response.model ? `${response.model} through Ollama` : "the local backend";
        void vscode3.window.showInformationMessage(`Personal Codeme is connected to ${target}.`);
      }
      return response;
    } catch (error) {
      if (userTriggered) {
        void vscode3.window.showErrorMessage("Unable to connect to the Personal Codeme backend.");
      }
      throw error;
    }
  }
  async registerWorkspace(path2, displayName) {
    const response = await this.post("/workspaces", {
      path: path2,
      display_name: displayName
    });
    return response.id;
  }
  async listConversations(query) {
    const suffix = query ? `?query=${encodeURIComponent(query)}` : "";
    return this.request(`/conversations${suffix}`);
  }
  async createConversation(title) {
    return this.post("/conversations", { title: title || "New chat" });
  }
  async getConversationMessages(conversationId) {
    return this.request(`/conversations/${conversationId}/messages`);
  }
  async renameConversation(conversationId, title) {
    return this.request(`/conversations/${conversationId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title })
    });
  }
  async deleteConversation(conversationId) {
    await this.request(`/conversations/${conversationId}`, { method: "DELETE" });
  }
  async streamChat(conversationId, messages, model, onChunk, onComplete, onError) {
    const url = this.getUrl(`/conversations/${conversationId}/chat`);
    this.controller = new AbortController();
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ model: model || this.configuredModel, messages }),
        signal: this.controller.signal
      });
      if (!response.ok) {
        throw new Error(`Backend request failed: ${response.status} ${await response.text()}`);
      }
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("The backend response stream is unavailable.");
      }
      const decoder = new TextDecoder();
      let buffer = "";
      let completed = false;
      while (!completed) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line.startsWith("data:")) {
            continue;
          }
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") {
            completed = true;
            break;
          }
          try {
            const decoded = JSON.parse(payload);
            if (typeof decoded === "string") {
              onChunk(decoded);
            } else if (decoded.error) {
              throw new Error(decoded.error);
            }
          } catch (error) {
            if (error instanceof SyntaxError) {
              onChunk(payload);
            } else {
              throw error;
            }
          }
        }
      }
      onComplete();
    } catch (error) {
      if (error?.name === "AbortError") {
        onError(new Error("Generation stopped."));
      } else {
        onError(error);
      }
    } finally {
      this.controller = void 0;
    }
  }
  cancel() {
    this.controller?.abort();
  }
  updateSettings(config) {
    this.config = config;
  }
  getUrl(path2) {
    return `${this.backendUrl.replace(/\/+$/, "")}/api${path2}`;
  }
  async request(path2, init, timeout = 5e3, retries = 1) {
    const url = this.getUrl(path2);
    const attempt = async (count) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await fetch(url, { signal: controller.signal, ...init });
        if (!response.ok) {
          throw new Error(`Backend request failed: ${response.status} ${await response.text()}`);
        }
        if (response.status === 204) {
          return void 0;
        }
        return await response.json();
      } catch (error) {
        if (count < retries && error.name !== "AbortError") {
          await new Promise((resolve) => setTimeout(resolve, 200 * count));
          return attempt(count + 1);
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    };
    return attempt(1);
  }
  post(path2, body) {
    return this.request(path2, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  }
};

// src/contextResolver.ts
var vscode4 = __toESM(require("vscode"));
var ContextReferenceResolver = class {
  async resolveSelection(editor) {
    const document = editor.document;
    const text = document.getText(editor.selection);
    const workspaceFolder = vscode4.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath ?? null;
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
    const selection = new vscode4.Range(0, 0, 0, 0);
    const workspaceFolder = vscode4.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath ?? null;
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
    const gitExtension = vscode4.extensions.getExtension("vscode.git")?.exports;
    if (!gitExtension) {
      return void 0;
    }
    const api = gitExtension.getAPI(1);
    const repo = api.repositories.find((repository) => repository.rootUri.fsPath === workspaceFolder.uri.fsPath);
    return repo;
  }
  async getDiffFromRepository(repo) {
    const [workingTree, staged] = await Promise.all([repo.diff(false), repo.diff(true)]);
    return [workingTree, staged].filter(Boolean).join("\n\n");
  }
};

// src/extension.ts
function activate(context) {
  const config = vscode5.workspace.getConfiguration("personalCodex");
  const backendClient = new BackendClient(config);
  const resolver = new ContextReferenceResolver();
  const sidebarProvider = new PersonalCodexSidebarProvider(context, backendClient, resolver);
  context.subscriptions.push(
    vscode5.window.registerWebviewViewProvider("personalCodemeSidebar", sidebarProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );
  const registerCommand = (command, callback) => {
    context.subscriptions.push(vscode5.commands.registerCommand(command, callback));
  };
  registerCommand("personalCodeme.openChat", async () => sidebarProvider.reveal());
  registerCommand("personalCodex.newChat", async () => sidebarProvider.createNewChat());
  registerCommand("personalCodex.explainSelection", async () => sidebarProvider.handleSelectionCommand("explain"));
  registerCommand("personalCodex.fixSelection", async () => sidebarProvider.handleSelectionCommand("fix"));
  registerCommand("personalCodex.refactorSelection", async () => sidebarProvider.handleSelectionCommand("refactor"));
  registerCommand("personalCodex.generateTests", async () => sidebarProvider.handleSelectionCommand("tests"));
  registerCommand("personalCodex.askCurrentFile", async () => sidebarProvider.handleFileCommand("ask"));
  registerCommand("personalCodex.reviewChanges", async () => sidebarProvider.reviewChanges());
  registerCommand("personalCodex.registerWorkspace", async () => sidebarProvider.registerWorkspace());
  registerCommand("personalCodex.checkBackend", async () => {
    await backendClient.checkConnection(true);
  });
  registerCommand("personalCodex.startBackend", async () => sidebarProvider.startBackend());
  context.subscriptions.push(vscode5.workspace.onDidChangeWorkspaceFolders(() => sidebarProvider.refreshWorkspaceState()));
  context.subscriptions.push(vscode5.workspace.onDidChangeConfiguration(() => sidebarProvider.updateConfiguration()));
}
function deactivate() {
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  activate,
  deactivate
});
//# sourceMappingURL=extension.js.map
