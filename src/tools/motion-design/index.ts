// src/tools/motion-design/index.ts
// MCP tool implementations for Motion Design (Phase 28).
// All tools route commands through PluginBridgeClient to the C++ MCPBridge handlers.
// Returns structured plugin_not_connected errors when the plugin is absent.
//
// Tools registered (Phase 28 — MD-01 through MD-04):
//   ue_list_scene_states          — List Motion Design Scene State machines with their states
//   ue_trigger_scene_transition   — Trigger a Scene State transition with optional property overrides
//   ue_inspect_transition_logic   — Inspect a Transition Logic asset's sequences and layer changes
//   ue_manage_remote_control      — Read or modify Remote Control preset properties and functions
//
// All tools require MCPBridge plugin with Motion Design (Avalanche) plugin enabled (MD-01..04).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withKnownIssues, type ToolResult } from '../known-issues/middleware.js';
import { PluginBridgeClient, PluginNotConnectedError } from '../../plugin-bridge/client.js';
// Import result types — used as documentation of the response data shapes returned by the plugin.
// The sendOrDisconnect helper returns raw JSON.stringify(response.data); callers may cast to these.
import type {
  SceneStatesResult,         // MD-01 response shape
  SceneTransitionResult,     // MD-02 response shape
  TransitionLogicResult,     // MD-03 response shape
  RemoteControlResult,       // MD-04 response shape
} from './types.js';

// Suppress unused-import warnings — types are referenced in JSDoc comments.
type _UnusedImports =
  | SceneStatesResult
  | SceneTransitionResult
  | TransitionLogicResult
  | RemoteControlResult;

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
 * ue_list_scene_states handler — satisfies MD-01.
 * Sends motiondesign.sceneStates to the plugin; returns all Scene State machines
 * with their states and categories.
 *
 * @param args  Tool arguments including optional rundown_path.
 * @param b     PluginBridgeClient instance (defaults to module-level singleton).
 */
export async function handleListSceneStates(
  args: { rundown_path?: string },
  b: PluginBridgeClient = bridge
): Promise<ToolResult> {
  // Response data shape: SceneStatesResult
  const payload: Record<string, unknown> = {};
  if (args.rundown_path !== undefined) {
    payload['rundown_path'] = args.rundown_path;
  }
  return sendOrDisconnect(b, {
    type: 'motiondesign.sceneStates',
    payload,
  });
}

/**
 * ue_trigger_scene_transition handler — satisfies MD-02.
 * Sends motiondesign.transition to the plugin; triggers a Scene State transition
 * with optional property overrides.
 *
 * @param args  Tool arguments including rundown_path, target_state, and optional properties.
 * @param b     PluginBridgeClient instance (defaults to module-level singleton).
 */
export async function handleTriggerSceneTransition(
  args: { rundown_path: string; target_state: string; properties?: Record<string, unknown> },
  b: PluginBridgeClient = bridge
): Promise<ToolResult> {
  // Response data shape: SceneTransitionResult
  return sendOrDisconnect(b, {
    type: 'motiondesign.transition',
    payload: {
      rundown_path: args.rundown_path,
      target_state: args.target_state,
      ...(args.properties !== undefined && { properties: args.properties }),
    },
  });
}

/**
 * ue_inspect_transition_logic handler — satisfies MD-03.
 * Sends motiondesign.transitionLogic to the plugin; returns transition sequences,
 * in/out labels, and layer change definitions.
 *
 * @param args  Tool arguments including asset_path.
 * @param b     PluginBridgeClient instance (defaults to module-level singleton).
 */
export async function handleInspectTransitionLogic(
  args: { asset_path: string },
  b: PluginBridgeClient = bridge
): Promise<ToolResult> {
  // Response data shape: TransitionLogicResult
  return sendOrDisconnect(b, {
    type: 'motiondesign.transitionLogic',
    payload: { asset_path: args.asset_path },
  });
}

/**
 * ue_manage_remote_control handler — satisfies MD-04.
 * Sends motiondesign.remoteControl to the plugin; reads or modifies Remote Control
 * preset properties, or triggers exposed functions.
 *
 * @param args  Tool arguments including preset_path, action, and optional field params.
 * @param b     PluginBridgeClient instance (defaults to module-level singleton).
 */
