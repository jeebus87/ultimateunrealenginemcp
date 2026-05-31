// src/tools/known-issues/index.ts
// Registers the ue_list_known_issues and ue_add_known_issue MCP tools.
// Both tools are wrapped with withKnownIssues middleware per INF-06.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withKnownIssues } from './middleware.js';
import { readKnownIssues, appendKnownIssue } from './store.js';

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

/**
 * Register KNOWN_ISSUES management tools on the MCP server.
 *
 * Tools registered:
 *   ue_list_known_issues  — returns all entries from KNOWN_ISSUES.md (read-only)
 *   ue_add_known_issue    — appends a new entry to KNOWN_ISSUES.md
 *
 * @param server  The McpServer instance to register tools on.
 */
export function registerKnownIssuesTools(server: McpServer): void {
  // --------------------------------------------------------------------------
  // ue_list_known_issues
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_list_known_issues',
    {
      title: 'List Known Issues',
      description:
        'Returns all entries from KNOWN_ISSUES.md. Run this before any operation to check for known issues that may affect the result.',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_list_known_issues', async () => {
      const issues = await readKnownIssues();

      if (issues.length === 0) {
        return {
          content: [{ type: 'text', text: 'No known issues recorded.' }],
        };
      }

      const lines = issues.map(
        (i) =>
          `## ${i.id}\n` +
          `**Description:** ${i.description}\n` +
          `**Affected tools:** ${i.affectedTools.join(', ')}\n` +
          `**Root cause:** ${i.rootCause}\n` +
          `**Resolution:** ${i.resolution}\n` +
          `**Date added:** ${i.dateAdded}\n` +
          `**Status:** ${i.status}`
      );

      return {
        content: [{ type: 'text', text: lines.join('\n\n---\n\n') }],
      };
    })
  );

  // --------------------------------------------------------------------------
  // ue_add_known_issue
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_add_known_issue',
    {
      title: 'Add Known Issue',
      description:
        'Appends a new entry to KNOWN_ISSUES.md after user approves a fix.',
      inputSchema: z.object({
        description: z.string(),
        affectedTools: z
          .string()
          .describe('Comma-separated tool names, or * for all tools'),
        rootCause: z.string(),
        resolution: z.string(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    withKnownIssues(
      'ue_add_known_issue',
      async ({ description, affectedTools, rootCause, resolution }) => {
        const issue = await appendKnownIssue({
          description,
          affectedTools: affectedTools
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          rootCause,
          resolution,
          dateAdded: new Date().toISOString().split('T')[0] ?? '',
          status: 'active',
        });

        return {
          content: [
            {
              type: 'text',
              text: `Known issue recorded as ${issue.id}. It will be surfaced as a warning before any affected tool runs.`,
            },
          ],
        };
      }
    )
  );
}
