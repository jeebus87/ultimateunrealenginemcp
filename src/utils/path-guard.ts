// Path traversal guard — validates user-supplied file paths against project root.
// Implements ASVS V4 access control: resolves path and asserts within project root.
// Mitigates T-01-04 (path traversal via AI-crafted file path args).
//
// Windows compatible: path.resolve() and path.sep handle backslashes correctly.
// Do NOT use string concatenation with '/' — use path.resolve() + path.sep.

import * as path from 'path';

/**
 * Resolves userPath and asserts it is within (or equal to) projectRoot.
 *
 * @param userPath    The path supplied by the MCP tool caller (may be relative or absolute).
 * @param projectRoot The project root to validate against (should be absolute).
 * @returns           The resolved absolute path on success.
 * @throws Error      If the resolved path escapes the project root.
 */
export function validatePath(userPath: string, projectRoot: string): string {
  const resolved = path.resolve(userPath);
  const normalizedRoot = path.resolve(projectRoot);

  // Accept paths that are exactly the root or start with root + separator
  // Using path.sep ensures correct behavior on Windows (backslash) and POSIX (slash)
  if (
    resolved !== normalizedRoot &&
    !resolved.startsWith(normalizedRoot + path.sep)
  ) {
    throw new Error(
      `Path traversal rejected: "${userPath}" resolves outside project root "${projectRoot}"`
    );
  }

  return resolved;
}
