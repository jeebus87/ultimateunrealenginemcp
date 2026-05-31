// src/tools/known-issues/store.ts
// Reads, caches, and writes KNOWN_ISSUES.md at the project root.
// Cache is keyed by file mtime — re-reads only when the file changes.

import * as fs from 'fs/promises';
import * as path from 'path';
import { PROJECT_ROOT } from '../../config.js';

const KNOWN_ISSUES_PATH = path.join(PROJECT_ROOT, 'KNOWN_ISSUES.md');

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface KnownIssue {
  id: string;               // e.g., 'ISSUE-001'
  description: string;
  affectedTools: string[];  // split from comma-separated value, or ['*'] for wildcard
  rootCause: string;
  resolution: string;
  dateAdded: string;
  status: 'active' | 'resolved';
}

// ---------------------------------------------------------------------------
// Internal mtime cache
// ---------------------------------------------------------------------------

interface Cache {
  issues: KnownIssue[];
  mtime: number;
}

const cache: Cache = { issues: [], mtime: 0 };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the text after a bold field label on a line.
 * e.g., "**Description:** foo" → "foo"
 */
function extractField(lines: string[], label: string): string {
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith(label)) {
      return trimmed.slice(label.length).trim();
    }
  }
  return '';
}

/**
 * Parse a single issue block (text after "## ISSUE-" prefix).
 * The first line of the block is the issue number suffix (e.g., "001\n...").
 */
function parseIssueBlock(block: string): KnownIssue | null {
  const newlineIdx = block.indexOf('\n');
  const idSuffix = newlineIdx === -1 ? block.trim() : block.slice(0, newlineIdx).trim();
  if (!idSuffix) return null;

  const id = 'ISSUE-' + idSuffix;
  const body = newlineIdx === -1 ? '' : block.slice(newlineIdx + 1);
  const lines = body.split('\n');

  const description = extractField(lines, '**Description:**');
  const affectedToolsRaw = extractField(lines, '**Affected tools:**');
  const rootCause = extractField(lines, '**Root cause:**');
  const resolution = extractField(lines, '**Resolution:**');
  const dateAdded = extractField(lines, '**Date added:**');
  const statusRaw = extractField(lines, '**Status:**').toLowerCase();
  const status: 'active' | 'resolved' =
    statusRaw === 'resolved' ? 'resolved' : 'active';

  const affectedTools =
    affectedToolsRaw.trim() === ''
      ? []
      : affectedToolsRaw.split(',').map((s) => s.trim()).filter(Boolean);

  return { id, description, affectedTools, rootCause, resolution, dateAdded, status };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read and parse all ## ISSUE-NNN sections from KNOWN_ISSUES.md.
 * Results are cached by mtime; a second call without file changes returns the
 * same array reference without performing a second fs.readFile.
 *
 * Returns [] if the file does not exist or contains no ## ISSUE- sections.
 */
export async function readKnownIssues(): Promise<KnownIssue[]> {
  let stat;
  try {
    stat = await fs.stat(KNOWN_ISSUES_PATH);
  } catch (err: unknown) {
    if (
      err !== null &&
      typeof err === 'object' &&
      'code' in err &&
      (err as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return [];
    }
    throw err;
  }

  const currentMtime = stat.mtimeMs;
  if (currentMtime === cache.mtime) {
    return cache.issues;
  }

  const content = await fs.readFile(KNOWN_ISSUES_PATH, 'utf8');

  // Split on '\n## ISSUE-' — the first segment is the header (discarded).
  const segments = content.split('\n## ISSUE-');
  const issueBlocks = segments.slice(1); // discard header segment

  const issues: KnownIssue[] = [];
  for (const block of issueBlocks) {
    const issue = parseIssueBlock(block);
    if (issue !== null) {
      issues.push(issue);
    }
  }

  cache.issues = issues;
  cache.mtime = currentMtime;

  return issues;
}

/**
 * Append a new ## ISSUE-NNN section to KNOWN_ISSUES.md.
 * The issue number is auto-incremented from the highest existing issue number.
 * Invalidates the mtime cache so the next readKnownIssues() call re-reads the file.
 *
 * Returns the full KnownIssue with the computed id.
 */
export async function appendKnownIssue(
  issue: Omit<KnownIssue, 'id'>
): Promise<KnownIssue> {
  const existing = await readKnownIssues();

  // Compute next ID
  let maxN = 0;
  for (const existing_issue of existing) {
    const n = parseInt(existing_issue.id.replace('ISSUE-', ''), 10);
    if (!isNaN(n) && n > maxN) {
      maxN = n;
    }
  }
  const nextN = maxN + 1;
  const id = 'ISSUE-' + String(nextN).padStart(3, '0');

  // Build the markdown block matching KNOWN_ISSUES.md format
  const affectedToolsStr = issue.affectedTools.join(', ');
  const block =
    `\n## ${id}\n` +
    `**Description:** ${issue.description}\n` +
    `**Affected tools:** ${affectedToolsStr}\n` +
    `**Root cause:** ${issue.rootCause}\n` +
    `**Resolution:** ${issue.resolution}\n` +
    `**Date added:** ${issue.dateAdded}\n` +
    `**Status:** ${issue.status}\n` +
    `\n---`;

  await fs.appendFile(KNOWN_ISSUES_PATH, block, 'utf8');

  // Invalidate cache so next read picks up the newly appended content
  cache.mtime = 0;

  return { ...issue, id };
}
