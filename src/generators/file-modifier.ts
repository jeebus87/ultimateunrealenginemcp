// src/generators/file-modifier.ts
// Pure in-memory string transformations for modifying existing UE C++ header files.
//
// GEN-05: addProperty — inserts UPROPERTY declaration after last existing UPROPERTY
// GEN-06: addFunction — inserts UFUNCTION declaration after last existing UFUNCTION
// GEN-07: addInclude  — inserts #include before .generated.h line (idempotent)
// GEN-08: all modifications validated via validateUhtRules before returning
//
// T-05-06 mitigation: all output passes through validateUhtRules (specifier/name integrity).
// T-05-08 mitigation: TDD suite covers insertion edge cases.
//
// Constraints:
//   - Pure functions — no fs, no async, no side effects
//   - Never throws — always returns ModifyResult
//   - console.error only (never console.log)

import { parseCppFile } from '../parsers/cpp-parser.js';
import { validateUhtRules } from './uht-validator.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ModifyResult =
  | { success: true; content: string }
  | { success: false; error: string };

export type PropertyDecl = {
  specifiers: string[];    // e.g., ["EditAnywhere", "BlueprintReadWrite", "Category=\"Stats\""]
  type: string;            // e.g., "float"
  name: string;            // e.g., "Health"
  defaultValue?: string;   // e.g., "100.0f"
};

