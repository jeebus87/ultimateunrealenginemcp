// src/tools/viewport/index.ts
// MCP tool implementations for editor state, PIE control, and viewport operations (Phase 12).
// Extended with base64 image returns and autonomous visual review tools (Phase 31).
// All tools route commands through PluginBridgeClient to the C++ MCPBridge plugin.
// Returns structured plugin_not_connected errors when the plugin is absent.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFile, stat } from 'node:fs/promises';
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
// readScreenshotAsImage helper
// ---------------------------------------------------------------------------

/**
 * Reads a screenshot file from disk and returns MCP content blocks.
 *
 * - Returns image + text blocks on success (base64-encoded PNG).
 * - Returns a single text warning block if file > 5MB (prevents MCP message bloat).
 * - Returns a single text error block if file does not exist.
 *
 * Per CONTEXT.md non-negotiable: 5MB cap.
 * The file path is always returned in the text block for traceability.
 */
async function readScreenshotAsImage(
  filePath: string
): Promise<Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>> {
  try {
    const fileInfo = await stat(filePath);
    if (fileInfo.size > 5 * 1024 * 1024) {
      return [
        {
          type: 'text',
          text: JSON.stringify({ warning: 'image_too_large', file_path: filePath, size_bytes: fileInfo.size }),
        },
      ];
    }
    const buffer = await readFile(filePath);
    const base64String = buffer.toString('base64');
    return [
      { type: 'image', data: base64String, mimeType: 'image/png' },
      { type: 'text', text: JSON.stringify({ file_path: filePath }) },
    ];
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === 'ENOENT') {
      return [
        {
          type: 'text',
          text: JSON.stringify({ error: 'screenshot_file_not_found', file_path: filePath }),
        },
      ];
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// sendScreenshotCommand helper
// ---------------------------------------------------------------------------

/**
 * Sends a screenshot command to the bridge and reads the resulting image from disk.
 *
 * Flow:
 * 1. Sends the command via bridge.sendCommand.
 * 2. On command failure: returns isError ToolResult.
 * 3. If response.data.file_path exists: waits 200ms for disk flush, reads image.
 * 4. If only response.data.screenshot_dir: falls back to text-only (backward compat).
 * 5. Catches PluginNotConnectedError and returns structured error.
 */
async function sendScreenshotCommand(
  bridge: PluginBridgeClient,
  commandType: string,
  payload: Record<string, unknown>
): Promise<ToolResult> {
  try {
    const response = await bridge.sendCommand({ type: commandType, payload, correlationId: '' });
    if (!response.success) {
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ error: response.error }) }],
      };
    }
    const data = response.data as Record<string, unknown> | undefined ?? {};
    const filePath = data['file_path'] as string | undefined;
    if (filePath) {
      // Wait for screenshot to flush to disk
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
      const imageBlocks = await readScreenshotAsImage(filePath);
      return { content: imageBlocks };
    }
    // Fallback: no file_path in response (e.g., screenshot_dir only)
    return {
      content: [{ type: 'text', text: JSON.stringify(data) }],
    };
  } catch (err) {
    if (err instanceof PluginNotConnectedError) {
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify(err.bridgeError) }],
      };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Shared angle union schema
// ---------------------------------------------------------------------------

const anglePresets = ['front', 'back', 'left', 'right', 'top', '45deg'] as const;

const angleSchema = z
  .union([
    z.enum(anglePresets),
    z.object({ yaw: z.number(), pitch: z.number() }),
  ])
  .optional()
  .default('front');

// ---------------------------------------------------------------------------
// Shared target union schema
// ---------------------------------------------------------------------------

const targetSchema = z.union([
  z.string().describe('Actor label (resolved server-side)'),
  z.object({ x: z.number(), y: z.number(), z: z.number() }).describe('World position in UE units (cm)'),
]);

// ---------------------------------------------------------------------------
// registerViewportTools
// ---------------------------------------------------------------------------

