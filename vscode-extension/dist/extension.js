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
var vscode6 = __toESM(require("vscode"));

// src/sidebarProvider.ts
var path3 = __toESM(require("path"));
var vscode3 = __toESM(require("vscode"));

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

// src/changeSetManager.ts
var import_crypto = require("crypto");
var import_fs = require("fs");
var path = __toESM(require("path"));
var vscode2 = __toESM(require("vscode"));

// src/changeSet.ts
function isSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
function validateRelativePath(value) {
  const normalized = value.replace(/\\/g, "/");
  if (!normalized || normalized.includes("\0") || normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error("Change-set paths must be workspace-relative.");
  }
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("Traversal and ambiguous path segments are not allowed.");
  }
  return normalized;
}
function validateChangeSet(changeSet) {
  if (changeSet.schema_version !== 1 || !changeSet.id || !changeSet.operations.length) {
    throw new Error("Invalid or empty change set.");
  }
  const paths = /* @__PURE__ */ new Set();
  for (const operation of changeSet.operations) {
    const relativePath = validateRelativePath(operation.relative_path);
    const key = relativePath.toLocaleLowerCase();
    if (paths.has(key))
      throw new Error(`Duplicate change-set path: ${relativePath}`);
    paths.add(key);
    if (!["create", "modify"].includes(operation.type) || !isSha256(operation.proposed_sha256)) {
      throw new Error(`Invalid operation for ${relativePath}`);
    }
    if (operation.type === "modify" && !isSha256(operation.base_sha256)) {
      throw new Error(`Modify operation lacks a base hash for ${relativePath}`);
    }
    if (operation.type === "create" && operation.base_sha256 !== null) {
      throw new Error(`Create operation must not include a base hash for ${relativePath}`);
    }
  }
}

// src/changeSetManager.ts
var ChangeSetConflictError = class extends Error {
};
function sha256Bytes(value) {
  return (0, import_crypto.createHash)("sha256").update(value).digest("hex");
}
function sha256Text(value) {
  return sha256Bytes(Buffer.from(value, "utf8"));
}
var ChangeSetManager = class {
  constructor(context) {
    this.context = context;
  }
  async assertPreviewable(changeSet, folder) {
    validateChangeSet(changeSet);
    const root = await import_fs.promises.realpath(folder.uri.fsPath);
    for (const operation of changeSet.operations) {
      const target = await this.resolveTarget(root, operation);
      const openDocument = this.findOpenDocument(vscode2.Uri.file(target));
      if (openDocument?.isDirty) {
        throw new ChangeSetConflictError(`Unsaved changes block preview for ${operation.relative_path}.`);
      }
      if (operation.type === "create") {
        if (await this.exists(target))
          throw new ChangeSetConflictError(`Create target now exists: ${operation.relative_path}`);
      } else {
        const document = openDocument || await vscode2.workspace.openTextDocument(vscode2.Uri.file(target));
        if (sha256Text(document.getText()) !== operation.base_sha256) {
          throw new ChangeSetConflictError(`The file changed after proposal: ${operation.relative_path}`);
        }
      }
    }
  }
  async apply(changeSet, folder) {
    validateChangeSet(changeSet);
    const root = await import_fs.promises.realpath(folder.uri.fsPath);
    const documents = /* @__PURE__ */ new Map();
    const checkpoint = {
      schemaVersion: 1,
      changeSetId: changeSet.id,
      workspaceRoot: root,
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      files: []
    };
    for (const operation of changeSet.operations) {
      const target = await this.resolveTarget(root, operation);
      const uri = vscode2.Uri.file(target);
      const openDocument = this.findOpenDocument(uri);
      if (openDocument?.isDirty) {
        throw new ChangeSetConflictError(`Unsaved changes block ${operation.relative_path}. Save or revert them before applying.`);
      }
      if (operation.type === "create") {
        if (await this.exists(target))
          throw new ChangeSetConflictError(`Create target now exists: ${operation.relative_path}`);
        checkpoint.files.push({
          relativePath: operation.relative_path,
          existed: false,
          originalBase64: "",
          originalSha256: null,
          appliedSha256: operation.proposed_sha256
        });
      } else {
        const document = openDocument || await vscode2.workspace.openTextDocument(uri);
        const current = document.getText();
        if (sha256Text(current) !== operation.base_sha256) {
          throw new ChangeSetConflictError(`The file changed after preview: ${operation.relative_path}`);
        }
        documents.set(operation.relative_path, document);
        checkpoint.files.push({
          relativePath: operation.relative_path,
          existed: true,
          originalBase64: Buffer.from(current, "utf8").toString("base64"),
          originalSha256: operation.base_sha256,
          appliedSha256: operation.proposed_sha256
        });
      }
      if (sha256Text(operation.proposed_content) !== operation.proposed_sha256) {
        throw new ChangeSetConflictError(`Proposed content hash is invalid: ${operation.relative_path}`);
      }
    }
    const checkpointReference = await this.writeCheckpoint(checkpoint);
    const edit = new vscode2.WorkspaceEdit();
    for (const operation of changeSet.operations) {
      const target = vscode2.Uri.file(path.join(root, validateRelativePath(operation.relative_path)));
      if (operation.type === "create") {
        edit.createFile(target, { overwrite: false, ignoreIfExists: false });
        edit.insert(target, new vscode2.Position(0, 0), operation.proposed_content);
      } else {
        const document = documents.get(operation.relative_path);
        edit.replace(target, new vscode2.Range(document.positionAt(0), document.positionAt(document.getText().length)), operation.proposed_content);
      }
    }
    try {
      const applied = await vscode2.workspace.applyEdit(edit);
      if (!applied)
        throw new Error("VS Code rejected the complete WorkspaceEdit.");
      const resultHashes = await this.verifyApplied(changeSet, root);
      return { checkpointReference, resultHashes };
    } catch (error) {
      await this.rollbackCheckpoint(checkpoint);
      throw error;
    }
  }
  async restore(changeSet, folder) {
    const checkpointReference = changeSet.checkpoint_reference;
    if (!checkpointReference)
      throw new ChangeSetConflictError("This change set has no checkpoint.");
    const checkpoint = await this.readCheckpoint(checkpointReference);
    const root = await import_fs.promises.realpath(folder.uri.fsPath);
    if (path.normalize(checkpoint.workspaceRoot).toLowerCase() !== path.normalize(root).toLowerCase()) {
      throw new ChangeSetConflictError("The checkpoint belongs to a different workspace.");
    }
    for (const file of checkpoint.files) {
      const operation = changeSet.operations.find((item) => item.relative_path === file.relativePath);
      if (!operation)
        throw new ChangeSetConflictError(`Checkpoint operation is missing: ${file.relativePath}`);
      const target = await this.resolveTarget(root, operation, true);
      if (!await this.exists(target))
        throw new ChangeSetConflictError(`Applied file is missing: ${file.relativePath}`);
      const document = this.findOpenDocument(vscode2.Uri.file(target)) || await vscode2.workspace.openTextDocument(vscode2.Uri.file(target));
      if (sha256Text(document.getText()) !== file.appliedSha256) {
        throw new ChangeSetConflictError(`Restore conflict: ${file.relativePath} changed after application.`);
      }
    }
    const edit = new vscode2.WorkspaceEdit();
    for (const file of checkpoint.files) {
      const uri = vscode2.Uri.file(path.join(root, validateRelativePath(file.relativePath)));
      if (!file.existed) {
        edit.deleteFile(uri, { ignoreIfNotExists: false, recursive: false });
      } else {
        const document = this.findOpenDocument(uri) || await vscode2.workspace.openTextDocument(uri);
        const original = Buffer.from(file.originalBase64, "base64").toString("utf8");
        edit.replace(uri, new vscode2.Range(document.positionAt(0), document.positionAt(document.getText().length)), original);
      }
    }
    if (!await vscode2.workspace.applyEdit(edit))
      throw new Error("VS Code rejected the restore WorkspaceEdit.");
    for (const file of checkpoint.files) {
      const target = path.join(root, validateRelativePath(file.relativePath));
      if (!file.existed) {
        if (await this.exists(target))
          throw new Error(`Restore verification failed for ${file.relativePath}`);
      } else {
        const document = this.findOpenDocument(vscode2.Uri.file(target)) || await vscode2.workspace.openTextDocument(vscode2.Uri.file(target));
        if (sha256Text(document.getText()) !== file.originalSha256)
          throw new Error(`Restore verification failed for ${file.relativePath}`);
      }
    }
  }
  async verifyApplied(changeSet, root) {
    const hashes = {};
    for (const operation of changeSet.operations) {
      const uri = vscode2.Uri.file(path.join(root, validateRelativePath(operation.relative_path)));
      const document = this.findOpenDocument(uri) || await vscode2.workspace.openTextDocument(uri);
      const hash = sha256Text(document.getText());
      if (hash !== operation.proposed_sha256)
        throw new Error(`Application verification failed for ${operation.relative_path}`);
      hashes[operation.relative_path] = hash;
    }
    return hashes;
  }
  async rollbackCheckpoint(checkpoint) {
    const edit = new vscode2.WorkspaceEdit();
    for (const file of checkpoint.files) {
      const uri = vscode2.Uri.file(path.join(checkpoint.workspaceRoot, validateRelativePath(file.relativePath)));
      if (!file.existed) {
        edit.deleteFile(uri, { ignoreIfNotExists: true, recursive: false });
        continue;
      }
      try {
        const document = this.findOpenDocument(uri) || await vscode2.workspace.openTextDocument(uri);
        const original = Buffer.from(file.originalBase64, "base64").toString("utf8");
        edit.replace(uri, new vscode2.Range(document.positionAt(0), document.positionAt(document.getText().length)), original);
      } catch {
        edit.createFile(uri, { ignoreIfExists: true });
        edit.insert(uri, new vscode2.Position(0, 0), Buffer.from(file.originalBase64, "base64").toString("utf8"));
      }
    }
    await vscode2.workspace.applyEdit(edit);
  }
  async resolveTarget(root, operation, allowExistingCreate = false) {
    const relativePath = validateRelativePath(operation.relative_path);
    const target = path.resolve(root, relativePath);
    const relative4 = path.relative(root, target);
    if (!relative4 || relative4.startsWith("..") || path.isAbsolute(relative4)) {
      throw new ChangeSetConflictError(`Path escapes the workspace: ${relativePath}`);
    }
    if (await this.exists(target)) {
      const realTarget = await import_fs.promises.realpath(target);
      this.assertInside(root, realTarget, relativePath);
      if (operation.type === "create" && !allowExistingCreate) {
        throw new ChangeSetConflictError(`Create target already exists: ${relativePath}`);
      }
    } else {
      let parent = path.dirname(target);
      while (!await this.exists(parent)) {
        const next = path.dirname(parent);
        if (next === parent)
          throw new ChangeSetConflictError(`No safe parent exists for ${relativePath}`);
        parent = next;
      }
      const realParent = await import_fs.promises.realpath(parent);
      this.assertInside(root, realParent, relativePath);
      if (path.normalize(parent) !== path.normalize(path.dirname(target))) {
        throw new ChangeSetConflictError(`Create parent does not exist: ${relativePath}`);
      }
    }
    return target;
  }
  assertInside(root, target, relativePath) {
    const relative4 = path.relative(root, target);
    if (relative4.startsWith("..") || path.isAbsolute(relative4)) {
      throw new ChangeSetConflictError(`Symlink or junction escapes the workspace: ${relativePath}`);
    }
  }
  findOpenDocument(uri) {
    return vscode2.workspace.textDocuments.find((document) => path.normalize(document.uri.fsPath).toLowerCase() === path.normalize(uri.fsPath).toLowerCase());
  }
  async exists(target) {
    try {
      await import_fs.promises.stat(target);
      return true;
    } catch {
      return false;
    }
  }
  checkpointUri(reference) {
    return vscode2.Uri.joinPath(this.context.globalStorageUri, "change-set-checkpoints", reference);
  }
  async writeCheckpoint(checkpoint) {
    const reference = `${checkpoint.changeSetId}.json`;
    const directory = vscode2.Uri.joinPath(this.context.globalStorageUri, "change-set-checkpoints");
    await vscode2.workspace.fs.createDirectory(directory);
    await vscode2.workspace.fs.writeFile(this.checkpointUri(reference), Buffer.from(JSON.stringify(checkpoint), "utf8"));
    return reference;
  }
  async readCheckpoint(reference) {
    if (!/^[a-zA-Z0-9._-]+\.json$/.test(reference))
      throw new ChangeSetConflictError("Invalid checkpoint reference.");
    const bytes = await vscode2.workspace.fs.readFile(this.checkpointUri(reference));
    const checkpoint = JSON.parse(Buffer.from(bytes).toString("utf8"));
    if (checkpoint.schemaVersion !== 1)
      throw new ChangeSetConflictError("Unsupported checkpoint version.");
    return checkpoint;
  }
};

