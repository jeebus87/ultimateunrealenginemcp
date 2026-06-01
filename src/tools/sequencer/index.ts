// src/tools/sequencer/index.ts
// MCP tool implementations for Sequencer & Cinematics operations (Phase 13).
// All tools route commands through PluginBridgeClient to the C++ MCPBridge plugin.
// Returns structured plugin_not_connected errors when the plugin is absent.
//
// Tools registered (Phase 13 — SEQ-01 through SEQ-05):
//   ue_create_sequence        — Create a new Level Sequence asset
//   ue_list_sequence_tracks   — List all tracks in a Level Sequence
//   ue_add_sequence_track     — Add a transform or float track to an actor
//   ue_add_keyframe           — Add a keyframe at a given frame on a track
//   ue_sequence_playback      — Control Level Sequence playback (play/pause/stop/scrub)
//
// All tools require MCPBridge plugin (Phase 13 — SEQ-01 through SEQ-05).

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
// registerSequencerTools
// ---------------------------------------------------------------------------

/**
 * Register UE Sequencer & Cinematics tools on the MCP server.
 *
 * All tools in this domain require the MCPBridge editor plugin.
 * When the plugin is not connected, each handler returns:
 *   { isError: true, content: [{ type: 'text', text: <plugin_not_connected JSON> }] }
 *
 * Tools registered (Phase 13):
 *   ue_create_sequence        — Create a new Level Sequence asset
 *   ue_list_sequence_tracks   — List all tracks in a Level Sequence
 *   ue_add_sequence_track     — Add a property or transform track for an actor
 *   ue_add_keyframe           — Add a keyframe at a specified frame on a track
 *   ue_sequence_playback      — Control Level Sequence playback
 *
 * @param server  The McpServer instance to register tools on.
 * @param bridge  Optional PluginBridgeClient for testing (defaults to a new instance).
 */
export function registerSequencerTools(server: McpServer, bridge?: PluginBridgeClient): void {
  const _bridge = bridge ?? PluginBridgeClient.shared();

  // --------------------------------------------------------------------------
  // ue_create_sequence
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_create_sequence',
    {
      title: 'Create Level Sequence',
      description:
        '[requires_plugin] Create a new Level Sequence asset at the specified content path and open it in the Sequencer editor.',
      inputSchema: z.object({
        asset_path: z
          .string()
          .min(1)
          .describe('Content browser path for the new sequence, e.g. /Game/Cinematics/MySequence'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_create_sequence', async (args) => {
      return sendOrDisconnect(_bridge, {
        type: 'sequencer.create',
        payload: { asset_path: args.asset_path },
      });
    })
  );

  // --------------------------------------------------------------------------
  // ue_list_sequence_tracks
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_list_sequence_tracks',
    {
      title: 'List Sequence Tracks',
      description:
        '[requires_plugin] List all tracks in a Level Sequence with bound objects, track type, section count, and key count.',
      inputSchema: z.object({
        asset_path: z
          .string()
          .min(1)
          .describe('Content browser path to the Level Sequence asset'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_list_sequence_tracks', async (args) => {
      return sendOrDisconnect(_bridge, {
        type: 'sequencer.tracks',
        payload: { asset_path: args.asset_path },
      });
    })
  );

  // --------------------------------------------------------------------------
  // ue_add_sequence_track
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_add_sequence_track',
    {
      title: 'Add Sequence Track',
      description:
        '[requires_plugin] Add a property or transform track to a Level Sequence for a given actor.',
      inputSchema: z.object({
        asset_path: z.string().min(1),
        actor_label: z
          .string()
          .min(1)
          .describe('Display label of the actor to bind the track to'),
        track_type: z
          .enum(['transform', 'float'])
          .describe('Track type: transform (3D transform track) or float (generic float property track)'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_add_sequence_track', async (args) => {
      return sendOrDisconnect(_bridge, {
        type: 'sequencer.addTrack',
        payload: {
          asset_path: args.asset_path,
          actor_label: args.actor_label,
          track_type: args.track_type,
        },
      });
    })
  );

  // --------------------------------------------------------------------------
  // ue_add_keyframe
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_add_keyframe',
    {
      title: 'Add Keyframe',
      description:
        '[requires_plugin] Add a keyframe at a specified frame number on an existing track in a Level Sequence.',
      inputSchema: z.object({
        asset_path: z.string().min(1),
        track_type: z
          .enum(['transform', 'float'])
          .describe('Type of track to add keyframe to'),
        frame: z
          .number()
          .int()
          .min(0)
          .describe('Frame number (integer, 0-based at sequence display rate)'),
        value: z
          .number()
          .optional()
          .describe('Keyframe value for float tracks (ignored for transform tracks, defaults 0.0)'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_add_keyframe', async (args) => {
      const payload: Record<string, unknown> = {
        asset_path: args.asset_path,
        track_type: args.track_type,
        frame: args.frame,
      };
      if (args.value !== undefined) {
        payload['value'] = args.value;
      }
      return sendOrDisconnect(_bridge, { type: 'sequencer.addKey', payload });
    })
  );

  // --------------------------------------------------------------------------
  // ue_sequence_playback
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_sequence_playback',
    {
      title: 'Sequence Playback Control',
      description:
        '[requires_plugin] Control Level Sequence playback — play, pause, stop, or scrub to a specific frame.',
      inputSchema: z.object({
        asset_path: z.string().min(1),
        action: z
          .enum(['play', 'pause', 'stop', 'scrub'])
          .describe('Playback action: play, pause, stop, or scrub to a frame'),
        frame: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Target frame number for scrub action'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_sequence_playback', async (args) => {
      const payload: Record<string, unknown> = {
        asset_path: args.asset_path,
        action: args.action,
      };
      if (args.frame !== undefined) {
        payload['frame'] = args.frame;
      }
      return sendOrDisconnect(_bridge, { type: 'sequencer.playback', payload });
    })
  );
}
