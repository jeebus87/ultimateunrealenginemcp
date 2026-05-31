// src/build/fix-suggester.ts
// Pure-logic module for mapping structured BuildErrors to actionable fix suggestions.
// No I/O, no logging, no side effects.

import type { DocIndex } from '../docs/doc-index.js';
import type { BuildError } from './error-parser.js';

/**
 * An actionable fix suggestion for a compiler diagnostic.
 */
export interface FixSuggestion {
  /** Short identifier for the matched pattern (e.g. "missing-include"). */
  pattern: string;
  /** Human-readable, actionable fix description. */
  suggestion: string;
  /** Include path from DocIndex when relevant (e.g. "GameFramework/GameMode.h"). */
  includeHint?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extract the first UE-style type name from a compiler message.
 * UE types start with one of A, U, F, E, I followed by an uppercase letter.
 */
function extractUeType(msg: string): string | null {
  return /\b([AUFEI][A-Z]\w+)/.exec(msg)?.[1] ?? null;
}

// Pattern regexes compiled once at module load.
const RE_MISSING_INCLUDE = /cannot open include file|No such file or directory|file not found/i;
const RE_GENERATED_BODY = /GENERATED_BODY/i;
const RE_UNDECLARED = /undeclared identifier|unknown type name|use of undeclared|identifier not found/i;
const RE_SPECIFIER = /specifier/i;
const RE_UE_MACRO = /UPROPERTY|UFUNCTION|UCLASS/i;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return all FixSuggestion objects that match the given BuildError.
 *
 * Multiple patterns may match a single error -- all matching suggestions are
 * returned. Returns [] when no pattern matches.
 *
 * @param error    - The structured compiler diagnostic.
 * @param docIndex - Optional DocIndex for include-path hints.
 */
export function suggestFix(error: BuildError, docIndex?: DocIndex): FixSuggestion[] {
  const results: FixSuggestion[] = [];
  const msg = error.message;

  // Pattern 1: missing-include
  if (RE_MISSING_INCLUDE.test(msg)) {
    const hint: FixSuggestion = {
      pattern: 'missing-include',
      suggestion:
        'Add the required #include. Use ue_get_include_path to find the correct header for the missing file.',
    };
    if (docIndex !== undefined) {
      const ueType = extractUeType(msg);
      if (ueType !== null) {
        const path = docIndex.getIncludePath(ueType);
        if (path !== null) {
          hint.includeHint = path;
        }
      }
    }
    results.push(hint);
  }

  // Pattern 2: generated-body-missing
  if (RE_GENERATED_BODY.test(msg)) {
    results.push({
      pattern: 'generated-body-missing',
      suggestion:
        'Add GENERATED_BODY() as the first declaration inside the UCLASS body, immediately after the opening brace.',
    });
  }

  // Pattern 3: undeclared-ue-type
  if (RE_UNDECLARED.test(msg)) {
    const ueType = extractUeType(msg);
    if (ueType !== null) {
      const hint: FixSuggestion = {
        pattern: 'undeclared-ue-type',
        suggestion:
          'Add the #include for the missing UE type. Use ue_get_include_path to find the correct header.',
      };
      if (docIndex !== undefined) {
        const path = docIndex.getIncludePath(ueType);
        if (path !== null) {
          hint.includeHint = path;
        }
      }
      results.push(hint);
    }
  }

  // Pattern 4: wrong-specifier
  if (RE_SPECIFIER.test(msg) && RE_UE_MACRO.test(msg)) {
    results.push({
      pattern: 'wrong-specifier',
      suggestion:
        'Check the specifier spelling. Valid UCLASS specifiers: BlueprintType, Blueprintable, Abstract. Valid UPROPERTY specifiers: EditAnywhere, VisibleAnywhere, BlueprintReadWrite, BlueprintReadOnly, Category.',
    });
  }

  return results;
}
