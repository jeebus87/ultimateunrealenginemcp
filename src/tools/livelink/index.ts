// src/tools/livelink/index.ts
// MCP tool implementations for Live Link source/subject management (Phase 27).
// All tools route commands through PluginBridgeClient to the C++ MCPBridge handlers.
// Returns structured plugin_not_connected errors when the plugin is absent.
//
// Tools registered (Phase 27 — LL-01 through LL-04):
//   ue_list_livelink_sources    — List all active Live Link sources with connection status
//   ue_list_livelink_subjects   — List all Live Link subjects with roles and enabled state
//   ue_control_livelink_subject — Pause or resume an individual Live Link subject
//   ue_preview_livelink_data    — Inspect current frame data for a Live Link subject
//
// All tools require MCPBridge plugin (Phase 27 — LL-01 through LL-04).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withKnownIssues, type ToolResult } from '../known-issues/middleware.js';
import { PluginBridgeClient, PluginNotConnectedError } from '../../plugin-bridge/client.js';
// Import result types — used as documentation of the response data shapes returned by the plugin.
// The sendOrDisconnect helper returns raw JSON.stringify(response.data); callers may cast to these.
import type {
  LiveLinkSourcesResult,    // LL-01 response shape
  LiveLinkSubjectsResult,   // LL-02 response shape
  LiveLinkControlResult,    // LL-03 response shape
  LiveLinkPreviewResult,    // LL-04 response shape
} from './types.js';

// Suppress unused-import warnings — types are referenced in JSDoc comments.
type _UnusedImports =
  | LiveLinkSourcesResult
  | LiveLinkSubjectsResult
  | LiveLinkControlResult
  | LiveLinkPreviewResult;

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
 * ue_list_livelink_sources handler — satisfies LL-01.
 * Sends livelink.sources to the plugin; returns all active Live Link sources
 * with connection status, source type, and machine name.
 *
 * @param args  Tool arguments (no parameters required).
 * @param b     PluginBridgeClient instance (defaults to module-level singleton).
 */
export async function handleListLiveLinkSources(
  args: Record<string, never>,
  b: PluginBridgeClient = bridge
): Promise<ToolResult> {
  // Response data shape: LiveLinkSourcesResult
  void args; // no parameters
  return sendOrDisconnect(b, {
    type: 'livelink.sources',
    payload: {},
  });
}

/**
 * ue_list_livelink_subjects handler — satisfies LL-02.
 * Sends livelink.subjects to the plugin; returns all Live Link subjects
 * with their roles (Animation, Transform, Camera, Light) and enabled state.
 *
 * @param args  Tool arguments (no parameters required).
 * @param b     PluginBridgeClient instance (defaults to module-level singleton).
 */
export async function handleListLiveLinkSubjects(
  args: Record<string, never>,
  b: PluginBridgeClient = bridge
): Promise<ToolResult> {
  // Response data shape: LiveLinkSubjectsResult
  void args; // no parameters
  return sendOrDisconnect(b, {
    type: 'livelink.subjects',
    payload: {},
  });
}

/**
 * ue_control_livelink_subject handler — satisfies LL-03.
 * Sends livelink.control to the plugin; pauses or resumes an individual
 * Live Link subject by toggling its enabled state.
 *
 * @param args  Tool arguments: subject_name and enabled flag.
 * @param b     PluginBridgeClient instance (defaults to module-level singleton).
 */
export async function handleControlLiveLinkSubject(
  args: { subject_name: string; enabled: boolean },
  b: PluginBridgeClient = bridge
): Promise<ToolResult> {
  // Response data shape: LiveLinkControlResult
  return sendOrDisconnect(b, {
    type: 'livelink.control',
    payload: { subject_name: args.subject_name, enabled: args.enabled },
  });
}

