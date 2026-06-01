// src/tools/validation/index.ts
// MCP tool implementations for UE data validation and Blueprint compile-check (Phase 16).
// All tools route commands through PluginBridgeClient to the C++ MCPBridge handlers.
// Returns structured plugin_not_connected errors when the plugin is absent.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withKnownIssues, type ToolResult } from '../known-issues/middleware.js';
import { PluginBridgeClient, PluginNotConnectedError } from '../../plugin-bridge/client.js';
// Import result types — used as documentation of the response data shapes returned by the plugin.
// The sendOrDisconnect helper returns raw JSON.stringify(response.data); callers may cast to these.
import type {
  ValidationAssetResult,    // VAL-01 response shape
  ValidationFolderResult,   // VAL-02 response shape
  ValidationProjectResult,  // VAL-03 response shape
  BlueprintCompileResult,   // VAL-04 response shape
} from './types.js';

// Suppress unused-import warnings — types are referenced in JSDoc comments.
type _UnusedImports = ValidationAssetResult | ValidationFolderResult | ValidationProjectResult | BlueprintCompileResult;

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
 * ue_validate_asset handler — satisfies VAL-01.
 * Sends validate.asset to the plugin; returns structured pass/fail with error/warning counts.
 *
 * @param args  Tool arguments including asset_path.
 * @param b     PluginBridgeClient instance (defaults to module-level singleton).
 */
export async function handleValidateAsset(
  args: { asset_path: string },
  b: PluginBridgeClient = bridge
): Promise<ToolResult> {
  // Response data shape: ValidationAssetResult
  return sendOrDisconnect(b, {
    type: 'validate.asset',
    payload: { asset_path: args.asset_path },
  });
}

/**
 * ue_validate_folder handler — satisfies VAL-02.
 * Sends validate.folder to the plugin; returns per-folder summary with asset counts.
 *
 * @param args  Tool arguments including folder_path.
 * @param b     PluginBridgeClient instance (defaults to module-level singleton).
 */
export async function handleValidateFolder(
  args: { folder_path: string },
  b: PluginBridgeClient = bridge
): Promise<ToolResult> {
  // Response data shape: ValidationFolderResult
  return sendOrDisconnect(b, {
    type: 'validate.folder',
    payload: { folder_path: args.folder_path },
  });
}

/**
 * ue_validate_project handler — satisfies VAL-03.
 * Sends validate.project to the plugin; returns categorized project-wide counts.
 *
 * @param _args  No input arguments (empty record).
 * @param b      PluginBridgeClient instance (defaults to module-level singleton).
 */
export async function handleValidateProject(
  _args: Record<string, never>,
  b: PluginBridgeClient = bridge
): Promise<ToolResult> {
  return sendOrDisconnect(b, { type: 'validate.project' });
}

/**
 * ue_check_blueprint handler — satisfies VAL-04.
 * Sends validate.blueprint to the plugin; returns compiled:bool with status and errorMessage.
 *
 * @param args  Tool arguments including asset_path.
 * @param b     PluginBridgeClient instance (defaults to module-level singleton).
 */
export async function handleCheckBlueprint(
  args: { asset_path: string },
  b: PluginBridgeClient = bridge
): Promise<ToolResult> {
  // Response data shape: BlueprintCompileResult
  return sendOrDisconnect(b, {
    type: 'validate.blueprint',
    payload: { asset_path: args.asset_path },
  });
}

// ---------------------------------------------------------------------------
// registerValidationTools
// ---------------------------------------------------------------------------

/**
 * Register UE data validation and Blueprint compile-check tools on the MCP server.
 *
 * All tools in this domain require the MCPBridge editor plugin.
 * When the plugin is not connected, each handler returns:
 *   { isError: true, content: [{ type: 'text', text: <plugin_not_connected JSON> }] }
 *
 * Tools registered (Phase 16):
 *   ue_validate_asset    — VAL-01: Run data validation on a single asset
 *   ue_validate_folder   — VAL-02: Run data validation on all assets in a folder
 *   ue_validate_project  — VAL-03: Run data validation across all /Game/ assets
 *   ue_check_blueprint   — VAL-04: Compile-check a Blueprint asset
 *
 * @param server  The McpServer instance to register tools on.
 * @param bridge  Optional PluginBridgeClient for testing (defaults to a new instance).
 */
export function registerValidationTools(server: McpServer, bridge?: PluginBridgeClient): void {
  const _bridge = bridge ?? PluginBridgeClient.shared();

  // --------------------------------------------------------------------------
  // ue_validate_asset (VAL-01)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_validate_asset',
    {
      title: 'Validate UE Asset',
      description:
        '[requires_plugin] Run UE data validation rules on a single asset and return structured pass/fail results with error and warning counts.',
      inputSchema: z.object({
        asset_path: z
          .string()
          .describe('UE long package path, e.g. /Game/Blueprints/BP_MyActor'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_validate_asset', async (args) =>
      handleValidateAsset(args, _bridge)
    )
  );

  // --------------------------------------------------------------------------
  // ue_validate_folder (VAL-02)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_validate_folder',
    {
      title: 'Validate UE Assets in Folder',
      description:
        '[requires_plugin] Run UE data validation on all assets under a folder path and return a summary report.',
      inputSchema: z.object({
        folder_path: z
          .string()
          .describe('UE package path prefix, e.g. /Game/Blueprints'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_validate_folder', async (args) =>
      handleValidateFolder(args, _bridge)
    )
  );

  // --------------------------------------------------------------------------
  // ue_validate_project (VAL-03)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_validate_project',
    {
      title: 'Validate All Project Assets',
      description:
        '[requires_plugin] Run UE data validation across all /Game/ assets and return categorized error, warning, and info counts.',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_validate_project', async (_args) =>
      handleValidateProject({} as Record<string, never>, _bridge)
    )
  );

  // --------------------------------------------------------------------------
  // ue_check_blueprint (VAL-04)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_check_blueprint',
    {
      title: 'Check Blueprint Compilation',
      description:
        '[requires_plugin] Compile-check a Blueprint asset and return structured compiler messages indicating success or failure.',
      inputSchema: z.object({
        asset_path: z
          .string()
          .describe(
            'UE long package path to the Blueprint asset, e.g. /Game/Blueprints/BP_MyActor'
          ),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_check_blueprint', async (args) =>
      handleCheckBlueprint(args, _bridge)
    )
  );
}
