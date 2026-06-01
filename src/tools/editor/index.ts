// src/tools/editor/index.ts
// Real tool implementations for UE Editor actor/asset operations (Phase 9).
// All tools route commands through PluginBridgeClient to the C++ MCPBridge plugin.
// Returns structured plugin_not_connected errors (not crashes) when plugin is absent.

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
// registerEditorTools
// ---------------------------------------------------------------------------

/**
 * Register UE Editor actor/asset tools on the MCP server.
 *
 * All tools in this domain require the MCPBridge editor plugin.
 * When the plugin is not connected, each handler returns:
 *   { isError: true, content: [{ type: 'text', text: <plugin_not_connected JSON> }] }
 *
 * Tools registered (Phase 9 — real implementations):
 *   ue_list_actors        — List actors in the current level
 *   ue_spawn_actor        — Spawn a new actor in the level
 *   ue_transform_actor    — Move, rotate, and/or scale an existing actor
 *   ue_delete_actor       — Delete an actor from the level
 *   ue_query_assets       — Query the UE asset registry
 *   ue_trace_references   — Trace asset reference graph
 *   ue_read_level_layout  — Read the open level structure
 *
 * @param server  The McpServer instance to register tools on.
 * @param bridge  Optional PluginBridgeClient for testing (defaults to a new instance).
 */
export function registerEditorTools(server: McpServer, bridge?: PluginBridgeClient): void {
  const _bridge = bridge ?? PluginBridgeClient.shared();

  // --------------------------------------------------------------------------
  // ue_list_actors
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_list_actors',
    {
      title: 'List UE Actors',
      description:
        '[requires_plugin] List all actors in the currently open UE Editor level.',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_list_actors', async (_args) => {
      return sendOrDisconnect(_bridge, { type: 'actor.list' });
    })
  );

  // --------------------------------------------------------------------------
  // ue_spawn_actor
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_spawn_actor',
    {
      title: 'Spawn UE Actor',
      description:
        '[requires_plugin] Spawn a new actor in the currently open UE Editor level at the specified location.',
      inputSchema: z.object({
        class_name: z.string().describe('The actor class to spawn (e.g., AStaticMeshActor)'),
        location: z.object({
          x: z.number().describe('X coordinate in Unreal units (cm)'),
          y: z.number().describe('Y coordinate in Unreal units (cm)'),
          z: z.number().describe('Z coordinate in Unreal units (cm)'),
        }).describe('World-space location to spawn the actor at'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_spawn_actor', async (args) => {
      return sendOrDisconnect(_bridge, {
        type: 'actor.spawn',
        payload: { class_name: args.class_name, location: args.location },
      });
    })
  );

  // --------------------------------------------------------------------------
  // ue_transform_actor  (Phase 9 — adds scale field; renamed from Phase 1 stub)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_transform_actor',
    {
      title: 'Transform UE Actor',
      description:
        '[requires_plugin] Move, rotate, and/or scale an existing actor in the currently open UE Editor level.',
      inputSchema: z.object({
        actor_label: z.string().describe('The editor label of the actor to transform'),
        location: z
          .object({
            x: z.number().describe('X coordinate in Unreal units (cm)'),
            y: z.number().describe('Y coordinate in Unreal units (cm)'),
            z: z.number().describe('Z coordinate in Unreal units (cm)'),
          })
          .optional()
          .describe('New world-space location (optional — omit to keep current location)'),
        rotation: z
          .object({
            pitch: z.number().describe('Pitch angle in degrees'),
            yaw: z.number().describe('Yaw angle in degrees'),
            roll: z.number().describe('Roll angle in degrees'),
          })
          .optional()
          .describe('New rotation in degrees (optional — omit to keep current rotation)'),
        scale: z
          .object({
            x: z.number().describe('X scale factor'),
            y: z.number().describe('Y scale factor'),
            z: z.number().describe('Z scale factor'),
          })
          .optional()
          .describe('New 3D scale (optional, default 1.0 per axis)'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_transform_actor', async (args) => {
      const payload: Record<string, unknown> = { actor_label: args.actor_label };
      if (args.location) payload['location'] = args.location;
      if (args.rotation) payload['rotation'] = args.rotation;
      if (args.scale)    payload['scale']    = args.scale;
      return sendOrDisconnect(_bridge, { type: 'actor.transform', payload });
    })
  );

  // --------------------------------------------------------------------------
  // ue_delete_actor
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_delete_actor',
    {
      title: 'Delete UE Actor',
      description:
        '[requires_plugin] Delete an actor from the currently open UE Editor level. This operation is destructive.',
      inputSchema: z.object({
        actor_label: z.string().describe('The editor label of the actor to delete'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
      },
    },
    withKnownIssues('ue_delete_actor', async (args) => {
      return sendOrDisconnect(_bridge, {
        type: 'actor.delete',
        payload: { actor_label: args.actor_label },
      });
    })
  );

  // --------------------------------------------------------------------------
  // ue_query_assets
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_query_assets',
    {
      title: 'Query UE Assets',
      description:
        '[requires_plugin] Query the UE asset registry for assets matching optional filters (type, path prefix, tag).',
      inputSchema: z.object({
        asset_type: z
          .string()
          .optional()
          .describe('Asset class name to filter by (e.g., StaticMesh, Blueprint)'),
        path_prefix: z
          .string()
          .optional()
          .describe('Asset path prefix to filter by (e.g., /Game/Meshes/)'),
        tag: z
          .string()
          .optional()
          .describe('Asset tag key to filter by'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_query_assets', async (args) => {
      // Map TS-friendly names to the C++ handler's expected field names.
      // C++ expects 'asset_class' (not 'asset_type') and 'tag_key' (not 'tag').
      const payload: Record<string, unknown> = {};
      if (args.asset_type)  payload['asset_class'] = args.asset_type;
      if (args.path_prefix) payload['path_prefix'] = args.path_prefix;
      if (args.tag)         payload['tag_key']     = args.tag;
      return sendOrDisconnect(_bridge, { type: 'asset.query', payload });
    })
  );

  // --------------------------------------------------------------------------
  // ue_trace_references  (new tool — EDT-06)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_trace_references',
    {
      title: 'Trace UE Asset References',
      description:
        '[requires_plugin] Trace the reference graph for a given asset — what it depends on and what depends on it.',
      inputSchema: z.object({
        package_path: z.string().describe('Asset package path (e.g. /Game/Meshes/SM_Rock)'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_trace_references', async (args) => {
      return sendOrDisconnect(_bridge, {
        type: 'asset.references',
        payload: { package_path: args.package_path },
      });
    })
  );

  // --------------------------------------------------------------------------
  // ue_read_level_layout  (new tool — EDT-07)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_read_level_layout',
    {
      title: 'Read UE Level Layout',
      description:
        '[requires_plugin] Read the open level structure — placed actors, streaming sublevels, and world partition status.',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_read_level_layout', async (_args) => {
      return sendOrDisconnect(_bridge, { type: 'level.layout' });
    })
  );
}
