// src/tools/audio/index.ts
// MCP tool implementations for audio asset inspection (Phase 23).
// All tools route commands through PluginBridgeClient to the C++ MCPBridge handlers.
// Returns structured plugin_not_connected errors when the plugin is absent.
//
// Tools registered (Phase 23 — AUD-01 through AUD-04):
//   ue_list_sound_assets      — List all sound assets, optionally filtered by type
//   ue_inspect_metasound      — Inspect MetaSound patch graph nodes, edges, inputs, outputs
//   ue_inspect_sound_cue      — Read SoundCue node graph structure and attenuation settings
//   ue_query_audio_insights   — Query Audio Insights monitoring data (active sounds, events)
//
// All tools require MCPBridge plugin (Phase 23 — AUD-01 through AUD-04).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withKnownIssues, type ToolResult } from '../known-issues/middleware.js';
import { PluginBridgeClient, PluginNotConnectedError } from '../../plugin-bridge/client.js';
// Import result types — used as documentation of the response data shapes returned by the plugin.
// The sendOrDisconnect helper returns raw JSON.stringify(response.data); callers may cast to these.
import type {
  SoundAssetListResult,     // AUD-01 response shape
  MetaSoundInspectResult,   // AUD-02 response shape
  SoundCueInspectResult,    // AUD-03 response shape
  AudioInsightsResult,      // AUD-04 response shape
} from './types.js';

// Suppress unused-import warnings — types are referenced in JSDoc comments.
type _UnusedImports =
  | SoundAssetListResult
  | MetaSoundInspectResult
  | SoundCueInspectResult
  | AudioInsightsResult;

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
 * ue_list_sound_assets handler — satisfies AUD-01.
 * Sends audio.list to the plugin; returns all sound assets, optionally filtered by type.
 *
 * @param args  Tool arguments including optional type_filter.
 * @param b     PluginBridgeClient instance (defaults to bridge created in registerAudioTools).
 */
export async function handleListSoundAssets(
  args: { type_filter?: 'SoundWave' | 'SoundCue' | 'MetaSound' },
  b?: PluginBridgeClient
): Promise<ToolResult> {
  const bridge = b ?? PluginBridgeClient.shared();
  // Response data shape: SoundAssetListResult
  const payload: Record<string, unknown> = {};
  if (args.type_filter !== undefined) {
    payload['type_filter'] = args.type_filter;
  }
  return sendOrDisconnect(bridge, {
    type: 'audio.list',
    payload,
  });
}

/**
 * ue_inspect_metasound handler — satisfies AUD-02.
 * Sends audio.metasound to the plugin; returns graph nodes, edges, inputs, and outputs.
 *
 * @param args  Tool arguments including asset_path.
 * @param b     PluginBridgeClient instance (defaults to bridge created in registerAudioTools).
 */
export async function handleInspectMetasound(
  args: { asset_path: string },
  b?: PluginBridgeClient
): Promise<ToolResult> {
  const bridge = b ?? PluginBridgeClient.shared();
  // Response data shape: MetaSoundInspectResult
  return sendOrDisconnect(bridge, {
    type: 'audio.metasound',
    payload: { asset_path: args.asset_path },
  });
}

/**
 * ue_inspect_sound_cue handler — satisfies AUD-03.
 * Sends audio.soundcue to the plugin; returns recursive node tree and attenuation settings.
 *
 * @param args  Tool arguments including asset_path.
 * @param b     PluginBridgeClient instance (defaults to bridge created in registerAudioTools).
 */
export async function handleInspectSoundCue(
  args: { asset_path: string },
  b?: PluginBridgeClient
): Promise<ToolResult> {
  const bridge = b ?? PluginBridgeClient.shared();
  // Response data shape: SoundCueInspectResult
  return sendOrDisconnect(bridge, {
    type: 'audio.soundcue',
    payload: { asset_path: args.asset_path },
  });
}

