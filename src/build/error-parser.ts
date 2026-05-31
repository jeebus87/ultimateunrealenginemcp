// src/build/error-parser.ts
// Pure-logic module for parsing compiler diagnostic lines from UBT stdout/stderr.
// No I/O, no logging, no side effects.

/**
 * A structured compiler diagnostic extracted from a raw build output line.
 */
export interface BuildError {
  /** Absolute path to the file containing the diagnostic. */
  file: string;
  /** 1-based line number from the compiler output. */
  line: number;
  /** 1-based column number; 0 when not present in the output (e.g. MSVC no-column variant). */
  column: number;
  /** Human-readable diagnostic message (everything after the code). */
  message: string;
  /** Diagnostic severity level. */
  severity: 'error' | 'warning' | 'note';
  /** MSVC error code (e.g. "C2061"); empty string for Clang diagnostics. */
  code: string;
}

// MSVC format:  C:\path\File.cpp(42,7): error C2061: message
// MSVC variant: C:\path\File.cpp(10): warning C4668: message
const MSVC_RE = /^(.+?)\((\d+)(?:,(\d+))?\)\s*:\s*(error|warning|note)\s+(C\d+):\s*(.+)$/;

// Clang format: /home/user/File.cpp:15:3: error: message
const CLANG_RE = /^(.+?):(\d+):(\d+):\s*(error|warning|note):\s*(.+)$/;

/**
 * Parse raw lines from UBT stdout/stderr into structured BuildError objects.
 *
 * Lines that match neither the MSVC nor Clang diagnostic format are silently
 * discarded (blank lines, UBT progress messages, continuation lines, linker
 * summaries, etc.).
 *
 * @param lines - Raw text lines from UBT output.
 * @returns Array of matched BuildError objects, one per recognised diagnostic line.
 */
export function parseErrors(lines: string[]): BuildError[] {
  const results: BuildError[] = [];

  for (const line of lines) {
    // Try MSVC first -- parenthesis-based format avoids false matches on Windows
    // drive-letter colons (e.g. "C:\path").
    const msvc = MSVC_RE.exec(line);
    if (msvc !== null) {
      results.push({
        file: msvc[1]!,
        line: parseInt(msvc[2]!, 10),
        column: msvc[3] !== undefined ? parseInt(msvc[3], 10) : 0,
        severity: msvc[4] as BuildError['severity'],
        code: msvc[5]!,
        message: msvc[6]!,
      });
      continue;
    }

    // Try Clang format next.
    const clang = CLANG_RE.exec(line);
    if (clang !== null) {
      results.push({
        file: clang[1]!,
        line: parseInt(clang[2]!, 10),
        column: parseInt(clang[3]!, 10),
        severity: clang[4] as BuildError['severity'],
        code: '',
        message: clang[5]!,
      });
    }
    // Non-matching lines are silently discarded.
  }

  return results;
}
