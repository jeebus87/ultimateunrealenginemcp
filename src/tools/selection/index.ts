// src/tools/selection/index.ts
// MCP tool implementations for Actor Selection and Duplication (Phase 19).
// All tools route commands through PluginBridgeClient to the C++ MCPBridge handlers.
// Returns structured plugin_not_connected errors when the plugin is absent.
//
// Tools registered (Phase 19 — SEL-01 through SEL-04):
//   ue_select_actors     — Select or deselect actors by name, label, or class
//   ue_get_selection     — Get current editor selection or change selection mode
//   ue_duplicate_actors  — Duplicate selected actors with optional position offset
//   ue_convert_actor     — Convert an actor to a different class
//
// All tools require MCPBridge plugin (Phase 19 — SEL-01 through SEL-04).

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
// registerSelectionTools
// ---------------------------------------------------------------------------

/**
 * Register UE actor selection and duplication tools on the MCP server.
 *
 * All tools in this domain require the MCPBridge editor plugin.
 * When the plugin is not connected, each handler returns:
 *   { isError: true, content: [{ type: 'text', text: <plugin_not_connected JSON> }] }
 *
 * Tools registered (Phase 19):
 *   ue_select_actors    — SEL-01: Select or deselect actors by name, label, or class
 *   ue_get_selection    — SEL-02: Get current editor selection or change selection mode
 *   ue_duplicate_actors — SEL-03: Duplicate selected actors with optional offset
 *   ue_convert_actor    — SEL-04: Convert an actor to a different class
 *
 * @param server  The McpServer instance to register tools on.
 * @param bridge  Optional PluginBridgeClient for testing (defaults to a new instance).
 */
export function registerSelectionTools(server: McpServer, bridge?: PluginBridgeClient): void {
  const _bridge = bridge ?? new PluginBridgeClient();

  // --------------------------------------------------------------------------
  // ue_select_actors (SEL-01)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_select_actors',
    {
      title: 'Select Actors',
      description:
        "[requires_plugin] Select or deselect actors in the editor by name, label, or class. Supports wildcard patterns (e.g. 'Light*').",
      inputSchema: z.object({
        actors: z
          .array(z.string())
          .optional()
          .describe('Actor labels or names to match. Supports wildcards like Light*'),
        class_filter: z
          .string()
          .optional()
          .describe('Select all actors of this class, e.g. StaticMeshActor'),
        action: z
          .enum(['select', 'deselect'])
          .default('select')
          .describe('Whether to select or deselect matched actors'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_select_actors', async (args) => {
      const payload: Record<string, unknown> = {};
      if (args.actors !== undefined) payload['actors'] = args.actors;
      if (args.class_filter !== undefined) payload['class_filter'] = args.class_filter;
      if (args.action !== undefined) payload['action'] = args.action;
      return sendOrDisconnect(_bridge, { type: 'selection.select', payload });
    })
  );

  // --------------------------------------------------------------------------
  // ue_get_selection (SEL-02)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_get_selection',
    {
      title: 'Get/Set Actor Selection',
      description:
        "[requires_plugin] Get the current editor actor selection. Optionally change selection mode: 'all' selects everything, 'none' clears selection, 'invert' toggles each actor.",
      inputSchema: z.object({
        mode: z
          .enum(['current', 'all', 'none', 'invert'])
          .default('current')
          .describe('Selection mode: current (read only), all, none, or invert'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_get_selection', async (args) => {
      return sendOrDisconnect(_bridge, {
        type: 'selection.get',
        payload: { mode: args.mode },
      });
    })
  );

  // --------------------------------------------------------------------------
  // ue_duplicate_actors (SEL-03)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_duplicate_actors',
    {
      title: 'Duplicate Selected Actors',
      description:
        '[requires_plugin] Duplicate all currently selected actors in the editor with an optional position offset. Defaults to offset (100, 0, 0) if not specified.',
      inputSchema: z.object({
        offset: z
          .object({
            x: z.number().default(100),
            y: z.number().default(0),
            z: z.number().default(0),
          })
          .optional()
          .describe('Position offset for duplicated actors in UE units'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_duplicate_actors', async (args) => {
      return sendOrDisconnect(_bridge, {
        type: 'selection.duplicate',
        payload: { offset: args.offset ?? { x: 100, y: 0, z: 0 } },
      });
    })
  );

  // --------------------------------------------------------------------------
  // ue_convert_actor (SEL-04)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_convert_actor',
    {
      title: 'Convert Actor Class',
      description:
        "[requires_plugin] Convert an actor to a different class (e.g. StaticMeshActor to a Blueprint class). The actor is replaced with a new instance of the target class at the same transform.",
      inputSchema: z.object({
        actor_label: z
          .string()
          .describe('Label of the actor to convert'),
        target_class: z
          .string()
          .describe(
            "Target class name (e.g. 'StaticMeshActor') or full path (e.g. '/Game/BP_MyActor.BP_MyActor_C')"
          ),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
      },
    },
    withKnownIssues('ue_convert_actor', async (args) => {
      return sendOrDisconnect(_bridge, {
        type: 'selection.convert',
        payload: { actor_label: args.actor_label, target_class: args.target_class },
      });
    })
  );
}