/**
 * Register UE Editor viewport, PIE control, and editor state tools on the MCP server.
 *
 * All tools in this domain require the MCPBridge editor plugin.
 * When the plugin is not connected, each handler returns:
 *   { isError: true, content: [{ type: 'text', text: <plugin_not_connected JSON> }] }
 *
 * Tools registered (Phase 12 + Phase 31):
 *   ue_editor_state            — Query selected actors, open assets, viewport camera
 *   ue_pie_start               — Start a PIE session
 *   ue_pie_stop                — Stop the active PIE session
 *   ue_pie_logs                — Read PIE output log lines
 *   ue_pie_game_state          — Query runtime game state during PIE
 *   ue_viewport_screenshot     — Capture viewport as screenshot (now returns inline image)
 *   ue_viewport_camera         — Control viewport camera position/rotation/FOV
 *   ue_viewport_render_mode    — Switch viewport render mode
 *   ue_viewport_hires_screenshot — High-resolution screenshot (now returns inline image)
 *   ue_visual_review           — Quick screenshot for iterative visual review loops
 *   ue_look_at                 — Navigate camera to actor or position, optionally screenshot
 *   ue_orbit_review            — Multi-angle screenshots orbiting a target
 *   ue_iterate_scene           — Full visual + semantic context in one call
 *   ue_fly_through             — Camera waypoint walkthrough with screenshots
 *   ue_focus_actor             — Auto-frame an actor by label
 *   ue_cleanup_screenshots     — Delete MCP-generated screenshots from disk
 *
 * @param server  The McpServer instance to register tools on.
 * @param bridge  Optional PluginBridgeClient for testing (defaults to a new instance).
 */
