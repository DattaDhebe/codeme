const KNOWN_DOTFILES = new Set([
  '.gitignore', '.gitattributes', '.editorconfig', '.npmrc', '.prettierrc', '.eslintrc', '.dockerignore',
]);

const KNOWN_FILENAMES = new Set([
  'dockerfile', 'makefile', 'procfile', 'package.json', 'tsconfig.json', 'angular.json', 'requirements.txt',
  'pyproject.toml', 'cargo.toml', 'go.mod', 'readme.md',
]);

function normalizeCandidate(value: string): string {
  return value.trim().replace(/^["']|["':;,]$/g, '').replace(/\\/g, '/').replace(/^\.\//, '');
}

export function workspacePathScore(rawValue: string): number {
  const value = normalizeCandidate(rawValue);
  if (!value || value.length > 260 || /\s/.test(value) || /[*?<>|]/.test(value)) return 0;
  if (value.startsWith('/') || value.startsWith('\\') || /^[a-zA-Z]:/.test(value)) return 0;
  if (value.split('/').some((part) => part === '..' || !part)) return 0;
  const basename = value.split('/').pop()?.toLowerCase() || '';
  if (KNOWN_DOTFILES.has(basename) || KNOWN_FILENAMES.has(basename)) return 100;
  if (/^\.[a-z0-9]+$/i.test(basename)) return 0; // An extension such as `.zip`, not a file target.
  if (value.includes('/') && /^[^./][^/]*\.[a-z0-9][a-z0-9._-]*$/i.test(basename)) return 90;
  if (/^[^./][^/]*\.[a-z0-9][a-z0-9._-]*$/i.test(basename)) return 70;
  return 0;
}

function bestCandidate(text: string): string | undefined {
  const candidates: Array<{ value: string; score: number; index: number }> = [];
  const inlineCode = /`([^`\n]+)`/g;
  let match: RegExpExecArray | null;
  while ((match = inlineCode.exec(text)) !== null) {
    const score = workspacePathScore(match[1]);
    if (score) candidates.push({ value: normalizeCandidate(match[1]), score, index: match.index });
  }
  const plainPath = /(?:^|[\s(])((?:[\w.-]+\/)+[\w.-]+\.[a-z0-9._-]+)/gim;
  while ((match = plainPath.exec(text)) !== null) {
    const score = workspacePathScore(match[1]);
    if (score) candidates.push({ value: normalizeCandidate(match[1]), score, index: match.index });
  }
  candidates.sort((left, right) => right.score - left.score || right.index - left.index);
  return candidates[0]?.value;
}

export function inferCodeBlockTargets(markdown: string): Array<string | undefined> {
  const targets: Array<string | undefined> = [];
  const fence = /```([^\n`]*)\r?\n[\s\S]*?```/g;
  let previousEnd = 0;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(markdown)) !== null) {
    const info = match[1].trim();
    const explicit = /(?:path|filename|file)\s*=\s*["']?([^\s"']+)/i.exec(info)?.[1]
      || info.split(/\s+/).slice(1).find((item) => workspacePathScore(item) > 0);
    const nearbyText = markdown.slice(Math.max(previousEnd, match.index - 1_200), match.index);
    targets.push(explicit && workspacePathScore(explicit) ? normalizeCandidate(explicit) : bestCandidate(nearbyText));
    previousEnd = fence.lastIndex;
  }
  return targets;
}
