// src/tools/docs/index.ts
// Registers UE documentation tools backed by DocIndex and the bundled UE 5.7 API data.
// All handlers are wrapped with withKnownIssues() per INF-06.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withKnownIssues } from '../known-issues/middleware.js';
import { DocIndex } from '../../docs/doc-index.js';
import { UE57_API_RECORDS } from '../../docs/data/ue57-api.js';

// ---------------------------------------------------------------------------
// Module-level singleton — loaded once at import time.
// Avoids rebuilding the MiniSearch index on every tool call.
// ---------------------------------------------------------------------------

const docIndex = new DocIndex();
docIndex.load(UE57_API_RECORDS);

// ---------------------------------------------------------------------------
// Pure handler functions (exported for testing without MCP server)
// ---------------------------------------------------------------------------

/**
 * ue_search_api handler logic — exported for direct testing.
 * @param args     Tool input args ({ query: string })
 * @param index    DocIndex to query (defaults to the module singleton)
 */
export async function handleSearchApi(
  args: { query: string },
  index: DocIndex = docIndex
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  const results = index.search(args.query, 20);

  if (results.length === 0) {
    return {
      content: [
        { type: 'text', text: `No results found for query: "${args.query}"` },
      ],
    };
  }

  const lines: string[] = [
    `Search results for "${args.query}" (${results.length} result${results.length === 1 ? '' : 's'}):`,
  ];

  results.forEach((result, idx) => {
    const r = result.record;
    const scoreStr = result.score.toFixed(2);
    lines.push('');
    lines.push(`${idx + 1}. [${r.type}] ${r.fullName} (score: ${scoreStr})`);

    if (r.module) {
      if (r.type === 'class' || r.type === 'enum') {
        lines.push(`   Module: ${r.module} | Include: ${r.includePath}`);
      } else {
        if (r.signature) {
          lines.push(`   Signature: ${r.signature}`);
        }
        lines.push(`   Include: ${r.includePath}`);
      }
    }

    if (r.description) {
      lines.push(`   ${r.description}`);
    }
  });

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
  };
}

/**
 * ue_lookup_class handler logic — exported for direct testing.
 * @param args     Tool input args ({ class_name: string })
 * @param index    DocIndex to query (defaults to the module singleton)
 */
export async function handleLookupClass(
  args: { class_name: string },
  index: DocIndex = docIndex
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  const records = index.lookupClass(args.class_name);

  if (records.length === 0) {
    return {
      content: [
        {
          type: 'text',
          text: `Class not found: "${args.class_name}". Check spelling and case (e.g., UStaticMeshComponent).`,
        },
      ],
      isError: true,
    };
  }

  const classRecord = records.find((r) => r.type === 'class') ?? records[0]!;
  const members = records.filter((r) => r.type !== 'class');

  const lines: string[] = [
    `Class: ${classRecord.className}`,
    `Module: ${classRecord.module}`,
    `Include: #include "${classRecord.includePath}"`,
    `Description: ${classRecord.description}`,
  ];

  if (classRecord.deprecated) {
    lines.push('');
    lines.push(`[DEPRECATED] ${classRecord.deprecatedMessage}`);
    if (classRecord.replacementAPI) {
      lines.push(`Replacement: ${classRecord.replacementAPI}`);
    }
  }

  lines.push('');
  lines.push(`Members (${members.length}):`);

  if (members.length === 0) {
    lines.push('  (no indexed members)');
  } else {
    for (const m of members) {
      if (m.type === 'function') {
        lines.push(`  [function] ${m.name} — ${m.signature}`);
      } else if (m.type === 'property') {
        lines.push(`  [property] ${m.name}`);
      } else {
        lines.push(`  [${m.type}] ${m.name}`);
      }
    }
  }

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
  };
}

/**
 * ue_get_include_path handler logic — exported for direct testing.
 * @param args     Tool input args ({ class_name: string })
 * @param index    DocIndex to query (defaults to the module singleton)
 */
export async function handleGetIncludePath(
  args: { class_name: string },
  index: DocIndex = docIndex
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  const includePath = index.getIncludePath(args.class_name);

  if (includePath === null) {
    return {
      content: [
        {
          type: 'text',
          text: `No include path found for "${args.class_name}". Class not in UE 5.7 index.`,
        },
      ],
      isError: true,
    };
  }

  return {
    content: [{ type: 'text', text: `#include "${includePath}"` }],
  };
}

/**
 * ue_check_deprecation handler logic — exported for direct testing.
 * @param args     Tool input args ({ symbol_name: string })
 * @param index    DocIndex to query (defaults to the module singleton)
 */
export async function handleCheckDeprecation(
  args: { symbol_name: string },
  index: DocIndex = docIndex
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  const result = index.checkDeprecation(args.symbol_name);

  if (result === null) {
    return {
      content: [
        {
          type: 'text',
          text: `Symbol not found: "${args.symbol_name}". Cannot check deprecation status.`,
        },
      ],
      isError: true,
    };
  }

  if (!result.deprecated) {
    return {
      content: [
        {
          type: 'text',
          text: `"${args.symbol_name}" is NOT deprecated in UE 5.7. Safe to use.`,
        },
      ],
    };
  }

  return {
    content: [
      {
        type: 'text',
        text: `"${args.symbol_name}" IS DEPRECATED in UE 5.7.\nReason: ${result.message}\nRecommended replacement: ${result.replacement}`,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

/**
 * Register UE documentation tools on the MCP server.
 *
 * Tools registered:
 *   ue_search_api        — Full-text search across the UE API reference
 *   ue_lookup_class      — Look up a specific UE class in the API docs
 *   ue_get_include_path  — Get the correct #include path for a UE class
 *   ue_check_deprecation — Check if a UE symbol is deprecated in UE 5.7
 *
 * @param server  The McpServer instance to register tools on.
 */
export function registerDocsTools(server: McpServer): void {
  // --------------------------------------------------------------------------
  // ue_search_api
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_search_api',
    {
      title: 'Search UE API',
      description:
        'Search the Unreal Engine 5.7 API reference documentation for classes, functions, and concepts.',
      inputSchema: z.object({
        query: z.string().describe('Search query (e.g., "UStaticMeshComponent collision")'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_search_api', async (args) => {
      return handleSearchApi(args);
    })
  );

  // --------------------------------------------------------------------------
  // ue_lookup_class
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_lookup_class',
    {
      title: 'Lookup UE Class',
      description:
        'Look up a specific Unreal Engine class in the API docs, returning its description, hierarchy, and key methods.',
      inputSchema: z.object({
        class_name: z.string().describe('The UE class name (e.g., UStaticMeshComponent)'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_lookup_class', async (args) => {
      return handleLookupClass(args);
    })
  );

  // --------------------------------------------------------------------------
  // ue_get_include_path
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_get_include_path',
    {
      title: 'Get UE Include Path',
      description:
        'Get the correct #include path for a Unreal Engine class (e.g., #include "Components/StaticMeshComponent.h").',
      inputSchema: z.object({
        class_name: z.string().describe('The UE class name to find the include path for'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_get_include_path', async (args) => {
      return handleGetIncludePath(args);
    })
  );

  // --------------------------------------------------------------------------
  // ue_check_deprecation
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_check_deprecation',
    {
      title: 'Check UE Symbol Deprecation',
      description:
        'Check whether a UE 5.7 symbol (class, function, or macro) is deprecated and what the recommended replacement is.',
      inputSchema: z.object({
        symbol_name: z.string().describe('The UE symbol name to check for deprecation'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_check_deprecation', async (args) => {
      return handleCheckDeprecation(args);
    })
  );
}