// src/commandPolicy.ts
var import_node_fs = require("node:fs");
var path2 = __toESM(require("node:path"));
var PROFILES = /* @__PURE__ */ new Set([
  "pytest",
  "python_module",
  "npm_test",
  "npm_build",
  "npm_lint",
  "dotnet_test",
  "dotnet_build",
  "maven_test",
  "maven_package",
  "gradle_test",
  "gradle_build",
  "git_status",
  "git_diff",
  "custom_executable"
]);
var SECRET_ENV = /(TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|CONNECTION_STRING|CREDENTIAL|AUTH|COOKIE)/i;
var SHELL_META = /[|&;<>`\r\n]|\$\(|\|\||&&/;
var WINDOWS_WRAPPER_META = /[&|<>^%!()"\r\n]/;
var BLOCKED_EXECUTABLES = /* @__PURE__ */ new Set([
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
  "cmd",
  "cmd.exe",
  "bash",
  "bash.exe",
  "sh",
  "sh.exe",
  "diskpart",
  "diskpart.exe",
  "format",
  "format.com",
  "shutdown",
  "shutdown.exe",
  "reg",
  "reg.exe",
  "sc",
  "sc.exe",
  "schtasks",
  "schtasks.exe",
  "rm",
  "rmdir",
  "del",
  "remove-item"
]);
var BLOCKED_TOKENS = /* @__PURE__ */ new Set([
  "reset",
  "clean",
  "checkout",
  "restore",
  "--hard",
  "--force",
  "--delete",
  "-d",
  "-D",
  "remove-item",
  "rm",
  "rmdir",
  "del",
  "diskpart",
  "format",
  "shutdown",
  "restart-computer",
  "reg",
  "regedit",
  "sc",
  "schtasks",
  "credential",
  "credentials",
  "keychain",
  "private_key",
  "id_rsa",
  "id_ed25519",
  "known_hosts",
  "history",
  ".bash_history",
  "cookies",
  "login data",
  "env",
  "set",
  "printenv",
  "get-childitem env:",
  "-encodedcommand",
  "-enc",
  "-command",
  "--eval",
  "eval",
  "--force-with-lease",
  "--mirror"
]);
var RISK_PRIORITY = [
  "BLOCKED",
  "PACKAGE_INSTALL",
  "NETWORK",
  "LONG_RUNNING",
  "SENSITIVE",
  "WRITES_WORKSPACE",
  "BUILD_OR_TEST",
  "READ_ONLY"
];
var CommandPolicyError = class extends Error {
};
function filteredEnvironment(profile, source = process.env) {
  const baseKeys = ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "USERPROFILE", "HOME", "LANG", "LC_ALL"];
  if (profile.startsWith("dotnet"))
    baseKeys.push("DOTNET_ROOT", "DOTNET_CLI_HOME");
  if (profile.startsWith("maven") || profile.startsWith("gradle"))
    baseKeys.push("JAVA_HOME");
  const environment = {};
  for (const key of baseKeys) {
    if (SECRET_ENV.test(key))
      continue;
    const actualKey = Object.keys(source).find((item) => item.toLowerCase() === key.toLowerCase());
    if (actualKey && source[actualKey] !== void 0)
      environment[actualKey] = source[actualKey];
  }
  return environment;
}
function validateArguments(arguments_) {
  if (arguments_.length > 50)
    throw new CommandPolicyError("Too many command arguments.");
  for (const argument of arguments_) {
    if (typeof argument !== "string" || argument.length > 500 || argument.includes("\0")) {
      throw new CommandPolicyError("Command arguments must be bounded literal strings.");
    }
    if (SHELL_META.test(argument))
      throw new CommandPolicyError("Shell metacharacters are not allowed.");
    const normalized = argument.replace(/\\/g, "/");
    if (path2.isAbsolute(argument) || /^[\\/]{2}/.test(argument) || /^[A-Za-z]:/.test(argument) || normalized.split("/").includes("..")) {
      throw new CommandPolicyError("Absolute, UNC, and traversal argument paths are not allowed.");
    }
  }
}
function profileCommand(profile, arguments_, config) {
  const python = config.get("pythonExecutable", process.platform === "win32" ? "python" : "python3");
  const configuredNpm = config.get("npmExecutable", "npm");
  const npm = process.platform === "win32" && configuredNpm === "npm" ? "npm.cmd" : configuredNpm;
  const dotnet = config.get("dotnetExecutable", "dotnet");
  const configuredMaven = config.get("mavenExecutable", "mvn");
  const maven = process.platform === "win32" && configuredMaven === "mvn" ? "mvn.cmd" : configuredMaven;
  const configuredGradle = config.get("gradleExecutable", "gradle");
  const gradle = process.platform === "win32" && configuredGradle === "gradle" ? "gradle.bat" : configuredGradle;
  const git = config.get("gitExecutable", "git");
  switch (profile) {
    case "pytest":
      return { executable: python, args: ["-m", "pytest", ...arguments_] };
    case "python_module": {
      if (!arguments_.length || !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(arguments_[0])) {
        throw new CommandPolicyError("python_module requires a dotted module name.");
      }
      return { executable: python, args: ["-m", ...arguments_] };
    }
    case "npm_test":
      return { executable: npm, args: ["test", ...arguments_] };
    case "npm_build":
      return { executable: npm, args: ["run", "build", ...arguments_] };
    case "npm_lint":
      return { executable: npm, args: ["run", "lint", ...arguments_] };
    case "dotnet_test":
      return { executable: dotnet, args: ["test", ...arguments_] };
    case "dotnet_build":
      return { executable: dotnet, args: ["build", ...arguments_] };
    case "maven_test":
      return { executable: maven, args: ["test", ...arguments_] };
    case "maven_package":
      return { executable: maven, args: ["package", ...arguments_] };
    case "gradle_test":
      return { executable: gradle, args: ["test", ...arguments_] };
    case "gradle_build":
      return { executable: gradle, args: ["build", ...arguments_] };
    case "git_status":
      return { executable: git, args: ["status", ...arguments_] };
    case "git_diff":
      return { executable: git, args: ["diff", ...arguments_] };
    case "custom_executable": {
      const [alias, ...rest] = arguments_;
      const allowlist = config.get("customExecutableAllowlist", {});
      if (!alias || !Object.prototype.hasOwnProperty.call(allowlist, alias)) {
        throw new CommandPolicyError("Custom executable aliases are disabled unless explicitly allowlisted by the user.");
      }
      const executable = allowlist[alias];
      if (!executable || typeof executable !== "string")
        throw new CommandPolicyError("The custom executable alias is invalid.");
      return { executable, args: rest };
    }
  }
}
function classify(profile, args, timeout, executable) {
  const risks = /* @__PURE__ */ new Set();
  const reasons = [];
  const baseName = path2.basename(executable).toLowerCase();
  const lowered = args.map((argument) => argument.trim().toLowerCase());
  const joined = lowered.join(" ");
  const destructiveGit = baseName.replace(/\.exe$/, "") === "git" && (/(^|\s)(reset|clean|checkout|restore)(\s|$)/.test(joined) || /(^|\s)push(\s|$)/.test(joined) && /(^|\s)(--force|-f|--force-with-lease|--mirror)(\s|=|$)/.test(joined) || /(^|\s)branch(\s|$)/.test(joined) && /(^|\s)(-d|-D|--delete)(\s|=|$)/.test(joined));
  const protectedDataAccess = /(id_rsa|id_ed25519|private[_ -]?key|\.ssh(?:[\\/]|$)|browser.{0,20}(profile|cookie|login)|\.bash_history|credential|keychain)/.test(joined);
  if (BLOCKED_EXECUTABLES.has(baseName) || lowered.some((token) => BLOCKED_TOKENS.has(token)) || destructiveGit || protectedDataAccess) {
    risks.add("BLOCKED");
    reasons.push("The executable or argument requests a prohibited shell, destructive, system, credential, or inline-evaluation operation.");
  }
  if (baseName.startsWith("python") && lowered.includes("-c") || baseName.startsWith("node") && lowered.includes("-e")) {
    risks.add("BLOCKED");
    reasons.push("Inline interpreter evaluation is prohibited.");
  }
  if (profile === "git_status" || profile === "git_diff") {
    risks.add("READ_ONLY");
    reasons.push("The selected Git profile is read-only.");
  } else if (["pytest", "npm_test", "dotnet_test", "maven_test", "gradle_test"].includes(profile)) {
    risks.add("BUILD_OR_TEST");
    reasons.push("The profile executes project tests and may run repository-provided code.");
  } else if (["npm_build", "npm_lint", "dotnet_build", "maven_package", "gradle_build"].includes(profile)) {
    risks.add("WRITES_WORKSPACE");
    reasons.push("The build profile may create or update workspace artifacts.");
  } else {
    risks.add("SENSITIVE");
    reasons.push("The profile executes a configured runtime or custom executable.");
  }
  if (/\b(install|add|restore|upgrade|update)\b/.test(joined)) {
    risks.add("PACKAGE_INSTALL");
    reasons.push("Arguments may install or restore packages.");
  }
  if (/https?:\/\//.test(joined) || ["maven_test", "maven_package", "gradle_test", "gradle_build"].includes(profile)) {
    risks.add("NETWORK");
    reasons.push("The profile or arguments may access the network.");
  }
  if (timeout > 120) {
    risks.add("LONG_RUNNING");
    reasons.push("The requested timeout exceeds the two-minute default.");
  }
  return { risks: [...risks], reasons };
}
function inside(root, candidate) {
  const relative4 = path2.relative(root, candidate);
  return relative4 === "" || !relative4.startsWith("..") && !path2.isAbsolute(relative4);
}
async function evaluateCommandPolicy(commandRun, registeredRoot, activeFolderRoot, config, sourceEnvironment = process.env) {
  if (commandRun.schema_version !== 1 || !PROFILES.has(commandRun.profile))
    throw new CommandPolicyError("Unsupported command proposal.");
  validateArguments(commandRun.arguments);
  if (/^[\\/]{2}/.test(registeredRoot) || /^[\\/]{2}/.test(activeFolderRoot)) {
    throw new CommandPolicyError("UNC workspaces are not supported for controlled execution.");
  }
  if (path2.isAbsolute(commandRun.cwd_relative) || /^[\\/]{2}/.test(commandRun.cwd_relative) || /^[A-Za-z]:/.test(commandRun.cwd_relative)) {
    throw new CommandPolicyError("Absolute and UNC working directories are not allowed.");
  }
  const cwdParts = commandRun.cwd_relative.replace(/\\/g, "/").split("/");
  if (cwdParts.some((part) => !part || part === "..") && commandRun.cwd_relative !== ".") {
    throw new CommandPolicyError("Working-directory traversal is not allowed.");
  }
  const registeredReal = await import_node_fs.promises.realpath(registeredRoot);
  const activeReal = await import_node_fs.promises.realpath(activeFolderRoot);
  const registeredComparable = process.platform === "win32" ? path2.normalize(registeredReal).toLowerCase() : path2.normalize(registeredReal);
  const activeComparable = process.platform === "win32" ? path2.normalize(activeReal).toLowerCase() : path2.normalize(activeReal);
  if (registeredComparable !== activeComparable) {
    throw new CommandPolicyError("The command workspace does not match the active registered workspace.");
  }
  const cwd = await import_node_fs.promises.realpath(path2.resolve(registeredReal, commandRun.cwd_relative));
  if (!inside(registeredReal, cwd))
    throw new CommandPolicyError("The working directory escapes through traversal, symlink, or junction.");
  if (!(await import_node_fs.promises.stat(cwd)).isDirectory())
    throw new CommandPolicyError("The command working directory does not exist.");
  const timeoutSeconds = Math.max(1, Math.min(commandRun.requested_timeout_seconds || 120, 900));
  const resolved = profileCommand(commandRun.profile, commandRun.arguments, config);
  const baseName = path2.basename(resolved.executable).toLowerCase();
  if (BLOCKED_EXECUTABLES.has(baseName))
    throw new CommandPolicyError("Shell and system executables cannot be used by a controlled profile.");
  const windowsWrapper = process.platform === "win32" && /\.(cmd|bat)$/i.test(resolved.executable);
  if (windowsWrapper && resolved.args.some((argument) => WINDOWS_WRAPPER_META.test(argument))) {
    throw new CommandPolicyError("A Windows wrapper argument contains expansion or shell metacharacters.");
  }
  const classification = classify(commandRun.profile, resolved.args, timeoutSeconds, resolved.executable);
  const risk = RISK_PRIORITY.find((item) => classification.risks.includes(item)) || "SENSITIVE";
  const environment = filteredEnvironment(commandRun.profile, sourceEnvironment);
  return {
    risk,
    risks: classification.risks,
    explanation: classification.reasons.join(" "),
    blocked: risk === "BLOCKED",
    network: classification.risks.includes("NETWORK"),
    writesWorkspace: classification.risks.includes("WRITES_WORKSPACE") || classification.risks.includes("PACKAGE_INSTALL"),
    executable: resolved.executable,
    executableName: path2.basename(resolved.executable),
    args: resolved.args,
    cwd,
    cwdRelative: commandRun.cwd_relative,
    timeoutSeconds,
    environment,
    environmentKeys: Object.keys(environment).sort(),
    windowsWrapper
  };
}
function quoteWindowsWrapperArgument(value) {
  if (WINDOWS_WRAPPER_META.test(value))
    throw new CommandPolicyError("Unsafe Windows wrapper argument.");
  return `"${value.replace(/\\*(?=")/g, (slashes) => `${slashes}${slashes}`)}"`;
}

