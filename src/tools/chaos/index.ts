// src/tools/chaos/index.ts
// MCP tool implementations for Chaos physics management (Phase 26).
// All tools route commands through PluginBridgeClient to the C++ MCPBridge plugin.
// Returns structured plugin_not_connected errors when the plugin is absent.
//
// Tools registered (Phase 26 — CHAOS-01 through CHAOS-04):
//   ue_inspect_geometry_collection  — Inspect geometry collection fracture hierarchy and bone data
//   ue_reset_destruction            — Reset geometry collection actor to initial unfractured state
//   ue_read_cloth_params            — Read Chaos cloth simulation parameters from actor or asset
//   ue_manage_physics_cache         — Start, stop, or query Chaos physics cache recording
//
// All tools require MCPBridge plugin (Phase 26 — CHAOS-01 through CHAOS-04).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withKnownIssues, type ToolResult } from '../known-issues/middleware.js';
import { PluginBridgeClient, PluginNotConnectedError } from '../../plugin-bridge/client.js';
// Import result types — used as documentation of the response data shapes returned by the plugin.
// The sendOrDisconnect helper returns raw JSON.stringify(response.data); callers may cast to these.
import type {
  GeometryCollectionInspectResult, // CHAOS-01 response shape
  DestructionResetResult,          // CHAOS-02 response shape
  ClothParamsResult,               // CHAOS-03 response shape
  PhysicsCacheResult,              // CHAOS-04 response shape
} from './types.js';

// Suppress unused-import warnings — types are referenced in JSDoc comments.
type _UnusedImports =
  | GeometryCollectionInspectResult
  | DestructionResetResult
  | ClothParamsResult
  | PhysicsCacheResult;

// Module-level bridge instance — injected in tests via exported handler signatures.
const _defaultBridge = new PluginBridgeClient();

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
 * ue_inspect_geometry_collection handler — satisfies CHAOS-01.
 * Sends chaos.geometryCollection to the plugin; returns fracture hierarchy,
 * bone count, level breakdown, and damage thresholds.
 *
 * @param args  Tool arguments — provide asset_path and/or actor_label.
 * @param b     PluginBridgeClient instance (defaults to module-level singleton).
 */
export async function handleInspectGeometryCollection(
  args: { asset_path?: string; actor_label?: string },
  b: PluginBridgeClient = _defaultBridge
): Promise<ToolResult> {
  // Response data shape: GeometryCollectionInspectResult
  const payload: Record<string, unknown> = {};
  if (args.asset_path !== undefined) payload['asset_path'] = args.asset_path;
  if (args.actor_label !== undefined) payload['actor_label'] = args.actor_label;
  return sendOrDisconnect(b, {
    type: 'chaos.geometryCollection',
    payload,
  });
}

/**
 * ue_reset_destruction handler — satisfies CHAOS-02.
 * Sends chaos.resetDestruction to the plugin; resets a geometry collection
 * actor to its initial unfractured state.
 *
 * @param args  Tool arguments including actor_label.
 * @param b     PluginBridgeClient instance (defaults to module-level singleton).
 */
export async function handleResetDestruction(
  args: { actor_label: string },
  b: PluginBridgeClient = _defaultBridge
): Promise<ToolResult> {
  // Response data shape: DestructionResetResult
  return sendOrDisconnect(b, {
    type: 'chaos.resetDestruction',
    payload: { actor_label: args.actor_label },
  });
}

/**
 * ue_read_cloth_params handler — satisfies CHAOS-03.
 * Sends chaos.cloth to the plugin; returns cloth simulation parameters
 * (stiffness, damping, friction, gravity scale, wind coefficients).
 *
 * @param args  Tool arguments — provide actor_label and/or asset_path.
 * @param b     PluginBridgeClient instance (defaults to module-level singleton).
 */
export async function handleReadClothParams(
  args: { actor_label?: string; asset_path?: string },
  b: PluginBridgeClient = _defaultBridge
): Promise<ToolResult> {
  // Response data shape: ClothParamsResult
  const payload: Record<string, unknown> = {};
  if (args.actor_label !== undefined) payload['actor_label'] = args.actor_label;
  if (args.asset_path !== undefined) payload['asset_path'] = args.asset_path;
  return sendOrDisconnect(b, {
    type: 'chaos.cloth',
    payload,
  });
}

/**
 * ue_manage_physics_cache handler — satisfies CHAOS-04.
 * Sends chaos.physicsCache to the plugin; starts, stops, or queries
 * Chaos physics cache recording state.
 *
 * @param args  Tool arguments including action and optional actor_label.
 * @param b     PluginBridgeClient instance (defaults to module-level singleton).
 */
