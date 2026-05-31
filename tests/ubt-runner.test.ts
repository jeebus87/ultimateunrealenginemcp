// tests/ubt-runner.test.ts
// Unit tests for UBT runner — vi.mock based, no real subprocesses or file I/O.
// Covers: successful build, failed build, concurrent guard, dotnet/.dll invocation,
// direct .exe invocation, arg assembly (target/platform/config), defaults, UBT not found.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

vi.mock('node:fs');
vi.mock('../src/utils/execFileNoThrow.js');
// Mock config so PROJECT_ROOT is deterministic
vi.mock('../src/config.js', () => ({ PROJECT_ROOT: '/project' }));
// Mock logger to suppress output during tests
vi.mock('../src/utils/logger.js', () => ({
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

import * as fs from 'node:fs';
import { execFileNoThrow } from '../src/utils/execFileNoThrow.js';
import { runUbt } from '../src/build/ubt-runner.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Reset buildInProgress between tests by re-importing is not straightforward with vi.mock,
 *  so we use a workaround: let in-flight builds settle, or rely on test isolation ordering.
 *  Actually the simplest approach: await a dummy run that resolves quickly before each test.
 *  We'll reset mocks and the module state using resetModules in beforeEach when needed. */

const mockExecFile = vi.mocked(execFileNoThrow);
const mockFs = vi.mocked(fs);

function makeSuccessResult(stdout = 'Build succeeded', stderr = '') {
  return { stdout, stderr, status: 0 };
}

function makeFailResult(stdout = '', stderr = 'Build failed', status = 1) {
  return { stdout, stderr, status };
}

/**
 * Set up fs mocks for the UBT-not-found scenario where discovery is required.
 * - readdirSync returns a .uproject file
 * - readFileSync returns valid JSON with no EngineAssociation (forces fallback)
 * - existsSync always returns false (no UBT binary found anywhere)
 */
function setupDiscoveryMocks({
  engineAssociation,
  existsResult = false,
}: {
  engineAssociation?: string;
  existsResult?: boolean;
} = {}) {
  mockFs.readdirSync = vi.fn().mockReturnValue(['Project.uproject']) as typeof fs.readdirSync;
  mockFs.readFileSync = vi.fn().mockReturnValue(
    JSON.stringify({
      FileVersion: 3,
      ...(engineAssociation !== undefined ? { EngineAssociation: engineAssociation } : {}),
    })
  ) as typeof fs.readFileSync;
  mockFs.existsSync = vi.fn().mockReturnValue(existsResult) as typeof fs.existsSync;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runUbt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. Successful build
  // -------------------------------------------------------------------------
  it('returns UbtRunResult with exitCode 0 and durationMs >= 0 on successful build', async () => {
    mockExecFile.mockResolvedValue(makeSuccessResult('Build succeeded'));

    const result = await runUbt({ target: 'MyProjectEditor', ubtPath: '/engines/ubt.exe' });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('Build succeeded');
    expect(result.stderr).toBe('');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  // -------------------------------------------------------------------------
  // 2. Failed build — non-zero exit code
  // -------------------------------------------------------------------------
  it('returns UbtRunResult with exitCode 1 when UBT exits with error', async () => {
    mockExecFile.mockResolvedValue(makeFailResult('', 'Compile error', 1));

    const result = await runUbt({ target: 'MyProjectEditor', ubtPath: '/engines/ubt.exe' });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('Compile error');
  });

  // -------------------------------------------------------------------------
  // 3. Concurrent build rejection
  // -------------------------------------------------------------------------
  it('rejects with "Build already in progress" when a second runUbt is called concurrently', async () => {
    // Create a promise we can control to keep the first build "in progress"
    let resolveFirstBuild!: (val: { stdout: string; stderr: string; status: number }) => void;
    const firstBuildPromise = new Promise<{ stdout: string; stderr: string; status: number }>(
      (resolve) => { resolveFirstBuild = resolve; }
    );

    mockExecFile.mockReturnValueOnce(firstBuildPromise);

    // Start the first build but do not await
    const firstBuild = runUbt({ target: 'MyProjectEditor', ubtPath: '/engines/ubt.exe' });

    // Second call should reject immediately
    await expect(
      runUbt({ target: 'MyProjectEditor', ubtPath: '/engines/ubt.exe' })
    ).rejects.toThrow(/Build already in progress/);

    // Let the first build finish so the guard is cleared
    resolveFirstBuild({ stdout: '', stderr: '', status: 0 });
    await firstBuild;
  });

  // -------------------------------------------------------------------------
  // 4. dotnet invocation for .dll ubtPath
  // -------------------------------------------------------------------------
  it('invokes "dotnet" as command when ubtPath ends in ".dll"', async () => {
    mockExecFile.mockResolvedValue(makeSuccessResult());

    await runUbt({ target: 'MyProjectEditor', ubtPath: '/engine/UnrealBuildTool.dll' });

    expect(mockExecFile).toHaveBeenCalledWith(
      'dotnet',
      expect.arrayContaining(['/engine/UnrealBuildTool.dll']),
      expect.anything()
    );
  });

  // -------------------------------------------------------------------------
  // 5. Direct exe invocation for .exe ubtPath
  // -------------------------------------------------------------------------
  it('invokes the exe path directly as command when ubtPath ends in ".exe"', async () => {
    mockExecFile.mockResolvedValue(makeSuccessResult());

    await runUbt({ target: 'MyProjectEditor', ubtPath: '/engine/UnrealBuildTool.exe' });

    expect(mockExecFile).toHaveBeenCalledWith(
      '/engine/UnrealBuildTool.exe',
      expect.not.arrayContaining(['/engine/UnrealBuildTool.exe']),
      expect.anything()
    );
  });

  // -------------------------------------------------------------------------
  // 6. Target, platform, configuration in args
  // -------------------------------------------------------------------------
  it('assembles args with target, platform, and configuration', async () => {
    mockExecFile.mockResolvedValue(makeSuccessResult());

    await runUbt({
      target: 'MyProjectEditor',
      configuration: 'Shipping',
      platform: 'Linux',
      ubtPath: '/engine/ubt.exe',
    });

    const callArgs = mockExecFile.mock.calls[0]!;
    const args = callArgs[1] as string[];
    expect(args).toContain('MyProjectEditor');
    expect(args).toContain('Linux');
    expect(args).toContain('Shipping');
  });

  // -------------------------------------------------------------------------
  // 7. Default configuration and platform
  // -------------------------------------------------------------------------
  it('defaults to "Win64" platform and "Development" configuration when not specified', async () => {
    mockExecFile.mockResolvedValue(makeSuccessResult());

    await runUbt({ target: 'MyGame', ubtPath: '/engine/ubt.exe' });

    const callArgs = mockExecFile.mock.calls[0]!;
    const args = callArgs[1] as string[];
    expect(args).toContain('Win64');
    expect(args).toContain('Development');
  });

  // -------------------------------------------------------------------------
  // 8. UBT not found — discovery failure
  // -------------------------------------------------------------------------
  it('rejects with "UnrealBuildTool not found" when UBT binary cannot be located', async () => {
    // Mock fs for discovery path: .uproject present, no EngineAssociation, existsSync=false
    setupDiscoveryMocks({ existsResult: false });

    await expect(
      runUbt({ target: 'MyProjectEditor' })
    ).rejects.toThrow(/UnrealBuildTool not found/);
  });

  // -------------------------------------------------------------------------
  // 9. Launcher binary install — discovered via EngineAssociation + existsSync
  // -------------------------------------------------------------------------
  it('discovers dotnet+dll path when EngineAssociation matches "X.Y" pattern and dll exists', async () => {
    mockFs.readdirSync = vi.fn().mockReturnValue(['Project.uproject']) as typeof fs.readdirSync;
    mockFs.readFileSync = vi.fn().mockReturnValue(
      JSON.stringify({ FileVersion: 3, EngineAssociation: '5.4' })
    ) as typeof fs.readFileSync;
    // First existsSync call (for the dll path) returns true
    mockFs.existsSync = vi.fn().mockReturnValue(true) as typeof fs.existsSync;
    mockExecFile.mockResolvedValue(makeSuccessResult());

    const result = await runUbt({ target: 'MyProjectEditor' });

    expect(result.exitCode).toBe(0);
    // cmd should be 'dotnet'
    expect(mockExecFile).toHaveBeenCalledWith(
      'dotnet',
      expect.arrayContaining([expect.stringContaining('UnrealBuildTool.dll')]),
      expect.anything()
    );
  });

  // -------------------------------------------------------------------------
  // 10. uprojectPath arg is included in UBT args when provided
  // -------------------------------------------------------------------------
  it('includes -project= arg when uprojectPath is provided', async () => {
    mockExecFile.mockResolvedValue(makeSuccessResult());

    await runUbt({
      target: 'MyProjectEditor',
      ubtPath: '/engine/ubt.exe',
      uprojectPath: '/project/MyGame.uproject',
    });

    const callArgs = mockExecFile.mock.calls[0]!;
    const args = callArgs[1] as string[];
    expect(args.some((a) => a.startsWith('-project='))).toBe(true);
  });
});