// src/processRunner.ts
var import_node_child_process = require("node:child_process");
var import_node_string_decoder = require("node:string_decoder");
var ANSI_PATTERN = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
function cleanOutput(value) {
  return value.replace(ANSI_PATTERN, "").replace(/[^\x09\x0A\x0D\x20-\x7E\u0080-\uFFFF]/g, "");
}
function appendTail(current, value, limit) {
  const bytes = Buffer.from(current + value, "utf8");
  return (bytes.length <= limit ? bytes : bytes.subarray(bytes.length - limit)).toString("utf8");
}
var ControlledProcessRunner = class {
  constructor(options = {}) {
    this.active = /* @__PURE__ */ new Map();
    this.displayLimit = Math.min(Math.max(options.displayLimitBytes || 1048576, 16384), 4194304);
    this.tailLimit = Math.min(Math.max(options.tailLimitBytes || 65536, 8192), 65536);
  }
  async run(commandRun, decision, onOutput) {
    if (commandRun.status !== "starting" || commandRun.decision !== "approve") {
      throw new Error("A controlled process can start only after a durable one-time approval and starting transition.");
    }
    if (decision.blocked || decision.risk === "BLOCKED") {
      throw new Error("A blocked command cannot start.");
    }
    if (this.active.has(commandRun.id))
      throw new Error("This command run is already active.");
    const started = /* @__PURE__ */ new Date();
    let executable = decision.executable;
    let args = [...decision.args];
    if (decision.windowsWrapper) {
      const comspec = process.env.ComSpec || process.env.COMSPEC || "C:\\Windows\\System32\\cmd.exe";
      const line = [decision.executable, ...decision.args].map(quoteWindowsWrapperArgument).join(" ");
      executable = comspec;
      args = ["/d", "/s", "/c", line];
    }
    let child;
    try {
      child = (0, import_node_child_process.spawn)(executable, args, {
        cwd: decision.cwd,
        env: decision.environment,
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      return this.spawnFailure(started, error);
    }
    const active = { child, cancellation: null };
    this.active.set(commandRun.id, active);
    onOutput({ commandRunId: commandRun.id, stream: "status", text: "Running" });
    return new Promise((resolve4) => {
      let stdoutTail = "";
      let stderrTail = "";
      let displayed = 0;
      let outputTruncated = false;
      let settled = false;
      let spawnError;
      const stdoutDecoder = new import_node_string_decoder.StringDecoder("utf8");
      const stderrDecoder = new import_node_string_decoder.StringDecoder("utf8");
      const emit = (stream, raw) => {
        const value = cleanOutput(raw);
        if (stream === "stdout")
          stdoutTail = appendTail(stdoutTail, value, this.tailLimit);
        else
          stderrTail = appendTail(stderrTail, value, this.tailLimit);
        const size = Buffer.byteLength(value, "utf8");
        const remaining = Math.max(0, this.displayLimit - displayed);
        if (displayed < this.displayLimit) {
          const visible = size <= remaining ? value : Buffer.from(value, "utf8").subarray(0, remaining).toString("utf8");
          if (visible)
            onOutput({ commandRunId: commandRun.id, stream, text: visible });
          displayed += Math.min(size, remaining);
        }
        if (size > remaining)
          outputTruncated = true;
      };
      child.stdout?.on("data", (chunk) => emit("stdout", stdoutDecoder.write(chunk)));
      child.stderr?.on("data", (chunk) => emit("stderr", stderrDecoder.write(chunk)));
      child.on("error", (error) => {
        spawnError = error;
      });
      const timeout = setTimeout(() => {
        const current = this.active.get(commandRun.id);
        if (!current || settled)
          return;
        current.cancellation = "timed_out";
        onOutput({ commandRunId: commandRun.id, stream: "status", text: "Timed out; terminating process tree" });
        void this.terminateTree(current.child);
      }, decision.timeoutSeconds * 1e3);
      child.on("close", (code, signal) => {
        if (settled)
          return;
        settled = true;
        clearTimeout(timeout);
        emit("stdout", stdoutDecoder.end());
        emit("stderr", stderrDecoder.end());
        const cancellation = active.cancellation;
        this.active.delete(commandRun.id);
        const completed = /* @__PURE__ */ new Date();
        const durationMs = Math.max(0, completed.getTime() - started.getTime());
        const status = cancellation === "timed_out" ? "timed_out" : cancellation === "cancelled" ? "cancelled" : spawnError || code !== 0 ? "failed" : "completed";
        resolve4({
          status,
          exitCode: code,
          terminationReason: cancellation || signal || (spawnError ? "spawn_error" : code === 0 ? "exit" : "non_zero_exit"),
          startedAt: started.toISOString(),
          completedAt: completed.toISOString(),
          durationMs,
          stdoutTail,
          stderrTail,
          outputTruncated,
          timedOut: cancellation === "timed_out",
          cancelled: cancellation === "cancelled",
          failureReason: spawnError?.message || (code && code !== 0 ? `Process exited with code ${code}` : void 0)
        });
      });
    });
  }
  async cancel(commandRunId) {
    const active = this.active.get(commandRunId);
    if (!active)
      return false;
    if (!active.cancellation)
      active.cancellation = "cancelled";
    await this.terminateTree(active.child);
    return true;
  }
  dispose() {
    for (const [id] of this.active)
      void this.cancel(id);
  }
  spawnFailure(started, error) {
    const completed = /* @__PURE__ */ new Date();
    return {
      status: "failed",
      exitCode: null,
      terminationReason: "spawn_error",
      startedAt: started.toISOString(),
      completedAt: completed.toISOString(),
      durationMs: Math.max(0, completed.getTime() - started.getTime()),
      stdoutTail: "",
      stderrTail: "",
      outputTruncated: false,
      timedOut: false,
      cancelled: false,
      failureReason: error.message
    };
  }
  async terminateTree(child) {
    if (!child.pid)
      return;
    if (process.platform === "win32") {
      await new Promise((resolve4) => {
        const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
        const taskkill = `${systemRoot}\\System32\\taskkill.exe`;
        const killer = (0, import_node_child_process.spawn)(taskkill, ["/pid", String(child.pid), "/t", "/f"], {
          shell: false,
          windowsHide: true,
          stdio: "ignore"
        });
        const fallback = () => {
          try {
            child.kill();
          } catch {
          }
          resolve4();
        };
        killer.once("error", fallback);
        killer.once("close", (code) => {
          if (code !== 0) {
            fallback();
          } else {
            resolve4();
          }
        });
      });
      return;
    }
    try {
      process.kill(-child.pid, "SIGTERM");
      setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
        }
      }, 1e3).unref();
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {
      }
    }
  }
};

