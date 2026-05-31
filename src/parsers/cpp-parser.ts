// src/parsers/cpp-parser.ts
// Purpose-built TypeScript regex parser for UE C++ macro grammar.
//
// Parses a small, well-defined subset of C++ that UHT (Unreal Header Tool) emits:
//   - UCLASS / UPROPERTY / UFUNCTION macros with specifiers and meta=(...)
//   - Inheritance declarations: class AMyActor : public AActor
//   - #include directives (both quoted and angled)
//
// This is NOT a general C++ parser — it targets UE macro patterns only.
// Design rules (Phase 4 context):
//   - Pure string processing — no fs imports, no eval, never throws
//   - Returns discriminated union ParseResult<T>
//   - All output goes to console.error (never console.log)
//   - T-04-02 mitigation: balanced-paren collector capped at 500 lines

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ParseResult<T> =
  | { success: true; data: T }
  | { success: false; error: string };

export type UPropertyDecl = {
  name: string;
  type: string;
  specifiers: string[];
  meta: Record<string, string>;
  line: number;
};

export type UFunctionDecl = {
  name: string;
  returnType: string;
  specifiers: string[];
  meta: Record<string, string>;
  line: number;
};

export type UClassDecl = {
  name: string;
  parentClass: string;
  specifiers: string[];
  meta: Record<string, string>;
  properties: UPropertyDecl[];
  functions: UFunctionDecl[];
  line: number;
};

export type ParsedCppFile = {
  classes: UClassDecl[];
  includes: string[];
  rawContent: string;
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const INCLUDE_RE = /^\s*#include\s+["<]([^">]+)[">]/;
const MACRO_START_RE = /^\s*(UCLASS|UPROPERTY|UFUNCTION)\s*\(/;

/**
 * Collects a balanced-parenthesis macro argument string starting from the
 * opening paren found at `startLine`. The `lines` array must have the opening
 * paren on lines[startLine]. Returns the inner content (excluding outer parens)
 * and the index of the line containing the matching closing paren.
 *
 * T-04-02: Capped at 500 lines to prevent runaway loops on pathological input.
 */
function collectMacroArgs(
  lines: string[],
  startLine: number
): { args: string; endLine: number } {
  let depth = 0;
  let collecting = false;
  const parts: string[] = [];
  const MAX_LINES = 500;

  for (let i = startLine; i < lines.length && i - startLine <= MAX_LINES; i++) {
    const line = lines[i]!;
    for (let j = 0; j < line.length; j++) {
      const ch = line[j]!;
      if (ch === '(' ) {
        depth++;
        collecting = true;
      } else if (ch === ')') {
        depth--;
        if (depth === 0 && collecting) {
          // Capture everything collected so far as the full arg string
          parts.push(line.slice(0, j));
          // Remove the opening paren from the first segment
          const joined = parts.join('\n');
          // Strip everything up to and including the first '('
          const openIdx = joined.indexOf('(');
          const inner = openIdx >= 0 ? joined.slice(openIdx + 1) : joined;
          return { args: inner.trim(), endLine: i };
        }
      }
    }
    if (collecting) {
      parts.push(line);
    }
  }

  // Unclosed paren or exceeded 500 lines — return what we have
  const joined = parts.join('\n');
  const openIdx = joined.indexOf('(');
  const inner = openIdx >= 0 ? joined.slice(openIdx + 1) : joined;
  return { args: inner.trim(), endLine: Math.min(startLine + MAX_LINES, lines.length - 1) };
}

/**
 * Parses a meta=(...) block from specifier text.
 * Example: 'meta=(ClampMin="0", ClampMax="100")' → { ClampMin: "0", ClampMax: "100" }
 */
function parseMeta(metaBlock: string): Record<string, string> {
  const result: Record<string, string> = {};
  // metaBlock is the content inside the outer parens, e.g. 'ClampMin="0", ClampMax="100"'
  const inner = metaBlock.replace(/^\s*meta\s*=\s*\(/, '').replace(/\)\s*$/, '').trim();
  if (!inner) return result;

  // Split on commas that are not inside nested parens or quotes
  const pairs = splitTopLevel(inner, ',');
  for (const pair of pairs) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx < 0) continue;
    const key = pair.slice(0, eqIdx).trim();
    const val = pair.slice(eqIdx + 1).trim().replace(/^"(.*)"$/, '$1');
    if (key) result[key] = val;
  }
  return result;
}

/**
 * Splits a string on a delimiter, but only at the top level
 * (not inside nested parentheses or double-quoted strings).
 */
