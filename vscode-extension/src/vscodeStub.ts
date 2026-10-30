import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';

export class Uri {
  constructor(public readonly fsPath: string, public readonly scheme = 'file') {}
  static file(value: string): Uri { return new Uri(nodePath.resolve(value)); }
  static joinPath(base: Uri, ...parts: string[]): Uri { return Uri.file(nodePath.join(base.fsPath, ...parts)); }
  static from(value: { scheme: string; path: string; query?: string }): Uri { return new Uri(value.path, value.scheme); }
  toString(): string { return `${this.scheme}:${this.fsPath}`; }
}

export class Position {
  constructor(public readonly line: number, public readonly character: number) {}
}

export class Range {
  constructor(public readonly start: Position, public readonly end: Position) {}
}

export enum EndOfLine { LF = 1, CRLF = 2 }

export class TextEdit {
  public newEol?: EndOfLine;
  constructor(public range: Range, public newText: string) {}
  static setEndOfLine(eol: EndOfLine): TextEdit {
    const edit = new TextEdit(new Range(new Position(0, 0), new Position(0, 0)), '');
    edit.newEol = eol;
    return edit;
  }
}

class TextDocument {
  public isDirty = false;
  public eol: EndOfLine;
  constructor(public readonly uri: Uri, private text: string) { this.eol = text.includes('\r\n') ? EndOfLine.CRLF : EndOfLine.LF; }
  getText(): string { return this.text; }
  positionAt(offset: number): Position {
    const before = this.text.slice(0, offset).split('\n');
    return new Position(before.length - 1, before[before.length - 1]?.length || 0);
  }
  offsetAt(position: Position): number {
    const lines = this.text.split('\n');
    return lines.slice(0, position.line).reduce((total, line) => total + line.length + 1, 0) + position.character;
  }
  setText(value: string): void {
    this.text = normalizeEditorLineEndings ? value.replace(/\r\n|\r|\n/g, this.eol === EndOfLine.CRLF ? '\r\n' : '\n') : value;
    this.isDirty = true;
  }
  async save(): Promise<boolean> {
    if (failNextSave) { failNextSave = false; return false; }
    writeFileSync(this.uri.fsPath, this.text, 'utf8');
    this.isDirty = false;
    return true;
  }
}

type EditOperation =
  | { kind: 'create'; uri: Uri; options: { overwrite?: boolean; ignoreIfExists?: boolean } }
  | { kind: 'insert'; uri: Uri; position: Position; text: string }
  | { kind: 'replace'; uri: Uri; range: Range; text: string }
  | { kind: 'eol'; uri: Uri; eol: EndOfLine }
  | { kind: 'delete'; uri: Uri; options: { ignoreIfNotExists?: boolean; recursive?: boolean } };

export class WorkspaceEdit {
  readonly operations: EditOperation[] = [];
  createFile(uri: Uri, options: { overwrite?: boolean; ignoreIfExists?: boolean } = {}): void { this.operations.push({ kind: 'create', uri, options }); }
  insert(uri: Uri, position: Position, text: string): void { this.operations.push({ kind: 'insert', uri, position, text }); }
  replace(uri: Uri, range: Range, text: string): void { this.operations.push({ kind: 'replace', uri, range, text }); }
  deleteFile(uri: Uri, options: { ignoreIfNotExists?: boolean; recursive?: boolean } = {}): void { this.operations.push({ kind: 'delete', uri, options }); }
  get(uri: Uri): TextEdit[] {
    return this.operations.filter(operation => operation.uri.toString() === uri.toString()).flatMap(operation => {
      if (operation.kind === 'insert') return [new TextEdit(new Range(operation.position, operation.position), operation.text)];
      if (operation.kind === 'replace') return [new TextEdit(operation.range, operation.text)];
      if (operation.kind === 'eol') return [TextEdit.setEndOfLine(operation.eol)];
      return [];
    });
  }
  set(uri: Uri, edits: readonly TextEdit[]): void {
    for (const edit of edits) {
      if (edit.newEol !== undefined) this.operations.push({ kind: 'eol', uri, eol: edit.newEol });
      else this.operations.push({ kind: 'replace', uri, range: edit.range, text: edit.newText });
    }
  }
}

const documents: TextDocument[] = [];
let failNextApply = false;
let failAfterOperations: number | undefined;
let failNextSave = false;
let deferEditPersistence = false;
let normalizeEditorLineEndings = false;

function findDocument(uri: Uri): TextDocument | undefined {
  return documents.find((document) => nodePath.normalize(document.uri.fsPath).toLowerCase() === nodePath.normalize(uri.fsPath).toLowerCase());
}