// src/sidebarProvider.ts
var PersonalCodexSidebarProvider = class {
  constructor(context, backend, resolver) {
    this.context = context;
    this.backend = backend;
    this.resolver = resolver;
    this.webviewReady = false;
    this.pendingMessages = [];
    this.proposedDocuments = /* @__PURE__ */ new Map();
    this.legacyChangeSets = /* @__PURE__ */ new Map();
    this.commandPolicies = /* @__PURE__ */ new Map();
    this.changeSetManager = new ChangeSetManager(context);
    const configuration = vscode3.workspace.getConfiguration("personalCodex");
    this.processRunner = new ControlledProcessRunner({
      displayLimitBytes: configuration.get("commandOutputLimitBytes", 1048576),
      tailLimitBytes: configuration.get("commandTailLimitBytes", 65536)
    });
    this.context.subscriptions.push({ dispose: () => this.processRunner.dispose() });
    this.context.subscriptions.push(vscode3.workspace.registerTextDocumentContentProvider("codeme-proposed", {
      provideTextDocumentContent: (uri) => this.proposedDocuments.get(uri.toString()) || ""
    }));
  }
  resolveWebviewView(webviewView) {
    this.view = webviewView;
    this.webviewReady = false;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode3.Uri.joinPath(this.context.extensionUri, "dist"),
        vscode3.Uri.joinPath(this.context.extensionUri, "media")
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
      await vscode3.commands.executeCommand("workbench.view.extension.personalCodeme");
    }
    this.view?.show?.(true);
  }
  async createNewChat() {
    await this.reveal();
    await this.send({ command: "newChat", payload: {} });
  }
  async handleSelectionCommand(action) {
    const editor = vscode3.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      void vscode3.window.showWarningMessage("Select code before running this action.");
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
          label: `${path3.basename(selection.filePath)} \xB7 selected code`,
          detail: selection.filePath,
          content: selection.text,
          language: selection.language
        }
      }
    });
  }
  async handleFileCommand(action) {
    const editor = vscode3.window.activeTextEditor;
    if (!editor) {
      void vscode3.window.showWarningMessage("Open a file first.");
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
          label: path3.basename(file.filePath),
          detail: file.filePath,
          content: file.text,
          language: file.language
        }
      }
    });
  }
  async reviewChanges() {
    const workspace5 = this.getActiveWorkspaceFolder();
    if (!workspace5) {
      void vscode3.window.showWarningMessage("Open a workspace folder first.");
      return;
    }
    const diff = await this.resolver.resolveGitDiff(workspace5);
    await this.reveal();
    await this.send({
      command: "contextAction",
      payload: {
        action: "reviewChanges",
        context: {
          kind: "changes",
          label: diff.branch ? `Changes on ${diff.branch}` : "Working tree changes",
          detail: workspace5.uri.fsPath,
          content: diff.changes,
          language: "diff"
        }
      }
    });
  }
  async registerWorkspace() {
    const folder = this.getActiveWorkspaceFolder();
    if (!folder) {
      void vscode3.window.showWarningMessage("Open a workspace folder first.");
      return;
    }
    const accept = await vscode3.window.showInformationMessage(
      `Register '${folder.name}' with Personal Codeme?`,
      "Register",
      "Cancel"
    );
    if (accept !== "Register") {
      return;
    }
    const workspaceId = await this.backend.registerWorkspace(folder.uri.fsPath, folder.name);
    this.currentWorkspaceId = workspaceId;
    await this.context.workspaceState.update(this.workspaceConsentKey(folder), true);
    await this.send({ command: "workspaceRegistered", payload: { workspaceId, rootPath: folder.uri.fsPath } });
    await this.refreshWorkspaceState();
  }
  async startBackend() {
    try {
      await this.backend.checkConnection(false);
      void vscode3.window.showInformationMessage("Personal Codeme backend is already running.");
      await this.refreshBackendStatus(false);
      return;
    } catch {
    }
    const tasks2 = await vscode3.tasks.fetchTasks();
    const backendTask = tasks2.find((task) => task.name === "Run Codeme API");
    if (!backendTask) {
      void vscode3.window.showWarningMessage("Task 'Run Codeme API' was not found in this workspace.");
      return;
    }
    await vscode3.tasks.executeTask(backendTask);
    void vscode3.window.showInformationMessage("Starting the Personal Codeme backend\u2026");
    setTimeout(() => void this.refreshBackendStatus(false), 2500);
  }
  async refreshWorkspaceState() {
    const folder = this.getActiveWorkspaceFolder();
    await this.send({
      command: "workspaceState",
      payload: {
        workspace: folder?.name ?? null,
        rootPath: folder?.uri.fsPath ?? null,
        folders: vscode3.workspace.workspaceFolders?.length ?? 0,
        workspaceId: this.currentWorkspaceId ?? null,
        registered: Boolean(this.currentWorkspaceId)
      }
    });
  }
  async updateConfiguration() {
    this.backend.updateSettings(vscode3.workspace.getConfiguration("personalCodex"));
    if (this.webviewReady) {
      await this.initialize();
    }
  }
  getActiveWorkspaceFolder() {
    return vscode3.workspace.workspaceFolders?.[0];
  }
  async initialize(conversationId) {
    await this.refreshBackendStatus(false);
    await this.syncActiveWorkspaceRegistration();
    const autoRegister = vscode3.workspace.getConfiguration("personalCodex").get("autoRegisterWorkspace", false);
    if (!this.currentWorkspaceId && autoRegister) {
      await this.requestWorkspaceRegistration();
    }
    await Promise.all([this.refreshWorkspaceState(), this.refreshConversations()]);
    if (conversationId) {
      await this.loadConversation(conversationId);
    }
  }
  workspaceConsentKey(folder) {
    return `personalCodex.workspaceRegistrationConsent:${folder.uri.toString()}`;
  }
  async syncActiveWorkspaceRegistration() {
    const folder = this.getActiveWorkspaceFolder();
    if (!folder) {
      this.currentWorkspaceId = void 0;
      return;
    }
    try {
      const normalizedRoot = path3.resolve(folder.uri.fsPath).toLowerCase();
      const existing = (await this.backend.listWorkspaces()).find(
        (item) => item.root_path && path3.resolve(item.root_path).toLowerCase() === normalizedRoot
      );
      this.currentWorkspaceId = existing?.id;
    } catch {
      this.currentWorkspaceId = void 0;
    }
  }
  async requestWorkspaceRegistration() {
    const folder = this.getActiveWorkspaceFolder();
    if (!folder)
      return false;
    const rememberedConsent = this.context.workspaceState.get(this.workspaceConsentKey(folder), false);
    if (!rememberedConsent) {
      const choice = await vscode3.window.showInformationMessage(
        `Personal Codeme needs permission to register '${folder.name}' before Agent mode can inspect it.`,
        { modal: true },
        "Register workspace"
      );
      if (choice !== "Register workspace")
        return false;
      await this.context.workspaceState.update(this.workspaceConsentKey(folder), true);
    }
    try {
      this.currentWorkspaceId = await this.backend.registerWorkspace(folder.uri.fsPath, folder.name);
      await this.send({ command: "workspaceRegistered", payload: { workspaceId: this.currentWorkspaceId, rootPath: folder.uri.fsPath } });
      await this.refreshWorkspaceState();
      return true;
    } catch (error) {
      await this.send({ command: "operationError", payload: { message: error.message } });
      return false;
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
          await vscode3.env.clipboard.writeText(message.args.text);
        }
        break;
      case "openCode":
        if (typeof message.args?.text === "string") {
          const targetPath = typeof message.args?.path === "string" ? message.args.path : void 0;
          await this.openGeneratedCode(message.args.text, targetPath, typeof message.args?.language === "string" ? message.args.language : void 0);
        }
        break;
      case "applyCode":
        if (typeof message.args?.text === "string") {
          await this.applyCodeToEditor(message.args.text, typeof message.args?.path === "string" ? message.args.path : void 0);
        }
        break;
      case "applyFileChange":
        if (typeof message.args?.path === "string" && typeof message.args?.content === "string") {
          await this.applyFileChange(message.args.path, message.args.content, String(message.args?.explanation || ""));
        }
        break;
      case "previewChangeSet":
        if (message.args?.changeSet) {
          await this.previewChangeSet(message.args.changeSet);
        }
        break;
      case "applyChangeSet":
        if (message.args?.changeSet) {
          await this.applyChangeSet(message.args.changeSet);
        }
        break;
      case "rejectChangeSet":
        if (message.args?.changeSet) {
          await this.rejectChangeSet(message.args.changeSet);
        }
        break;
      case "restoreChangeSet":
        if (message.args?.changeSet) {
          await this.restoreChangeSet(message.args.changeSet);
        }
        break;
      case "previewFileChange":
        if (typeof message.args?.path === "string" && typeof message.args?.content === "string") {
          await this.previewFileChange(message.args.path, message.args.content);
        }
        break;
      case "runProposedCommand":
        if (typeof message.args?.command === "string") {
          await this.runProposedCommand(message.args.command, String(message.args?.explanation || ""));
        }
        break;
      case "runCommandProposal":
        if (message.args?.commandRun) {
          await this.runControlledCommand(message.args.commandRun);
        }
        break;
      case "rejectCommandProposal":
        if (message.args?.commandRun) {
          await this.rejectControlledCommand(message.args.commandRun);
        }
        break;
      case "cancelCommandRun":
        if (typeof message.args?.commandRunId === "string") {
          await this.processRunner.cancel(message.args.commandRunId);
        }
        break;
      case "openSettings":
        await vscode3.commands.executeCommand("workbench.action.openSettings", "@ext:personal-codex-local.personal-codeme");
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
      const editor = vscode3.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        void vscode3.window.showWarningMessage("Select code in the editor first.");
        return;
      }
      const selection = await this.resolver.resolveSelection(editor);
      await this.send({
        command: "contextAdded",
        payload: {
          kind: "selection",
          label: `${path3.basename(selection.filePath)} \xB7 selection`,
          detail: selection.filePath,
          content: selection.text,
          language: selection.language
        }
      });
      return;
    }
    if (kind === "file") {
      const editor = vscode3.window.activeTextEditor;
      if (!editor) {
        void vscode3.window.showWarningMessage("Open a file first.");
        return;
      }
      const file = await this.resolver.resolveFile(editor);
      await this.send({
        command: "contextAdded",
        payload: {
          kind: "file",
          label: path3.basename(file.filePath),
          detail: file.filePath,
          content: file.text,
          language: file.language
        }
      });
      return;
    }
    if (kind === "changes") {
      const workspace5 = this.getActiveWorkspaceFolder();
      if (!workspace5) {
        void vscode3.window.showWarningMessage("Open a workspace folder first.");
        return;
      }
      const diff = await this.resolver.resolveGitDiff(workspace5);
      await this.send({
        command: "contextAdded",
        payload: {
          kind: "changes",
          label: diff.branch ? `Changes on ${diff.branch}` : "Working tree changes",
          detail: workspace5.uri.fsPath,
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
    if (args.mode === "agent") {
      if (!this.currentWorkspaceId) {
        await this.syncActiveWorkspaceRegistration();
      }
      if (!this.currentWorkspaceId) {
        await this.requestWorkspaceRegistration();
      }
      if (!this.currentWorkspaceId) {
        await this.send({ command: "streamError", payload: { conversationId, message: "Open a workspace and start the backend to use Agent mode." } });
        return;
      }
      await this.backend.streamAgent(
        conversationId,
        prompt,
        this.currentWorkspaceId,
        contextText || void 0,
        args.model,
        (event) => {
          if (event.type === "proposal" && event.kind === "file_change" && event.change_set) {
            this.legacyChangeSets.set(event.path, event.change_set);
          }
          if (event.type === "proposal" && event.kind === "command_proposal") {
            void this.prepareCommandProposalEvent(conversationId, event.command_run);
            return;
          }
          void this.send({ command: "agentEvent", payload: { conversationId, event } });
        },
        () => {
          void this.send({ command: "streamComplete", payload: { conversationId } });
          void this.refreshConversations();
        },
        (error) => {
          void this.send({ command: "streamError", payload: { conversationId, message: error.message } });
          void this.refreshConversations();
        }
      );
      return;
    }
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
  async openGeneratedCode(code, relativePath, language) {
    if (relativePath && this.resolveWorkspaceFile(relativePath)) {
      await this.previewFileChange(relativePath, code);
      return;
    }
    const document = await vscode3.workspace.openTextDocument({ content: code, language: this.normalizeLanguage(language) });
    await vscode3.window.showTextDocument(document, { preview: true });
  }
  async applyCodeToEditor(code, relativePath) {
    if (relativePath && this.resolveWorkspaceFile(relativePath)) {
      await this.applyFileChange(relativePath, code, `Replace the complete contents of ${relativePath}`);
      return;
    }
    const editor = vscode3.window.activeTextEditor;
    if (!editor) {
      const document = await vscode3.workspace.openTextDocument({ content: code });
      await vscode3.window.showTextDocument(document, { preview: true });
      return;
    }
    let replaceWholeDocument = false;
    if (editor.selection.isEmpty) {
      const choice = await vscode3.window.showWarningMessage(
        `No target filename was found. How should the generated code be applied to ${path3.basename(editor.document.fileName)}?`,
        { modal: true },
        "Replace entire file",
        "Insert at cursor"
      );
      if (!choice)
        return;
      replaceWholeDocument = choice === "Replace entire file";
    } else {
      const requireApproval = vscode3.workspace.getConfiguration("personalCodex").get("requireWriteApproval", true);
      if (requireApproval) {
        const choice = await vscode3.window.showWarningMessage("Replace the selected code with the generated block?", { modal: true }, "Apply");
        if (choice !== "Apply")
          return;
      }
    }
    const applied = await editor.edit((builder) => {
      if (replaceWholeDocument) {
        builder.replace(new vscode3.Range(editor.document.positionAt(0), editor.document.positionAt(editor.document.getText().length)), code);
      } else if (editor.selection.isEmpty) {
        builder.insert(editor.selection.active, code);
      } else {
        builder.replace(editor.selection, code);
      }
    });
    if (!applied) {
      void vscode3.window.showErrorMessage("Unable to apply the generated code.");
    }
  }
  resolveWorkspaceFile(relativePath) {
    const folder = this.getActiveWorkspaceFolder();
    if (!folder || !relativePath || path3.isAbsolute(relativePath) || relativePath.includes("\0"))
      return void 0;
    const root = path3.resolve(folder.uri.fsPath);
    const target = path3.resolve(root, relativePath);
    const relative4 = path3.relative(root, target);
    if (!relative4 || relative4.startsWith("..") || path3.isAbsolute(relative4))
      return void 0;
    return vscode3.Uri.file(target);
  }
  async applyFileChange(relativePath, content, explanation) {
    const changeSet = this.legacyChangeSets.get(relativePath);
    const operation = changeSet?.operations.find((item) => item.relative_path === relativePath);
    if (!changeSet || !operation || operation.proposed_content !== content) {
      void vscode3.window.showWarningMessage(
        `The legacy proposal for ${relativePath} has no verified base hash. Ask Agent mode to regenerate it as a transactional change set before applying.`
      );
      return;
    }
    await this.applyChangeSet(changeSet);
  }
  async previewChangeSet(changeSet) {
    const folder = this.getActiveWorkspaceFolder();
    if (!folder) {
      void vscode3.window.showErrorMessage("Open the registered workspace before previewing this change set.");
      return;
    }
    try {
      await this.changeSetManager.assertPreviewable(changeSet, folder);
      for (const operation of changeSet.operations) {
        await this.previewFileChange(operation.relative_path, operation.proposed_content);
      }
    } catch (error) {
      void vscode3.window.showErrorMessage(error.message);
    }
  }
  async applyChangeSet(changeSet) {
    const folder = this.getActiveWorkspaceFolder();
    if (!folder) {
      void vscode3.window.showErrorMessage("Open the registered workspace before applying this change set.");
      return;
    }
    const files = changeSet.operations.map((operation) => `${operation.type}: ${operation.relative_path}`).join("\n");
    const choice = await vscode3.window.showWarningMessage(
      `Apply the complete change set?

${changeSet.summary}

${files}`,
      { modal: true },
      "Apply complete change set"
    );
    if (choice !== "Apply complete change set")
      return;
    let approved;
    let localResult;
    try {
      approved = await this.backend.decideChangeSet(changeSet.id, "approve", "Approved as a complete change set in VS Code");
      localResult = await this.changeSetManager.apply(approved, folder);
      const applied = await this.backend.reportChangeSetResult(
        approved.id,
        "applied",
        localResult.resultHashes,
        localResult.checkpointReference
      );
      await this.send({ command: "changeSetUpdated", payload: applied });
      void vscode3.window.showInformationMessage(`Applied ${applied.operations.length} file change(s). A restore checkpoint is available.`);
    } catch (error) {
      let failure = error;
      if (approved && localResult) {
        try {
          await this.changeSetManager.restore(
            { ...approved, checkpoint_reference: localResult.checkpointReference },
            folder
          );
          failure = new Error(`Backend result reporting failed, so the local change was rolled back: ${failure.message}`);
        } catch (rollbackError) {
          failure = new Error(
            `Backend result reporting failed and local rollback also failed: ${failure.message}; ${rollbackError.message}`
          );
        }
      }
      try {
        if (approved) {
          const failed = await this.backend.reportChangeSetResult(approved.id, "failed", {}, void 0, failure.message);
          await this.send({ command: "changeSetUpdated", payload: failed });
        }
      } catch {
      }
      void vscode3.window.showErrorMessage(`Change set was not applied: ${failure.message}`);
    }
  }
  async rejectChangeSet(changeSet) {
    try {
      const rejected = await this.backend.decideChangeSet(changeSet.id, "reject", "Rejected in VS Code");
      await this.send({ command: "changeSetUpdated", payload: rejected });
    } catch (error) {
      void vscode3.window.showErrorMessage(`Unable to reject change set: ${error.message}`);
    }
  }
  async restoreChangeSet(changeSet) {
    const folder = this.getActiveWorkspaceFolder();
    if (!folder)
      return;
    const choice = await vscode3.window.showWarningMessage(
      `Restore only the files changed by '${changeSet.summary}'? Newer user changes will cause a conflict.`,
      { modal: true },
      "Restore change set"
    );
    if (choice !== "Restore change set")
      return;
    try {
      await this.changeSetManager.restore(changeSet, folder);
      const restored = await this.backend.reportChangeSetRestore(changeSet.id, "restored");
      await this.send({ command: "changeSetUpdated", payload: restored });
      void vscode3.window.showInformationMessage("Change set restored from its checkpoint.");
    } catch (error) {
      try {
        const failed = await this.backend.reportChangeSetRestore(changeSet.id, "restore_failed", error.message);
        await this.send({ command: "changeSetUpdated", payload: failed });
      } catch {
      }
      void vscode3.window.showErrorMessage(`Restore stopped: ${error.message}`);
    }
  }
  async previewFileChange(relativePath, content) {
    const target = this.resolveWorkspaceFile(relativePath);
    if (!target) {
      void vscode3.window.showErrorMessage("The proposed file path is outside the active workspace.");
      return;
    }
    let exists = true;
    try {
      await vscode3.workspace.fs.stat(target);
    } catch {
      exists = false;
    }
    if (!exists) {
      const document = await vscode3.workspace.openTextDocument({ content, language: this.normalizeLanguage(path3.extname(relativePath).slice(1)) });
      await vscode3.window.showTextDocument(document, { preview: true });
      return;
    }
    const proposedUri = vscode3.Uri.from({
      scheme: "codeme-proposed",
      path: `/${relativePath.replace(/\\/g, "/")}`,
      query: `v=${Date.now()}-${Math.random().toString(36).slice(2)}`
    });
    this.proposedDocuments.set(proposedUri.toString(), content);
    await vscode3.commands.executeCommand("vscode.diff", target, proposedUri, `${relativePath} \u2194 Codeme proposal`, { preview: true });
  }
  async evaluateCommand(commandRun) {
    const folders = vscode3.workspace.workspaceFolders || [];
    if (folders.length !== 1) {
      throw new CommandPolicyError("Controlled execution requires exactly one active VS Code workspace folder.");
    }
    if (!this.currentWorkspaceId || commandRun.workspace_id !== this.currentWorkspaceId) {
      throw new CommandPolicyError("The command proposal does not belong to the active registered workspace.");
    }
    const registered = (await this.backend.listWorkspaces()).find((item) => item.id === commandRun.workspace_id);
    if (!registered?.root_path)
      throw new CommandPolicyError("The backend workspace registration is unavailable.");
    return evaluateCommandPolicy(
      commandRun,
      registered.root_path,
      folders[0].uri.fsPath,
      vscode3.workspace.getConfiguration("personalCodex")
    );
  }
  withPolicy(commandRun, policy) {
    return {
      ...commandRun,
      calculated_risk: policy.risk,
      risk_explanation: policy.explanation,
      resolved_executable_name: policy.executableName,
      resolved_arguments: policy.args,
      environment_keys: policy.environmentKeys,
      network_access: policy.network,
      writes_workspace: policy.writesWorkspace,
      policy_blocked: policy.blocked
    };
  }
  async prepareCommandProposalEvent(conversationId, commandRun) {
    try {
      const policy = await this.evaluateCommand(commandRun);
      this.commandPolicies.set(commandRun.id, policy);
      if (policy.blocked) {
        const blocked = await this.backend.decideCommandRun(
          commandRun.id,
          "block",
          "BLOCKED",
          policy.explanation,
          policy.executableName,
          policy.environmentKeys
        );
        await this.send({
          command: "agentEvent",
          payload: { conversationId, event: { type: "proposal", kind: "command_proposal", command_run: this.withPolicy(blocked, policy) } }
        });
        return;
      }
      await this.send({
        command: "agentEvent",
        payload: { conversationId, event: { type: "proposal", kind: "command_proposal", command_run: this.withPolicy(commandRun, policy) } }
      });
    } catch (error) {
      const explanation = `Blocked by extension policy: ${error.message}`;
      let blocked = { ...commandRun, status: "blocked", calculated_risk: "BLOCKED", risk_explanation: explanation, policy_blocked: true };
      try {
        blocked = {
          ...await this.backend.decideCommandRun(commandRun.id, "block", "BLOCKED", explanation),
          policy_blocked: true
        };
      } catch {
      }
      await this.send({
        command: "agentEvent",
        payload: { conversationId, event: { type: "proposal", kind: "command_proposal", command_run: blocked } }
      });
    }
  }
  approvalText(commandRun, policy) {
    const warning = policy.risks.some((risk) => ["NETWORK", "PACKAGE_INSTALL", "LONG_RUNNING"].includes(risk)) ? "\n\nStrong warning: this request may access the network, install packages, or run longer than the safe default." : "";
    return [
      commandRun.purpose,
      `Profile: ${commandRun.profile}`,
      `Executable: ${policy.executableName}`,
      `Arguments: ${JSON.stringify(policy.args)}`,
      `Working directory: ${policy.cwdRelative}`,
      `Risk: ${policy.risk}`,
      policy.explanation,
      `Timeout: ${policy.timeoutSeconds}s`,
      `Environment keys: ${policy.environmentKeys.join(", ") || "(none)"}`
    ].join("\n") + warning;
  }
  async runControlledCommand(commandRun) {
    let fresh = await this.backend.getCommandRun(commandRun.id);
    let processStarted = false;
    if (fresh.status !== "proposed") {
      void vscode3.window.showWarningMessage(`This command is already ${fresh.status}.`);
      return;
    }
    let policy;
    try {
      policy = await this.evaluateCommand(fresh);
    } catch (error) {
      const explanation = `Blocked by extension policy: ${error.message}`;
      const blocked = await this.backend.decideCommandRun(fresh.id, "block", "BLOCKED", explanation);
      await this.send({ command: "commandRunUpdated", payload: blocked });
      return;
    }
    if (policy.blocked) {
      const blocked = await this.backend.decideCommandRun(fresh.id, "block", "BLOCKED", policy.explanation, policy.executableName, policy.environmentKeys);
      await this.send({ command: "commandRunUpdated", payload: this.withPolicy(blocked, policy) });
      return;
    }
    const choice = await vscode3.window.showWarningMessage(
      this.approvalText(fresh, policy),
      { modal: true },
      "Run once"
    );
    if (choice !== "Run once")
      return;
    fresh = await this.backend.decideCommandRun(
      fresh.id,
      "approve",
      policy.risk,
      policy.explanation,
      policy.executableName,
      policy.environmentKeys
    );
    await this.send({ command: "commandRunUpdated", payload: this.withPolicy(fresh, policy) });
    fresh = await this.backend.reportCommandEvent(fresh.id, "starting", "Approved process is starting");
    await this.send({ command: "commandRunUpdated", payload: this.withPolicy(fresh, policy) });
    try {
      policy = await this.evaluateCommand(fresh);
      const resultPromise = this.processRunner.run(fresh, policy, (event) => {
        void this.send({ command: "commandRunOutput", payload: event });
      });
      processStarted = true;
      fresh = await this.backend.reportCommandEvent(fresh.id, "running", "Controlled process started");
      await this.send({ command: "commandRunUpdated", payload: this.withPolicy(fresh, policy) });
      const result = await resultPromise;
      const completed = await this.backend.reportCommandResult(fresh.id, result);
      await this.send({ command: "commandRunUpdated", payload: this.withPolicy(completed, policy) });
    } catch (error) {
      if (processStarted) {
        await this.processRunner.cancel(fresh.id);
      }
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const failed = await this.backend.reportCommandResult(fresh.id, {
        status: "failed",
        exitCode: null,
        terminationReason: "runner_error",
        startedAt: fresh.started_at || now,
        completedAt: now,
        durationMs: 0,
        stdoutTail: "",
        stderrTail: "",
        outputTruncated: false,
        timedOut: false,
        cancelled: false,
        failureReason: error.message
      });
      await this.send({ command: "commandRunUpdated", payload: failed });
    }
  }
  async rejectControlledCommand(commandRun) {
    try {
      const policy = this.commandPolicies.get(commandRun.id) || await this.evaluateCommand(commandRun);
      const rejected = await this.backend.decideCommandRun(
        commandRun.id,
        "reject",
        policy.risk,
        policy.explanation,
        policy.executableName,
        policy.environmentKeys
      );
      await this.send({ command: "commandRunUpdated", payload: this.withPolicy(rejected, policy) });
    } catch (error) {
      void vscode3.window.showErrorMessage(`Unable to reject command: ${error.message}`);
    }
  }
  async runProposedCommand(command, explanation) {
    const folder = this.getActiveWorkspaceFolder();
    if (!folder || !command.trim() || /[\r\n]/.test(command) || command.length > 2e3) {
      void vscode3.window.showErrorMessage("The proposed terminal command is invalid.");
      return;
    }
    const unsafeEnabled = vscode3.workspace.getConfiguration("personalCodex").get("enableUnsafeCommandExecution", false);
    if (!unsafeEnabled) {
      const action = await vscode3.window.showWarningMessage(
        "This is a deprecated raw command proposal. Raw command text is display-only; ask the agent for a structured Phase 5 command profile.",
        "Open setting"
      );
      if (action === "Open setting") {
        await vscode3.commands.executeCommand("workbench.action.openSettings", "personalCodex.enableUnsafeCommandExecution");
      }
      return;
    }
    void vscode3.window.showWarningMessage(
      `Deprecated raw command proposals are display-only and cannot execute, even when personalCodex.enableUnsafeCommandExecution is enabled. Ask the agent for a structured command profile instead.

${command}${explanation ? `

${explanation}` : ""}`
    );
  }
};

// src/backendClient.ts
var vscode4 = __toESM(require("vscode"));
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
      void vscode4.window.showWarningMessage("Personal Codeme is configured to use a non-local backend URL.");
    }
    try {
      const response = await this.request("/health", void 0, 3e3, 3);
      if (response.status === "ok" && this.showNotifications && userTriggered) {
        const target = response.model ? `${response.model} through Ollama` : "the local backend";
        void vscode4.window.showInformationMessage(`Personal Codeme is connected to ${target}.`);
      }
      return response;
    } catch (error) {
      if (userTriggered) {
        void vscode4.window.showErrorMessage("Unable to connect to the Personal Codeme backend.");
      }
      throw error;
    }
  }
  async registerWorkspace(path4, displayName) {
    const response = await this.post("/workspaces", {
      path: path4,
      display_name: displayName
    });
    return response.id;
  }
  async listWorkspaces() {
    return this.request("/workspaces");
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
  async decideChangeSet(changeSetId, decision, detail) {
    return this.post(`/change-sets/${encodeURIComponent(changeSetId)}/decision`, { decision, detail });
  }
  async reportChangeSetResult(changeSetId, status, resultHashes, checkpointReference, failureReason) {
    return this.post(`/change-sets/${encodeURIComponent(changeSetId)}/result`, {
      status,
      result_hashes: resultHashes,
      checkpoint_reference: checkpointReference,
      failure_reason: failureReason
    });
  }
  async reportChangeSetRestore(changeSetId, status, failureReason) {
    return this.post(`/change-sets/${encodeURIComponent(changeSetId)}/restore`, {
      status,
      failure_reason: failureReason
    });
  }
  async getCommandRun(commandRunId) {
    return this.request(`/command-runs/${encodeURIComponent(commandRunId)}`);
  }
  async decideCommandRun(commandRunId, decision, risk, riskExplanation, executableName, environmentKeys = []) {
    return this.post(`/command-runs/${encodeURIComponent(commandRunId)}/decision`, {
      decision,
      calculated_risk: risk,
      risk_explanation: riskExplanation,
      resolved_executable_name: executableName,
      environment_keys: environmentKeys
    });
  }
  async reportCommandEvent(commandRunId, status, detail) {
    return this.post(`/command-runs/${encodeURIComponent(commandRunId)}/events`, { status, detail });
  }
  async reportCommandResult(commandRunId, result) {
    return this.post(`/command-runs/${encodeURIComponent(commandRunId)}/result`, {
      status: result.status,
      exit_code: result.exitCode,
      termination_reason: result.terminationReason,
      started_at: result.startedAt,
      completed_at: result.completedAt,
      duration_ms: result.durationMs,
      stdout_tail: result.stdoutTail,
      stderr_tail: result.stderrTail,
      output_truncated: result.outputTruncated,
      timed_out: result.timedOut,
      cancelled: result.cancelled,
      failure_reason: result.failureReason
    });
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
  async streamAgent(conversationId, prompt, workspaceId, context, model, onEvent, onComplete, onError) {
    const url = this.getUrl(`/conversations/${conversationId}/agent`);
    this.controller = new AbortController();
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ model: model || this.configuredModel, prompt, workspace_id: workspaceId, context }),
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
        if (done)
          break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          let eventName = "message";
          let data = "";
          for (const line of block.split("\n")) {
            if (line.startsWith("event:"))
              eventName = line.slice(6).trim();
            if (line.startsWith("data:"))
              data += line.slice(5).trim();
          }
          if (eventName === "done" || data === "[DONE]") {
            completed = true;
            break;
          }
          if (!data)
            continue;
          const decoded = JSON.parse(data);
          if (eventName === "error" || "error" in decoded) {
            throw new Error("error" in decoded ? decoded.error : "Agent request failed.");
          }
          onEvent(decoded);
        }
      }
      onComplete();
    } catch (error) {
      onError(error?.name === "AbortError" ? new Error("Generation stopped.") : error);
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
  getUrl(path4) {
    return `${this.backendUrl.replace(/\/+$/, "")}/api${path4}`;
  }
  async request(path4, init, timeout = 5e3, retries = 1) {
    const url = this.getUrl(path4);
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
          await new Promise((resolve4) => setTimeout(resolve4, 200 * count));
          return attempt(count + 1);
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    };
    return attempt(1);
  }
  post(path4, body) {
    return this.request(path4, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  }
};