export function registerViewportTools(server: McpServer, bridge?: PluginBridgeClient): void {
  const _bridge = bridge ?? new PluginBridgeClient();

  // --------------------------------------------------------------------------
  // ue_editor_state
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_editor_state',
    {
      title: 'Query UE Editor State',
      description:
        '[requires_plugin] Query the current UE Editor state — selected actors, open assets, and viewport camera position.',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_editor_state', async (_args) => {
      return sendOrDisconnect(_bridge, { type: 'editor.state' });
    })
  );

  // --------------------------------------------------------------------------
  // ue_pie_start
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_pie_start',
    {
      title: 'Start PIE Session',
      description:
        '[requires_plugin] Start a Play In Editor (PIE) session.',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_pie_start', async (_args) => {
      return sendOrDisconnect(_bridge, { type: 'pie.start' });
    })
  );

  // --------------------------------------------------------------------------
  // ue_pie_stop
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_pie_stop',
    {
      title: 'Stop PIE Session',
      description:
        '[requires_plugin] Stop the active Play In Editor (PIE) session.',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_pie_stop', async (_args) => {
      return sendOrDisconnect(_bridge, { type: 'pie.stop' });
    })
  );

  // --------------------------------------------------------------------------
  // ue_pie_logs
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_pie_logs',
    {
      title: 'Read PIE Logs',
      description:
        '[requires_plugin] Read PIE output log lines captured since the PIE session started.',
      inputSchema: z.object({
        category_filter: z
          .string()
          .optional()
          .describe('Filter log lines containing this string (case-insensitive, empty = all)'),
        max_lines: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe('Maximum log lines to return (default 100)'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_pie_logs', async (args) => {
      const payload: Record<string, unknown> = {};
      if (args.category_filter) payload['category_filter'] = args.category_filter;
      if (args.max_lines !== undefined) payload['max_lines'] = args.max_lines;
      return sendOrDisconnect(_bridge, { type: 'pie.logs', payload });
    })
  );

  // --------------------------------------------------------------------------
  // ue_pie_game_state
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_pie_game_state',
    {
      title: 'Query PIE Game State',
      description:
        '[requires_plugin] Query runtime game state during an active PIE session — actor positions and active GameMode.',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_pie_game_state', async (_args) => {
      return sendOrDisconnect(_bridge, { type: 'pie.gameState' });
    })
  );

  // --------------------------------------------------------------------------
  // ue_viewport_screenshot
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_viewport_screenshot',
    {
      title: 'Take Viewport Screenshot',
      description:
        '[requires_plugin] Capture the active UE viewport as a screenshot. Returns the screenshot as an inline image (base64) when the plugin saves to a known path, or the screenshot directory path as fallback.',
      inputSchema: z.object({
        width: z
          .number()
          .int()
          .min(64)
          .max(7680)
          .optional()
          .describe('Screenshot width in pixels (default 1920)'),
        height: z
          .number()
          .int()
          .min(64)
          .max(4320)
          .optional()
          .describe('Screenshot height in pixels (default 1080)'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_viewport_screenshot', async (args) => {
      const payload: Record<string, unknown> = {};
      if (args.width !== undefined) payload['width'] = args.width;
      if (args.height !== undefined) payload['height'] = args.height;
      return sendScreenshotCommand(_bridge, 'viewport.screenshot', payload);
    })
  );

  // --------------------------------------------------------------------------
  // ue_viewport_camera
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_viewport_camera',
    {
      title: 'Control Viewport Camera',
      description:
        '[requires_plugin] Set the viewport camera position, rotation, FOV, or orbit around a target point.',
      inputSchema: z.object({
        location: z
          .object({
            x: z.number(),
            y: z.number(),
            z: z.number(),
          })
          .optional()
          .describe('Camera world position in Unreal units (cm)'),
        rotation: z
          .object({
            pitch: z.number(),
            yaw: z.number(),
            roll: z.number(),
          })
          .optional()
          .describe('Camera rotation in degrees'),
        fov: z
          .number()
          .min(5)
          .max(170)
          .optional()
          .describe('Horizontal field of view in degrees'),
        look_at: z
          .object({
            x: z.number(),
            y: z.number(),
            z: z.number(),
          })
          .optional()
          .describe('Point to orbit/look at — overrides rotation when location is also provided'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_viewport_camera', async (args) => {
      const payload: Record<string, unknown> = {};
      if (args.location !== undefined) payload['location'] = args.location;
      if (args.rotation !== undefined) payload['rotation'] = args.rotation;
      if (args.fov !== undefined) payload['fov'] = args.fov;
      if (args.look_at !== undefined) payload['look_at'] = args.look_at;
      return sendOrDisconnect(_bridge, { type: 'viewport.camera', payload });
    })
  );

  // --------------------------------------------------------------------------
  // ue_viewport_render_mode
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_viewport_render_mode',
    {
      title: 'Switch Viewport Render Mode',
      description:
        '[requires_plugin] Switch the active viewport render mode.',
      inputSchema: z.object({
        mode: z
          .enum(['lit', 'unlit', 'wireframe', 'collision', 'detail_lighting'])
          .describe('Render mode: lit (default), unlit, wireframe, collision, detail_lighting'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_viewport_render_mode', async (args) => {
      return sendOrDisconnect(_bridge, {
        type: 'viewport.renderMode',
        payload: { mode: args.mode },
      });
    })
  );

  // --------------------------------------------------------------------------
  // ue_viewport_hires_screenshot
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_viewport_hires_screenshot',
    {
      title: 'High-Resolution Viewport Screenshot',
      description:
        '[requires_plugin] Take a high-resolution screenshot with configurable multiplier. Returns the screenshot as an inline image (base64) when the plugin saves to a known path, or the screenshot directory path as fallback.',
      inputSchema: z.object({
        resolution_multiplier: z
          .number()
          .int()
          .min(1)
          .max(8)
          .optional()
          .describe('Resolution multiplier (default 2 = 2x base resolution)'),
        width: z
          .number()
          .int()
          .min(64)
          .max(7680)
          .optional()
          .describe('Base width in pixels (default 1920)'),
        height: z
          .number()
          .int()
          .min(64)
          .max(4320)
          .optional()
          .describe('Base height in pixels (default 1080)'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_viewport_hires_screenshot', async (args) => {
      const payload: Record<string, unknown> = {};
      if (args.resolution_multiplier !== undefined) payload['resolution_multiplier'] = args.resolution_multiplier;
      if (args.width !== undefined) payload['width'] = args.width;
      if (args.height !== undefined) payload['height'] = args.height;
      return sendScreenshotCommand(_bridge, 'viewport.hiresScreenshot', payload);
    })
  );

  // --------------------------------------------------------------------------
  // ue_visual_review  (VIS-02)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_visual_review',
    {
      title: 'Visual Review Screenshot',
      description:
        '[requires_plugin] Take a quick viewport screenshot for visual review. Returns the image inline with camera context. Use this for iterative review loops.',
      inputSchema: z.object({
        width: z
          .number()
          .int()
          .min(64)
          .max(7680)
          .optional()
          .default(1280)
          .describe('Screenshot width in pixels (default 1280)'),
        height: z
          .number()
          .int()
          .min(64)
          .max(4320)
          .optional()
          .default(720)
          .describe('Screenshot height in pixels (default 720)'),
        focus: z
          .string()
          .optional()
          .describe('Describe what to look for in the screenshot (e.g., "check the lighting on the left wall")'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_visual_review', async (args) => {
      const result = await sendScreenshotCommand(_bridge, 'viewport.screenshot', {
        width: args.width,
        height: args.height,
      });
      if (args.focus && result.content) {
        return {
          ...result,
          content: [
            { type: 'text' as const, text: JSON.stringify({ focus_description: args.focus }) },
            ...result.content,
          ],
        };
      }
      return result;
    })
  );

  // --------------------------------------------------------------------------
  // ue_look_at  (VIS-03)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_look_at',
    {
      title: 'Navigate Camera to Target',
      description:
        "[requires_plugin] Navigate the editor camera to look at an actor (by label) or world position. Automatically frames the target and optionally takes a screenshot. Claude's primary navigation tool — use actor labels from previous responses.",
      inputSchema: z.object({
        target: targetSchema.describe(
          'Actor label (string) or world position ({x,y,z}) to navigate to'
        ),
        distance: z
          .number()
          .optional()
          .describe('Camera distance from target in UE units (auto-calculated from actor bounds if omitted)'),
        angle: angleSchema.describe(
          'Viewing angle preset ("front","back","left","right","top","45deg") or {yaw,pitch} object'
        ),
        screenshot: z
          .boolean()
          .optional()
          .default(true)
          .describe('Take a screenshot after navigating (default true)'),
        width: z
          .number()
          .int()
          .min(64)
          .max(7680)
          .optional()
          .default(1280)
          .describe('Screenshot width in pixels (default 1280)'),
        height: z
          .number()
          .int()
          .min(64)
          .max(4320)
          .optional()
          .default(720)
          .describe('Screenshot height in pixels (default 720)'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_look_at', async (args) => {
      try {
        const payload: Record<string, unknown> = {};
        if (typeof args.target === 'string') {
          payload['target_label'] = args.target;
        } else {
          payload['target_position'] = args.target;
        }
        if (args.distance !== undefined) payload['distance'] = args.distance;
        if (args.angle !== undefined) {
          if (typeof args.angle === 'string') {
            payload['angle_preset'] = args.angle;
          } else {
            payload['angle_custom'] = args.angle;
          }
        }
        payload['screenshot'] = args.screenshot;
        payload['width'] = args.width;
        payload['height'] = args.height;

        const response = await _bridge.sendCommand({ type: 'viewport.lookAt', payload, correlationId: '' });
        if (!response.success) {
          return {
            isError: true,
            content: [{ type: 'text', text: JSON.stringify({ error: response.error }) }],
          };
        }
        const data = response.data as Record<string, unknown> | undefined ?? {};
        const filePath = data['file_path'] as string | undefined;
        if (filePath) {
          await new Promise<void>((resolve) => setTimeout(resolve, 200));
          const imageBlocks = await readScreenshotAsImage(filePath);
          return {
            content: [
              ...imageBlocks,
              { type: 'text' as const, text: JSON.stringify(data) },
            ],
          };
        }
        return { content: [{ type: 'text', text: JSON.stringify(data) }] };
      } catch (err) {
        if (err instanceof PluginNotConnectedError) {
          return {
            isError: true,
            content: [{ type: 'text', text: JSON.stringify(err.bridgeError) }],
          };
        }
        throw err;
      }
    })
  );

  // --------------------------------------------------------------------------
  // ue_orbit_review  (VIS-04)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_orbit_review',
    {
      title: 'Orbit Multi-Angle Review',
      description:
        '[requires_plugin] Take screenshots from multiple angles orbiting around a target actor or position. Returns one image per angle for multi-angle inspection.',
      inputSchema: z.object({
        target: targetSchema.describe(
          'Actor label (string) or world position ({x,y,z}) to orbit around'
        ),
        distance: z
          .number()
          .optional()
          .describe('Camera distance from target in UE units (auto-calculated from actor bounds if omitted)'),
        angles: z
          .array(z.number())
          .max(12)
          .optional()
          .default([0, 90, 180, 270])
          .describe('Yaw angles in degrees to capture (default [0,90,180,270], max 12 entries)'),
        pitch: z
          .number()
          .optional()
          .default(-20)
          .describe('Camera pitch angle in degrees (default -20)'),
        width: z
          .number()
          .int()
          .optional()
          .default(1280)
          .describe('Screenshot width in pixels (default 1280)'),
        height: z
          .number()
          .int()
          .optional()
          .default(720)
          .describe('Screenshot height in pixels (default 720)'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_orbit_review', async (args) => {
      try {
        const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [];
        for (const yaw of args.angles) {
          const payload: Record<string, unknown> = {
            screenshot: true,
            width: args.width,
            height: args.height,
            angle: { yaw, pitch: args.pitch },
          };
          if (typeof args.target === 'string') {
            payload['target_label'] = args.target;
          } else {
            payload['target_position'] = args.target;
          }
          if (args.distance !== undefined) payload['distance'] = args.distance;

          try {
            const response = await _bridge.sendCommand({ type: 'viewport.lookAt', payload, correlationId: '' });
            if (!response.success) {
              content.push({ type: 'text', text: JSON.stringify({ angle_yaw: yaw, error: response.error }) });
              continue;
            }
            const data = response.data as Record<string, unknown> | undefined ?? {};
            const filePath = data['file_path'] as string | undefined;
            content.push({ type: 'text', text: JSON.stringify({ angle_yaw: yaw, pitch: args.pitch }) });
            if (filePath) {
              await new Promise<void>((resolve) => setTimeout(resolve, 200));
              const imageBlocks = await readScreenshotAsImage(filePath);
              content.push(...imageBlocks);
            } else {
              content.push({ type: 'text', text: JSON.stringify({ angle_yaw: yaw, result: data }) });
            }
          } catch (innerErr) {
            if (innerErr instanceof PluginNotConnectedError) throw innerErr;
            content.push({ type: 'text', text: JSON.stringify({ angle_yaw: yaw, error: String(innerErr) }) });
          }
        }
        return { content };
      } catch (err) {
        if (err instanceof PluginNotConnectedError) {
          return {
            isError: true,
            content: [{ type: 'text', text: JSON.stringify(err.bridgeError) }],
          };
        }
        throw err;
      }
    })
  );

  // --------------------------------------------------------------------------
  // ue_iterate_scene  (VIS-05)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_iterate_scene',
    {
      title: 'Full Scene Context Snapshot',
      description:
        '[requires_plugin] Get full visual and semantic context in one call. Takes a screenshot AND returns structured data about nearby actors. Use this to orient yourself — see what you are looking at and what is nearby.',
      inputSchema: z.object({
        width: z
          .number()
          .int()
          .optional()
          .default(1280)
          .describe('Screenshot width in pixels (default 1280)'),
        height: z
          .number()
          .int()
          .optional()
          .default(720)
          .describe('Screenshot height in pixels (default 720)'),
        include_actors: z
          .boolean()
          .optional()
          .default(true)
          .describe('Include actors from the view frustum in the response (default true)'),
        include_materials: z
          .boolean()
          .optional()
          .default(false)
          .describe('Include material information (default false)'),
        radius: z
          .number()
          .optional()
          .describe('Only include actors within N UE units of camera (no limit if omitted)'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_iterate_scene', async (args) => {
      try {
        // Step 1: take a screenshot
        const screenshotResponse = await _bridge.sendCommand({
          type: 'viewport.screenshot',
          payload: { width: args.width, height: args.height },
          correlationId: '',
        });

        let imageBlocks: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [];
        let screenshotMeta: Record<string, unknown> = {};

        if (screenshotResponse.success) {
          const ssData = screenshotResponse.data as Record<string, unknown> | undefined ?? {};
          const filePath = ssData['file_path'] as string | undefined;
          if (filePath) {
            await new Promise<void>((resolve) => setTimeout(resolve, 200));
            imageBlocks = await readScreenshotAsImage(filePath);
          }
          screenshotMeta = ssData;
        }

        // Step 2: get actors in frustum
        let actorsData: Record<string, unknown> = {};
        if (args.include_actors) {
          const actorPayload: Record<string, unknown> = { max_actors: 50 };
          if (args.radius !== undefined) actorPayload['radius'] = args.radius;
          const actorResponse = await _bridge.sendCommand({
            type: 'viewport.frustumActors',
            payload: actorPayload,
            correlationId: '',
          });
          if (actorResponse.success) {
            actorsData = actorResponse.data as Record<string, unknown> ?? {};
          }
        }

        // Step 3: combine results
        const sceneContext = {
          screenshot: screenshotMeta,
          actors: actorsData,
          include_materials: args.include_materials,
        };

        return {
          content: [
            ...imageBlocks,
            { type: 'text' as const, text: JSON.stringify(sceneContext) },
          ],
        };
      } catch (err) {
        if (err instanceof PluginNotConnectedError) {
          return {
            isError: true,
            content: [{ type: 'text', text: JSON.stringify(err.bridgeError) }],
          };
        }
        throw err;
      }
    })
  );

  // --------------------------------------------------------------------------
  // ue_fly_through  (VIS-06)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_fly_through',
    {
      title: 'Camera Fly-Through Waypoints',
      description:
        '[requires_plugin] Move the camera through a series of waypoints, taking a screenshot at each. Use this for level walkthroughs and spatial surveys.',
      inputSchema: z.object({
        waypoints: z
          .array(
            z.object({
              location: z.object({ x: z.number(), y: z.number(), z: z.number() }),
              look_at: z.object({ x: z.number(), y: z.number(), z: z.number() }),
              label: z.string().optional().describe('Optional label for this waypoint'),
            })
          )
          .min(1)
          .max(20)
          .describe('Camera waypoints to visit (1–20 waypoints)'),
        width: z
          .number()
          .int()
          .optional()
          .default(1280)
          .describe('Screenshot width in pixels (default 1280)'),
        height: z
          .number()
          .int()
          .optional()
          .default(720)
          .describe('Screenshot height in pixels (default 720)'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_fly_through', async (args) => {
      try {
        const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [];

        for (let i = 0; i < args.waypoints.length; i++) {
          const wp = args.waypoints[i];
          const waypointLabel = wp.label ?? `Waypoint ${i + 1}`;
          content.push({ type: 'text', text: JSON.stringify({ waypoint: waypointLabel, index: i + 1 }) });

          try {
            // Move camera to waypoint
            await _bridge.sendCommand({
              type: 'viewport.camera',
              payload: { location: wp.location, look_at: wp.look_at },
              correlationId: '',
            });

            // Take screenshot
            const screenshotResponse = await _bridge.sendCommand({
              type: 'viewport.screenshot',
              payload: { width: args.width, height: args.height },
              correlationId: '',
            });

            if (screenshotResponse.success) {
              const ssData = screenshotResponse.data as Record<string, unknown> | undefined ?? {};
              const filePath = ssData['file_path'] as string | undefined;
              if (filePath) {
                await new Promise<void>((resolve) => setTimeout(resolve, 200));
                const imageBlocks = await readScreenshotAsImage(filePath);
                content.push(...imageBlocks);
              } else {
                content.push({ type: 'text', text: JSON.stringify({ waypoint: waypointLabel, result: ssData }) });
              }
            } else {
              content.push({ type: 'text', text: JSON.stringify({ waypoint: waypointLabel, error: screenshotResponse.error }) });
            }
          } catch (innerErr) {
            if (innerErr instanceof PluginNotConnectedError) throw innerErr;
            content.push({ type: 'text', text: JSON.stringify({ waypoint: waypointLabel, error: String(innerErr) }) });
          }
        }

        return { content };
      } catch (err) {
        if (err instanceof PluginNotConnectedError) {
          return {
            isError: true,
            content: [{ type: 'text', text: JSON.stringify(err.bridgeError) }],
          };
        }
        throw err;
      }
    })
  );

  // --------------------------------------------------------------------------
  // ue_focus_actor  (VIS-07)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_focus_actor',
    {
      title: 'Frame Actor in Viewport',
      description:
        '[requires_plugin] Frame a specific actor perfectly in the viewport. Auto-calculates camera distance from actor bounds. Use when you need a detailed view of a specific object.',
      inputSchema: z.object({
        actor_label: z
          .string()
          .describe('Label of the actor to focus on'),
        padding: z
          .number()
          .optional()
          .default(1.5)
          .describe('Multiplier on actor bounds for camera distance (default 1.5)'),
        angle: angleSchema.describe(
          'Viewing angle preset ("front","back","left","right","top","45deg") or {yaw,pitch} object (default "front")'
        ),
        screenshot: z
          .boolean()
          .optional()
          .default(true)
          .describe('Take a screenshot after framing (default true)'),
        width: z
          .number()
          .int()
          .optional()
          .default(1280)
          .describe('Screenshot width in pixels (default 1280)'),
        height: z
          .number()
          .int()
          .optional()
          .default(720)
          .describe('Screenshot height in pixels (default 720)'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_focus_actor', async (args) => {
      try {
        const payload: Record<string, unknown> = {
          actor_label: args.actor_label,
          padding: args.padding,
          screenshot: args.screenshot,
          width: args.width,
          height: args.height,
        };
        if (args.angle !== undefined) {
          if (typeof args.angle === 'string') {
            payload['angle_preset'] = args.angle;
          } else {
            payload['angle_custom'] = args.angle;
          }
        }

        const response = await _bridge.sendCommand({ type: 'viewport.focusActor', payload, correlationId: '' });
        if (!response.success) {
          return {
            isError: true,
            content: [{ type: 'text', text: JSON.stringify({ error: response.error }) }],
          };
        }
        const data = response.data as Record<string, unknown> | undefined ?? {};
        const filePath = data['file_path'] as string | undefined;
        if (filePath) {
          await new Promise<void>((resolve) => setTimeout(resolve, 200));
          const imageBlocks = await readScreenshotAsImage(filePath);
          return {
            content: [
              ...imageBlocks,
              { type: 'text' as const, text: JSON.stringify(data) },
            ],
          };
        }
        return { content: [{ type: 'text', text: JSON.stringify(data) }] };
      } catch (err) {
        if (err instanceof PluginNotConnectedError) {
          return {
            isError: true,
            content: [{ type: 'text', text: JSON.stringify(err.bridgeError) }],
          };
        }
        throw err;
      }
    })
  );

  // --------------------------------------------------------------------------
  // ue_cleanup_screenshots  (VIS-08)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_cleanup_screenshots',
    {
      title: 'Clean Up MCP Screenshots',
      description:
        '[requires_plugin] Delete MCP-generated screenshots to free disk space. Only targets files with the mcp_screenshot_ prefix — never deletes user screenshots. Call this when a visual review loop is complete.',
      inputSchema: z.object({
        confirm: z
          .literal(true)
          .describe('Must be true — safety guard to prevent accidental deletion'),
        keep_last: z
          .number()
          .int()
          .optional()
          .default(0)
          .describe('Preserve the N most recent screenshots (default 0 = delete all)'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
      },
    },
    withKnownIssues('ue_cleanup_screenshots', async (args) => {
      return sendOrDisconnect(_bridge, {
        type: 'viewport.cleanupScreenshots',
        payload: { keep_last: args.keep_last },
      });
    })
  );
}
