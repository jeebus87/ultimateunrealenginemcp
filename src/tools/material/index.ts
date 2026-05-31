// src/tools/material/index.ts
// MCP tool implementations for material parameter inspection and material instance creation (Phase 15).
// All tools route commands through PluginBridgeClient to the C++ MCPBridge plugin.
// Returns structured plugin_not_connected errors when the plugin is absent.

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
// registerMaterialTools
// ---------------------------------------------------------------------------

/**
 * Register UE material parameter inspection and material instance tools on the MCP server.
 *
 * All tools in this domain require the MCPBridge editor plugin.
 * When the plugin is not connected, each handler returns:
 *   { isError: true, content: [{ type: 'text', text: <plugin_not_connected JSON> }] }
 *
 * Tools registered (Phase 15):
 *   ue_material_params           — Read all parameters from a material or material instance
 *   ue_create_material_instance  — Create a new Material Instance Constant asset from a parent material
 *   ue_set_material_param        — Set a scalar, vector, or texture parameter on a material instance
 *   ue_actor_materials           — List all material asset paths used by an actor or static mesh
 *
 * @param server  The McpServer instance to register tools on.
 * @param bridge  Optional PluginBridgeClient for testing (defaults to a new instance).
 */
export function registerMaterialTools(server: McpServer, bridge?: PluginBridgeClient): void {
  const _bridge = bridge ?? new PluginBridgeClient();

  // --------------------------------------------------------------------------
  // ue_material_params
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_material_params',
    {
      title: 'Read Material Parameters',
      description:
        '[requires_plugin] Read all scalar, vector, and texture parameters from a material asset or material instance. Returns parameter name, type, current value, and default value.',
      inputSchema: z.object({
        asset_path: z
          .string()
          .describe('UE asset path to the material or material instance, e.g. "/Game/Materials/M_Rock"'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_material_params', async (args) => {
      return sendOrDisconnect(_bridge, {
        type: 'material.params',
        payload: { asset_path: args.asset_path },
      });
    })
  );

  // --------------------------------------------------------------------------
  // ue_create_material_instance
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_create_material_instance',
    {
      title: 'Create Material Instance',
      description:
        '[requires_plugin] Create a new Material Instance Constant asset from a parent material. The instance is saved to disk as a persistent UE asset.',
      inputSchema: z.object({
        parent_path: z
          .string()
          .describe('UE asset path of the parent material, e.g. "/Game/Materials/M_Rock"'),
        instance_path: z
          .string()
          .describe('Package path (directory) for the new instance, e.g. "/Game/Materials". Must start with /Game/.'),
        instance_name: z
          .string()
          .describe('Asset name for the new instance, e.g. "MI_Rock_Red"'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_create_material_instance', async (args) => {
      return sendOrDisconnect(_bridge, {
        type: 'material.createInstance',
        payload: {
          parent_path: args.parent_path,
          instance_path: args.instance_path,
          instance_name: args.instance_name,
        },
      });
    })
  );

  // --------------------------------------------------------------------------
  // ue_set_material_param
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_set_material_param',
    {
      title: 'Set Material Instance Parameter',
      description:
        '[requires_plugin] Set a scalar, vector, or texture parameter override on a Material Instance Constant. The value type must match param_type.',
      inputSchema: z.object({
        asset_path: z
          .string()
          .describe('UE asset path to the Material Instance Constant'),
        param_name: z
          .string()
          .describe('Parameter name as defined in the parent material'),
        param_type: z
          .enum(['scalar', 'vector', 'texture'])
          .describe('Parameter type: scalar (float), vector (RGBA), or texture (asset path string)'),
        value: z
          .union([
            z.number(),
            z.object({
              r: z.number(),
              g: z.number(),
              b: z.number(),
              a: z.number().optional(),
            }),
            z.string(),
          ])
          .describe('Parameter value: number for scalar, {r,g,b,a} object for vector, asset path string for texture'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_set_material_param', async (args) => {
      return sendOrDisconnect(_bridge, {
        type: 'material.setParam',
        payload: {
          asset_path: args.asset_path,
          param_name: args.param_name,
          param_type: args.param_type,
          value: args.value,
        },
      });
    })
  );

  // --------------------------------------------------------------------------
  // ue_actor_materials
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_actor_materials',
    {
      title: 'List Actor or Mesh Materials',
      description:
        '[requires_plugin] List all material asset paths used by an actor in the open level or by a Static Mesh asset. Provide either actor_label or asset_path.',
      inputSchema: z.object({
        actor_label: z
          .string()
          .optional()
          .describe('Label of the actor in the open level (e.g. "StaticMeshActor_0"). Provide this OR asset_path.'),
        asset_path: z
          .string()
          .optional()
          .describe('UE asset path to a Static Mesh asset (e.g. "/Game/Meshes/SM_Rock"). Provide this OR actor_label.'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_actor_materials', async (args) => {
      const payload: Record<string, unknown> = {};
      if (args.actor_label) payload['actor_label'] = args.actor_label;
      if (args.asset_path) payload['asset_path'] = args.asset_path;
      return sendOrDisconnect(_bridge, { type: 'material.actorMaterials', payload });
    })
  );
}
