// tests/fix-suggester.test.ts
// TDD test suite for suggestFix — RED phase.
// Implementation target: src/build/fix-suggester.ts
//
// Strategy: Pure unit tests — no file I/O. All inputs are BuildError objects.
// Tests cover all four fix suggestion patterns and DocIndex integration.

import { describe, it, expect } from 'vitest';
import { suggestFix } from '../src/build/fix-suggester.js';
import type { BuildError } from '../src/build/error-parser.js';
import type { FixSuggestion } from '../src/build/fix-suggester.js';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeError(message: string, overrides?: Partial<BuildError>): BuildError {
  return {
    file: 'File.cpp',
    line: 1,
    column: 1,
    severity: 'error',
    code: 'C2065',
    message,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock DocIndex
// ---------------------------------------------------------------------------

function makeDocIndex(returnValue: string | null) {
  return {
    getIncludePath: (className: string) => returnValue,
    lookupClass: (_className: string) => [],
    search: (_query: string) => [],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('suggestFix', () => {

  describe('missing-include pattern — cannot open include file', () => {
    it('returns suggestion with pattern="missing-include"', () => {
      const error = makeError(`cannot open include file: 'AGameMode.h': No such file`);
      const results = suggestFix(error);
      const match = results.find(r => r.pattern === 'missing-include');
      expect(match).toBeDefined();
      expect(match!.suggestion.length).toBeGreaterThan(0);
    });
  });

  describe('missing-include pattern — No such file or directory', () => {
    it('triggers missing-include pattern for "No such file or directory" message', () => {
      const error = makeError(`fatal error: 'SomeHeader.h' file not found: No such file or directory`);
      const results = suggestFix(error);
      const match = results.find(r => r.pattern === 'missing-include');
      expect(match).toBeDefined();
    });
  });

  describe('missing-include pattern — file not found', () => {
    it('triggers missing-include for "file not found" message', () => {
      const error = makeError(`GameFramework/Character.h: file not found`);
      const results = suggestFix(error);
      const match = results.find(r => r.pattern === 'missing-include');
      expect(match).toBeDefined();
    });
  });

  describe('missing-include with DocIndex returning include path', () => {
    it('sets includeHint when docIndex.getIncludePath returns a value', () => {
      const error = makeError(`cannot open include file: 'AGameMode.h'`);
      const mockDocIndex = makeDocIndex('GameFramework/GameMode.h');
      const results = suggestFix(error, mockDocIndex as any);
      const match = results.find(r => r.pattern === 'missing-include');
      expect(match).toBeDefined();
      expect(match!.includeHint).toBe('GameFramework/GameMode.h');
    });
  });

  describe('missing-include with DocIndex returning null', () => {
    it('includeHint is absent or undefined when docIndex.getIncludePath returns null', () => {
      const error = makeError(`cannot open include file: 'UnknownFile.h'`);
      const mockDocIndex = makeDocIndex(null);
      const results = suggestFix(error, mockDocIndex as any);
      const match = results.find(r => r.pattern === 'missing-include');
      expect(match).toBeDefined();
      expect(match!.includeHint).toBeUndefined();
    });
  });

  describe('GENERATED_BODY pattern', () => {
    it('triggers pattern="generated-body-missing" for GENERATED_BODY message', () => {
      const error = makeError(`GENERATED_BODY() missing from class`);
      const results = suggestFix(error);
      const match = results.find(r => r.pattern === 'generated-body-missing');
      expect(match).toBeDefined();
      expect(match!.suggestion).toContain('GENERATED_BODY()');
    });
  });

  describe('undeclared-ue-type — AGameMode in message', () => {
    it('triggers pattern="undeclared-ue-type" for undeclared identifier with UE type', () => {
      const error = makeError(`undeclared identifier 'AGameMode'`);
      const results = suggestFix(error);
      const match = results.find(r => r.pattern === 'undeclared-ue-type');
      expect(match).toBeDefined();
      expect(match!.suggestion.length).toBeGreaterThan(0);
    });
  });

  describe('undeclared-ue-type — non-UE identifier ignored', () => {
    it('does NOT trigger undeclared-ue-type for "undeclared identifier \'foo\'"', () => {
      const error = makeError(`undeclared identifier 'foo'`);
      const results = suggestFix(error);
      const match = results.find(r => r.pattern === 'undeclared-ue-type');
      expect(match).toBeUndefined();
    });
  });

  describe('undeclared-ue-type with DocIndex', () => {
    it('populates includeHint when docIndex.getIncludePath returns a value', () => {
      const error = makeError(`unknown type name 'UStaticMeshComponent'`);
      const mockDocIndex = makeDocIndex('Components/StaticMeshComponent.h');
      const results = suggestFix(error, mockDocIndex as any);
      const match = results.find(r => r.pattern === 'undeclared-ue-type');
      expect(match).toBeDefined();
      expect(match!.includeHint).toBe('Components/StaticMeshComponent.h');
    });
  });

  describe('wrong-specifier UPROPERTY', () => {
    it('triggers pattern="wrong-specifier" for invalid specifier on UPROPERTY', () => {
      const error = makeError(`invalid specifier for UPROPERTY`);
      const results = suggestFix(error);
      const match = results.find(r => r.pattern === 'wrong-specifier');
      expect(match).toBeDefined();
      expect(match!.suggestion).toContain('UPROPERTY');
    });
  });

  describe('wrong-specifier UCLASS', () => {
    it('triggers pattern="wrong-specifier" for invalid specifier on UCLASS', () => {
      const error = makeError(`unknown specifier for UCLASS declaration`);
      const results = suggestFix(error);
      const match = results.find(r => r.pattern === 'wrong-specifier');
      expect(match).toBeDefined();
      expect(match!.suggestion).toContain('UCLASS');
    });
  });

  describe('no match', () => {
    it('returns [] for "memory access violation" message', () => {
      const error = makeError(`memory access violation at address 0x0`);
      const results = suggestFix(error);
      expect(results).toEqual([]);
    });
  });

  describe('suggestFix without docIndex', () => {
    it('missing-include works without docIndex — no includeHint', () => {
      const error = makeError(`cannot open include file: 'ACharacter.h'`);
      const results = suggestFix(error);
      const match = results.find(r => r.pattern === 'missing-include');
      expect(match).toBeDefined();
      expect(match!.includeHint).toBeUndefined();
    });

    it('undeclared-ue-type works without docIndex — no includeHint', () => {
      const error = makeError(`undeclared identifier 'APlayerController'`);
      const results = suggestFix(error);
      const match = results.find(r => r.pattern === 'undeclared-ue-type');
      expect(match).toBeDefined();
      expect(match!.includeHint).toBeUndefined();
    });
  });

});
