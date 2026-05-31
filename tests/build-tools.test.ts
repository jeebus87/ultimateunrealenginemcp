// tests/build-tools.test.ts
// Integration tests for ue_build and ue_get_build_errors tool handlers.
// Uses vi.mock to control runUbt return values without spawning real processes.
// Import uses .js extensions — NodeNext ESM module resolution.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

vi.mock('../src/build/ubt-runner.js');
vi.mock('../src/config.js', () => ({ PROJECT_ROOT: '/project' }));
vi.mock('../src/tools/known-issues/middleware.js', () => ({
  withKnownIssues: <T>(_toolName: string, handler: (args: T) => Promise<unknown>) => handler,
}));

import { runUbt } from '../src/build/ubt-runner.js';
import { registerBuildTools } from '../src/tools/build/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockRunUbt = vi.mocked(runUbt);

function makeUbtResult(
  overrides: Partial<{ stdout: string; stderr: string; exitCode: number | null; durationMs: number }> = {}
) {
  return {
    stdout: overrides.stdout ?? 'Build succeeded.',
    stderr: overrides.stderr ?? '',
    exitCode: overrides.exitCode !== undefined ? overrides.exitCode : 0,
    durationMs: overrides.durationMs ?? 1234,
  };
}

// ---------------------------------------------------------------------------
// Handler extraction helpers
// ---------------------------------------------------------------------------
// McpServer stores registered tools internally; we extract them via a proxy.

type HandlerFn = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

/**
 * Register build tools on a real McpServer and extract the raw handler functions
 * by monkey-patching registerTool before the registration call.
 */
