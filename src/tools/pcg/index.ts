// src/tools/pcg/index.ts
// MCP tool implementations for PCG Framework operations (Phase 24).
// All tools route commands through PluginBridgeClient to the C++ MCPBridge plugin.
// Returns structured plugin_not_connected errors when the plugin is absent.
//
// Tools registered (Phase 24 — PCG-01 through PCG-04):
//   ue_list_pcg_graphs    — List all PCG graph assets in the project
//   ue_inspect_pcg_graph  — Inspect nodes, connections, and parameters of a PCG graph
//   ue_execute_pcg_graph  — Execute a PCG graph on an actor with optional parameter overrides
//   ue_query_pcg_results  — Query PCG execution results for an actor
//
// All tools require MCPBridge plugin (Phase 24 — PCG-01 through PCG-04).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withKnownIssues, type ToolResult } from '../known-issues/middleware.js';
import { PluginBridgeClient, PluginNotConnectedError } from '../../plugin-bridge/client.js';

// ---------------------------------------------------------------------------
// sendOrDisconnect helper
// ---------------------------------------------------------------------------

/**
 * Sends a command to the bridge and returns a ToolResult.
 *
 * - On success (response.success true): returns data as JSON text.
 * - On command-level failure (response.success false): returns isError:true with error JSON.
 * - On PluginNotConnectedError: returns isError:true with plugin_not_connected JSON.
 * - On other errors: rethrows (withKnownIssues catches and formats).
 *
 * NOTE: sendCommand() overwrites correlationId with crypto.randomUUID() internally;
 * passing an empty string is safe and correct (per STATE.md decision).
 */
async function sendOrDisconnect(
  bridge: PluginBridgeClient,
  cmd: { type: string; payload?: unknown }
): Promise<ToolResult> {
  try {
    const response = await bridge.sendCommand({ ...cmd, correlationId: '' });
    if (!response.success) {
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ error: response.error }) }],
      };
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(response.data ?? {}) }],
    };
  } catch (err) {
    if (err instanceof PluginNotConnectedError) {
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify(err.bridgeError) }],
      };
    }
    throw err; // withKnownIssues catches unexpected errors
  }
}

// ---------------------------------------------------------------------------
// registerPCGTools
// ---------------------------------------------------------------------------

/**
 * Register UE PCG Framework tools on the MCP server.
 *
 * All tools in this domain require the MCPBridge editor plugin.
 * When the plugin is not connected, each handler returns:
 *   { isError: true, content: [{ type: 'text', text: <plugin_not_connected JSON> }] }
 *
 * Tools registered (Phase 24):
 *   ue_list_pcg_graphs    — List all PCG graph assets in the project
 *   ue_inspect_pcg_graph  — Inspect nodes, connections, and parameters of a PCG graph
 *   ue_execute_pcg_graph  — Execute a PCG graph on an actor with optional parameter overrides
 *   ue_query_pcg_results  — Query PCG execution results for an actor
 *
 * @param server  The McpServer instance to register tools on.
 * @param bridge  Optional PluginBridgeClient for testing (defaults to a new instance).
 */
export function registerPCGTools(server: McpServer, bridge?: PluginBridgeClient): void {
  const _bridge = bridge ?? PluginBridgeClient.shared();

  // --------------------------------------------------------------------------
  // ue_list_pcg_graphs
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_list_pcg_graphs',
    {
      title: 'List PCG Graphs',
      description:
        '[requires_plugin] List all PCG graph assets in the project with node count and component assignment.',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_list_pcg_graphs', async (_args) => {
      return sendOrDisconnect(_bridge, {
        type: 'pcg.list',
        payload: {},
      });
    })
  );

  // --------------------------------------------------------------------------
  // ue_inspect_pcg_graph
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_inspect_pcg_graph',
    {
      title: 'Inspect PCG Graph',
      description:
        '[requires_plugin] Inspect a PCG graph\'s nodes, connections, parameters, and enabled state.',
      inputSchema: z.object({
        asset_path: z
          .string()
          .min(1)
          .describe('Content browser path to the PCG graph asset, e.g. /Game/PCG/MyGraph'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_inspect_pcg_graph', async (args) => {
      return sendOrDisconnect(_bridge, {
        type: 'pcg.inspect',
        payload: { asset_path: args.asset_path },
      });
    })
  );

  // --------------------------------------------------------------------------
  // ue_execute_pcg_graph
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_execute_pcg_graph',
    {
      title: 'Execute PCG Graph',
      description:
        '[requires_plugin] Execute a PCG graph on an actor\'s PCG component with optional parameter overrides.',
      inputSchema: z.object({
        actor_label: z
          .string()
          .min(1)
          .describe('Display label of the actor with a PCG component'),
        parameter_overrides: z
          .record(z.union([z.number(), z.string()]))
          .optional()
          .describe('Key-value map of parameter overrides to apply before execution'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_execute_pcg_graph', async (args) => {
      const payload: Record<string, unknown> = {
        actor_label: args.actor_label,
      };
      if (args.parameter_overrides !== undefined) {
        payload['parameter_overrides'] = args.parameter_overrides;
      }
      return sendOrDisconnect(_bridge, { type: 'pcg.execute', payload });
    })
  );

  // --------------------------------------------------------------------------
  // ue_query_pcg_results
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_query_pcg_results',
    {
      title: 'Query PCG Results',
      description:
        '[requires_plugin] Query PCG execution results for an actor — point counts, data entries, and warnings.',
      inputSchema: z.object({
        actor_label: z
          .string()
          .min(1)
          .describe('Display label of the actor with a PCG component'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_query_pcg_results', async (args) => {
      return sendOrDisconnect(_bridge, {
        type: 'pcg.results',
        payload: { actor_label: args.actor_label },
      });
    })
  );
}