// src/contextResolver.ts
var vscode5 = __toESM(require("vscode"));
var ContextReferenceResolver = class {
  async resolveSelection(editor) {
    const document = editor.document;
    const text = document.getText(editor.selection);
    const workspaceFolder = vscode5.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath ?? null;
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
    const selection = new vscode5.Range(0, 0, 0, 0);
    const workspaceFolder = vscode5.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath ?? null;
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
    const gitExtension = vscode5.extensions.getExtension("vscode.git")?.exports;
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
  const config = vscode6.workspace.getConfiguration("personalCodex");
  if (config.get("enableUnsafeCommandExecution", false)) {
    void vscode6.window.showWarningMessage(
      "personalCodex.enableUnsafeCommandExecution is deprecated. Raw command proposals remain display-only and cannot bypass the controlled runner."
    );
  }
  const backendClient = new BackendClient(config);
  const resolver = new ContextReferenceResolver();
  const sidebarProvider = new PersonalCodexSidebarProvider(context, backendClient, resolver);
  context.subscriptions.push(
    vscode6.window.registerWebviewViewProvider("personalCodemeSidebar", sidebarProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );
  const registerCommand = (command, callback) => {
    context.subscriptions.push(vscode6.commands.registerCommand(command, callback));
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
  context.subscriptions.push(vscode6.workspace.onDidChangeWorkspaceFolders(() => sidebarProvider.refreshWorkspaceState()));
  context.subscriptions.push(vscode6.workspace.onDidChangeConfiguration((event) => {
    sidebarProvider.updateConfiguration();
    if (event.affectsConfiguration("personalCodex.enableUnsafeCommandExecution") && vscode6.workspace.getConfiguration("personalCodex").get("enableUnsafeCommandExecution", false)) {
      void vscode6.window.showWarningMessage(
        "personalCodex.enableUnsafeCommandExecution is deprecated. Raw commands remain display-only."
      );
    }
  }));
}
function deactivate() {
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  activate,
  deactivate
});
//# sourceMappingURL=extension.js.map