/**
 * ue_query_audio_insights handler — satisfies AUD-04.
 * Sends audio.insights to the plugin; returns monitoring data or informative unavailable message.
 *
 * @param args  No required parameters (empty object).
 * @param b     PluginBridgeClient instance (defaults to bridge created in registerAudioTools).
 */
export async function handleQueryAudioInsights(
  args: Record<string, never>,
  b?: PluginBridgeClient
): Promise<ToolResult> {
  const bridge = b ?? PluginBridgeClient.shared();
  // Response data shape: AudioInsightsResult
  return sendOrDisconnect(bridge, {
    type: 'audio.insights',
    payload: {},
  });
}

// ---------------------------------------------------------------------------
// registerAudioTools
// ---------------------------------------------------------------------------

/**
 * Register UE audio asset inspection and monitoring tools on the MCP server.
 *
 * All tools in this domain require the MCPBridge editor plugin.
 * When the plugin is not connected, each handler returns:
 *   { isError: true, content: [{ type: 'text', text: <plugin_not_connected JSON> }] }
 *
 * Tools registered (Phase 23):
 *   ue_list_sound_assets      — AUD-01: List sound assets filtered by type
 *   ue_inspect_metasound      — AUD-02: Inspect MetaSound patch graph nodes and connections
 *   ue_inspect_sound_cue      — AUD-03: Read SoundCue node graph and attenuation settings
 *   ue_query_audio_insights   — AUD-04: Query Audio Insights monitoring data
 *
 * @param server  The McpServer instance to register tools on.
 * @param bridge  Optional PluginBridgeClient for testing (injected into handler calls).
 */
export function registerAudioTools(server: McpServer, bridge?: PluginBridgeClient): void {
  const b = bridge ?? PluginBridgeClient.shared();

  // --------------------------------------------------------------------------
  // ue_list_sound_assets (AUD-01)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_list_sound_assets',
    {
      title: 'List Sound Assets',
      description:
        '[requires_plugin] List all sound assets in the project, optionally filtered by type (SoundWave, SoundCue, MetaSound). Returns asset paths, names, types, and audio properties.',
      inputSchema: z.object({
        type_filter: z
          .enum(['SoundWave', 'SoundCue', 'MetaSound'])
          .optional()
          .describe('Filter by sound asset type. Omit to list all types.'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_list_sound_assets', async (args) =>
      handleListSoundAssets(args, b)
    )
  );

  // --------------------------------------------------------------------------
  // ue_inspect_metasound (AUD-02)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_inspect_metasound',
    {
      title: 'Inspect MetaSound Patch',
      description:
        "[requires_plugin] Inspect a MetaSound patch's graph nodes, connections, input pins, and output pins.",
      inputSchema: z.object({
        asset_path: z
          .string()
          .min(1)
          .describe('UE content path to the MetaSound asset, e.g. /Game/Audio/MS_Ambience'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_inspect_metasound', async (args) =>
      handleInspectMetasound(args, b)
    )
  );

  // --------------------------------------------------------------------------
  // ue_inspect_sound_cue (AUD-03)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_inspect_sound_cue',
    {
      title: 'Inspect Sound Cue',
      description:
        "[requires_plugin] Read a SoundCue's node graph structure, configured parameters (volume, pitch), and attenuation settings.",
      inputSchema: z.object({
        asset_path: z
          .string()
          .min(1)
          .describe('UE content path to the SoundCue asset, e.g. /Game/Audio/SC_Footstep'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_inspect_sound_cue', async (args) =>
      handleInspectSoundCue(args, b)
    )
  );

  // --------------------------------------------------------------------------
  // ue_query_audio_insights (AUD-04)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_query_audio_insights',
    {
      title: 'Query Audio Insights',
      description:
        '[requires_plugin] Query Audio Insights monitoring data including active sound count, max channels, and recent audio events. Returns informative message if Audio Insights plugin is not enabled.',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_query_audio_insights', async (args) =>
      handleQueryAudioInsights(args as Record<string, never>, b)
    )
  );
}