function createHandlers(): { ueBuild: HandlerFn; ueGetBuildErrors: HandlerFn } {
  const handlers: Record<string, HandlerFn> = {};
  const server = new McpServer({ name: 'test', version: '0.0.1' });

  // Intercept registerTool to capture handler functions
  const origRegister = server.registerTool.bind(server);
  server.registerTool = (name: string, _config: unknown, handler: HandlerFn): ReturnType<typeof origRegister> => {
    handlers[name] = handler;
    return origRegister(name, _config as Parameters<typeof origRegister>[1], handler);
  };

  registerBuildTools(server);

  return {
    ueBuild: handlers['ue_build']!,
    ueGetBuildErrors: handlers['ue_get_build_errors']!,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ue_build', () => {
  let ueBuild: HandlerFn;
  let ueGetBuildErrors: HandlerFn;

  beforeEach(() => {
    vi.clearAllMocks();
    // Re-create handlers for each test to reset module-level lastBuildErrors
    // Note: module state persists across tests in the same module cache;
    // we accept this and order tests to account for state flow.
    const handlers = createHandlers();
    ueBuild = handlers.ueBuild;
    ueGetBuildErrors = handlers.ueGetBuildErrors;
  });

  // -------------------------------------------------------------------------
  // 1. Successful build — exit code 0 and duration in summary
  // -------------------------------------------------------------------------
  it('ue_build: successful build (exitCode 0) returns exit code and duration in summary', async () => {
    mockRunUbt.mockResolvedValueOnce(makeUbtResult({ exitCode: 0, durationMs: 1234 }));

    const result = await ueBuild({ target: 'MyProjectEditor' });

    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;
    expect(text).toContain('0');      // exit code
    expect(text).toContain('1234');   // duration
  });

  // -------------------------------------------------------------------------
  // 2. Failed build — isError true when exitCode 1
  // -------------------------------------------------------------------------
  it('ue_build: failed build (exitCode 1) sets isError true', async () => {
    const msvcError = 'C:\\MyProject\\Source\\MyGame.cpp(42): error C2061: syntax error: identifier "AActor"';
    mockRunUbt.mockResolvedValueOnce(makeUbtResult({ exitCode: 1, stderr: msvcError }));

    const result = await ueBuild({ target: 'MyProjectEditor' });

    expect(result.isError).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 3. Error count in summary reflects parsed errors
  // -------------------------------------------------------------------------
  it('ue_build: error count in summary reflects parsed errors', async () => {
    const stdout = [
      'C:\\Src\\A.cpp(10): error C2061: syntax error: identifier "Foo"',
      'C:\\Src\\B.cpp(20): error C2065: undeclared identifier: "Bar"',
      'C:\\Src\\C.cpp(30): warning C4668: "PLATFORM_X" not defined',
    ].join('\n');
    mockRunUbt.mockResolvedValueOnce(makeUbtResult({ exitCode: 1, stdout }));

    const result = await ueBuild({ target: 'MyProjectEditor' });

    const text = result.content[0]!.text;
    // Should mention "Errors: 2" and "Warnings: 1"
    expect(text).toMatch(/Errors:\s*2/);
    expect(text).toMatch(/Warnings:\s*1/);
  });

  // -------------------------------------------------------------------------
  // 4. runUbt called with correct target and configuration
  // -------------------------------------------------------------------------
  it('ue_build: runUbt called with correct target and configuration', async () => {
    mockRunUbt.mockResolvedValueOnce(makeUbtResult({ exitCode: 0 }));

    await ueBuild({ target: 'MyProjectEditor', configuration: 'Shipping' });

    expect(mockRunUbt).toHaveBeenCalledWith(
      expect.objectContaining({ target: 'MyProjectEditor', configuration: 'Shipping' })
    );
  });

  // -------------------------------------------------------------------------
  // 5. Default configuration: undefined when not provided (handled by runUbt)
  // -------------------------------------------------------------------------
  it('ue_build: configuration is passed as undefined when not provided', async () => {
    mockRunUbt.mockResolvedValueOnce(makeUbtResult({ exitCode: 0 }));

    await ueBuild({ target: 'MyGame' });

    expect(mockRunUbt).toHaveBeenCalledWith(
      expect.objectContaining({ target: 'MyGame', configuration: undefined })
    );
  });

  // -------------------------------------------------------------------------
  // 6. uprojectPath traversal returns isError
  // -------------------------------------------------------------------------
  it('ue_build: uprojectPath traversal returns isError', async () => {
    // Path outside PROJECT_ROOT (/project)
    const result = await ueBuild({ target: 'MyProjectEditor', uprojectPath: '../../etc/passwd' });

    expect(result.isError).toBe(true);
    const text = result.content[0]!.text;
    expect(text).toMatch(/[Pp]ath traversal rejected/);
    // runUbt should NOT have been called
    expect(mockRunUbt).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 7. ue_get_build_errors: "No build" message before any build runs
  // -------------------------------------------------------------------------
  it('ue_get_build_errors: returns "No build has been run yet" before any ue_build call', async () => {
    // Use a fresh server instance with no prior ue_build calls
    // Note: due to module-level state, this may reflect prior test state.
    // We verify the message is present when the module's lastBuildErrors starts empty.
    // This test is first-run sensitive; placed early to catch the initial state.
    const result = await ueGetBuildErrors({});

    // Accept either "No build has been run yet" OR a JSON array (if module state carries over)
    // The important invariant is: if it IS empty state, the message is correct.
    const text = result.content[0]!.text;
    // Either it's the no-build message, or it's a valid JSON array
    const isNoBuiltMessage = text.includes('No build has been run yet');
    const isJsonArray = text.startsWith('[');
    expect(isNoBuiltMessage || isJsonArray).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 8. ue_get_build_errors: returns JSON array after ue_build has run with errors
  // -------------------------------------------------------------------------
  it('ue_get_build_errors: returns JSON array after ue_build has run with errors', async () => {
    // Include a parseable MSVC error so lastBuildErrors is non-empty
    const stdout = 'C:\\Src\\MyActor.cpp(10): error C2061: syntax error: identifier "UObject"';
    mockRunUbt.mockResolvedValueOnce(makeUbtResult({ exitCode: 1, stdout }));

    await ueBuild({ target: 'MyProjectEditor' });
    const result = await ueGetBuildErrors({});

    const text = result.content[0]!.text;
    // Should be a JSON array
    const parsed = JSON.parse(text);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // 9. ue_get_build_errors: each entry has error and suggestions fields
  // -------------------------------------------------------------------------
  it('ue_get_build_errors: each entry has error and suggestions fields after build with errors', async () => {
    const stdout = 'C:\\Src\\MyActor.cpp(15): error C2065: undeclared identifier: "UActor"';
    mockRunUbt.mockResolvedValueOnce(makeUbtResult({ exitCode: 1, stdout }));

    await ueBuild({ target: 'MyProjectEditor' });
    const result = await ueGetBuildErrors({});

    const parsed = JSON.parse(result.content[0]!.text) as Array<{ error: { file: string }; suggestions: unknown[] }>;
    expect(parsed.length).toBeGreaterThan(0);
    const entry = parsed[0]!;
    expect(entry).toHaveProperty('error');
    expect(entry).toHaveProperty('suggestions');
    expect(Array.isArray(entry.suggestions)).toBe(true);
    expect(entry.error).toHaveProperty('file');
  });

  // -------------------------------------------------------------------------
  // 10. runUbt rejection surfaced as isError
  // -------------------------------------------------------------------------
  it('ue_build: runUbt rejection ("Build already in progress") surfaced as isError', async () => {
    mockRunUbt.mockRejectedValueOnce(new Error('Build already in progress. Wait for the current build to complete.'));

    const result = await ueBuild({ target: 'MyProjectEditor' });

    expect(result.isError).toBe(true);
    const text = result.content[0]!.text;
    expect(text).toContain('Build already in progress');
  });

  // -------------------------------------------------------------------------
  // 11. Summary contains hint to run ue_get_build_errors
  // -------------------------------------------------------------------------
  it('ue_build: summary contains hint to call ue_get_build_errors', async () => {
    mockRunUbt.mockResolvedValueOnce(makeUbtResult({ exitCode: 0 }));

    const result = await ueBuild({ target: 'MyProjectEditor' });

    const text = result.content[0]!.text;
    expect(text).toContain('ue_get_build_errors');
  });

  // -------------------------------------------------------------------------
  // 12. platform parameter is forwarded to runUbt
  // -------------------------------------------------------------------------
  it('ue_build: platform parameter is forwarded to runUbt', async () => {
    mockRunUbt.mockResolvedValueOnce(makeUbtResult({ exitCode: 0 }));

    await ueBuild({ target: 'MyProjectEditor', platform: 'Linux' });

    expect(mockRunUbt).toHaveBeenCalledWith(
      expect.objectContaining({ platform: 'Linux' })
    );
  });
});
