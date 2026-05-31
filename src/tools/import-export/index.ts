// src/tools/import-export/index.ts
// MCP tool implementations for asset import/export operations (Phase 21).
// All tools route commands through PluginBridgeClient to the C++ MCPBridge handlers.
// Returns structured plugin_not_connected errors when the plugin is absent.
//
// Tools registered (Phase 21 — IMP-01 through IMP-04):
//   ue_import_fbx       — Import an FBX file into the project at a specified content path
//   ue_import_usd       — Import a USD file using the Interchange pipeline
//   ue_export_mesh      — Export a StaticMesh or SkeletalMesh asset to FBX format
//   ue_batch_import     — Batch import multiple files from a directory with configurable settings
//
// Command mappings:
//   ue_import_fbx    -> import.fbx
//   ue_import_usd    -> import.usd
//   ue_export_mesh   -> export.mesh
//   ue_batch_import  -> import.batch
//
// All tools require MCPBridge plugin (Phase 21 — IMP-01 through IMP-04).

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
// registerImportExportTools
// ---------------------------------------------------------------------------

/**
 * Register UE asset import/export tools on the MCP server.
 *
 * All tools in this domain require the MCPBridge editor plugin.
 * When the plugin is not connected, each handler returns:
 *   { isError: true, content: [{ type: 'text', text: <plugin_not_connected JSON> }] }
 *
 * Tools registered (Phase 21):
 *   ue_import_fbx    — IMP-01: Import an FBX file into the project
 *   ue_import_usd    — IMP-02: Import a USD file via Interchange pipeline
 *   ue_export_mesh   — IMP-03: Export a static/skeletal mesh to FBX
 *   ue_batch_import  — IMP-04: Batch import multiple files with settings
 *
 * @param server  The McpServer instance to register tools on.
 * @param bridge  Optional PluginBridgeClient for testing (injected bridge replaces module singleton).
 */
export function registerImportExportTools(server: McpServer, bridge?: PluginBridgeClient): void {
  const _bridge = bridge ?? new PluginBridgeClient();

  // --------------------------------------------------------------------------
  // ue_import_fbx (IMP-01)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_import_fbx',
    {
      title: 'Import FBX File',
      description:
        '[requires_plugin] Import an FBX file into the project at a specified content path. Returns the list of created asset paths.',
      inputSchema: z.object({
        source_file: z
          .string()
          .min(1)
          .describe('Absolute OS path to the .fbx file to import'),
        dest_path: z
          .string()
          .min(1)
          .describe('Content browser destination path, e.g. /Game/Meshes'),
        import_materials: z
          .boolean()
          .optional()
          .default(true)
          .describe('Import materials from FBX'),
        combine_meshes: z
          .boolean()
          .optional()
          .default(false)
          .describe('Combine all meshes into a single asset'),
        scale_factor: z
          .number()
          .optional()
          .default(1.0)
          .describe('Import scale factor'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_import_fbx', async (args) =>
      sendOrDisconnect(_bridge, {
        type: 'import.fbx',
        payload: { ...args },
      })
    )
  );

  // --------------------------------------------------------------------------
  // ue_import_usd (IMP-02)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_import_usd',
    {
      title: 'Import USD File',
      description:
        '[requires_plugin] Import a USD file into the project using the Interchange pipeline. Supports .usd, .usda, and .usdc formats.',
      inputSchema: z.object({
        source_file: z
          .string()
          .min(1)
          .describe('Absolute OS path to the USD file'),
        dest_path: z
          .string()
          .min(1)
          .describe('Content browser destination path'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_import_usd', async (args) =>
      sendOrDisconnect(_bridge, {
        type: 'import.usd',
        payload: { ...args },
      })
    )
  );

  // --------------------------------------------------------------------------
  // ue_export_mesh (IMP-03)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_export_mesh',
    {
      title: 'Export Mesh to FBX',
      description:
        '[requires_plugin] Export a StaticMesh or SkeletalMesh asset to FBX format at the specified output path.',
      inputSchema: z.object({
        asset_path: z
          .string()
          .min(1)
          .describe('Content browser path to the mesh asset, e.g. /Game/Meshes/MyMesh'),
        output_file: z
          .string()
          .min(1)
          .describe('Absolute OS path for the output .fbx file'),
        export_collision: z
          .boolean()
          .optional()
          .default(false)
          .describe('Include collision geometry in export'),
        level_of_detail: z
          .number()
          .int()
          .min(0)
          .optional()
          .default(0)
          .describe('LOD level to export (0 = base)'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_export_mesh', async (args) =>
      sendOrDisconnect(_bridge, {
        type: 'export.mesh',
        payload: { ...args },
      })
    )
  );

  // --------------------------------------------------------------------------
  // ue_batch_import (IMP-04)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_batch_import',
    {
      title: 'Batch Import Files',
      description:
        '[requires_plugin] Import multiple files from a directory into the project with configurable settings. Supports filtering by file extension.',
      inputSchema: z.object({
        directory: z
          .string()
          .min(1)
          .describe('Absolute OS path to the directory containing files to import'),
        extensions: z
          .array(z.string())
          .optional()
          .default(['fbx'])
          .describe("File extensions to import, e.g. ['fbx', 'obj', 'usd']"),
        dest_path: z
          .string()
          .min(1)
          .describe('Content browser destination path'),
        import_materials: z
          .boolean()
          .optional()
          .default(true)
          .describe('Import materials from source files'),
        scale_factor: z
          .number()
          .optional()
          .default(1.0)
          .describe('Import scale factor for all files'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_batch_import', async (args) =>
      sendOrDisconnect(_bridge, {
        type: 'import.batch',
        payload: { ...args },
      })
    )
  );
}
