// src/tools/known-issues/middleware.ts
// Wraps tool handlers with a pre-execution KNOWN_ISSUES check.
// Matching issues are prepended as warnings to the tool response content array.
// Handler exceptions are caught and returned as isError responses — never propagated.

import { readKnownIssues } from './store.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single content block returned by a tool handler. */
export type TextContentBlock = { type: 'text'; text: string };
export type ImageContentBlock = { type: 'image'; data: string; mimeType: string };
export type ContentBlock = TextContentBlock | ImageContentBlock;

export type ToolResult = {
  content: Array<ContentBlock>;
  isError?: boolean;
};

export type ToolHandler<T> = (args: T) => Promise<ToolResult>;

// ---------------------------------------------------------------------------
// withKnownIssues
// ---------------------------------------------------------------------------

/**
 * Wraps a tool handler with a KNOWN_ISSUES pre-execution check.
 *
 * Before invoking the real handler:
 *   1. Reads KNOWN_ISSUES.md (cached by mtime — cheap on cache hit).
 *   2. Filters issues where affectedTools includes toolName or '*' (wildcard).
 *   3. If matching issues exist, prepends a single warning content item
 *      (all warnings joined by '\n') before the handler's content items.
 *
 * Exceptions thrown by the handler are caught and returned as:
 *   { isError: true, content: [{ type: 'text', text: 'Error: <message>' }] }
 *
 * @param toolName  The MCP tool name (e.g., 'ue_read_cpp_class').
 * @param handler   The real tool handler to wrap.
 * @returns         A new handler with the same signature.
 */
export function withKnownIssues<T>(
  toolName: string,
  handler: ToolHandler<T>
): ToolHandler<T> {
  return async (args: T): Promise<ToolResult> => {
    const issues = await readKnownIssues();
    const relevant = issues.filter(
      (i) =>
        i.affectedTools.includes(toolName) || i.affectedTools.includes('*')
    );

    let result: ToolResult;
    try {
      result = await handler(args);
    } catch (err: unknown) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }

    if (relevant.length === 0) {
      return result;
    }

    const warnings = relevant
      .map(
        (i) =>
          `[KNOWN ISSUE ${i.id}] ${i.description} — Resolution: ${i.resolution}`
      )
      .join('\n');

    return {
      content: [{ type: 'text', text: warnings }, ...result.content],
      isError: result.isError,
    };
  };
}