async function openTextDocument(input: Uri | { content: string; language?: string }): Promise<TextDocument> {
  if (!(input instanceof Uri)) {
    const document = new TextDocument(new Uri(`untitled-${documents.length}`, 'untitled'), input.content);
    documents.push(document);
    return document;
  }
  const existing = findDocument(input);
  if (existing) return existing;
  if (!existsSync(input.fsPath)) throw new Error('File does not exist');
  const document = new TextDocument(input, readFileSync(input.fsPath, 'utf8'));
  documents.push(document);
  return document;
}

export const workspace = {
  get textDocuments(): TextDocument[] { return documents; },
  getConfiguration: () => ({ get: (_key: string, defaultValue: unknown) => defaultValue }),
  openTextDocument,
  applyEdit: async (edit: WorkspaceEdit): Promise<boolean> => {
    if (failNextApply) {
      failNextApply = false;
      return false;
    }
    let appliedOperations = 0;
    for (const operation of edit.operations) {
      if (operation.kind === 'create') {
        if (existsSync(operation.uri.fsPath) && !operation.options.ignoreIfExists && !operation.options.overwrite) return false;
        mkdirSync(nodePath.dirname(operation.uri.fsPath), { recursive: true });
        if (!existsSync(operation.uri.fsPath) || operation.options.overwrite) writeFileSync(operation.uri.fsPath, '');
      } else if (operation.kind === 'delete') {
        if (!existsSync(operation.uri.fsPath) && !operation.options.ignoreIfNotExists) return false;
        if (existsSync(operation.uri.fsPath)) rmSync(operation.uri.fsPath, { recursive: operation.options.recursive, force: Boolean(operation.options.ignoreIfNotExists) });
        const index = documents.findIndex((document) => document.uri.fsPath === operation.uri.fsPath);
        if (index >= 0) documents.splice(index, 1);
      } else {
        const document = findDocument(operation.uri) || await openTextDocument(operation.uri);
        const current = document.getText();
        if (operation.kind === 'eol') {
          document.eol = operation.eol;
          document.setText(current.replace(/\r\n|\r|\n/g, operation.eol === EndOfLine.CRLF ? '\r\n' : '\n'));
        } else if (operation.kind === 'insert') {
          const offset = document.offsetAt(operation.position);
          document.setText(current.slice(0, offset) + operation.text + current.slice(offset));
        } else {
          const start = document.offsetAt(operation.range.start);
          const end = document.offsetAt(operation.range.end);
          document.setText(current.slice(0, start) + operation.text + current.slice(end));
        }
        if (!deferEditPersistence) writeFileSync(operation.uri.fsPath, document.getText(), 'utf8');
      }
      appliedOperations += 1;
      if (failAfterOperations !== undefined && appliedOperations >= failAfterOperations) {
        failAfterOperations = undefined;
        return false;
      }
    }
    return true;
  },
  fs: {
    createDirectory: async (uri: Uri) => { mkdirSync(uri.fsPath, { recursive: true }); },
    writeFile: async (uri: Uri, bytes: Uint8Array) => { mkdirSync(nodePath.dirname(uri.fsPath), { recursive: true }); writeFileSync(uri.fsPath, bytes); },
    readFile: async (uri: Uri) => new Uint8Array(readFileSync(uri.fsPath)),
    stat: async (uri: Uri) => statSync(uri.fsPath),
  },
};

export const window = {
  showWarningMessage: async () => undefined,
  showInformationMessage: async () => undefined,
};

export const commands = {
  registerCommand: () => ({ dispose: () => undefined }),
};

export const extensions = {
  getExtension: () => undefined,
};

export function __resetDocuments(): void {
  documents.splice(0);
  failNextApply = false;
  failAfterOperations = undefined;
  failNextSave = false;
  deferEditPersistence = false;
  normalizeEditorLineEndings = false;
}

export function __setDirty(filePath: string, dirty: boolean): void {
  const document = documents.find((item) => nodePath.normalize(item.uri.fsPath).toLowerCase() === nodePath.normalize(filePath).toLowerCase());
  if (document) document.isDirty = dirty;
}

export function __failNextWorkspaceEdit(): void {
  failNextApply = true;
}

export function __failWorkspaceEditAfter(operationCount: number): void {
  failAfterOperations = operationCount;
}

export function __deferEditPersistence(): void { deferEditPersistence = true; }
export function __failNextSave(): void { failNextSave = true; }
export function __normalizeEditorLineEndings(): void { normalizeEditorLineEndings = true; }
