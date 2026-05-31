// src/build/ubt-runner.ts
// UBT invocation, UBT path discovery, and concurrent build guard.
// Invokes UnrealBuildTool as an array-form subprocess via execFileNoThrow — never shell string.
//
// Discovery strategy:
//   1. If params.ubtPath is provided — use it directly (skip discovery).
//   2. If params.uprojectPath is provided — read EngineAssociation from it.
//   3. Otherwise — scan PROJECT_ROOT for a .uproject file, then read EngineAssociation.
//   4. EngineAssociation "X.Y" → binary Launcher install → dotnet + UBT.dll
//   5. Fallback: walk ancestor dirs looking for source engine UBT.exe
//
// Security: execFileNoThrow uses array-form execFile — T-06-04 (injection) is mitigated.
// Concurrency: buildInProgress boolean guard prevents T-06-05 (double-spawn DoS).

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileNoThrow } from '../utils/execFileNoThrow.js';
import { parseUproject } from '../parsers/uproject-parser.js';
import { PROJECT_ROOT } from '../config.js';
import { log, warn } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface UbtRunParams {
  /** Build target name, e.g. "MyProjectEditor". */
  target: string;
  /** Build configuration. Defaults to "Development". */
  configuration?: string;
  /** Target platform. Defaults to "Win64". */
  platform?: string;
  /** Explicit .uproject path. Auto-discovered from PROJECT_ROOT when omitted. */
  uprojectPath?: string;
  /** Explicit UBT binary override — skips all discovery. Ends in .dll or .exe. */
  ubtPath?: string;
}

export interface UbtRunResult {
  stdout: string;
  stderr: string;
  /** UBT process exit code. null if the process was killed by a signal. */
  exitCode: number | null;
  /** Elapsed wall-clock milliseconds from build start to finish. */
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Concurrent build guard
// ---------------------------------------------------------------------------

/** Module-level flag — at most one UBT process may run at a time. Mitigates T-06-05. */
let buildInProgress = false;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Invoke UnrealBuildTool for the specified target.
 *
 * Rejects immediately if another build is already running.
 * Rejects with "UnrealBuildTool not found" if UBT cannot be located.
 *
 * @param params Build parameters. Only `target` is required.
 */
export async function runUbt(params: UbtRunParams): Promise<UbtRunResult> {
  if (buildInProgress) {
    throw new Error('Build already in progress. Wait for the current build to complete.');
  }
  buildInProgress = true;
  const start = Date.now();

  try {
    // Resolve UBT command and any argument prefix
    let ubtCmd: string;
    let ubtArgPrefix: string[];

    if (params.ubtPath) {
      // Explicit override — derive invocation style from extension
      if (params.ubtPath.endsWith('.dll')) {
        // Binary Launcher install: dotnet <path-to-dll>
        ubtCmd = 'dotnet';
        ubtArgPrefix = [params.ubtPath];
      } else {
        // Source engine install: invoke executable directly
        ubtCmd = params.ubtPath;
        ubtArgPrefix = [];
      }
    } else {
      // Discovery path
      const uprojectPath = params.uprojectPath ?? findUproject();
      const discovered = discoverUbt(uprojectPath);
      ubtCmd = discovered.cmd;
      ubtArgPrefix = discovered.argPrefix;
    }

    // Assemble final argument list:
    //   [ubtArgPrefix..., target, platform, configuration, -project=<path>?]
    const config = params.configuration ?? 'Development';
    const platform = params.platform ?? 'Win64';
    const uprojectArg = params.uprojectPath ? [`-project=${params.uprojectPath}`] : [];
    const args = [...ubtArgPrefix, params.target, platform, config, ...uprojectArg];

    log(`runUbt: ${ubtCmd} ${args.join(' ')}`);

    const result = await execFileNoThrow(ubtCmd, args, { cwd: PROJECT_ROOT });
    const durationMs = Date.now() - start;

    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.status,
      durationMs,
    };
  } finally {
    buildInProgress = false;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Scan PROJECT_ROOT for a .uproject file.
 * Throws if none found.
 */
function findUproject(): string {
  const entries = fs.readdirSync(PROJECT_ROOT) as string[];
  const uproject = entries.find((e) => e.endsWith('.uproject'));
  if (!uproject) {
    throw new Error(`No .uproject file found in ${PROJECT_ROOT}`);
  }
  return path.join(PROJECT_ROOT as string, uproject);
}

/**
 * Discover the UBT binary from the given .uproject file.
 *
 * Candidate 1 — Binary Launcher install (EngineAssociation = "X.Y"):
 *   %PROGRAMFILES%\Epic Games\UE_X.Y\Engine\Binaries\DotNET\UnrealBuildTool\UnrealBuildTool.dll
 *   → invoked as: dotnet <dll-path>
 *
 * Candidate 2 — Source engine install (walk ancestor dirs up to 3 levels):
 *   <ancestor>\Engine\Binaries\DotNET\UnrealBuildTool\UnrealBuildTool.exe
 *   → invoked directly
 *
 * Throws "UnrealBuildTool not found" if neither candidate exists.
 */
function discoverUbt(uprojectPath: string): { cmd: string; argPrefix: string[] } {
  // Read EngineAssociation from .uproject
  let engineVersion: string | undefined;
  try {
    const content = fs.readFileSync(uprojectPath, 'utf-8') as string;
    const parsed = parseUproject(content);
    if (parsed.success) {
      engineVersion = parsed.data.EngineAssociation;
    }
  } catch {
    warn('discoverUbt: failed to read .uproject; attempting fallback paths');
  }

  // Candidate 1: binary Launcher install — EngineAssociation looks like "5.4"
  if (engineVersion && /^\d+\.\d+$/.test(engineVersion)) {
    const programFiles = process.env['PROGRAMFILES'] ?? 'C:\\Program Files';
    const dllPath = path.join(
      programFiles,
      'Epic Games',
      `UE_${engineVersion}`,
      'Engine',
      'Binaries',
      'DotNET',
      'UnrealBuildTool',
      'UnrealBuildTool.dll'
    );
    if (fs.existsSync(dllPath)) {
      return { cmd: 'dotnet', argPrefix: [dllPath] };
    }
  }

  // Candidate 2: source engine install — walk ancestor directories
  let dir = path.dirname(uprojectPath);
  for (let i = 0; i < 3; i++) {
    const exePath = path.join(
      dir,
      'Engine',
      'Binaries',
      'DotNET',
      'UnrealBuildTool',
      'UnrealBuildTool.exe'
    );
    if (fs.existsSync(exePath)) {
      return { cmd: exePath, argPrefix: [] };
    }
    dir = path.dirname(dir);
  }

  throw new Error(
    'UnrealBuildTool not found. Set UBT_PATH environment variable or ensure UE is installed ' +
      'at the default Launcher location (C:\\Program Files\\Epic Games\\UE_X.Y).'
  );
}
