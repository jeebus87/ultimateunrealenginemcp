// src/tools/ai-systems/index.ts
// MCP tool implementations for AI system asset inspection (Phase 22).
// All tools route commands through PluginBridgeClient to the C++ MCPBridge handlers.
// Returns structured plugin_not_connected errors when the plugin is absent.
//
// Tools registered (Phase 22 — AI-01 through AI-05):
//   ue_inspect_behavior_tree  — Inspect BT node hierarchy, decorators, and services
//   ue_inspect_state_tree     — Read State Tree states, transitions, and tasks
//   ue_inspect_blackboard     — List Blackboard keys with types and instance-sync status
//   ue_inspect_eqs            — Inspect EQS query templates: generators, tests, scoring
//   ue_query_navmesh          — Query NavMesh build status, bounds, and point reachability
//
// All tools require MCPBridge plugin (Phase 22 — AI-01 through AI-05).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withKnownIssues, type ToolResult } from '../known-issues/middleware.js';
import { PluginBridgeClient, PluginNotConnectedError } from '../../plugin-bridge/client.js';
// Import result types — used as documentation of the response data shapes returned by the plugin.
// The sendOrDisconnect helper returns raw JSON.stringify(response.data); callers may cast to these.
import type {
  BehaviorTreeInspectResult, // AI-01 response shape
  StateTreeInspectResult,    // AI-02 response shape
  BlackboardInspectResult,   // AI-03 response shape
  EQSInspectResult,          // AI-04 response shape
  NavMeshQueryResult,        // AI-05 response shape
} from './types.js';

// Suppress unused-import warnings — types are referenced in JSDoc comments.
type _UnusedImports =
  | BehaviorTreeInspectResult
  | StateTreeInspectResult
  | BlackboardInspectResult
  | EQSInspectResult
  | NavMeshQueryResult;

// Module-level bridge instance — injected in tests via exported handler signatures.
const bridge = new PluginBridgeClient();

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
 * ue_inspect_behavior_tree handler — satisfies AI-01.
 * Sends ai.behaviorTree to the plugin; returns node hierarchy, decorators, and services.
 *
 * @param args  Tool arguments including asset_path.
 * @param b     PluginBridgeClient instance (defaults to module-level singleton).
 */
export async function handleInspectBehaviorTree(
  args: { asset_path: string },
  b: PluginBridgeClient = bridge
): Promise<ToolResult> {
  // Response data shape: BehaviorTreeInspectResult
  return sendOrDisconnect(b, {
    type: 'ai.behaviorTree',
    payload: { asset_path: args.asset_path },
  });
}

/**
 * ue_inspect_state_tree handler — satisfies AI-02.
 * Sends ai.stateTree to the plugin; returns states, transitions, and tasks.
 *
 * @param args  Tool arguments including asset_path.
 * @param b     PluginBridgeClient instance (defaults to module-level singleton).
 */
export async function handleInspectStateTree(
  args: { asset_path: string },
  b: PluginBridgeClient = bridge
): Promise<ToolResult> {
  // Response data shape: StateTreeInspectResult
  return sendOrDisconnect(b, {
    type: 'ai.stateTree',
    payload: { asset_path: args.asset_path },
  });
}

/**
 * ue_inspect_blackboard handler — satisfies AI-03.
 * Sends ai.blackboard to the plugin; returns Blackboard keys with types and instance-sync status.
 *
 * @param args  Tool arguments including asset_path.
 * @param b     PluginBridgeClient instance (defaults to module-level singleton).
 */
export async function handleInspectBlackboard(
  args: { asset_path: string },
  b: PluginBridgeClient = bridge
): Promise<ToolResult> {
  // Response data shape: BlackboardInspectResult
  return sendOrDisconnect(b, {
    type: 'ai.blackboard',
    payload: { asset_path: args.asset_path },
  });
}

/**
 * ue_inspect_eqs handler — satisfies AI-04.
 * Sends ai.eqs to the plugin; returns EQS generator classes, tests, and scoring configuration.
 *
 * @param args  Tool arguments including asset_path.
 * @param b     PluginBridgeClient instance (defaults to module-level singleton).
 */
export async function handleInspectEqs(
  args: { asset_path: string },
  b: PluginBridgeClient = bridge
): Promise<ToolResult> {
  // Response data shape: EQSInspectResult
  return sendOrDisconnect(b, {
    type: 'ai.eqs',
    payload: { asset_path: args.asset_path },
  });
}

/**
 * ue_query_navmesh handler — satisfies AI-05.
 * Sends ai.navmesh to the plugin; returns NavMesh build status, bounds, and optional
 * point-to-point reachability when both start_point and end_point are provided.
 *
 * @param args  Tool arguments including optional start_point and end_point.
 * @param b     PluginBridgeClient instance (defaults to module-level singleton).
 */
