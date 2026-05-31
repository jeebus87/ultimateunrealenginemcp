// src/parsers/cpp-class-index.ts
// Project-wide class scanner and query engine for UE C++ headers.
//
// Scans Source/**/*.h files, parses each with cpp-parser.ts, and provides:
//   - buildIndex(projectRoot): scans disk with mtime caching
//   - buildIndexFromMap(files): in-memory variant for testing (no fs I/O)
//   - CppClassIndex: query methods (getClassHierarchy, getIncludes, findClassFile)
//   - clearIndexCache(): reset mtime cache between test runs
//
// Design rules (Phase 4 / CONTEXT.md):
//   - No console.log — all log output via console.error only
//   - T-04-04 mitigated: cycle detection via visited Set in getClassHierarchy
//   - T-04-05: mtime caching keeps repeated calls O(1) per unchanged file
//   - buildIndex() returns IndexBuildResult discriminated union — never throws

import * as fs from 'fs';
import * as path from 'path';
import { parseCppFile } from './cpp-parser.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ClassIndexEntry = {
  className: string;
  headerPath: string;
  sourcePath: string | null;
  parentClass: string;
  includes: string[];
  specifiers: string[];
};

export type CppClassIndex = {
  entries: Map<string, ClassIndexEntry>;
  getClassHierarchy(className: string): string[];
  getIncludes(className: string): string[];
  findClassFile(className: string): { header: string; source: string | null } | null;
};

export type IndexBuildResult =
  | { success: true; index: CppClassIndex; fileCount: number; errorCount: number }
  | { success: false; error: string };

// ---------------------------------------------------------------------------
// Module-level mtime cache (singleton per process)
// ---------------------------------------------------------------------------

type CacheEntry = {
  mtime: number;
  entries: ClassIndexEntry[];
};

const mtimeCache = new Map<string, CacheEntry>();

/**
 * Clears the mtime cache. Used in tests to ensure isolation between runs.
 */
export function clearIndexCache(): void {
  mtimeCache.clear();
}

// ---------------------------------------------------------------------------
// Internal: build CppClassIndex from a Map<className, ClassIndexEntry>
// ---------------------------------------------------------------------------

function makeCppClassIndex(entries: Map<string, ClassIndexEntry>): CppClassIndex {
  return {
    entries,

    /**
     * Returns the inheritance chain starting from className.
     * Stops when parent is not in index or a cycle is detected.
     * T-04-04: visited Set prevents infinite loop on circular inheritance.
     *
     * Rule: always add the starting class. For subsequent parents, only add
     * them if they exist in the index (stop without adding unknown parents).
     * Exception for cycle detection: if a class appears in visited, stop
     * without adding it again.
     */
    getClassHierarchy(className: string): string[] {
      const chain: string[] = [];
      const visited = new Set<string>();

      // Always add the starting class regardless of whether it's in the index
      chain.push(className);
      visited.add(className);

      // Look up the entry for the starting class
      let entry = entries.get(className);
      if (!entry || !entry.parentClass) {
        return chain;
      }

      let current = entry.parentClass;

      while (true) {
        if (visited.has(current)) {
          // Cycle detected — stop WITHOUT adding the duplicate
          break;
        }

        const currentEntry = entries.get(current);
        if (!currentEntry) {
          // Parent not in index — stop WITHOUT adding it to chain
          break;
        }

        // Parent is in index — add it and continue traversal
        chain.push(current);
        visited.add(current);

        if (!currentEntry.parentClass) {
          // No further parent — chain ends here
          break;
        }
        current = currentEntry.parentClass;
      }

      return chain;
    },

    /**
     * Returns the #include list for the entry's header.
     * Returns [] if className is not in the index.
     */
    getIncludes(className: string): string[] {
      const entry = entries.get(className);
      return entry ? entry.includes : [];
    },

    /**
     * Returns header and source paths for a class.
     * Returns null if className is not in the index.
     */
    findClassFile(className: string): { header: string; source: string | null } | null {
      const entry = entries.get(className);
      if (!entry) return null;
      return { header: entry.headerPath, source: entry.sourcePath };
    },
  };
}

// ---------------------------------------------------------------------------
// Internal: parse a single header content and produce ClassIndexEntry[]
// ---------------------------------------------------------------------------

