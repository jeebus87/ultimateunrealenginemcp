// tests/error-parser.test.ts
// TDD test suite for parseErrors — RED phase.
// Implementation target: src/build/error-parser.ts
//
// Strategy: Pure unit tests — no file I/O. All inputs are raw compiler output lines.
// Tests cover MSVC format, Clang format, warnings, notes, and discarded non-diagnostic lines.

import { describe, it, expect } from 'vitest';
import { parseErrors } from '../src/build/error-parser.js';
import type { BuildError } from '../src/build/error-parser.js';

// ---------------------------------------------------------------------------
// Sample lines
// ---------------------------------------------------------------------------

const MSVC_ERROR_LINE = `C:\\path\\File.cpp(42,7): error C2061: syntax error: identifier 'UMyComponent'`;
const MSVC_NO_COLUMN_LINE = `C:\\path\\File.cpp(10): warning C4668: '_WIN32_WINNT' is not defined`;
const MSVC_WARNING_LINE = `C:\\path\\File.cpp(5,3): warning C4100: 'param': unreferenced formal parameter`;
const CLANG_ERROR_LINE = `/home/user/File.cpp:15:3: error: unknown type name 'UGameMode'`;
const CLANG_NOTE_LINE = `/home/user/File.h:5:10: note: previous declaration here`;
const UBT_PROGRESS_LINE = `Building 3 actions...`;
const UBT_COMPILING_LINE = `Compiling MyGame...`;
const BLANK_LINE = ``;
const CONTINUATION_LINE = `        ^`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('parseErrors', () => {

  describe('MSVC error with line and column', () => {
    it('parses file, line, column, severity, code, and message correctly', () => {
      const results = parseErrors([MSVC_ERROR_LINE]);
      expect(results).toHaveLength(1);
      const err = results[0]!;
      expect(err.file).toBe(`C:\\path\\File.cpp`);
      expect(err.line).toBe(42);
      expect(err.column).toBe(7);
      expect(err.severity).toBe('error');
      expect(err.code).toBe('C2061');
      expect(err.message).toBe("syntax error: identifier 'UMyComponent'");
    });
  });

  describe('MSVC error with line only (no column)', () => {
    it('parses correctly with column=0', () => {
      const results = parseErrors([MSVC_NO_COLUMN_LINE]);
      expect(results).toHaveLength(1);
      const err = results[0]!;
      expect(err.file).toBe(`C:\\path\\File.cpp`);
      expect(err.line).toBe(10);
      expect(err.column).toBe(0);
      expect(err.severity).toBe('warning');
      expect(err.code).toBe('C4668');
    });
  });

  describe('MSVC warning', () => {
    it('parses severity as warning and preserves code', () => {
      const results = parseErrors([MSVC_WARNING_LINE]);
      expect(results).toHaveLength(1);
      const err = results[0]!;
      expect(err.severity).toBe('warning');
      expect(err.code).toBe('C4100');
    });
  });

  describe('Clang error', () => {
    it('parses file, line, column, severity=error, code="" (empty)', () => {
      const results = parseErrors([CLANG_ERROR_LINE]);
      expect(results).toHaveLength(1);
      const err = results[0]!;
      expect(err.file).toBe('/home/user/File.cpp');
      expect(err.line).toBe(15);
      expect(err.column).toBe(3);
      expect(err.severity).toBe('error');
      expect(err.code).toBe('');
      expect(err.message).toBe("unknown type name 'UGameMode'");
    });
  });

  describe('Clang note', () => {
    it('parses severity as note', () => {
      const results = parseErrors([CLANG_NOTE_LINE]);
      expect(results).toHaveLength(1);
      const err = results[0]!;
      expect(err.severity).toBe('note');
      expect(err.file).toBe('/home/user/File.h');
      expect(err.line).toBe(5);
      expect(err.column).toBe(10);
    });
  });

  describe('UBT progress line is discarded', () => {
    it('returns [] for "Building 3 actions..."', () => {
      const results = parseErrors([UBT_PROGRESS_LINE]);
      expect(results).toEqual([]);
    });

    it('returns [] for "Compiling MyGame..."', () => {
      const results = parseErrors([UBT_COMPILING_LINE]);
      expect(results).toEqual([]);
    });
  });

  describe('Blank line is discarded', () => {
    it('returns [] for empty string', () => {
      const results = parseErrors([BLANK_LINE]);
      expect(results).toEqual([]);
    });
  });

  describe('Continuation whitespace line discarded', () => {
    it('returns [] for indented caret line', () => {
      const results = parseErrors([CONTINUATION_LINE]);
      expect(results).toEqual([]);
    });
  });

  describe('parseErrors([]) returns []', () => {
    it('returns empty array for empty input', () => {
      const results = parseErrors([]);
      expect(results).toEqual([]);
    });
  });

  describe('Mixed input array', () => {
    it('returns exactly 2 BuildErrors in order for [msvcLine, clangLine, "Building..."]', () => {
      const results = parseErrors([MSVC_ERROR_LINE, CLANG_ERROR_LINE, UBT_PROGRESS_LINE]);
      expect(results).toHaveLength(2);
      expect(results[0]!.severity).toBe('error');
      expect(results[0]!.code).toBe('C2061');
      expect(results[1]!.severity).toBe('error');
      expect(results[1]!.code).toBe('');
    });
  });

  describe('Windows path with drive letter parses correctly', () => {
    it('gives file="C:\\Src\\File.cpp" for MSVC line with drive letter', () => {
      const line = `C:\\Src\\File.cpp(5,1): error C2065: 'foo': undeclared identifier`;
      const results = parseErrors([line]);
      expect(results).toHaveLength(1);
      expect(results[0]!.file).toBe('C:\\Src\\File.cpp');
      expect(results[0]!.line).toBe(5);
      expect(results[0]!.column).toBe(1);
    });
  });

  describe('Multi-component Windows path', () => {
    it('parses file path with multiple directory segments correctly', () => {
      const line = `C:\\Users\\Dev\\Proj\\Source\\File.h(1): warning C4668: msg`;
      const results = parseErrors([line]);
      expect(results).toHaveLength(1);
      expect(results[0]!.file).toBe('C:\\Users\\Dev\\Proj\\Source\\File.h');
      expect(results[0]!.line).toBe(1);
      expect(results[0]!.column).toBe(0);
    });
  });

  describe('Clang absolute unix path', () => {
    it('gives correct file for deep unix path', () => {
      const line = `/opt/unreal/Source/Runtime/File.h:10:5: error: unknown type 'UObject'`;
      const results = parseErrors([line]);
      expect(results).toHaveLength(1);
      expect(results[0]!.file).toBe('/opt/unreal/Source/Runtime/File.h');
      expect(results[0]!.line).toBe(10);
      expect(results[0]!.column).toBe(5);
    });
  });

  describe('MSVC error code preserved exactly', () => {
    it('code is "C2065", not "C 2065" or "2065"', () => {
      const line = `C:\\path\\File.cpp(1,1): error C2065: 'x': undeclared identifier`;
      const results = parseErrors([line]);
      expect(results).toHaveLength(1);
      expect(results[0]!.code).toBe('C2065');
    });
  });

  describe('Non-standard MSVC linker errors', () => {
    it('gracefully handles LNK error lines without crashing', () => {
      // LNK errors have no standard column; test that parseErrors does not throw
      const line = `link.exe: error LNK2019: unresolved external symbol "..." referenced in function "..."`;
      let threw = false;
      let results: BuildError[] = [];
      try {
        results = parseErrors([line]);
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      // LNK lines don't match MSVC or Clang format — either 0 or 1 results, no crash
      expect(Array.isArray(results)).toBe(true);
    });
  });

});
