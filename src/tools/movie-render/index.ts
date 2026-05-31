// src/tools/movie-render/index.ts
// MCP tool implementations for Movie Render Pipeline operations (Phase 29).
// All tools route commands through PluginBridgeClient to the C++ MCPBridge handlers.
// Returns structured plugin_not_connected errors when the plugin is absent.
//
// Tools registered (Phase 29 — MRP-01 through MRP-04):
//   ue_list_render_queue      — List all render queue jobs with status and output settings
//   ue_add_render_job         — Add a render job with sequence, format, resolution, and frame range
//   ue_control_render_queue   — Start, stop, or query progress of the render queue
//   ue_configure_render_output — Configure burn-in text, EXR metadata, and filename format tokens
//
// All tools require MCPBridge plugin (Phase 29 — MRP-01 through MRP-04).

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
// registerMovieRenderTools
// ---------------------------------------------------------------------------

/**
 * Register UE Movie Render Pipeline tools on the MCP server.
 *
 * All tools in this domain require the MCPBridge editor plugin with the
 * Movie Render Pipeline plugin enabled.
 * When the plugin is not connected, each handler returns:
 *   { isError: true, content: [{ type: 'text', text: <plugin_not_connected JSON> }] }
 *
 * Tools registered (Phase 29):
 *   ue_list_render_queue       — MRP-01: List render queue jobs with status and output settings
 *   ue_add_render_job          — MRP-02: Add a render job with sequence, format, resolution
 *   ue_control_render_queue    — MRP-03: Start, stop, or query progress of render queue
 *   ue_configure_render_output — MRP-04: Configure burn-in, EXR metadata, and filename tokens
 *
 * @param server  The McpServer instance to register tools on.
 * @param bridge  Optional PluginBridgeClient for testing (defaults to a new instance).
 */
export function registerMovieRenderTools(server: McpServer, bridge?: PluginBridgeClient): void {
  const _bridge = bridge ?? new PluginBridgeClient();

  // --------------------------------------------------------------------------
  // ue_list_render_queue (MRP-01)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_list_render_queue',
    {
      title: 'List Render Queue',
      description:
        '[requires_plugin] List all render queue jobs with their status, sequence path, output format, resolution, and progress percentage.',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_list_render_queue', async (_args) =>
      sendOrDisconnect(_bridge, {
        type: 'movierender.queue',
        payload: {},
      })
    )
  );

  // --------------------------------------------------------------------------
  // ue_add_render_job (MRP-02)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_add_render_job',
    {
      title: 'Add Render Job',
      description:
        '[requires_plugin] Add a render job to the queue with the specified Level Sequence, output format, resolution, and frame range.',
      inputSchema: z.object({
        sequence_path: z
          .string()
          .min(1)
          .describe(
            "Content path to the Level Sequence asset, e.g. /Game/Cinematics/MySequence"
          ),
        output_directory: z
          .string()
          .optional()
          .describe("Output directory path (defaults to {project}/Saved/MovieRenders)"),
        format: z
          .enum(['png', 'exr', 'jpeg', 'avi'])
          .optional()
          .describe('Output image format (default: png)'),
        resolution_x: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Output width in pixels (default: 1920)'),
        resolution_y: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Output height in pixels (default: 1080)'),
        frame_start: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Start frame number (default: 0)'),
        frame_end: z
          .number()
          .int()
          .optional()
          .describe('End frame number (default: -1, uses sequence range)'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_add_render_job', async (args) => {
      const payload: Record<string, unknown> = {
        sequence_path: args.sequence_path,
      };
      if (args.output_directory !== undefined) payload['output_directory'] = args.output_directory;
      if (args.format !== undefined) payload['format'] = args.format;
      if (args.resolution_x !== undefined) payload['resolution_x'] = args.resolution_x;
      if (args.resolution_y !== undefined) payload['resolution_y'] = args.resolution_y;
      if (args.frame_start !== undefined) payload['frame_start'] = args.frame_start;
      if (args.frame_end !== undefined) payload['frame_end'] = args.frame_end;
      return sendOrDisconnect(_bridge, {
        type: 'movierender.addJob',
        payload,
      });
    })
  );

  // --------------------------------------------------------------------------
  // ue_control_render_queue (MRP-03)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_control_render_queue',
    {
      title: 'Control Render Queue',
      description:
        '[requires_plugin] Start, stop, or query progress of the Movie Render Pipeline render queue.',
      inputSchema: z.object({
        action: z
          .enum(['start', 'stop', 'progress'])
          .describe(
            'Queue control action: start rendering, stop/cancel, or query progress'
          ),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_control_render_queue', async (args) =>
      sendOrDisconnect(_bridge, {
        type: 'movierender.control',
        payload: { action: args.action },
      })
    )
  );

  // --------------------------------------------------------------------------
  // ue_configure_render_output (MRP-04)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_configure_render_output',
    {
      title: 'Configure Render Output',
      description:
        '[requires_plugin] Configure burn-in text, EXR metadata, and output filename format tokens for a render job.',
      inputSchema: z.object({
        sequence_path: z
          .string()
          .min(1)
          .describe('Content path to the Level Sequence of the job to configure'),
        burn_in_text: z
          .record(z.string(), z.string())
          .optional()
          .describe('Key-value pairs for burn-in text overlay fields'),
        exr_metadata: z
          .record(z.string(), z.string())
          .optional()
          .describe('Key-value pairs for EXR file metadata'),
        filename_format: z
          .string()
          .optional()
          .describe(
            'Output filename token pattern, e.g. {sequence_name}_{frame_number}'
          ),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_configure_render_output', async (args) => {
      const payload: Record<string, unknown> = {
        sequence_path: args.sequence_path,
      };
      if (args.burn_in_text !== undefined) payload['burn_in_text'] = args.burn_in_text;
      if (args.exr_metadata !== undefined) payload['exr_metadata'] = args.exr_metadata;
      if (args.filename_format !== undefined) payload['filename_format'] = args.filename_format;
      return sendOrDisconnect(_bridge, {
        type: 'movierender.configure',
        payload,
      });
    })
  );
}
