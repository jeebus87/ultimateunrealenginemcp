// src/tools/input/index.ts
// MCP tool implementations for Enhanced Input Management (Phase 14).
// All tools route commands through PluginBridgeClient to the C++ MCPBridge plugin.

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
// registerInputTools
// ---------------------------------------------------------------------------

/**
 * Register UE Enhanced Input Management tools on the MCP server.
 *
 * All tools in this domain require the MCPBridge editor plugin.
 * When the plugin is not connected, each handler returns:
 *   { isError: true, content: [{ type: 'text', text: <plugin_not_connected JSON> }] }
 *
 * Tools registered (Phase 14):
 *   ue_list_input_actions     — List all UInputAction assets with value types
 *   ue_create_input_action    — Create a new UInputAction asset
 *   ue_list_input_contexts    — List all UInputMappingContext assets with bindings
 *   ue_add_input_binding      — Add or update a key binding in a UInputMappingContext
 *
 * @param server  The McpServer instance to register tools on.
 * @param bridge  Optional PluginBridgeClient for testing (defaults to a new instance).
 */
export function registerInputTools(server: McpServer, bridge?: PluginBridgeClient): void {
  const _bridge = bridge ?? PluginBridgeClient.shared();

  // --------------------------------------------------------------------------
  // ue_list_input_actions
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_list_input_actions',
    {
      title: 'List Input Actions',
      description:
        '[requires_plugin] List all UInputAction assets in the project with their value types (bool, float, Axis2D, Axis3D).',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_list_input_actions', async (_args) => {
      return sendOrDisconnect(_bridge, { type: 'input.listActions' });
    })
  );

  // --------------------------------------------------------------------------
  // ue_create_input_action
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_create_input_action',
    {
      title: 'Create Input Action',
      description:
        '[requires_plugin] Create a new UInputAction asset at the given content path with the specified value type.',
      inputSchema: z.object({
        asset_path: z.string().describe('Content-browser package path, e.g. /Game/Input/IA_Jump'),
        value_type: z
          .enum(['bool', 'float', 'Axis2D', 'Axis3D'])
          .describe('Input action value type'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_create_input_action', async (args) => {
      return sendOrDisconnect(_bridge, {
        type: 'input.createAction',
        payload: { asset_path: args.asset_path, value_type: args.value_type },
      });
    })
  );

  // --------------------------------------------------------------------------
  // ue_list_input_contexts
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_list_input_contexts',
    {
      title: 'List Input Mapping Contexts',
      description:
        '[requires_plugin] List all UInputMappingContext assets in the project with their action-to-key bindings.',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_list_input_contexts', async (_args) => {
      return sendOrDisconnect(_bridge, { type: 'input.listContexts' });
    })
  );

  // --------------------------------------------------------------------------
  // ue_add_input_binding
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_add_input_binding',
    {
      title: 'Add Input Binding',
      description:
        '[requires_plugin] Add or update a key binding in a UInputMappingContext. Maps an Input Action to a keyboard/gamepad key.',
      inputSchema: z.object({
        asset_path: z
          .string()
          .describe('Package path of the UInputMappingContext, e.g. /Game/Input/IMC_Default'),
        action_path: z
          .string()
          .describe('Package path of the UInputAction to bind, e.g. /Game/Input/IA_Jump'),
        key: z
          .string()
          .describe('Key name as a UE FKey string, e.g. SpaceBar, Gamepad_FaceButton_Bottom'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_add_input_binding', async (args) => {
      return sendOrDisconnect(_bridge, {
        type: 'input.addBinding',
        payload: {
          asset_path: args.asset_path,
          action_path: args.action_path,
          key: args.key,
        },
      });
    })
  );
}
