// src/tools/worldpartition/index.ts
// MCP tool implementations for World Partition management (Phase 18).
// All tools route commands through PluginBridgeClient to the C++ MCPBridge handlers.
// Returns structured plugin_not_connected errors when the plugin is absent.
//
// Tools registered (Phase 18 — WP-01 through WP-04):
//   ue_read_world_partition        — Read WP grid size, loading range, streaming config, runtime hash
//   ue_manage_data_layers          — List, create, toggle, or assign actors to data layers
//   ue_inspect_streaming_sources   — Inspect streaming source components and their configurations
//   ue_trigger_hlod_generation     — Trigger HLOD generation or inspect HLOD layer config
//
// All tools require MCPBridge plugin (Phase 18 — WP-01 through WP-04).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withKnownIssues, type ToolResult } from '../known-issues/middleware.js';
import { PluginBridgeClient, PluginNotConnectedError } from '../../plugin-bridge/client.js';
// Import result types — used as documentation of the response data shapes returned by the plugin.
// The sendOrDisconnect helper returns raw JSON.stringify(response.data); callers may cast to these.
import type {
  WorldPartitionSettingsResult, // WP-01 response shape
  DataLayersResult,             // WP-02 response shape
  StreamingSourcesResult,       // WP-03 response shape
  HlodResult,                   // WP-04 response shape
} from './types.js';

// Suppress unused-import warnings — types are referenced in JSDoc comments.
type _UnusedImports =
  | WorldPartitionSettingsResult
  | DataLayersResult
  | StreamingSourcesResult
  | HlodResult;

// Module-level bridge instance — injected in tests via exported handler signatures.
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
// Exported handler functions (for direct unit testing via bridge injection)
// ---------------------------------------------------------------------------

/**
 * ue_read_world_partition handler — satisfies WP-01.
 * Sends worldpartition.settings to the plugin; returns WP configuration.
 *
 * @param args  Tool arguments (none required for this tool).
 * @param b     PluginBridgeClient instance (defaults to module-level singleton).
 */
export async function handleReadWorldPartition(
  args: Record<string, never>,
  b: PluginBridgeClient = bridge
): Promise<ToolResult> {
  // Response data shape: WorldPartitionSettingsResult
  void args; // No parameters required
  return sendOrDisconnect(b, {
    type: 'worldpartition.settings',
    payload: {},
  });
}

/**
 * ue_manage_data_layers handler — satisfies WP-02.
 * Sends worldpartition.dataLayers to the plugin; lists, creates, toggles, or assigns actors to data layers.
 *
 * @param args  Tool arguments including action and optional layer/actor parameters.
 * @param b     PluginBridgeClient instance (defaults to module-level singleton).
 */
export async function handleManageDataLayers(
  args: {
    action: string;
    layer_name?: string;
    layer_type?: string;
    initial_state?: string;
    actor_label?: string;
  },
  b: PluginBridgeClient = bridge
): Promise<ToolResult> {
  // Response data shape: DataLayersResult (variant depends on action)
  const payload: Record<string, unknown> = { action: args.action };
  if (args.layer_name !== undefined) payload['layer_name'] = args.layer_name;
  if (args.layer_type !== undefined) payload['layer_type'] = args.layer_type;
  if (args.initial_state !== undefined) payload['initial_state'] = args.initial_state;
  if (args.actor_label !== undefined) payload['actor_label'] = args.actor_label;
  return sendOrDisconnect(b, {
    type: 'worldpartition.dataLayers',
    payload,
  });
}

/**
 * ue_inspect_streaming_sources handler — satisfies WP-03.
 * Sends worldpartition.streamingSources to the plugin; returns streaming source components.
 *
 * @param args  Tool arguments including optional actor_label filter.
 * @param b     PluginBridgeClient instance (defaults to module-level singleton).
 */
export async function handleInspectStreamingSources(
  args: { actor_label?: string },
  b: PluginBridgeClient = bridge
): Promise<ToolResult> {
  // Response data shape: StreamingSourcesResult
  const payload: Record<string, unknown> = {};
  if (args.actor_label !== undefined) payload['actor_label'] = args.actor_label;
  return sendOrDisconnect(b, {
    type: 'worldpartition.streamingSources',
    payload,
  });
}

