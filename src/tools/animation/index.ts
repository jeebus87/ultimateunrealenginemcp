// src/tools/animation/index.ts
// MCP tool implementations for animation asset inspection (Phase 17).
// All tools route commands through PluginBridgeClient to the C++ MCPBridge handlers.
// Returns structured plugin_not_connected errors when the plugin is absent.
//
// Tools registered (Phase 17 — ANIM-01 through ANIM-05):
//   ue_list_animation_assets    — List all animation assets, optionally filtered by type
//   ue_inspect_anim_blueprint   — Inspect AnimBP state machines, states, and transitions
//   ue_inspect_montage          — Read montage sections, notifies, and slot assignments
//   ue_inspect_blend_space      — Inspect blend space axes, samples, and grid config
//   ue_read_retarget_mappings   — Read IK Retargeter source/target rig and chain mappings
//
// All tools require MCPBridge plugin (Phase 17 — ANIM-01 through ANIM-05).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withKnownIssues, type ToolResult } from '../known-issues/middleware.js';
import { PluginBridgeClient, PluginNotConnectedError } from '../../plugin-bridge/client.js';
// Import result types — used as documentation of the response data shapes returned by the plugin.
// The sendOrDisconnect helper returns raw JSON.stringify(response.data); callers may cast to these.
import type {
  AnimationListResult,       // ANIM-01 response shape
  AnimBlueprintInspectResult, // ANIM-02 response shape
  MontageInspectResult,      // ANIM-03 response shape
  BlendSpaceInspectResult,   // ANIM-04 response shape
  RetargetMappingsResult,    // ANIM-05 response shape
} from './types.js';

// Suppress unused-import warnings — types are referenced in JSDoc comments.
type _UnusedImports =
  | AnimationListResult
  | AnimBlueprintInspectResult
  | MontageInspectResult
  | BlendSpaceInspectResult
  | RetargetMappingsResult;

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
 * ue_list_animation_assets handler — satisfies ANIM-01.
 * Sends animation.list to the plugin; returns all animation assets, optionally filtered by type.
 *
 * @param args  Tool arguments including optional type_filter.
 * @param b     PluginBridgeClient instance (defaults to module-level singleton).
 */
export async function handleListAnimationAssets(
  args: { type_filter?: string },
  b: PluginBridgeClient = bridge
): Promise<ToolResult> {
  // Response data shape: AnimationListResult
  const payload: Record<string, unknown> = {};
  if (args.type_filter !== undefined) {
    payload['type_filter'] = args.type_filter;
  }
  return sendOrDisconnect(b, {
    type: 'animation.list',
    payload,
  });
}

/**
 * ue_inspect_anim_blueprint handler — satisfies ANIM-02.
 * Sends animation.inspectAnimBP to the plugin; returns state machines, states, transitions, and skeleton.
 *
 * @param args  Tool arguments including asset_path.
 * @param b     PluginBridgeClient instance (defaults to module-level singleton).
 */
export async function handleInspectAnimBlueprint(
  args: { asset_path: string },
  b: PluginBridgeClient = bridge
): Promise<ToolResult> {
  // Response data shape: AnimBlueprintInspectResult
  return sendOrDisconnect(b, {
    type: 'animation.inspectAnimBP',
    payload: { asset_path: args.asset_path },
  });
}

/**
 * ue_inspect_montage handler — satisfies ANIM-03.
 * Sends animation.inspectMontage to the plugin; returns sections, notifies, and slot assignments.
 *
 * @param args  Tool arguments including asset_path.
 * @param b     PluginBridgeClient instance (defaults to module-level singleton).
 */
export async function handleInspectMontage(
  args: { asset_path: string },
  b: PluginBridgeClient = bridge
): Promise<ToolResult> {
  // Response data shape: MontageInspectResult
  return sendOrDisconnect(b, {
    type: 'animation.inspectMontage',
    payload: { asset_path: args.asset_path },
  });
}

/**
 * ue_inspect_blend_space handler — satisfies ANIM-04.
 * Sends animation.inspectBlendSpace to the plugin; returns axes, samples, and grid configuration.
 *
 * @param args  Tool arguments including asset_path.
 * @param b     PluginBridgeClient instance (defaults to module-level singleton).
 */
export async function handleInspectBlendSpace(
  args: { asset_path: string },
  b: PluginBridgeClient = bridge
): Promise<ToolResult> {
  // Response data shape: BlendSpaceInspectResult
  return sendOrDisconnect(b, {
    type: 'animation.inspectBlendSpace',
    payload: { asset_path: args.asset_path },
  });
}

/**
 * ue_read_retarget_mappings handler — satisfies ANIM-05.
 * Sends animation.retargetMappings to the plugin; returns source/target rigs and chain mappings.
 *
 * @param args  Tool arguments including asset_path.
 * @param b     PluginBridgeClient instance (defaults to module-level singleton).
 */
