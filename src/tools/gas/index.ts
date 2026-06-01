// src/tools/gas/index.ts
// MCP tool implementations for Gameplay Ability System asset inspection (Phase 25).
// All tools route commands through PluginBridgeClient to the C++ MCPBridge handlers.
// Returns structured plugin_not_connected errors when the plugin is absent.
//
// Tools registered (Phase 25 — GAS-01 through GAS-04):
//   ue_list_abilities             — List Gameplay Ability classes with tags, costs, and cooldowns
//   ue_inspect_gameplay_effect    — Inspect Gameplay Effect modifiers, duration, and stacking
//   ue_read_attribute_set         — Read Attribute Set definitions with base values and clamping
//   ue_query_gameplay_tags        — Query Gameplay Tag hierarchy and find tagged assets
//
// All tools require MCPBridge plugin (Phase 25 — GAS-01 through GAS-04).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withKnownIssues, type ToolResult } from '../known-issues/middleware.js';
import { PluginBridgeClient, PluginNotConnectedError } from '../../plugin-bridge/client.js';
// Import result types — used as documentation of the response data shapes returned by the plugin.
// The sendOrDisconnect helper returns raw JSON.stringify(response.data); callers may cast to these.
import type {
  AbilityListResult,             // GAS-01 response shape
  GameplayEffectInspectResult,   // GAS-02 response shape
  AttributeSetReadResult,        // GAS-03 response shape
  GameplayTagQueryResult,        // GAS-04 response shape
} from './types.js';

// Suppress unused-import warnings — types are referenced in JSDoc comments.
type _UnusedImports =
  | AbilityListResult
  | GameplayEffectInspectResult
  | AttributeSetReadResult
  | GameplayTagQueryResult;

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
 * ue_list_abilities handler — satisfies GAS-01.
 * Sends gas.abilities to the plugin; returns all Gameplay Ability classes with
 * tags, cost/cooldown effect references, and instancing policy.
 *
 * @param args  Tool arguments including optional class_filter.
 * @param b     PluginBridgeClient instance (defaults to module-level singleton).
 */
export async function handleListAbilities(
  args: { class_filter?: string },
  b: PluginBridgeClient = bridge
): Promise<ToolResult> {
  // Response data shape: AbilityListResult
  const payload: Record<string, unknown> = {};
  if (args.class_filter !== undefined) {
    payload['class_filter'] = args.class_filter;
  }
  return sendOrDisconnect(b, {
    type: 'gas.abilities',
    payload,
  });
}

/**
 * ue_inspect_gameplay_effect handler — satisfies GAS-02.
 * Sends gas.effects to the plugin; returns modifiers, duration policy,
 * stacking configuration, period interval, and Gameplay Cue tags.
 *
 * @param args  Tool arguments including asset_path.
 * @param b     PluginBridgeClient instance (defaults to module-level singleton).
 */
export async function handleInspectGameplayEffect(
  args: { asset_path: string },
  b: PluginBridgeClient = bridge
): Promise<ToolResult> {
  // Response data shape: GameplayEffectInspectResult
  return sendOrDisconnect(b, {
    type: 'gas.effects',
    payload: { asset_path: args.asset_path },
  });
}

/**
 * ue_read_attribute_set handler — satisfies GAS-03.
 * Sends gas.attributes to the plugin; returns all Attribute Set properties
 * with base values, replication status, and clamping information.
 *
 * @param args  Tool arguments including asset_path.
 * @param b     PluginBridgeClient instance (defaults to module-level singleton).
 */
export async function handleReadAttributeSet(
  args: { asset_path: string },
  b: PluginBridgeClient = bridge
): Promise<ToolResult> {
  // Response data shape: AttributeSetReadResult
  return sendOrDisconnect(b, {
    type: 'gas.attributes',
    payload: { asset_path: args.asset_path },
  });
}

/**
 * ue_query_gameplay_tags handler — satisfies GAS-04.
 * Sends gas.tags to the plugin; returns matching tag paths from the hierarchy
 * and optionally finds all assets that reference a specific tag.
 *
 * @param args  Tool arguments including optional tag_filter and find_assets_with_tag.
 * @param b     PluginBridgeClient instance (defaults to module-level singleton).
 */