export async function handleManagePhysicsCache(
  args: { action: 'start' | 'stop' | 'query'; actor_label?: string },
  b: PluginBridgeClient = _defaultBridge
): Promise<ToolResult> {
  // Response data shape: PhysicsCacheResult
  const payload: Record<string, unknown> = { action: args.action };
  if (args.actor_label !== undefined) payload['actor_label'] = args.actor_label;
  return sendOrDisconnect(b, {
    type: 'chaos.physicsCache',
    payload,
  });
}

// ---------------------------------------------------------------------------
// registerChaosTools
// ---------------------------------------------------------------------------

/**
 * Register UE Chaos physics management tools on the MCP server.
 *
 * All tools in this domain require the MCPBridge editor plugin.
 * When the plugin is not connected, each handler returns:
 *   { isError: true, content: [{ type: 'text', text: <plugin_not_connected JSON> }] }
 *
 * Tools registered (Phase 26):
 *   ue_inspect_geometry_collection  — CHAOS-01: Inspect fracture hierarchy and clusters
 *   ue_reset_destruction            — CHAOS-02: Reset geometry collection to unfractured state
 *   ue_read_cloth_params            — CHAOS-03: Read cloth simulation parameters
 *   ue_manage_physics_cache         — CHAOS-04: Start/stop/query physics cache recording
 *
 * @param server  The McpServer instance to register tools on.
 * @param bridge  Optional PluginBridgeClient for testing (defaults to a new instance).
 */
export function registerChaosTools(server: McpServer, bridge?: PluginBridgeClient): void {
  const b = bridge ?? new PluginBridgeClient();

  // --------------------------------------------------------------------------
  // ue_inspect_geometry_collection (CHAOS-01)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_inspect_geometry_collection',
    {
      title: 'Inspect Geometry Collection',
      description:
        "[requires_plugin] Inspect a Chaos geometry collection's fracture hierarchy, bone count, level breakdown, and damage thresholds. Provide either asset_path or actor_label.",
      inputSchema: z.object({
        asset_path: z
          .string()
          .optional()
          .describe("UE asset path to the geometry collection, e.g. '/Game/Destruction/GC_Wall'"),
        actor_label: z
          .string()
          .optional()
          .describe('Editor actor label of a placed geometry collection actor'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_inspect_geometry_collection', async (args) =>
      handleInspectGeometryCollection(args, b)
    )
  );

  // --------------------------------------------------------------------------
  // ue_reset_destruction (CHAOS-02)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_reset_destruction',
    {
      title: 'Reset Destruction State',
      description:
        '[requires_plugin] Reset a geometry collection actor to its initial unfractured state. Reverses any in-editor destruction simulation.',
      inputSchema: z.object({
        actor_label: z
          .string()
          .describe('Editor actor label of the geometry collection actor to reset'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_reset_destruction', async (args) =>
      handleResetDestruction(args, b)
    )
  );

  // --------------------------------------------------------------------------
  // ue_read_cloth_params (CHAOS-03)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_read_cloth_params',
    {
      title: 'Read Cloth Simulation Parameters',
      description:
        '[requires_plugin] Read Chaos cloth simulation parameters (stiffness, damping, friction, gravity, wind) from a skeletal mesh actor or cloth asset. Requires the ChaosCloth plugin to be enabled.',
      inputSchema: z.object({
        actor_label: z
          .string()
          .optional()
          .describe('Editor actor label of an actor with cloth simulation'),
        asset_path: z
          .string()
          .optional()
          .describe("UE asset path to a cloth asset, e.g. '/Game/Characters/Cloth_Cape'"),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_read_cloth_params', async (args) =>
      handleReadClothParams(args, b)
    )
  );

  // --------------------------------------------------------------------------
  // ue_manage_physics_cache (CHAOS-04)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_manage_physics_cache',
    {
      title: 'Manage Physics Cache',
      description:
        "[requires_plugin] Start, stop, or query Chaos physics cache recording. Use action 'start' to begin recording, 'stop' to end recording, 'query' to check status and frame count.",
      inputSchema: z.object({
        action: z
          .enum(['start', 'stop', 'query'])
          .describe("Cache operation: 'start' to begin recording, 'stop' to end, 'query' to inspect"),
        actor_label: z
          .string()
          .optional()
          .describe('Optional actor label for actor-specific cache operations'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_manage_physics_cache', async (args) =>
      handleManagePhysicsCache(args, b)
    )
  );
}