function buildEntriesFromContent(
  headerPath: string,
  content: string,
  sourcePath: (className: string) => string | null
): { entries: ClassIndexEntry[]; errorCount: number } {
  const parseResult = parseCppFile(content);
  if (!parseResult.success) {
    return { entries: [], errorCount: 1 };
  }

  const { classes, includes } = parseResult.data;
  const entries: ClassIndexEntry[] = classes.map((cls) => ({
    className: cls.name,
    headerPath,
    sourcePath: sourcePath(cls.name),
    parentClass: cls.parentClass,
    includes,
    specifiers: cls.specifiers,
  }));

  return { entries, errorCount: 0 };
}

// ---------------------------------------------------------------------------
// buildIndexFromMap — in-memory test variant (no fs I/O)
// ---------------------------------------------------------------------------

/**
 * Builds a CppClassIndex from an in-memory map of { absoluteFilePath: fileContent }.
 * Does NOT touch the filesystem — intended for testing.
 * No mtime caching in this variant (always parses fresh).
 */
export async function buildIndexFromMap(
  files: Record<string, string>
): Promise<IndexBuildResult> {
  const allEntries = new Map<string, ClassIndexEntry>();
  let fileCount = 0;
  let errorCount = 0;

  for (const [filePath, content] of Object.entries(files)) {
    fileCount++;
    // Derive the directory for potential .cpp companion lookup
    const dir = path.dirname(filePath);

    const { entries, errorCount: fileErrors } = buildEntriesFromContent(
      filePath,
      content,
      (className) => {
        // In-memory: check if a .cpp file exists in the provided map
        const candidateCpp = path.join(dir, `${className}.cpp`);
        return files[candidateCpp] !== undefined ? candidateCpp : null;
      }
    );

    errorCount += fileErrors;
    for (const entry of entries) {
      allEntries.set(entry.className, entry);
    }
  }

  return {
    success: true,
    index: makeCppClassIndex(allEntries),
    fileCount,
    errorCount,
  };
}

// ---------------------------------------------------------------------------
// buildIndex — real filesystem variant with mtime caching
// ---------------------------------------------------------------------------

/**
 * Scans {projectRoot}/Source/**\/*.h, parses each header, and builds an index.
 *
 * Returns IndexBuildResult — never throws.
 * - success=true even if individual headers fail (errorCount tracks failures)
 * - success=false only if the Source/ directory itself cannot be read
 *
 * Mtime caching: parsed results are cached per absolute path. Re-scanning an
 * unchanged file (same mtime) reuses cached entries without re-parsing.
 */
export async function buildIndex(projectRoot: string): Promise<IndexBuildResult> {
  const sourceDir = path.join(projectRoot, 'Source');

  let files: string[];
  try {
    const allEntries = await fs.promises.readdir(sourceDir, { recursive: true });
    files = allEntries
      .filter((f): f is string => typeof f === 'string' && f.endsWith('.h'))
      .map((f) => path.join(sourceDir, f));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Cannot read Source/ directory: ${msg}` };
  }

  const allEntries = new Map<string, ClassIndexEntry>();
  let fileCount = 0;
  let errorCount = 0;

  for (const headerPath of files) {
    fileCount++;

    // Stat for mtime caching
    let mtime: number;
    try {
      const stat = await fs.promises.stat(headerPath);
      mtime = stat.mtimeMs;
    } catch {
      // Cannot stat — skip with error
      errorCount++;
      continue;
    }

    const cached = mtimeCache.get(headerPath);
    let entries: ClassIndexEntry[];

    if (cached && cached.mtime === mtime) {
      // Cache hit — reuse without re-parsing
      entries = cached.entries;
    } else {
      // Cache miss — read and parse
      let content: string;
      try {
        content = await fs.promises.readFile(headerPath, 'utf-8');
      } catch {
        errorCount++;
        continue;
      }

      const dir = path.dirname(headerPath);
      const result = buildEntriesFromContent(headerPath, content, (className) => {
        const candidateCpp = path.join(dir, `${className}.cpp`);
        try {
          fs.accessSync(candidateCpp);
          return candidateCpp;
        } catch {
          return null;
        }
      });

      errorCount += result.errorCount;
      entries = result.entries;

      // Update cache
      mtimeCache.set(headerPath, { mtime, entries });
    }

    for (const entry of entries) {
      allEntries.set(entry.className, entry);
    }
  }

  return {
    success: true,
    index: makeCppClassIndex(allEntries),
    fileCount,
    errorCount,
  };
}
