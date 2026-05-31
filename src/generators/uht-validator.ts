// src/generators/uht-validator.ts
// Pure UHT pre-validation for generated or modified C++ header content.
// GEN-08: validates content against UHT rules before any disk write.
//
// Rules enforced:
//   1. GENERATED_BODY() present in every UCLASS body
//   2. ClassName.generated.h must be the last #include
//   3. No duplicate UPROPERTY names within a class
//   4. No duplicate UFUNCTION names within a class
//   5. UPROPERTY specifiers must be from the known allowlist (bare word specifiers only)
//
// Never throws — always returns UhtValidationResult.
// Pure function — no fs, no async, no side effects.
//
// T-05-01 mitigation: parseCppFile already caps balanced-paren search at 500 lines.
// The line-scan in this module is O(n) with no backtracking — safe for large input.

import { parseCppFile } from '../parsers/cpp-parser.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type UhtValidationResult = {
  valid: boolean;
  errors: string[];
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Known valid bare-word UPROPERTY specifiers.
 * Compound specifiers (containing '=' or '(') are always allowed and not checked here.
 */
const VALID_UPROPERTY_SPECIFIERS = new Set([
  'EditAnywhere',
  'EditDefaultsOnly',
  'EditInstanceOnly',
  'VisibleAnywhere',
  'VisibleDefaultsOnly',
  'VisibleInstanceOnly',
  'BlueprintReadWrite',
  'BlueprintReadOnly',
  'BlueprintGetter',
  'BlueprintSetter',
  'Category',
  'DisplayName',
  'AdvancedDisplay',
  'SaveGame',
  'Transient',
  'Replicated',
  'ReplicatedUsing',
  'NotReplicated',
  'Config',
  'GlobalConfig',
  'Localized',
  'Export',
  'NoClear',
  'EditFixedSize',
  'meta',
  'AllowPrivateAccess',
]);

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Validates generated or modified C++ header content against UHT rules.
 *
 * @param content - Raw C++ header file content as a string
 * @returns UhtValidationResult with valid flag and collected errors
 *
 * Never throws. Returns { valid: true, errors: [] } for empty or no-UCLASS content.
 */
export function validateUhtRules(content: string): UhtValidationResult {
  const errors: string[] = [];

  try {
    // Guard: null/undefined or whitespace-only input is considered valid (nothing to check)
    if (!content || typeof content !== 'string' || !content.trim()) {
      return { valid: true, errors: [] };
    }

    const parseResult = parseCppFile(content);
    if (!parseResult.success) {
      return {
        valid: false,
        errors: [`UHT validator: failed to parse C++ content: ${parseResult.error}`],
      };
    }

    const { classes, includes } = parseResult.data;

    // No UCLASS declarations found — nothing to validate
    if (classes.length === 0) {
      return { valid: true, errors: [] };
    }

    // -------------------------------------------------------------------------
    // Rule 2: generated.h must be the LAST include
    // -------------------------------------------------------------------------
    // Find the last include that ends with '.generated.h'
    const generatedIdx = includes.findIndex((inc) => inc.endsWith('.generated.h'));
    if (generatedIdx >= 0 && generatedIdx !== includes.length - 1) {
      errors.push(
        `${includes[generatedIdx]} must be the last #include in the file (UHT requirement)`
      );
    }

    // -------------------------------------------------------------------------
    // Per-class rules
    // -------------------------------------------------------------------------
    const lines = content.split('\n');

    for (const cls of classes) {
      const className = cls.name;

      // -----------------------------------------------------------------------
      // Rule 1: GENERATED_BODY() must appear in the class body
      // Search from the class declaration line forward, stopping when the
      // top-level class brace closes.
      // cls.line is 1-based; convert to 0-based index.
      // -----------------------------------------------------------------------
      const classStartLine = cls.line - 1; // 0-based
      let foundGenBody = false;
      let braceDepth = 0;
      let inBody = false;
      let bodyDone = false;

      for (let i = classStartLine; i < lines.length && !bodyDone; i++) {
        const ln = lines[i] ?? '';

        // Check for GENERATED_BODY() on this line before brace accounting
        if (ln.includes('GENERATED_BODY()')) {
          foundGenBody = true;
        }

        // Track brace depth to find the end of the class body
        for (const ch of ln) {
          if (ch === '{') {
            braceDepth++;
            inBody = true;
          } else if (ch === '}') {
            braceDepth--;
            if (inBody && braceDepth <= 0) {
              bodyDone = true;
              break;
            }
          }
        }
      }

      if (!foundGenBody) {
        errors.push(
          `Class ${className}: GENERATED_BODY() macro is missing from class body`
        );
      }

      // -----------------------------------------------------------------------
      // Rule 3: No duplicate UPROPERTY names within a class
      // -----------------------------------------------------------------------
      const seenPropNames = new Set<string>();
      for (const prop of cls.properties) {
        if (seenPropNames.has(prop.name)) {
          errors.push(
            `Class ${className}: duplicate UPROPERTY name '${prop.name}'`
          );
        } else {
          seenPropNames.add(prop.name);
        }
      }

      // -----------------------------------------------------------------------
      // Rule 4: No duplicate UFUNCTION names within a class
      // -----------------------------------------------------------------------
      const seenFnNames = new Set<string>();
      for (const fn of cls.functions) {
        if (seenFnNames.has(fn.name)) {
          errors.push(
            `Class ${className}: duplicate UFUNCTION name '${fn.name}'`
          );
        } else {
          seenFnNames.add(fn.name);
        }
      }

      // -----------------------------------------------------------------------
      // Rule 5: UPROPERTY specifier allowlist (bare-word specifiers only)
      // Compound specifiers (containing '=' or '(') are always allowed.
      // -----------------------------------------------------------------------
      for (const prop of cls.properties) {
        for (const spec of prop.specifiers) {
          // Skip compound specifiers — they contain '=' or '(' and are valid by convention
          if (spec.includes('=') || spec.includes('(')) continue;
          if (!VALID_UPROPERTY_SPECIFIERS.has(spec)) {
            errors.push(
              `Class ${className}, property ${prop.name}: unknown UPROPERTY specifier '${spec}'`
            );
          }
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { valid: false, errors: [`UHT validator internal error: ${msg}`] };
  }

  return { valid: errors.length === 0, errors };
}