export async function handleQueryNavmesh(
  args: {
    start_point?: { x: number; y: number; z: number };
    end_point?: { x: number; y: number; z: number };
  },
  b: PluginBridgeClient = bridge
): Promise<ToolResult> {
  // Response data shape: NavMeshQueryResult
  const payload: Record<string, unknown> = {};
  if (args.start_point !== undefined && args.end_point !== undefined) {
    payload['start_point'] = args.start_point;
    payload['end_point'] = args.end_point;
  }
  return sendOrDisconnect(b, {
    type: 'ai.navmesh',
    payload,
  });
}

// ---------------------------------------------------------------------------
// registerAISystemsTools
// ---------------------------------------------------------------------------

/**
 * Register UE AI system inspection tools on the MCP server.
 *
 * All tools in this domain require the MCPBridge editor plugin.
 * When the plugin is not connected, each handler returns:
 *   { isError: true, content: [{ type: 'text', text: <plugin_not_connected JSON> }] }
 *
 * Tools registered (Phase 22):
 *   ue_inspect_behavior_tree  — AI-01: Inspect BT node hierarchy with decorators and services
 *   ue_inspect_state_tree     — AI-02: Read State Tree states, transitions, and tasks
 *   ue_inspect_blackboard     — AI-03: List Blackboard keys with types and instance-sync status
 *   ue_inspect_eqs            — AI-04: Inspect EQS query generators, tests, and scoring
 *   ue_query_navmesh          — AI-05: Query NavMesh status, bounds, and reachability
 *
 * @param server  The McpServer instance to register tools on.
 * @param _bridge Optional PluginBridgeClient for testing (not used directly — handlers
 *                accept bridge injection via their exported function signatures).
 */
export function registerAISystemsTools(server: McpServer, _bridge?: PluginBridgeClient): void {
  const b = _bridge ?? new PluginBridgeClient();

  // --------------------------------------------------------------------------
  // ue_inspect_behavior_tree (AI-01)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_inspect_behavior_tree',
    {
      title: 'Inspect Behavior Tree',
      description:
        '[requires_plugin] Inspect a Behavior Tree asset\'s node hierarchy, decorators, and services.',
      inputSchema: z.object({
        asset_path: z
          .string()
          .min(1)
          .describe('UE long package path to the Behavior Tree asset, e.g. /Game/AI/BT_EnemyLogic'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_inspect_behavior_tree', async (args) =>
      handleInspectBehaviorTree(args, b)
    )
  );

  // --------------------------------------------------------------------------
  // ue_inspect_state_tree (AI-02)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_inspect_state_tree',
    {
      title: 'Inspect State Tree',
      description:
        '[requires_plugin] Read a State Tree\'s states, transitions, and tasks.',
      inputSchema: z.object({
        asset_path: z
          .string()
          .min(1)
          .describe('UE long package path to the State Tree asset, e.g. /Game/AI/ST_NPCBehavior'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_inspect_state_tree', async (args) =>
      handleInspectStateTree(args, b)
    )
  );

  // --------------------------------------------------------------------------
  // ue_inspect_blackboard (AI-03)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_inspect_blackboard',
    {
      title: 'Inspect Blackboard',
      description:
        '[requires_plugin] List all Blackboard keys with their types, default values, and instance-sync status.',
      inputSchema: z.object({
        asset_path: z
          .string()
          .min(1)
          .describe('UE long package path to the Blackboard Data asset, e.g. /Game/AI/BB_EnemyData'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_inspect_blackboard', async (args) =>
      handleInspectBlackboard(args, b)
    )
  );

  // --------------------------------------------------------------------------
  // ue_inspect_eqs (AI-04)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_inspect_eqs',
    {
      title: 'Inspect EQS Query',
      description:
        '[requires_plugin] Inspect an Environment Query System template\'s generators, tests, and scoring configuration.',
      inputSchema: z.object({
        asset_path: z
          .string()
          .min(1)
          .describe('UE long package path to the EQS query asset, e.g. /Game/AI/EQS_FindCover'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_inspect_eqs', async (args) =>
      handleInspectEqs(args, b)
    )
  );

  // --------------------------------------------------------------------------
  // ue_query_navmesh (AI-05)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_query_navmesh',
    {
      title: 'Query NavMesh',
      description:
        '[requires_plugin] Query NavMesh build status, bounds, and optionally test reachability between two points.',
      inputSchema: z.object({
        start_point: z
          .object({ x: z.number(), y: z.number(), z: z.number() })
          .optional()
          .describe('Optional start point for reachability test'),
        end_point: z
          .object({ x: z.number(), y: z.number(), z: z.number() })
          .optional()
          .describe('Optional end point for reachability test'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_query_navmesh', async (args) =>
      handleQueryNavmesh(args, b)
    )
  );
}
