export type ChangeOperationType = 'create' | 'modify';

export interface ChangeOperation {
  operation_id: string;
  type: ChangeOperationType;
  relative_path: string;
  summary: string;
  base_sha256: string | null;
  proposed_sha256: string;
  result_sha256?: string | null;
  encoding: 'utf-8';
  line_ending: 'lf' | 'crlf' | 'none' | 'mixed';
  edits: Array<{ old_text: string; new_text: string; replace_all: boolean }>;
  proposed_content: string;
  diff: string;
}

export interface ChangeSet {
  id: string;
  schema_version: 1;
  conversation_id: number;
  workspace_id: number;
  summary: string;
  status: string;
  checkpoint_reference?: string | null;
  failure_reason?: string | null;
  created_at: string;
  updated_at: string;
  operations: ChangeOperation[];
}

export function isSha256(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

export function validateRelativePath(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  if (!normalized || normalized.includes('\0') || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error('Change-set paths must be workspace-relative.');
  }
  const parts = normalized.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Traversal and ambiguous path segments are not allowed.');
  }
  return normalized;
}

export function validateChangeSet(changeSet: ChangeSet): void {
  if (changeSet.schema_version !== 1 || !changeSet.id || !changeSet.operations.length) {
    throw new Error('Invalid or empty change set.');
  }
  const paths = new Set<string>();
  for (const operation of changeSet.operations) {
    const relativePath = validateRelativePath(operation.relative_path);
    const key = relativePath.toLocaleLowerCase();
    if (paths.has(key)) throw new Error(`Duplicate change-set path: ${relativePath}`);
    paths.add(key);
    if (!['create', 'modify'].includes(operation.type) || !isSha256(operation.proposed_sha256)) {
      throw new Error(`Invalid operation for ${relativePath}`);
    }
    if (operation.type === 'modify' && !isSha256(operation.base_sha256)) {
      throw new Error(`Modify operation lacks a base hash for ${relativePath}`);
    }
    if (operation.type === 'create' && operation.base_sha256 !== null) {
      throw new Error(`Create operation must not include a base hash for ${relativePath}`);
    }
  }
}
