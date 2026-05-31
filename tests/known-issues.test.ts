// Tests for INF-06: KNOWN_ISSUES.md middleware behavior
// Implementation: src/tools/known-issues/middleware.ts, src/tools/known-issues/store.ts
//
// Strategy: store.ts reads/writes KNOWN_ISSUES.md at PROJECT_ROOT (process.cwd() by default).
// Tests operate on a real file at process.cwd()/KNOWN_ISSUES.md, restoring state after each test.
// The mtime-based cache in store.ts ensures re-reads happen between tests when file content changes.

import * as fs from 'fs/promises';
import * as path from 'path';
import { readKnownIssues, appendKnownIssue } from '../src/tools/known-issues/store.js';
import { withKnownIssues } from '../src/tools/known-issues/middleware.js';

// ---------------------------------------------------------------------------
// File isolation helpers
// ---------------------------------------------------------------------------

const KNOWN_ISSUES_PATH = path.join(process.cwd(), 'KNOWN_ISSUES.md');

// Save file state before each test; restore after
let originalContent: string | null = null;

beforeEach(async () => {
  try {
    originalContent = await fs.readFile(KNOWN_ISSUES_PATH, 'utf8');
  } catch {
    originalContent = null; // file did not exist
  }
});

afterEach(async () => {
  if (originalContent === null) {
    // File didn't exist before — delete it if tests created it
    await fs.rm(KNOWN_ISSUES_PATH, { force: true });
  } else {
    // Restore original content
    await fs.writeFile(KNOWN_ISSUES_PATH, originalContent, 'utf8');
  }
});

// Helper: overwrite KNOWN_ISSUES.md with test content
async function writeKnownIssues(content: string): Promise<void> {
  await fs.writeFile(KNOWN_ISSUES_PATH, content, 'utf8');
}

// Helper: delete KNOWN_ISSUES.md entirely (for testing missing-file case)
async function deleteKnownIssues(): Promise<void> {
  await fs.rm(KNOWN_ISSUES_PATH, { force: true });
}

// ---------------------------------------------------------------------------
// KNOWN_ISSUES store tests
// ---------------------------------------------------------------------------

describe('KNOWN_ISSUES store', () => {
  it('readKnownIssues returns [] when KNOWN_ISSUES.md does not exist', async () => {
    await deleteKnownIssues();
    const issues = await readKnownIssues();
    expect(issues).toEqual([]);
  });

  it('readKnownIssues returns [] for file with only a header (no ISSUE sections)', async () => {
    await writeKnownIssues('# Known Issues\n\nNo issues yet.\n');
    const issues = await readKnownIssues();
    expect(issues).toEqual([]);
  });

  it('readKnownIssues parses a single ISSUE block correctly', async () => {
    const content = [
      '# Known Issues',
      '',
      '## ISSUE-001',
      '**Description:** Test description',
      '**Affected tools:** ue_read_cpp_class, ue_trace_includes',
      '**Root cause:** Test root cause',
      '**Resolution:** Test resolution',
      '**Date added:** 2026-05-30',
      '**Status:** active',
      '',
      '---',
    ].join('\n');

    await writeKnownIssues(content);
    const issues = await readKnownIssues();

    expect(issues).toHaveLength(1);
    expect(issues[0]?.id).toBe('ISSUE-001');
    expect(issues[0]?.description).toBe('Test description');
    expect(issues[0]?.affectedTools).toEqual(['ue_read_cpp_class', 'ue_trace_includes']);
    expect(issues[0]?.status).toBe('active');
  });

  it('appendKnownIssue writes the first issue with auto-assigned ISSUE-001 id', async () => {
    // Start from a clean header file
    await writeKnownIssues('# Known Issues\n');

    const result = await appendKnownIssue({
      description: 'A test issue',
      affectedTools: ['ue_build'],
      rootCause: 'Test cause',
      resolution: 'Test fix',
      dateAdded: '2026-05-30',
      status: 'active',
    });

    expect(result.id).toBe('ISSUE-001');
    expect(result.description).toBe('A test issue');

    // Verify the issue is now readable
    const issues = await readKnownIssues();
    expect(issues.some((i) => i.id === 'ISSUE-001')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// KNOWN_ISSUES middleware tests
// ---------------------------------------------------------------------------

describe('KNOWN_ISSUES middleware', () => {
  it('withKnownIssues passes through result when no matching issues exist', async () => {
    // Write a file with an issue affecting a different tool
    await writeKnownIssues([
      '# Known Issues',
      '',
      '## ISSUE-001',
      '**Description:** Unrelated issue',
      '**Affected tools:** ue_build',
      '**Root cause:** Some cause',
      '**Resolution:** Some fix',
      '**Date added:** 2026-05-30',
      '**Status:** active',
    ].join('\n'));

    const handler = withKnownIssues('ue_read_cpp_class', async (_args: Record<string, unknown>) => ({
      content: [{ type: 'text' as const, text: 'ok' }],
    }));

    const result = await handler({});
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.text).toBe('ok');
    expect(result.isError).toBeUndefined();
  });

  it('withKnownIssues prepends warning for matching tool name', async () => {
    await writeKnownIssues([
      '# Known Issues',
      '',
      '## ISSUE-001',
      '**Description:** Known crash in test_tool',
      '**Affected tools:** test_tool',
      '**Root cause:** Race condition',
      '**Resolution:** Use async lock',
      '**Date added:** 2026-05-30',
      '**Status:** active',
    ].join('\n'));

    const handler = withKnownIssues('test_tool', async (_args: Record<string, unknown>) => ({
      content: [{ type: 'text' as const, text: 'result' }],
    }));

    const result = await handler({});

    // Expect 2 content items: warning prepended + original result
    expect(result.content).toHaveLength(2);
    expect(result.content[0]?.text).toContain('[KNOWN ISSUE ISSUE-001]');
    expect(result.content[0]?.text).toContain('Known crash in test_tool');
    expect(result.content[1]?.text).toBe('result');
  });

  it('withKnownIssues prepends warning for wildcard (*) affected tools', async () => {
    await writeKnownIssues([
      '# Known Issues',
      '',
      '## ISSUE-002',
      '**Description:** Global outage affecting all tools',
      '**Affected tools:** *',
      '**Root cause:** Config error',
      '**Resolution:** Fix config',
      '**Date added:** 2026-05-30',
      '**Status:** active',
    ].join('\n'));

    const handler = withKnownIssues('ue_list_known_issues', async (_args: Record<string, unknown>) => ({
      content: [{ type: 'text' as const, text: 'data' }],
    }));

    const result = await handler({});
    expect(result.content).toHaveLength(2);
    expect(result.content[0]?.text).toContain('[KNOWN ISSUE ISSUE-002]');
  });

  it('withKnownIssues returns isError response when handler throws', async () => {
    await writeKnownIssues('# Known Issues\n');

    const handler = withKnownIssues('ue_build', async (_args: Record<string, unknown>) => {
      throw new Error('Simulated handler failure');
    });

    const result = await handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Simulated handler failure');
  });
});