export async function handleManageRemoteControl(
  args: {
    preset_path: string;
    action: string;
    property_name?: string;
    value?: unknown;
    function_name?: string;
    args?: Record<string, unknown>;
  },
  b: PluginBridgeClient = bridge
): Promise<ToolResult> {
  // Response data shape: RemoteControlResult
  return sendOrDisconnect(b, {
    type: 'motiondesign.remoteControl',
    payload: {
      preset_path: args.preset_path,
      action: args.action,
      ...(args.property_name !== undefined && { property_name: args.property_name }),
      ...(args.value !== undefined && { value: args.value }),
      ...(args.function_name !== undefined && { function_name: args.function_name }),
      ...(args.args !== undefined && { args: args.args }),
    },
  });
}

// ---------------------------------------------------------------------------
// registerMotionDesignTools
// ---------------------------------------------------------------------------

/**
 * Register UE Motion Design tools on the MCP server.
 *
 * All tools in this domain require the MCPBridge editor plugin with the
 * Motion Design (Avalanche) plugin enabled.
 * When the plugin is not connected, each handler returns:
 *   { isError: true, content: [{ type: 'text', text: <plugin_not_connected JSON> }] }
 *
 * Tools registered (Phase 28):
 *   ue_list_scene_states          — MD-01: List Scene State machines and their states
 *   ue_trigger_scene_transition   — MD-02: Trigger Scene State transitions with property overrides
 *   ue_inspect_transition_logic   — MD-03: Inspect Transition Logic sequences and layer changes
 *   ue_manage_remote_control      — MD-04: Read/modify Remote Control preset properties and functions
 *
 * @param server  The McpServer instance to register tools on.
 * @param _bridge Optional PluginBridgeClient for testing (not used directly — handlers
 *                accept bridge injection via their exported function signatures).
 */
export function registerMotionDesignTools(server: McpServer, _bridge?: PluginBridgeClient): void {
  const b = _bridge ?? PluginBridgeClient.shared();

  // --------------------------------------------------------------------------
  // ue_list_scene_states (MD-01)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_list_scene_states',
    {
      title: 'List Scene States',
      description:
        '[requires_plugin] List Motion Design Scene State machines with their states and categories. Requires the Motion Design (Avalanche) plugin to be enabled.',
      inputSchema: z.object({
        rundown_path: z
          .string()
          .optional()
          .describe('Optional UE path to a specific rundown; omit to list all'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_list_scene_states', async (args) =>
      handleListSceneStates(args, b)
    )
  );

  // --------------------------------------------------------------------------
  // ue_trigger_scene_transition (MD-02)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_trigger_scene_transition',
    {
      title: 'Trigger Scene Transition',
      description:
        '[requires_plugin] Trigger a Scene State transition with optional property overrides. Requires the Motion Design (Avalanche) plugin to be enabled.',
      inputSchema: z.object({
        rundown_path: z
          .string()
          .min(1)
          .describe('UE path to the rundown'),
        target_state: z
          .string()
          .min(1)
          .describe('Name of the target state to transition to'),
        properties: z
          .record(z.unknown())
          .optional()
          .describe('Optional property key-value overrides to apply during transition'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_trigger_scene_transition', async (args) =>
      handleTriggerSceneTransition(args, b)
    )
  );

  // --------------------------------------------------------------------------
  // ue_inspect_transition_logic (MD-03)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_inspect_transition_logic',
    {
      title: 'Inspect Transition Logic',
      description:
        "[requires_plugin] Inspect a Transition Logic asset's sequences, in/out labels, and layer changes. Requires the Motion Design (Avalanche) plugin to be enabled.",
      inputSchema: z.object({
        asset_path: z
          .string()
          .min(1)
          .describe(
            'UE long package path to the Transition Logic asset, e.g. /Game/MotionDesign/TL_MainShow'
          ),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_inspect_transition_logic', async (args) =>
      handleInspectTransitionLogic(args, b)
    )
  );

  // --------------------------------------------------------------------------
  // ue_manage_remote_control (MD-04)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_manage_remote_control',
    {
      title: 'Manage Remote Control',
      description:
        '[requires_plugin] Read or modify Remote Control preset properties, or trigger exposed functions.',
      inputSchema: z.object({
        preset_path: z
          .string()
          .min(1)
          .describe('UE path to the Remote Control preset asset'),
        action: z
          .enum(['list', 'get', 'set', 'call'])
          .describe(
            'Operation: list properties/functions, get/set a property value, or call a function'
          ),
        property_name: z
          .string()
          .optional()
          .describe('Property name (required for get/set actions)'),
        value: z
          .unknown()
          .optional()
          .describe('Value to set (required for set action)'),
        function_name: z
          .string()
          .optional()
          .describe('Function name (required for call action)'),
        args: z
          .record(z.unknown())
          .optional()
          .describe('Arguments for function call (optional for call action)'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_manage_remote_control', async (args) =>
      handleManageRemoteControl(args, b)
    )
  );
}