function splitTopLevel(text: string, delimiter: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString = false;
  let current = '';

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"' && text[i - 1] !== '\\') {
      inString = !inString;
      current += ch;
    } else if (!inString && ch === '(') {
      depth++;
      current += ch;
    } else if (!inString && ch === ')') {
      depth--;
      current += ch;
    } else if (!inString && depth === 0 && text.slice(i, i + delimiter.length) === delimiter) {
      parts.push(current.trim());
      current = '';
      i += delimiter.length - 1;
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/**
 * Parses the args string from inside a UCLASS/UPROPERTY/UFUNCTION macro.
 * Returns { specifiers, meta }.
 * meta=(...) is extracted and NOT included in specifiers.
 */
function parseSpecifiersAndMeta(args: string): { specifiers: string[]; meta: Record<string, string> } {
  if (!args.trim()) return { specifiers: [], meta: {} };

  const topLevel = splitTopLevel(args, ',');
  const specifiers: string[] = [];
  let meta: Record<string, string> = {};

  for (const item of topLevel) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (/^meta\s*=\s*\(/.test(trimmed)) {
      meta = parseMeta(trimmed);
    } else {
      specifiers.push(trimmed);
    }
  }

  return { specifiers, meta };
}

/**
 * Finds the next non-blank line index after `fromLine`.
 * Returns -1 if none found.
 */
function nextNonBlankLine(lines: string[], fromLine: number): number {
  for (let i = fromLine + 1; i < lines.length; i++) {
    if (lines[i]!.trim().length > 0) return i;
  }
  return -1;
}

/**
 * Parses a property declaration line like:
 *   "float Health;"
 *   "AActor* TargetActor;"
 *   "TArray<FHitResult> HitResults;"
 * Returns { type, name } or null if unparseable.
 */
function parsePropertyDecl(declLine: string): { type: string; name: string } | null {
  const trimmed = declLine.trim();
  // Remove trailing semicolons, UPROPERTY that might bleed in, etc.
  const cleaned = trimmed.replace(/;.*$/, '').trim();
  if (!cleaned) return null;

  // Handle template types: TArray<FHitResult> HitResults
  // Strategy: find the last space-separated token as name, everything before as type
  // But we must handle TArray<A, B> with inner commas
  // Walk backwards through space-separated tokens respecting angle brackets

  // Find last word boundary at depth 0 (not inside <> or ())
  let depth = 0;
  let nameStart = -1;
  for (let i = cleaned.length - 1; i >= 0; i--) {
    const ch = cleaned[i]!;
    if (ch === '>' || ch === ')') depth++;
    else if (ch === '<' || ch === '(') depth--;
    else if (depth === 0 && ch === ' ') {
      nameStart = i + 1;
      break;
    }
  }

  if (nameStart < 0) return null;

  const name = cleaned.slice(nameStart).trim();
  const type = cleaned.slice(0, nameStart).trim();

  if (!name || !type) return null;
  // Validate name is an identifier (word chars only)
  if (!/^\w+$/.test(name)) return null;

  return { type, name };
}

/**
 * Parses a function declaration line like:
 *   "void Attack();"
 *   "void ServerFire(float Damage);"
 *   "FMyStruct GetStuff();"
 * Returns { returnType, name } or null if unparseable.
 */
function parseFunctionDecl(declLine: string): { returnType: string; name: string } | null {
  const trimmed = declLine.trim();
  // Match: returnType functionName(...)
  // The function name is the last word before '('
  const funcMatch = trimmed.match(/^(.*?)\s+(\w+)\s*\(/);
  if (!funcMatch) return null;

  const returnType = funcMatch[1]!.trim();
  const name = funcMatch[2]!.trim();

  if (!returnType || !name) return null;
  return { returnType, name };
}

// ---------------------------------------------------------------------------
// Main parse function
// ---------------------------------------------------------------------------

/**
 * Parses the content of a UE C++ header file.
 *
 * Returns ParseResult<ParsedCppFile> — never throws.
 * T-04-01: Pure string processing, no eval/exec.
 */
export function parseCppFile(content: string): ParseResult<ParsedCppFile> {
  try {
    // Guard against null/undefined input
    if (content === null || content === undefined) {
      return { success: true, data: { classes: [], includes: [], rawContent: '' } };
    }
    const rawContent = String(content);
    if (!rawContent.trim()) {
      return { success: true, data: { classes: [], includes: [], rawContent } };
    }

    const lines = rawContent.split('\n');
    const includes: string[] = [];
    // We'll accumulate classes as we go
    // Active class context: null when not inside a UCLASS block
    type ClassContext = {
      decl: UClassDecl;
      braceDepth: number;
      started: boolean; // true once we see the opening brace
    };

    let classes: UClassDecl[] = [];
    let activeClass: ClassContext | null = null;
    // pendingMacro: set when we see UCLASS/UPROPERTY/UFUNCTION, cleared when declaration is found
    type PendingMacro = {
      kind: 'UCLASS' | 'UPROPERTY' | 'UFUNCTION';
      specifiers: string[];
      meta: Record<string, string>;
      line: number; // 1-based line of the macro
    };
    let pendingMacro: PendingMacro | null = null;

    let i = 0;
    while (i < lines.length) {
      const line = lines[i]!;
      const lineNum = i + 1; // 1-based

      // ---- #include extraction ----
      const includeMatch = line.match(INCLUDE_RE);
      if (includeMatch) {
        let path = includeMatch[1]!;
        // For angle-bracket includes, the regex captures inside the brackets.
        // Re-check if it was angled: look at the original line
        if (line.trim().startsWith('#include <')) {
          path = '<' + path + '>';
        }
        includes.push(path);
        i++;
        continue;
      }

      // ---- UCLASS / UPROPERTY / UFUNCTION detection ----
      const macroMatch = line.match(MACRO_START_RE);
      if (macroMatch) {
        const macroKind = macroMatch[1] as 'UCLASS' | 'UPROPERTY' | 'UFUNCTION';
        const { args, endLine } = collectMacroArgs(lines, i);
        const { specifiers, meta } = parseSpecifiersAndMeta(args);

        pendingMacro = { kind: macroKind, specifiers, meta, line: lineNum };
        i = endLine + 1;
        continue;
      }

      // ---- Resolve pending UCLASS: look for class declaration ----
      if (pendingMacro?.kind === 'UCLASS') {
        // Look for: class NAME : public PARENT or class NAME
        const classMatch = line.match(/\bclass\s+(?:\w+\s+)?(\w+)\s*(?::\s*public\s+(\w+))?/);
        if (classMatch && !line.trim().startsWith('//')) {
          const className = classMatch[1]!;
          const parentClass = classMatch[2] ?? '';

          const newClass: UClassDecl = {
            name: className,
            parentClass,
            specifiers: pendingMacro.specifiers,
            meta: pendingMacro.meta,
            properties: [],
            functions: [],
            line: lineNum,
          };

          // Push previous class if still open
          if (activeClass) {
            classes.push(activeClass.decl);
          }
          activeClass = { decl: newClass, braceDepth: 0, started: false };
          pendingMacro = null;
          i++;
          continue;
        }
      }

      // ---- Track brace depth to know when we're inside a class body ----
      if (activeClass) {
        for (const ch of line) {
          if (ch === '{') {
            activeClass.braceDepth++;
            activeClass.started = true;
          } else if (ch === '}') {
            activeClass.braceDepth--;
            if (activeClass.started && activeClass.braceDepth <= 0) {
              // Class body closed
              classes.push(activeClass.decl);
              activeClass = null;
              break;
            }
          }
        }
      }

      // ---- Resolve pending UPROPERTY / UFUNCTION ----
      if (pendingMacro?.kind === 'UPROPERTY' || pendingMacro?.kind === 'UFUNCTION') {
        const trimmed = line.trim();
        // Skip blank lines, GENERATED_BODY(), braces
        if (
          trimmed.length === 0 ||
          trimmed.startsWith('GENERATED_BODY') ||
          trimmed === '{' ||
          trimmed === '}'
        ) {
          i++;
          continue;
        }

        if (pendingMacro.kind === 'UPROPERTY') {
          const parsed = parsePropertyDecl(line);
          if (parsed && activeClass) {
            activeClass.decl.properties.push({
              name: parsed.name,
              type: parsed.type,
              specifiers: pendingMacro.specifiers,
              meta: pendingMacro.meta,
              line: pendingMacro.line,
            });
          }
          pendingMacro = null;
        } else if (pendingMacro.kind === 'UFUNCTION') {
          const parsed = parseFunctionDecl(line);
          if (parsed && activeClass) {
            activeClass.decl.functions.push({
              name: parsed.name,
              returnType: parsed.returnType,
              specifiers: pendingMacro.specifiers,
              meta: pendingMacro.meta,
              line: pendingMacro.line,
            });
          }
          pendingMacro = null;
        }
      }

      i++;
    }

    // Flush any still-open class
    if (activeClass) {
      classes.push(activeClass.decl);
    }

    return {
      success: true,
      data: { classes, includes, rawContent },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Parser internal error: ${msg}` };
  }
}