export async function handleQueryGameplayTags(
  args: { tag_filter?: string; find_assets_with_tag?: string },
  b: PluginBridgeClient = bridge
): Promise<ToolResult> {
  // Response data shape: GameplayTagQueryResult
  const payload: Record<string, unknown> = {
    tag_filter: args.tag_filter ?? '',
  };
  if (args.find_assets_with_tag !== undefined) {
    payload['find_assets_with_tag'] = args.find_assets_with_tag;
  }
  return sendOrDisconnect(b, {
    type: 'gas.tags',
    payload,
  });
}

// ---------------------------------------------------------------------------
// registerGASTools
// ---------------------------------------------------------------------------

/**
 * Register UE Gameplay Ability System inspection tools on the MCP server.
 *
 * All tools in this domain require the MCPBridge editor plugin.
 * When the plugin is not connected, each handler returns:
 *   { isError: true, content: [{ type: 'text', text: <plugin_not_connected JSON> }] }
 *
 * Tools registered (Phase 25):
 *   ue_list_abilities             — GAS-01: List ability classes with tags, costs, and instancing
 *   ue_inspect_gameplay_effect    — GAS-02: Inspect effect modifiers, duration, stacking
 *   ue_read_attribute_set         — GAS-03: Read Attribute Set definitions with base values
 *   ue_query_gameplay_tags        — GAS-04: Query tag hierarchy and find tagged assets
 *
 * @param server  The McpServer instance to register tools on.
 * @param _bridge Optional PluginBridgeClient for testing (not used directly — handlers
 *                accept bridge injection via their exported function signatures).
 */
export function registerGASTools(server: McpServer, _bridge?: PluginBridgeClient): void {
  const b = _bridge ?? PluginBridgeClient.shared();

  // --------------------------------------------------------------------------
  // ue_list_abilities (GAS-01)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_list_abilities',
    {
      title: 'List Gameplay Abilities',
      description:
        '[requires_plugin] List all Gameplay Ability classes in the project with their tags, cost/cooldown effect references, and instancing policy.',
      inputSchema: z.object({
        class_filter: z
          .string()
          .optional()
          .describe('Optional substring to filter ability class names (e.g. "Melee" matches GA_MeleeAttack)'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_list_abilities', async (args) =>
      handleListAbilities(args, b)
    )
  );

  // --------------------------------------------------------------------------
  // ue_inspect_gameplay_effect (GAS-02)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_inspect_gameplay_effect',
    {
      title: 'Inspect Gameplay Effect',
      description:
        '[requires_plugin] Inspect a Gameplay Effect asset\'s modifiers, duration policy, stacking configuration, and period interval.',
      inputSchema: z.object({
        asset_path: z
          .string()
          .min(1)
          .describe('UE long package path to the Gameplay Effect asset, e.g. /Game/GAS/GE_DealDamage'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_inspect_gameplay_effect', async (args) =>
      handleInspectGameplayEffect(args, b)
    )
  );

  // --------------------------------------------------------------------------
  // ue_read_attribute_set (GAS-03)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_read_attribute_set',
    {
      title: 'Read Attribute Set',
      description:
        '[requires_plugin] Read an Attribute Set class\'s attributes with base values, replication status, and clamping information.',
      inputSchema: z.object({
        asset_path: z
          .string()
          .min(1)
          .describe('UE long package path to the Attribute Set asset, e.g. /Game/GAS/AS_Character'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_read_attribute_set', async (args) =>
      handleReadAttributeSet(args, b)
    )
  );

  // --------------------------------------------------------------------------
  // ue_query_gameplay_tags (GAS-04)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_query_gameplay_tags',
    {
      title: 'Query Gameplay Tags',
      description:
        '[requires_plugin] Query the Gameplay Tag hierarchy by filter and optionally find all assets that reference a specific tag.',
      inputSchema: z.object({
        tag_filter: z
          .string()
          .optional()
          .describe('Optional tag prefix or substring to filter results (e.g. "Ability.Melee" returns all melee ability tags)'),
        find_assets_with_tag: z
          .string()
          .optional()
          .describe('Optional exact tag path to perform a reverse lookup — returns all assets referencing this tag'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_query_gameplay_tags', async (args) =>
      handleQueryGameplayTags(args, b)
    )
  );
}