/**
 * ue_preview_livelink_data handler — satisfies LL-04.
 * Sends livelink.preview to the plugin; returns the current frame data for
 * a Live Link subject (transform, camera, or animation bone data).
 *
 * @param args  Tool arguments: subject_name.
 * @param b     PluginBridgeClient instance (defaults to module-level singleton).
 */
export async function handlePreviewLiveLinkData(
  args: { subject_name: string },
  b: PluginBridgeClient = bridge
): Promise<ToolResult> {
  // Response data shape: LiveLinkPreviewResult
  return sendOrDisconnect(b, {
    type: 'livelink.preview',
    payload: { subject_name: args.subject_name },
  });
}

// ---------------------------------------------------------------------------
// registerLiveLinkTools
// ---------------------------------------------------------------------------

/**
 * Register UE Live Link source/subject management tools on the MCP server.
 *
 * All tools in this domain require the MCPBridge editor plugin.
 * When the plugin is not connected, each handler returns:
 *   { isError: true, content: [{ type: 'text', text: <plugin_not_connected JSON> }] }
 *
 * Tools registered (Phase 27):
 *   ue_list_livelink_sources    — LL-01: List Live Link sources with status
 *   ue_list_livelink_subjects   — LL-02: List subjects with roles and enabled state
 *   ue_control_livelink_subject — LL-03: Pause or resume a Live Link subject
 *   ue_preview_livelink_data    — LL-04: Inspect current frame data for a subject
 *
 * @param server  The McpServer instance to register tools on.
 * @param _bridge Optional PluginBridgeClient for testing (not used directly — handlers
 *                accept bridge injection via their exported function signatures).
 */
export function registerLiveLinkTools(server: McpServer, _bridge?: PluginBridgeClient): void {
  const b = _bridge ?? new PluginBridgeClient();

  // --------------------------------------------------------------------------
  // ue_list_livelink_sources (LL-01)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_list_livelink_sources',
    {
      title: 'List Live Link Sources',
      description:
        '[requires_plugin] List all active Live Link sources with connection status, source type, and machine name. Returns informative message if Live Link plugin is not enabled.',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_list_livelink_sources', async (args) =>
      handleListLiveLinkSources(args as Record<string, never>, b)
    )
  );

  // --------------------------------------------------------------------------
  // ue_list_livelink_subjects (LL-02)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_list_livelink_subjects',
    {
      title: 'List Live Link Subjects',
      description:
        '[requires_plugin] List all Live Link subjects with their roles (Animation, Transform, Camera, Light) and enabled/disabled state.',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_list_livelink_subjects', async (args) =>
      handleListLiveLinkSubjects(args as Record<string, never>, b)
    )
  );

  // --------------------------------------------------------------------------
  // ue_control_livelink_subject (LL-03)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_control_livelink_subject',
    {
      title: 'Control Live Link Subject',
      description:
        '[requires_plugin] Pause or resume an individual Live Link subject by toggling its enabled state.',
      inputSchema: z.object({
        subject_name: z
          .string()
          .min(1)
          .describe("Name of the Live Link subject to control, e.g. 'MyMocapActor'"),
        enabled: z
          .boolean()
          .describe('true to resume/enable the subject, false to pause/disable it'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_control_livelink_subject', async (args) =>
      handleControlLiveLinkSubject(args, b)
    )
  );

  // --------------------------------------------------------------------------
  // ue_preview_livelink_data (LL-04)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_preview_livelink_data',
    {
      title: 'Preview Live Link Data',
      description:
        '[requires_plugin] Inspect the current frame data for a Live Link subject. Returns role-specific data: transform (location/rotation/scale), camera (FOV/aperture/focus), or animation (bone transforms, capped at 10 bones).',
      inputSchema: z.object({
        subject_name: z
          .string()
          .min(1)
          .describe("Name of the Live Link subject to preview, e.g. 'MyCamera'"),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_preview_livelink_data', async (args) =>
      handlePreviewLiveLinkData(args, b)
    )
  );
}