export async function handleReadRetargetMappings(
  args: { asset_path: string },
  b: PluginBridgeClient = bridge
): Promise<ToolResult> {
  // Response data shape: RetargetMappingsResult
  return sendOrDisconnect(b, {
    type: 'animation.retargetMappings',
    payload: { asset_path: args.asset_path },
  });
}

// ---------------------------------------------------------------------------
// registerAnimationTools
// ---------------------------------------------------------------------------

/**
 * Register UE animation asset inspection tools on the MCP server.
 *
 * All tools in this domain require the MCPBridge editor plugin.
 * When the plugin is not connected, each handler returns:
 *   { isError: true, content: [{ type: 'text', text: <plugin_not_connected JSON> }] }
 *
 * Tools registered (Phase 17):
 *   ue_list_animation_assets    — ANIM-01: List animation assets filtered by type
 *   ue_inspect_anim_blueprint   — ANIM-02: Inspect AnimBP state machines and transitions
 *   ue_inspect_montage          — ANIM-03: Read montage sections, notifies, slots
 *   ue_inspect_blend_space      — ANIM-04: Inspect blend space axes and sample points
 *   ue_read_retarget_mappings   — ANIM-05: Read IK Retargeter chain mappings
 *
 * @param server  The McpServer instance to register tools on.
 * @param _bridge Optional PluginBridgeClient for testing (not used directly — handlers
 *                accept bridge injection via their exported function signatures).
 */
export function registerAnimationTools(server: McpServer, _bridge?: PluginBridgeClient): void {
  const b = _bridge ?? new PluginBridgeClient();

  // --------------------------------------------------------------------------
  // ue_list_animation_assets (ANIM-01)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_list_animation_assets',
    {
      title: 'List Animation Assets',
      description:
        '[requires_plugin] List all animation assets in the project, optionally filtered by type (AnimBlueprint, AnimMontage, BlendSpace, BlendSpace1D, AnimSequence).',
      inputSchema: z.object({
        type_filter: z
          .string()
          .optional()
          .describe(
            'Optional asset class filter: AnimBlueprint | AnimMontage | BlendSpace | BlendSpace1D | AnimSequence'
          ),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_list_animation_assets', async (args) =>
      handleListAnimationAssets(args, b)
    )
  );

  // --------------------------------------------------------------------------
  // ue_inspect_anim_blueprint (ANIM-02)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_inspect_anim_blueprint',
    {
      title: 'Inspect Animation Blueprint',
      description:
        "[requires_plugin] Inspect an Animation Blueprint's state machines, states, transitions, and skeleton.",
      inputSchema: z.object({
        asset_path: z
          .string()
          .min(1)
          .describe('UE long package path to the Animation Blueprint asset, e.g. /Game/Animations/ABP_Character'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_inspect_anim_blueprint', async (args) =>
      handleInspectAnimBlueprint(args, b)
    )
  );

  // --------------------------------------------------------------------------
  // ue_inspect_montage (ANIM-03)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_inspect_montage',
    {
      title: 'Inspect Montage',
      description:
        '[requires_plugin] Read montage sections, notifies (with trigger times), and slot assignments.',
      inputSchema: z.object({
        asset_path: z
          .string()
          .min(1)
          .describe('UE long package path to the Animation Montage asset, e.g. /Game/Animations/AM_Attack'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_inspect_montage', async (args) =>
      handleInspectMontage(args, b)
    )
  );

  // --------------------------------------------------------------------------
  // ue_inspect_blend_space (ANIM-04)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_inspect_blend_space',
    {
      title: 'Inspect Blend Space',
      description:
        '[requires_plugin] Inspect blend space axes, sample points, and grid configuration.',
      inputSchema: z.object({
        asset_path: z
          .string()
          .min(1)
          .describe('UE long package path to the BlendSpace or BlendSpace1D asset, e.g. /Game/Animations/BS_Movement'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_inspect_blend_space', async (args) =>
      handleInspectBlendSpace(args, b)
    )
  );

  // --------------------------------------------------------------------------
  // ue_read_retarget_mappings (ANIM-05)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_read_retarget_mappings',
    {
      title: 'Read Retarget Mappings',
      description:
        '[requires_plugin] Read IK Retargeter source/target skeleton rigs and chain mappings.',
      inputSchema: z.object({
        asset_path: z
          .string()
          .min(1)
          .describe('UE long package path to the IK Retargeter asset, e.g. /Game/Animations/RTG_CharacterRetarget'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_read_retarget_mappings', async (args) =>
      handleReadRetargetMappings(args, b)
    )
  );
}
