// src/tools/collision-physics/index.ts
// MCP tool implementations for collision and physics configuration (Phase 20).
// All tools route commands through PluginBridgeClient to the C++ MCPBridge plugin.
// Returns structured plugin_not_connected errors when the plugin is absent.
//
// Tools registered (Phase 20 — PHY-01 through PHY-04):
//   ue_read_collision              — Read collision preset, enabled state, object type, and per-channel responses
//   ue_set_collision               — Set collision preset and/or individual channel response overrides
//   ue_manage_physical_material    — Read or modify physical material properties (friction, restitution, density)
//   ue_inspect_physics_asset       — Inspect physics asset per-bone body setup (capsules, spheres, boxes)
//
// All tools require MCPBridge plugin (Phase 20 — PHY-01 through PHY-04).

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
// registerCollisionPhysicsTools
// ---------------------------------------------------------------------------

/**
 * Register UE collision and physics configuration tools on the MCP server.
 *
 * All tools in this domain require the MCPBridge editor plugin.
 * When the plugin is not connected, each handler returns:
 *   { isError: true, content: [{ type: 'text', text: <plugin_not_connected JSON> }] }
 *
 * Tools registered (Phase 20):
 *   ue_read_collision              — Read collision preset and channel responses on a component (PHY-01)
 *   ue_set_collision               — Set collision preset and channel responses (PHY-02)
 *   ue_manage_physical_material    — Read/set physical material properties (PHY-03)
 *   ue_inspect_physics_asset       — Inspect physics asset body setup per bone (PHY-04)
 *
 * @param server  The McpServer instance to register tools on.
 * @param bridge  Optional PluginBridgeClient for testing (defaults to a new instance).
 */
export function registerCollisionPhysicsTools(server: McpServer, bridge?: PluginBridgeClient): void {
  const _bridge = bridge ?? PluginBridgeClient.shared();

  // --------------------------------------------------------------------------
  // ue_read_collision (PHY-01)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_read_collision',
    {
      title: 'Read Collision Settings',
      description:
        '[requires_plugin] Read collision preset, enabled state, object type, and per-channel response map from a primitive component on an actor.',
      inputSchema: z.object({
        actor_label: z
          .string()
          .describe('Editor actor label'),
        component_name: z
          .string()
          .optional()
          .describe('Component name; defaults to first UPrimitiveComponent if omitted'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_read_collision', async (args) => {
      const payload: Record<string, unknown> = { actor_label: args.actor_label };
      if (args.component_name !== undefined) payload['component_name'] = args.component_name;
      return sendOrDisconnect(_bridge, { type: 'collision.read', payload });
    })
  );

  // --------------------------------------------------------------------------
  // ue_set_collision (PHY-02)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_set_collision',
    {
      title: 'Set Collision Settings',
      description:
        "[requires_plugin] Set collision preset and/or individual channel response overrides on a primitive component. Returns updated collision state.",
      inputSchema: z.object({
        actor_label: z
          .string()
          .describe('Editor actor label'),
        component_name: z
          .string()
          .optional()
          .describe('Component name; defaults to first UPrimitiveComponent if omitted'),
        preset: z
          .string()
          .optional()
          .describe("Collision preset profile name, e.g. 'BlockAll', 'OverlapAll', 'NoCollision'"),
        responses: z
          .array(
            z.object({
              channel: z.number(),
              response: z.enum(['Ignore', 'Overlap', 'Block']),
            })
          )
          .optional()
          .describe('Per-channel response overrides; channel is ECollisionChannel int value'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_set_collision', async (args) => {
      const payload: Record<string, unknown> = { actor_label: args.actor_label };
      if (args.component_name !== undefined) payload['component_name'] = args.component_name;
      if (args.preset !== undefined) payload['preset'] = args.preset;
      if (args.responses !== undefined) payload['responses'] = args.responses;
      return sendOrDisconnect(_bridge, { type: 'collision.set', payload });
    })
  );

  // --------------------------------------------------------------------------
  // ue_manage_physical_material (PHY-03)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_manage_physical_material',
    {
      title: 'Read/Set Physical Material Properties',
      description:
        "[requires_plugin] Read or modify physical material properties (friction, restitution, density, surface type). Use action 'read' to inspect, 'write' to modify.",
      inputSchema: z.object({
        asset_path: z
          .string()
          .describe("UE asset path to the UPhysicalMaterial, e.g. '/Game/PhysMats/PM_Rock'"),
        action: z
          .enum(['read', 'write'])
          .describe("Operation to perform: 'read' to inspect, 'write' to modify"),
        friction: z
          .number()
          .optional(),
        static_friction: z
          .number()
          .optional(),
        restitution: z
          .number()
          .optional(),
        density: z
          .number()
          .optional(),
        surface_type: z
          .number()
          .optional()
          .describe('EPhysicalSurface enum value'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_manage_physical_material', async (args) => {
      const payload: Record<string, unknown> = {
        asset_path: args.asset_path,
        action: args.action,
      };
      if (args.friction !== undefined) payload['friction'] = args.friction;
      if (args.static_friction !== undefined) payload['static_friction'] = args.static_friction;
      if (args.restitution !== undefined) payload['restitution'] = args.restitution;
      if (args.density !== undefined) payload['density'] = args.density;
      if (args.surface_type !== undefined) payload['surface_type'] = args.surface_type;
      return sendOrDisconnect(_bridge, { type: 'physics.material', payload });
    })
  );

  // --------------------------------------------------------------------------
  // ue_inspect_physics_asset (PHY-04)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_inspect_physics_asset',
    {
      title: 'Inspect Physics Asset Bodies',
      description:
        "[requires_plugin] Inspect a physics asset's per-bone body setup including primitive shapes (capsules, spheres, boxes), dimensions, and mass configuration.",
      inputSchema: z.object({
        asset_path: z
          .string()
          .describe("UE asset path to the UPhysicsAsset, e.g. '/Game/Characters/SK_Mannequin_PhysicsAsset'"),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_inspect_physics_asset', async (args) => {
      return sendOrDisconnect(_bridge, {
        type: 'physics.asset',
        payload: { asset_path: args.asset_path },
      });
    })
  );
}