export type FunctionDecl = {
  specifiers: string[];    // e.g., ["BlueprintCallable", "Category=\"Combat\""]
  returnType: string;      // e.g., "void"
  name: string;            // e.g., "Attack"
  params?: string;         // e.g., "float Damage" (raw param string, may be empty)
  isConst?: boolean;
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Inserts `toInsert` lines after the given 0-based line index.
 */
function insertLinesAt(lines: string[], afterLineIndex: number, toInsert: string[]): string[] {
  return [
    ...lines.slice(0, afterLineIndex + 1),
    ...toInsert,
    ...lines.slice(afterLineIndex + 1),
  ];
}

/**
 * Validates modified content with UHT rules and returns ModifyResult.
 */
function validateAndReturn(content: string): ModifyResult {
  const validation = validateUhtRules(content);
  if (!validation.valid) {
    return { success: false, error: validation.errors.join('; ') };
  }
  return { success: true, content };
}

/**
 * Find the 0-based line index of GENERATED_BODY() starting from startLine (0-based).
 * Returns -1 if not found within the search range.
 */
function findGeneratedBodyLine(lines: string[], startLine: number): number {
  for (let i = startLine; i < lines.length; i++) {
    const ln = lines[i] ?? '';
    if (ln.includes('GENERATED_BODY()')) {
      return i;
    }
    // Stop searching if we hit a class-ending brace at depth 0
    // (simple heuristic: if line is just '}' or '};' after the opening brace)
    if (i > startLine + 2 && (ln.trim() === '}' || ln.trim() === '};')) {
      break;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------

/**
 * Adds a UPROPERTY declaration to an existing class in the C++ header content.
 *
 * Algorithm:
 * 1. Parse content — error if parse fails.
 * 2. Find class by name — error if not found.
 * 3. If class has existing properties: insert after the last property's declaration line.
 *    If not: insert after GENERATED_BODY() line.
 * 4. Validate with validateUhtRules before returning.
 *
 * GEN-05, GEN-08
 */
export function addProperty(content: string, className: string, decl: PropertyDecl): ModifyResult {
  try {
    const parseResult = parseCppFile(content);
    if (!parseResult.success) {
      return { success: false, error: `Parse error: ${parseResult.error}` };
    }

    const cls = parseResult.data.classes.find((c) => c.name === className);
    if (!cls) {
      return { success: false, error: `Class '${className}' not found in file` };
    }

    const lines = content.split('\n');

    // Build the insertion block (tab-indented, UE style)
    const specStr = decl.specifiers.join(', ');
    const defaultSuffix = decl.defaultValue ? ` = ${decl.defaultValue}` : '';
    const insertBlock = [
      `\tUPROPERTY(${specStr})`,
      `\t${decl.type} ${decl.name}${defaultSuffix};`,
      `\t`,
    ];

    let insertAfterIndex: number;

    if (cls.properties.length > 0) {
      // Insert after the declaration line of the last property.
      // prop.line is 1-based line of the UPROPERTY macro.
      // Declaration is on the next line: prop.line + 1 (1-based) = prop.line (0-based).
      const lastProp = cls.properties[cls.properties.length - 1]!;
      // 0-based index of declaration line = lastProp.line (since macro is at lastProp.line - 1 in 0-based,
      // declaration is at lastProp.line in 0-based)
      insertAfterIndex = lastProp.line; // 0-based index of the property declaration line
    } else {
      // No properties — find GENERATED_BODY() and insert after it
      // cls.line is 1-based class declaration line, convert to 0-based
      const classLineIdx = cls.line - 1;
      const genBodyIdx = findGeneratedBodyLine(lines, classLineIdx);
      if (genBodyIdx < 0) {
        return { success: false, error: `GENERATED_BODY() not found in class '${className}'` };
      }
      insertAfterIndex = genBodyIdx;
    }

    const newLines = insertLinesAt(lines, insertAfterIndex, insertBlock);
    const newContent = newLines.join('\n');

    return validateAndReturn(newContent);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[file-modifier] addProperty error: ${msg}`);
    return { success: false, error: `Internal error: ${msg}` };
  }
}

/**
 * Adds a UFUNCTION declaration to an existing class in the C++ header content.
 *
 * Algorithm:
 * 1. Parse content — error if parse fails.
 * 2. Find class by name — error if not found.
 * 3. If class has existing functions: insert after the last function's declaration line.
 *    If not: insert after GENERATED_BODY() line.
 * 4. Validate with validateUhtRules before returning.
 *
 * GEN-06, GEN-08
 */
export function addFunction(content: string, className: string, decl: FunctionDecl): ModifyResult {
  try {
    const parseResult = parseCppFile(content);
    if (!parseResult.success) {
      return { success: false, error: `Parse error: ${parseResult.error}` };
    }

    const cls = parseResult.data.classes.find((c) => c.name === className);
    if (!cls) {
      return { success: false, error: `Class '${className}' not found in file` };
    }

    const lines = content.split('\n');

    // Build the insertion block (tab-indented, UE style)
    const specStr = decl.specifiers.join(', ');
    const paramStr = decl.params ?? '';
    const constSuffix = decl.isConst ? ' const' : '';
    const insertBlock = [
      `\tUFUNCTION(${specStr})`,
      `\t${decl.returnType} ${decl.name}(${paramStr})${constSuffix};`,
      `\t`,
    ];

    let insertAfterIndex: number;

    if (cls.functions.length > 0) {
      // Insert after the declaration line of the last function.
      // fn.line is 1-based line of the UFUNCTION macro.
      // Declaration is on the next line: fn.line + 1 (1-based) = fn.line (0-based).
      const lastFn = cls.functions[cls.functions.length - 1]!;
      insertAfterIndex = lastFn.line; // 0-based index of the function declaration line
    } else {
      // No functions — find GENERATED_BODY() and insert after it
      const classLineIdx = cls.line - 1;
      const genBodyIdx = findGeneratedBodyLine(lines, classLineIdx);
      if (genBodyIdx < 0) {
        return { success: false, error: `GENERATED_BODY() not found in class '${className}'` };
      }
      insertAfterIndex = genBodyIdx;
    }

    const newLines = insertLinesAt(lines, insertAfterIndex, insertBlock);
    const newContent = newLines.join('\n');

    return validateAndReturn(newContent);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[file-modifier] addFunction error: ${msg}`);
    return { success: false, error: `Internal error: ${msg}` };
  }
}

/**
 * Adds an #include directive to a C++ header file.
 *
 * Algorithm:
 * 1. Parse content — error if parse fails.
 * 2. Check for duplicate — if include already present, return unchanged content (idempotent).
 * 3. Find .generated.h line — if present, insert before it.
 *    Otherwise insert after last #include, or after #pragma once if no includes.
 * 4. Validate with validateUhtRules before returning.
 *
 * GEN-07, GEN-08
 */
export function addInclude(content: string, includePath: string): ModifyResult {
  try {
    const parseResult = parseCppFile(content);
    if (!parseResult.success) {
      return { success: false, error: `Parse error: ${parseResult.error}` };
    }

    const { includes } = parseResult.data;

    // Normalize the includePath for duplicate checking.
    // Strip surrounding quotes or angle brackets.
    const normalizedPath = includePath.replace(/^["<]/, '').replace(/[">]$/, '');

    // Check if already present (idempotent)
    const alreadyPresent = includes.some((inc) => {
      // Parser strips angle brackets for angle-bracket includes, adds '<>' prefix
      // For quoted includes, the parser stores just the path without quotes
      const normalizedInc = inc.startsWith('<') ? inc.slice(1, -1) : inc;
      return normalizedInc === normalizedPath;
    });

    if (alreadyPresent) {
      return { success: true, content };
    }

    // Determine the formatted include directive
    const isAngleBracket = includePath.startsWith('<') && includePath.endsWith('>');
    let directive: string;
    if (isAngleBracket) {
      directive = `#include ${includePath}`;
    } else {
      // If path already has quotes, use as-is; otherwise add quotes
      if (includePath.startsWith('"') && includePath.endsWith('"')) {
        directive = `#include ${includePath}`;
      } else {
        directive = `#include "${includePath}"`;
      }
    }

    const lines = content.split('\n');

    // Find the .generated.h line index (0-based)
    let generatedHLineIdx = -1;
    let lastIncludeLineIdx = -1;
    let pragmaOnceLineIdx = -1;

    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i] ?? '';
      const trimmed = ln.trim();

      if (trimmed.startsWith('#pragma once')) {
        pragmaOnceLineIdx = i;
      }

      if (trimmed.startsWith('#include')) {
        lastIncludeLineIdx = i;
        if (trimmed.includes('.generated.h')) {
          generatedHLineIdx = i;
        }
      }
    }

    let newLines: string[];

    if (generatedHLineIdx >= 0) {
      // Insert before the .generated.h line
      newLines = [
        ...lines.slice(0, generatedHLineIdx),
        directive,
        ...lines.slice(generatedHLineIdx),
      ];
    } else if (lastIncludeLineIdx >= 0) {
      // Insert after the last #include line
      newLines = insertLinesAt(lines, lastIncludeLineIdx, [directive]);
    } else if (pragmaOnceLineIdx >= 0) {
      // Insert after #pragma once
      newLines = insertLinesAt(lines, pragmaOnceLineIdx, [directive]);
    } else {
      // Insert at the beginning
      newLines = [directive, ...lines];
    }

    const newContent = newLines.join('\n');

    return validateAndReturn(newContent);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[file-modifier] addInclude error: ${msg}`);
    return { success: false, error: `Internal error: ${msg}` };
  }
}