/**
 * ue_trigger_hlod_generation handler — satisfies WP-04.
 * Sends worldpartition.hlod to the plugin; inspects HLOD config or triggers HLOD build.
 *
 * @param args  Tool arguments including action ("inspect" | "generate").
 * @param b     PluginBridgeClient instance (defaults to module-level singleton).
 */
export async function handleTriggerHlodGeneration(
  args: { action: string },
  b: PluginBridgeClient = bridge
): Promise<ToolResult> {
  // Response data shape: HlodResult (variant depends on action)
  return sendOrDisconnect(b, {
    type: 'worldpartition.hlod',
    payload: { action: args.action },
  });
}

// ---------------------------------------------------------------------------
// registerWorldPartitionTools
// ---------------------------------------------------------------------------

/**
 * Register UE World Partition management tools on the MCP server.
 *
 * All tools in this domain require the MCPBridge editor plugin.
 * When the plugin is not connected, each handler returns:
 *   { isError: true, content: [{ type: 'text', text: <plugin_not_connected JSON> }] }
 *
 * Tools registered (Phase 18):
 *   ue_read_world_partition        — WP-01: Read WP configuration (grid size, loading range, streaming)
 *   ue_manage_data_layers          — WP-02: List, create, toggle data layers; assign actors to layers
 *   ue_inspect_streaming_sources   — WP-03: Inspect streaming source components and target states
 *   ue_trigger_hlod_generation     — WP-04: Inspect HLOD layer config or trigger HLOD build
 *
 * @param server  The McpServer instance to register tools on.
 * @param _bridge Optional PluginBridgeClient for testing (not used directly — handlers
 *                accept bridge injection via their exported function signatures).
 */
export function registerWorldPartitionTools(server: McpServer, _bridge?: PluginBridgeClient): void {
  const b = _bridge ?? PluginBridgeClient.shared();

  // --------------------------------------------------------------------------
  // ue_read_world_partition (WP-01)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_read_world_partition',
    {
      title: 'Read World Partition Settings',
      description:
        '[requires_plugin] Read World Partition configuration including grid size, loading range, streaming state, and runtime hash.',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_read_world_partition', async (args) =>
      handleReadWorldPartition(args as Record<string, never>, b)
    )
  );

  // --------------------------------------------------------------------------
  // ue_manage_data_layers (WP-02)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_manage_data_layers',
    {
      title: 'Manage Data Layers',
      description:
        '[requires_plugin] List, create, enable/disable data layers, or assign actors to data layers in a World Partition world.',
      inputSchema: z.object({
        action: z
          .enum(['list', 'create', 'toggle', 'assign_actor'])
          .describe('Action to perform on data layers'),
        layer_name: z
          .string()
          .optional()
          .describe('Data layer name (required for create, toggle, assign_actor)'),
        layer_type: z
          .enum(['Runtime', 'Editor'])
          .optional()
          .describe('Layer type (required for create)'),
        initial_state: z
          .enum(['Unloaded', 'Loaded', 'Activated'])
          .optional()
          .describe('Initial runtime state (for toggle action)'),
        actor_label: z
          .string()
          .optional()
          .describe('Actor label to assign to layer (for assign_actor action)'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_manage_data_layers', async (args) =>
      handleManageDataLayers(args, b)
    )
  );

  // --------------------------------------------------------------------------
  // ue_inspect_streaming_sources (WP-03)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_inspect_streaming_sources',
    {
      title: 'Inspect Streaming Sources',
      description:
        '[requires_plugin] Inspect World Partition streaming source components, their shapes, priorities, and target states.',
      inputSchema: z.object({
        actor_label: z
          .string()
          .optional()
          .describe('Optional actor label to filter streaming sources'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_inspect_streaming_sources', async (args) =>
      handleInspectStreamingSources(args, b)
    )
  );

  // --------------------------------------------------------------------------
  // ue_trigger_hlod_generation (WP-04)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_trigger_hlod_generation',
    {
      title: 'HLOD Generation',
      description:
        '[requires_plugin] Trigger HLOD generation or inspect HLOD layer configuration for World Partition.',
      inputSchema: z.object({
        action: z
          .enum(['inspect', 'generate'])
          .describe('inspect: read HLOD layer config; generate: trigger HLOD build'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_trigger_hlod_generation', async (args) =>
      handleTriggerHlodGeneration(args, b)
    )
  );
}
