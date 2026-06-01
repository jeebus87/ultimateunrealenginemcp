// src/tools/networking/index.ts
// MCP tool implementations for Networking and Replication inspection (Phase 30).
// All tools route commands through PluginBridgeClient to the C++ MCPBridge handlers.
// Returns structured plugin_not_connected errors when the plugin is absent.
// All operations are read-only — no mutations performed.
//
// Tools registered (Phase 30 — NET-01 through NET-04):
//   ue_inspect_replication          — Inspect actor replication settings
//   ue_list_replicated_properties   — List replicated properties with conditions
//   ue_read_net_driver              — Read NetDriver configuration and connections
//   ue_inspect_session              — Inspect online subsystem session and players
//
// All tools require MCPBridge plugin (Phase 30 — NET-01 through NET-04).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withKnownIssues, type ToolResult } from '../known-issues/middleware.js';
import { PluginBridgeClient, PluginNotConnectedError } from '../../plugin-bridge/client.js';

// Module-level bridge instance — injected in tests via exported function parameter.
const bridge = PluginBridgeClient.shared();

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
  b: PluginBridgeClient,
  cmd: { type: string; payload?: unknown }
): Promise<ToolResult> {
  try {
    const response = await b.sendCommand({ ...cmd, correlationId: '' });
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
// registerNetworkingTools
// ---------------------------------------------------------------------------

/**
 * Register UE Networking and Replication tools on the MCP server.
 *
 * All tools in this domain require the MCPBridge editor plugin.
 * When the plugin is not connected, each handler returns:
 *   { isError: true, content: [{ type: 'text', text: <plugin_not_connected JSON> }] }
 *
 * All tools are read-only — they never modify game state.
 *
 * Tools registered (Phase 30):
 *   ue_inspect_replication        — NET-01: Actor replication settings
 *   ue_list_replicated_properties — NET-02: Replicated properties with conditions
 *   ue_read_net_driver            — NET-03: NetDriver config and connections
 *   ue_inspect_session            — NET-04: Online subsystem session and players
 *
 * @param server  The McpServer instance to register tools on.
 * @param _bridge Optional PluginBridgeClient for testing (defaults to module singleton).
 */
export function registerNetworkingTools(server: McpServer, _bridge?: PluginBridgeClient): void {
  const b = _bridge ?? bridge;

  // --------------------------------------------------------------------------
  // ue_inspect_replication (NET-01)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_inspect_replication',
    {
      title: 'Inspect Actor Replication',
      description:
        '[requires_plugin] Inspect actor replication settings including bReplicates, relevancy, update frequency, priority, and dormancy.',
      inputSchema: z.object({
        actor_label: z
          .string()
          .min(1)
          .describe('Display label of the actor to inspect replication settings for'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_inspect_replication', async (args) =>
      sendOrDisconnect(b, {
        type: 'net.replication',
        payload: { actor_label: args.actor_label },
      })
    )
  );

  // --------------------------------------------------------------------------
  // ue_list_replicated_properties (NET-02)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_list_replicated_properties',
    {
      title: 'List Replicated Properties',
      description:
        '[requires_plugin] List all replicated properties on an actor with their replication conditions and RepNotify status.',
      inputSchema: z.object({
        actor_label: z
          .string()
          .min(1)
          .describe('Display label of the actor to list replicated properties for'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_list_replicated_properties', async (args) =>
      sendOrDisconnect(b, {
        type: 'net.properties',
        payload: { actor_label: args.actor_label },
      })
    )
  );

  // --------------------------------------------------------------------------
  // ue_read_net_driver (NET-03)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_read_net_driver',
    {
      title: 'Read NetDriver Configuration',
      description:
        '[requires_plugin] Read NetDriver configuration, connection count, and network stats. Returns informative status if no NetDriver is active (e.g., editor without PIE).',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_read_net_driver', async (_args) =>
      sendOrDisconnect(b, {
        type: 'net.driver',
        payload: {},
      })
    )
  );

  // --------------------------------------------------------------------------
  // ue_inspect_session (NET-04)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_inspect_session',
    {
      title: 'Inspect Online Session',
      description:
        '[requires_plugin] Inspect online subsystem session information including player list, session state, and connection details. Returns informative status if no online subsystem is configured.',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_inspect_session', async (_args) =>
      sendOrDisconnect(b, {
        type: 'net.session',
        payload: {},
      })
    )
  );
}
