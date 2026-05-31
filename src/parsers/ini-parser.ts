// UE-aware INI parser — standalone pure string-processing module.
// No fs imports — all I/O is the caller's responsibility.
// No console.log — pure transform, no side effects.
//
// Handles all five UE INI operators:
//   plain =   scalar assignment; last occurrence wins
//   +         append if not already present (no duplicates)
//   .         append always (duplicates allowed)
//   -         remove exact match
//   !         clear all values for key (value after = is ignored)
//
// Values are always stored as string[] (scalars as single-element arrays).
// Section names and key names are case-sensitive per UE requirements.
// Indexed-array syntax (MyArray[0]=val) is stored with the bracket index
// as part of the literal key name — no special flattening.
// Struct/compound values (parens) are treated as opaque strings.
// Only lines where ; is the first non-whitespace char are treated as comments;
// mid-line semicolons are preserved verbatim in the value.

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A map from key name to the array of values accumulated for that key. */
export type IniSection = Record<string, string[]>;

/**
 * The result of parsing an INI file.
 * Maps section name → key → values.
 * All values are string[] — scalars are stored as single-element arrays.
 */
export type ParsedIni = Record<string, IniSection>;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const OPERATORS = new Set(['+', '-', '.', '!']);

/**
 * Strips the UE operator prefix (+ - . !) from a raw key token and
 * returns { operator, key }.
 * If the first character is not an operator, operator is '' (plain =).
 */
function splitOperator(rawKey: string): { operator: string; key: string } {
  const first = rawKey[0] ?? '';
  if (OPERATORS.has(first)) {
    return { operator: first, key: rawKey.slice(1) };
  }
  return { operator: '', key: rawKey };
}

// ---------------------------------------------------------------------------
// parseIni
// ---------------------------------------------------------------------------

/**
 * Parse a full INI file content string into a structured map.
 * Handles all five UE operators: plain =, +, -, ., !
 * Section names are case-sensitive (UE requirement).
 */
export function parseIni(content: string): ParsedIni {
  const result: ParsedIni = {};
  let currentSection = '';

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();

    // Skip blank lines
    if (!line) continue;

    // Skip comment lines (first non-whitespace char is ;)
    if (line.startsWith(';')) continue;

    // Section header: [SectionName]
    if (line.startsWith('[') && line.endsWith(']')) {
      currentSection = line.slice(1, -1);
      if (!result[currentSection]) {
        result[currentSection] = {};
      }
      continue;
    }

    // Key=Value line — must have an = sign
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue; // malformed line — skip silently

    const rawKey = line.slice(0, eqIdx).trim();
    // Preserve value verbatim after the = (no trimming — spaces and semicolons kept)
    const value = line.slice(eqIdx + 1);

    const { operator, key } = splitOperator(rawKey);

    // Ensure section exists (handles key lines before any section header)
    if (!result[currentSection]) {
      result[currentSection] = {};
    }
    const section = result[currentSection]!;

    switch (operator) {
      case '!':
        // Clear all accumulated values for this key
        section[key] = [];
        break;

      case '-':
        // Remove exact match from array
        section[key] = (section[key] ?? []).filter((v) => v !== value);
        break;

      case '+':
        // Append only if value not already present
        if (!(section[key] ?? []).includes(value)) {
          section[key] = [...(section[key] ?? []), value];
        }
        break;

      case '.':
        // Append unconditionally (duplicates allowed)
        section[key] = [...(section[key] ?? []), value];
        break;

      default:
        // Plain = : last occurrence wins — store as single-element array
        section[key] = [value];
        break;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// setIniValue
// ---------------------------------------------------------------------------

/**
 * Write/update a single key in a section (plain = operator).
 * Returns the new file content string — does not write to disk.
 *
 * Behaviour:
 * - If the key exists in the target section (with any operator prefix),
 *   replaces the FIRST matching line with "key=value" and drops all
 *   subsequent lines for that key.
 * - If the key is not found but the section exists, appends "key=value"
 *   at the end of the section block (before the next [Section] header).
 * - If the section does not exist at all, appends an empty line, the
 *   section header, and "key=value" at the end of the file.
 *
 * Output uses \n line endings regardless of input style.
 */
export function setIniValue(
  content: string,
  section: string,
  key: string,
  value: string,
): string {
  const lines = content.split(/\r?\n/);
  let inTargetSection = false;
  let sectionFound = false;
  let keyReplaced = false;
  const output: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Detect section headers
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      // Leaving a section — if we were in target section and haven't placed
      // the key yet, inject it before moving to the new section
      if (inTargetSection && !keyReplaced) {
        output.push(`${key}=${value}`);
        keyReplaced = true;
      }

      inTargetSection = trimmed.slice(1, -1) === section;
      if (inTargetSection) sectionFound = true;

      output.push(line);
      continue;
    }

    // Within target section: look for lines whose bare key matches
    if (inTargetSection && !keyReplaced) {
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx !== -1) {
        const rawKey = trimmed.slice(0, eqIdx).trim();
        const { key: bareKey } = splitOperator(rawKey);
        if (bareKey === key) {
          // Replace this line with the new key=value
          output.push(`${key}=${value}`);
          keyReplaced = true;
          continue; // drop the original line
        }
      }
    } else if (inTargetSection && keyReplaced) {
      // Key already replaced — drop any further lines for the same key
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx !== -1) {
        const rawKey = trimmed.slice(0, eqIdx).trim();
        const { key: bareKey } = splitOperator(rawKey);
        if (bareKey === key) {
          continue; // skip duplicate key lines
        }
      }
    }

    output.push(line);
  }

  // After loop: section was found but key never appeared — append at end
  if (inTargetSection && !keyReplaced) {
    output.push(`${key}=${value}`);
  }

  // Section was not in the file at all — append section + key at end
  if (!sectionFound) {
    output.push('', `[${section}]`, `${key}=${value}`);
  }

  return output.join('\n');
}

// ---------------------------------------------------------------------------
// writeIniRemoveKey
// ---------------------------------------------------------------------------

/**
 * Remove all lines for a key from a specified section (all operator prefixes).
 * Returns the new file content string — does not write to disk.
 *
 * - Removes lines whose bare key (operator prefix stripped) matches target key.
 * - No-op if section or key does not exist (returns content unchanged).
 * - Output uses \n line endings regardless of input style.
 */
export function writeIniRemoveKey(
  content: string,
  section: string,
  key: string,
): string {
  const lines = content.split(/\r?\n/);
  let inTargetSection = false;
  const output: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Detect section headers
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      inTargetSection = trimmed.slice(1, -1) === section;
      output.push(line);
      continue;
    }

    // Within target section: skip lines whose bare key matches
    if (inTargetSection) {
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx !== -1) {
        const rawKey = trimmed.slice(0, eqIdx).trim();
        const { key: bareKey } = splitOperator(rawKey);
        if (bareKey === key) {
          continue; // remove this line
        }
      }
    }

    output.push(line);
  }

  return output.join('\n');
}
