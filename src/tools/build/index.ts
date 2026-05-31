// src/tools/build/index.ts
// Registers UE build tools on the MCP server with real implementations.
// Wires ue_build and ue_get_build_errors to runUbt, parseErrors, and suggestFix.
// Module-level state (lastBuildErrors) stores parsed results for ue_get_build_errors.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withKnownIssues } from '../known-issues/middleware.js';
import { runUbt } from '../../build/ubt-runner.js';
import { parseErrors } from '../../build/error-parser.js';
import type { BuildError } from '../../build/error-parser.js';
import { suggestFix } from '../../build/fix-suggester.js';
import type { FixSuggestion } from '../../build/fix-suggester.js';
import { validatePath } from '../../utils/path-guard.js';
import { PROJECT_ROOT } from '../../config.js';
import { DocIndex } from '../../docs/doc-index.js';

// ---------------------------------------------------------------------------
// Shared DocIndex instance (no records loaded by default; provides include hints
// when the doc data has been loaded externally via a shared instance).
// ---------------------------------------------------------------------------
const docIndex = new DocIndex();

// ---------------------------------------------------------------------------
// Module-level state — last build's parsed errors with fix suggestions.
// Mitigates T-06-11: compiler diagnostics are developer-intended output,
// not persisted to disk, and contain no credentials.
// ---------------------------------------------------------------------------

interface BuildErrorWithSuggestions {
  error: BuildError;
  suggestions: FixSuggestion[];
}

let lastBuildErrors: BuildErrorWithSuggestions[] = [];

// ---------------------------------------------------------------------------
// registerBuildTools
// ---------------------------------------------------------------------------

/**
 * Register UE build tools on the MCP server.
 *
 * Tools registered:
 *   ue_build            — Trigger an Unreal Build Tool (UBT) build
 *   ue_get_build_errors — Retrieve the last build error list with fix suggestions
 *
 * @param server  The McpServer instance to register tools on.
 */
export function registerBuildTools(server: McpServer): void {
  // --------------------------------------------------------------------------
  // ue_build
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_build',
    {
      title: 'Build UE Project',
      description:
        'Trigger an Unreal Build Tool (UBT) build for the specified target and configuration.',
      inputSchema: z.object({
        target: z.string().describe('The UBT build target (e.g., "MyProjectEditor")'),
        configuration: z
          .string()
          .optional()
          .describe('Build configuration (e.g., "Development", "Shipping"). Defaults to "Development".'),
        platform: z
          .string()
          .optional()
          .describe('Target platform (e.g., "Win64", "Linux"). Defaults to "Win64".'),
        uprojectPath: z
          .string()
          .optional()
          .describe('Absolute path to the .uproject file. Auto-discovered from PROJECT_ROOT when omitted.'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_build', async (args) => {
      // Validate uprojectPath before passing to runUbt (T-06-09 path traversal mitigation)
      let validatedUprojectPath: string | undefined;
      if (args.uprojectPath !== undefined) {
        try {
          validatedUprojectPath = validatePath(args.uprojectPath, PROJECT_ROOT);
        } catch (err: unknown) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `Error: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
          };
        }
      }

      // Invoke UBT — T-06-10: runUbt raises "Build already in progress" error
      // which withKnownIssues catches and returns as isError. T-06-08: target
      // is passed as an array argument, no shell interpolation.
      let result;
      try {
        result = await runUbt({
          target: args.target,
          configuration: args.configuration,
          platform: args.platform,
          uprojectPath: validatedUprojectPath,
        });
      } catch (err: unknown) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }

      // Parse stdout + stderr for compiler diagnostics
      const allLines = [
        ...result.stdout.split('\n'),
        ...result.stderr.split('\n'),
      ];
      const errors = parseErrors(allLines);

      // Attach fix suggestions and store in module-level state
      lastBuildErrors = errors.map((e) => ({
        error: e,
        suggestions: suggestFix(e, docIndex),
      }));

      // Classify errors vs warnings
      const errorCount = errors.filter((e) => e.severity === 'error').length;
      const warningCount = errors.filter((e) => e.severity === 'warning').length;

      // Format first 5 errors for the summary
      const firstFiveErrors = errors
        .filter((e) => e.severity === 'error')
        .slice(0, 5)
        .map((e) => `  ${e.file}(${e.line}): ${e.message}`)
        .join('\n');

      const summary = [
        `Build completed in ${result.durationMs}ms. Exit code: ${result.exitCode}.`,
        `Errors: ${errorCount}  Warnings: ${warningCount}`,
        firstFiveErrors.length > 0 ? firstFiveErrors : '',
        'Run ue_get_build_errors for full structured output with fix suggestions.',
      ]
        .filter((line) => line !== '')
        .join('\n');

      return {
        isError: result.exitCode !== 0 && result.exitCode !== null,
        content: [{ type: 'text' as const, text: summary }],
      };
    })
  );

  // --------------------------------------------------------------------------
  // ue_get_build_errors
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_get_build_errors',
    {
      title: 'Get UE Build Errors',
      description:
        'Retrieve the error and warning list from the most recent Unreal Build Tool build, with fix suggestions.',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_get_build_errors', async (_args) => {
      if (lastBuildErrors.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No build has been run yet. Call ue_build first.',
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(lastBuildErrors, null, 2),
          },
        ],
      };
    })
  );
}
