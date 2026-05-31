// tests/viewport.test.ts
// Integration tests for Phase 12 viewport/PIE/editor-state tools
// and Phase 31 visual review tools.
// Uses mock PluginBridgeClient injected into registerViewportTools.
// Does NOT spin up a real TCP server or real McpServer.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PluginBridgeClient, PluginNotConnectedError } from '../src/plugin-bridge/client.js';
import { registerViewportTools } from '../src/tools/viewport/index.js';

// ---------------------------------------------------------------------------
// Mock node:fs/promises at module level.
// 'node:fs/promises' and 'fs/promises' resolve to the same module in Node.js,
// so this mock covers both -- including the stat/readFile calls in store.ts.
// The mock functions delegate to the real implementation by default, allowing
// tests to inject per-path overrides using the screenshotFsMocks registry below.
// ---------------------------------------------------------------------------

vi.mock('node:fs/promises', async () => {
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

  // Per-path override registry: maps a file path to a one-shot result.
  // Real fs is used for paths not in this map.
  const statOverrides = new Map<string, () => Promise<import('node:fs').Stats>>();
  const readFileOverrides = new Map<string, () => Promise<Buffer>>();

  // Expose the override maps on the mock so tests can populate them.
  const mockModule = {
    ...real,
    _statOverrides: statOverrides,
    _readFileOverrides: readFileOverrides,
    stat: vi.fn((...args: Parameters<typeof real.stat>) => {
      const filePath = args[0] as string;
      const override = statOverrides.get(filePath);
      if (override) {
        statOverrides.delete(filePath);
        return override();
      }
      return real.stat(...args);
    }),
    readFile: vi.fn((...args: Parameters<typeof real.readFile>) => {
      const filePath = args[0] as string;
      const override = readFileOverrides.get(filePath);
      if (override) {
        readFileOverrides.delete(filePath);
        return override();
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (real.readFile as any)(...args);
    }),
  };
  return mockModule;
});

// Import the mocked module AFTER vi.mock so Vitest provides the wrapped version
import * as mockFsModule from 'node:fs/promises';

// Cast to access the private override maps injected by the factory above
const mockFsPromises = mockFsModule as typeof mockFsModule & {
  _statOverrides: Map<string, () => Promise<import('node:fs').Stats>>;
  _readFileOverrides: Map<string, () => Promise<Buffer>>;
};

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

type ToolResultContent = Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
type ToolResultShape = { content: ToolResultContent; isError?: boolean };

/**
 * Create a minimal mock PluginBridgeClient for testing.
 * sendCommand resolves with success response by default.
 * Pass throwDisconnect:true to simulate a disconnected plugin.
 */
function makeMockBridge(opts: {
  connected?: boolean;
  responseData?: unknown;
  responseSuccess?: boolean;
  responseError?: string;
  throwDisconnect?: boolean;
}): PluginBridgeClient {
  const disconnectedError = {
    error: 'plugin_not_connected' as const,
    message: 'Test: plugin not connected',
    required_plugin: true as const,
  };

  const sendCommandImpl = opts.throwDisconnect
    ? vi.fn().mockRejectedValue(new PluginNotConnectedError(disconnectedError))
    : vi.fn().mockResolvedValue({
        success: opts.responseSuccess ?? true,
        correlationId: 'test-corr-id',
        data: opts.responseData,
        error: opts.responseError,
      });

  return {
    isConnected: vi.fn().mockReturnValue(opts.connected ?? true),
    getDisconnectedError: vi.fn().mockReturnValue(disconnectedError),
    sendCommand: sendCommandImpl,
    destroy: vi.fn(),
  } as unknown as PluginBridgeClient;
}

/**
 * Builds a stub McpServer that captures registered handlers by tool name.
 * Allows calling handlers directly without a real McpServer.
 */
function makeStubServer(): {
  server: McpServer;
  handlers: Map<string, (args: unknown) => Promise<unknown>>;
} {
  const handlers = new Map<string, (args: unknown) => Promise<unknown>>();
  const stubServer = {
    registerTool: (
      _name: string,
      _schema: unknown,
      handler: (args: unknown) => Promise<unknown>
    ) => {
      handlers.set(_name, handler);
    },
  } as unknown as McpServer;
  return { server: stubServer, handlers };
}

/**
 * Register a per-path fs override so the next stat/readFile call for this path
 * returns mock data instead of hitting disk.
 *
 * Subsequent calls for the SAME path fall through to real fs (one-shot override).
 * Calls for other paths (e.g., KNOWN_ISSUES.md in store.ts) always use real fs.
 *
 * Returns the expected base64 string for the given buffer.
 */
function setupFsForScreenshot(filePath: string, pngData: string = 'fake-png-data'): string {
  const buf = Buffer.from(pngData);
  mockFsPromises._statOverrides.set(
    filePath,
    () => Promise.resolve({ size: buf.length } as import('node:fs').Stats)
  );
  mockFsPromises._readFileOverrides.set(
    filePath,
    () => Promise.resolve(buf)
  );
  return buf.toString('base64');
}

// ---------------------------------------------------------------------------
// describe('viewport tools')
// ---------------------------------------------------------------------------

describe('viewport tools', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // ue_editor_state
  // -------------------------------------------------------------------------
  describe('ue_editor_state', () => {
    it('happy path: returns editor state data including selectedActors', async () => {
      const editorStateData = {
        selectedActors: [{ label: 'Cube', class: 'StaticMeshActor', id: 'Cube_0' }],
        openAssets: ['/Game/Maps/TestLevel'],
        viewport: { location: { x: 0, y: 0, z: 100 }, rotation: { pitch: 0, yaw: 0, roll: 0 }, fov: 90 },
      };
      const mockBridge = makeMockBridge({ responseData: editorStateData });
      const { server, handlers } = makeStubServer();
      registerViewportTools(server, mockBridge);

      const handler = handlers.get('ue_editor_state')!;
      const result = await handler({}) as ToolResultShape;

      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'editor.state' })
      );
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('selectedActors');
    });

    it('disconnected: returns plugin_not_connected error', async () => {
      const mockBridge = makeMockBridge({ throwDisconnect: true });
      const { server, handlers } = makeStubServer();
      registerViewportTools(server, mockBridge);

      const handler = handlers.get('ue_editor_state')!;
      const result = await handler({}) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text!);
      expect(parsed.error).toBe('plugin_not_connected');
    });
  });

  // -------------------------------------------------------------------------
  // ue_pie_start
  // -------------------------------------------------------------------------
  describe('ue_pie_start', () => {
    it('happy path: returns started:true response', async () => {
      const mockBridge = makeMockBridge({ responseData: { started: true } });
      const { server, handlers } = makeStubServer();
      registerViewportTools(server, mockBridge);

      const handler = handlers.get('ue_pie_start')!;
      const result = await handler({}) as ToolResultShape;

      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'pie.start' })
      );
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('started');
    });

    it('disconnected: returns isError:true with plugin_not_connected', async () => {
      const mockBridge = makeMockBridge({ throwDisconnect: true });
      const { server, handlers } = makeStubServer();
      registerViewportTools(server, mockBridge);

      const handler = handlers.get('ue_pie_start')!;
      const result = await handler({}) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text!);
      expect(parsed.error).toBe('plugin_not_connected');
    });
  });

  // -------------------------------------------------------------------------
  // ue_pie_stop
  // -------------------------------------------------------------------------
  describe('ue_pie_stop', () => {
    it('happy path: returns stopped:true response', async () => {
      const mockBridge = makeMockBridge({ responseData: { stopped: true } });
      const { server, handlers } = makeStubServer();
      registerViewportTools(server, mockBridge);

      const handler = handlers.get('ue_pie_stop')!;
      const result = await handler({}) as ToolResultShape;

      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'pie.stop' })
      );
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('stopped');
    });

    it('plugin command error pie_not_active: returns isError:true with error string', async () => {
      const mockBridge = makeMockBridge({ responseSuccess: false, responseError: 'pie_not_active' });
      const { server, handlers } = makeStubServer();
      registerViewportTools(server, mockBridge);

      const handler = handlers.get('ue_pie_stop')!;
      const result = await handler({}) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text!);
      expect(parsed.error).toBe('pie_not_active');
    });
  });

  // -------------------------------------------------------------------------
  // ue_pie_logs
  // -------------------------------------------------------------------------
  describe('ue_pie_logs', () => {
    it('happy path no filters: returns log lines data', async () => {
      const logsData = { lines: ['LogTemp: hello'], total_captured: 1, returned: 1 };
      const mockBridge = makeMockBridge({ responseData: logsData });
      const { server, handlers } = makeStubServer();
      registerViewportTools(server, mockBridge);

      const handler = handlers.get('ue_pie_logs')!;
      const result = await handler({}) as ToolResultShape;

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('lines');
    });

    it('with category_filter param: sendCommand called with payload containing category_filter', async () => {
      const mockBridge = makeMockBridge({ responseData: { lines: [], total_captured: 0, returned: 0 } });
      const { server, handlers } = makeStubServer();
      registerViewportTools(server, mockBridge);

      const handler = handlers.get('ue_pie_logs')!;
      await handler({ category_filter: 'LogTemp' });

      const call = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.type).toBe('pie.logs');
      expect(call.payload).toHaveProperty('category_filter', 'LogTemp');
    });

    it('with max_lines param: sendCommand called with payload containing max_lines', async () => {
      const mockBridge = makeMockBridge({ responseData: { lines: [], total_captured: 0, returned: 0 } });
      const { server, handlers } = makeStubServer();
      registerViewportTools(server, mockBridge);

      const handler = handlers.get('ue_pie_logs')!;
      await handler({ max_lines: 50 });

      const call = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.type).toBe('pie.logs');
      expect(call.payload).toHaveProperty('max_lines', 50);
    });
  });

  // -------------------------------------------------------------------------
  // ue_pie_game_state
  // -------------------------------------------------------------------------
  describe('ue_pie_game_state', () => {
    it('happy path: returns game state data including game_mode_class', async () => {
      const gameStateData = { game_mode_class: 'AMyGameMode', actor_count: 2, actors: [] };
      const mockBridge = makeMockBridge({ responseData: gameStateData });
      const { server, handlers } = makeStubServer();
      registerViewportTools(server, mockBridge);

      const handler = handlers.get('ue_pie_game_state')!;
      const result = await handler({}) as ToolResultShape;

      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'pie.gameState' })
      );
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('game_mode_class');
    });

    it('plugin error pie_not_active: returns isError:true', async () => {
      const mockBridge = makeMockBridge({ responseSuccess: false, responseError: 'pie_not_active' });
      const { server, handlers } = makeStubServer();
      registerViewportTools(server, mockBridge);

      const handler = handlers.get('ue_pie_game_state')!;
      const result = await handler({}) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text!);
      expect(parsed.error).toBe('pie_not_active');
    });
  });

  // -------------------------------------------------------------------------
  // ue_viewport_screenshot
  // -------------------------------------------------------------------------
  describe('ue_viewport_screenshot', () => {
    it('happy path no file_path: returns screenshot_dir text-only (backward compat)', async () => {
      const screenshotData = { screenshot_dir: '/path/to/screenshots', queued: true };
      const mockBridge = makeMockBridge({ responseData: screenshotData });
      const { server, handlers } = makeStubServer();
      registerViewportTools(server, mockBridge);

      const handler = handlers.get('ue_viewport_screenshot')!;
      const result = await handler({}) as ToolResultShape;

      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'viewport.screenshot' })
      );
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('screenshot_dir');
    });

    it('with width/height params: sendCommand called with payload {width:2560, height:1440}', async () => {
      const mockBridge = makeMockBridge({ responseData: { screenshot_dir: '/path', queued: true } });
      const { server, handlers } = makeStubServer();
      registerViewportTools(server, mockBridge);

      const handler = handlers.get('ue_viewport_screenshot')!;
      await handler({ width: 2560, height: 1440 });

      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'viewport.screenshot',
          payload: { width: 2560, height: 1440 },
        })
      );
    });

    it('returns image content block when file_path is in response', async () => {
      const screenshotData = { file_path: '/tmp/mcp_screenshot_123.png', width: 1280, height: 720 };
      const mockBridge = makeMockBridge({ responseData: screenshotData });
      const { server, handlers } = makeStubServer();
      registerViewportTools(server, mockBridge);

      const expectedBase64 = setupFsForScreenshot('/tmp/mcp_screenshot_123.png', 'fake-png-data');

      const handler = handlers.get('ue_viewport_screenshot')!;
      const result = await handler({}) as ToolResultShape;

      expect(result.isError).toBeFalsy();
      const imageBlock = result.content.find((b) => b.type === 'image');
      expect(imageBlock).toBeDefined();
      expect(imageBlock!.data).toBe(expectedBase64);
      expect(imageBlock!.mimeType).toBe('image/png');
    });
  });

  // -------------------------------------------------------------------------
  // ue_viewport_camera
  // -------------------------------------------------------------------------
  describe('ue_viewport_camera', () => {
    it('set location only: payload contains location but not rotation', async () => {
      const mockBridge = makeMockBridge({ responseData: {} });
      const { server, handlers } = makeStubServer();
      registerViewportTools(server, mockBridge);

      const handler = handlers.get('ue_viewport_camera')!;
      await handler({ location: { x: 100, y: 200, z: 300 } });

      const call = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.type).toBe('viewport.camera');
      expect(call.payload).toHaveProperty('location', { x: 100, y: 200, z: 300 });
      expect(call.payload).not.toHaveProperty('rotation');
      expect(call.payload).not.toHaveProperty('look_at');
    });

    it('set rotation only: payload contains rotation but not location', async () => {
      const mockBridge = makeMockBridge({ responseData: {} });
      const { server, handlers } = makeStubServer();
      registerViewportTools(server, mockBridge);

      const handler = handlers.get('ue_viewport_camera')!;
      await handler({ rotation: { pitch: -30, yaw: 45, roll: 0 } });

      const call = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.type).toBe('viewport.camera');
      expect(call.payload).toHaveProperty('rotation', { pitch: -30, yaw: 45, roll: 0 });
      expect(call.payload).not.toHaveProperty('location');
    });

    it('set location + look_at: payload contains both location and look_at', async () => {
      const mockBridge = makeMockBridge({ responseData: {} });
      const { server, handlers } = makeStubServer();
      registerViewportTools(server, mockBridge);

      const handler = handlers.get('ue_viewport_camera')!;
      await handler({
        location: { x: 500, y: 0, z: 200 },
        look_at: { x: 0, y: 0, z: 0 },
      });

      const call = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.payload).toHaveProperty('location', { x: 500, y: 0, z: 200 });
      expect(call.payload).toHaveProperty('look_at', { x: 0, y: 0, z: 0 });
      expect(call.payload).not.toHaveProperty('rotation');
    });
  });

  // -------------------------------------------------------------------------
  // ue_viewport_render_mode
  // -------------------------------------------------------------------------
  describe('ue_viewport_render_mode', () => {
    it('mode wireframe: sendCommand called with {type:viewport.renderMode, payload:{mode:wireframe}}', async () => {
      const mockBridge = makeMockBridge({ responseData: { applied: true } });
      const { server, handlers } = makeStubServer();
      registerViewportTools(server, mockBridge);

      const handler = handlers.get('ue_viewport_render_mode')!;
      await handler({ mode: 'wireframe' });

      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'viewport.renderMode',
          payload: { mode: 'wireframe' },
        })
      );
    });

    it('plugin returns unknown_render_mode error: returns isError:true', async () => {
      const mockBridge = makeMockBridge({ responseSuccess: false, responseError: 'unknown_render_mode' });
      const { server, handlers } = makeStubServer();
      registerViewportTools(server, mockBridge);

      const handler = handlers.get('ue_viewport_render_mode')!;
      const result = await handler({ mode: 'lit' }) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text!);
      expect(parsed.error).toBe('unknown_render_mode');
    });
  });

  // -------------------------------------------------------------------------
  // ue_viewport_hires_screenshot
  // -------------------------------------------------------------------------
  describe('ue_viewport_hires_screenshot', () => {
    it('happy path with resolution_multiplier:4: payload contains resolution_multiplier:4', async () => {
      const hiresData = { queued: true, width: 7680, height: 4320 };
      const mockBridge = makeMockBridge({ responseData: hiresData });
      const { server, handlers } = makeStubServer();
      registerViewportTools(server, mockBridge);

      const handler = handlers.get('ue_viewport_hires_screenshot')!;
      const result = await handler({ resolution_multiplier: 4 }) as ToolResultShape;

      const call = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.type).toBe('viewport.hiresScreenshot');
      expect(call.payload).toHaveProperty('resolution_multiplier', 4);
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('queued');
    });

    it('returns image content block when file_path is in response', async () => {
      const hiresData = { file_path: '/tmp/mcp_screenshot_hires.png', width: 3840, height: 2160 };
      const mockBridge = makeMockBridge({ responseData: hiresData });
      const { server, handlers } = makeStubServer();
      registerViewportTools(server, mockBridge);

      setupFsForScreenshot('/tmp/mcp_screenshot_hires.png', 'hires-png-data');

      const handler = handlers.get('ue_viewport_hires_screenshot')!;
      const result = await handler({ resolution_multiplier: 2 }) as ToolResultShape;

      expect(result.isError).toBeFalsy();
      const imageBlock = result.content.find((b) => b.type === 'image');
      expect(imageBlock).toBeDefined();
      expect(imageBlock!.mimeType).toBe('image/png');
    });

    it('disconnected: returns isError:true with plugin_not_connected', async () => {
      const mockBridge = makeMockBridge({ throwDisconnect: true });
      const { server, handlers } = makeStubServer();
      registerViewportTools(server, mockBridge);

      const handler = handlers.get('ue_viewport_hires_screenshot')!;
      const result = await handler({}) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text!);
      expect(parsed.error).toBe('plugin_not_connected');
    });
  });

  // -------------------------------------------------------------------------
  // readScreenshotAsImage behavior
  // -------------------------------------------------------------------------
  describe('readScreenshotAsImage behavior', () => {
    it('returns warning text block when file is larger than 5MB', async () => {
      const screenshotData = { file_path: '/tmp/mcp_screenshot_large.png', width: 1280, height: 720 };
      const mockBridge = makeMockBridge({ responseData: screenshotData });
      const { server, handlers } = makeStubServer();
      registerViewportTools(server, mockBridge);

      // Override stat for this specific file path to return a size > 5MB
      mockFsPromises._statOverrides.set(
        '/tmp/mcp_screenshot_large.png',
        () => Promise.resolve({ size: 6_000_000 } as import('node:fs').Stats)
      );

      const handler = handlers.get('ue_viewport_screenshot')!;
      const result = await handler({}) as ToolResultShape;

      expect(result.isError).toBeFalsy();
      const textBlock = result.content.find(
        (b) => b.type === 'text' && b.text?.includes('image_too_large')
      );
      expect(textBlock).toBeDefined();
      expect(result.content.find((b) => b.type === 'image')).toBeUndefined();
    });

    it('returns error text block when screenshot file is missing (ENOENT)', async () => {
      const screenshotData = { file_path: '/tmp/mcp_screenshot_missing.png', width: 1280, height: 720 };
      const mockBridge = makeMockBridge({ responseData: screenshotData });
      const { server, handlers } = makeStubServer();
      registerViewportTools(server, mockBridge);

      // Override stat for this specific file path to simulate ENOENT
      const enoentError = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      mockFsPromises._statOverrides.set(
        '/tmp/mcp_screenshot_missing.png',
        () => Promise.reject(enoentError)
      );

      const handler = handlers.get('ue_viewport_screenshot')!;
      const result = await handler({}) as ToolResultShape;

      expect(result.isError).toBeFalsy();
      const textBlock = result.content.find(
        (b) => b.type === 'text' && b.text?.includes('screenshot_file_not_found')
      );
      expect(textBlock).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // ue_visual_review  (VIS-02)
  // -------------------------------------------------------------------------
  describe('ue_visual_review', () => {
    it('happy path with focus: returns focus_description text block + image block', async () => {
      const screenshotData = { file_path: '/tmp/mcp_screenshot_vr.png', width: 1280, height: 720 };
      const mockBridge = makeMockBridge({ responseData: screenshotData });
      const { server, handlers } = makeStubServer();
      registerViewportTools(server, mockBridge);

      setupFsForScreenshot('/tmp/mcp_screenshot_vr.png', 'visual-review-png');

      const handler = handlers.get('ue_visual_review')!;
      const result = await handler({ width: 1280, height: 720, focus: 'check the lighting on the left wall' }) as ToolResultShape;

      expect(result.isError).toBeFalsy();
      const focusBlock = result.content.find(
        (b) => b.type === 'text' && b.text?.includes('focus_description')
      );
      expect(focusBlock).toBeDefined();
      expect(focusBlock!.text).toContain('check the lighting on the left wall');
      const imageBlock = result.content.find((b) => b.type === 'image');
      expect(imageBlock).toBeDefined();
    });

    it('without focus: returns image block without focus_description text', async () => {
      const screenshotData = { file_path: '/tmp/mcp_screenshot_vr2.png', width: 1280, height: 720 };
      const mockBridge = makeMockBridge({ responseData: screenshotData });
      const { server, handlers } = makeStubServer();
      registerViewportTools(server, mockBridge);

      setupFsForScreenshot('/tmp/mcp_screenshot_vr2.png', 'nofocus-png');

      const handler = handlers.get('ue_visual_review')!;
      const result = await handler({ width: 1280, height: 720 }) as ToolResultShape;

      expect(result.isError).toBeFalsy();
      const focusBlock = result.content.find(
        (b) => b.type === 'text' && b.text?.includes('focus_description')
      );
      expect(focusBlock).toBeUndefined();
    });

    it('plugin not connected: returns plugin_not_connected error', async () => {
      const mockBridge = makeMockBridge({ throwDisconnect: true });
      const { server, handlers } = makeStubServer();
      registerViewportTools(server, mockBridge);

      const handler = handlers.get('ue_visual_review')!;
      const result = await handler({}) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text!);
      expect(parsed.error).toBe('plugin_not_connected');
    });
  });

  // -------------------------------------------------------------------------
  // ue_look_at  (VIS-03)
  // -------------------------------------------------------------------------
  describe('ue_look_at', () => {
    it('happy path with actor label: sends target_label in payload and returns image block', async () => {
      const lookAtData = {
        camera_position: { x: 100, y: 0, z: 150 },
        target_position: { x: 0, y: 0, z: 0 },
        actor_label: 'PointLight_0',
        file_path: '/tmp/mcp_screenshot_lookat.png',
      };
      const mockBridge = makeMockBridge({ responseData: lookAtData });
      const { server, handlers } = makeStubServer();
      registerViewportTools(server, mockBridge);

      setupFsForScreenshot('/tmp/mcp_screenshot_lookat.png', 'lookat-png');

      const handler = handlers.get('ue_look_at')!;
      const result = await handler({ target: 'PointLight_0', screenshot: true }) as ToolResultShape;

      const call = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.type).toBe('viewport.lookAt');
      expect(call.payload).toHaveProperty('target_label', 'PointLight_0');

      expect(result.isError).toBeFalsy();
      const imageBlock = result.content.find((b) => b.type === 'image');
      expect(imageBlock).toBeDefined();
    });

    it('happy path with position target: sends target_position in payload', async () => {
      const lookAtData = {
        camera_position: { x: 200, y: 0, z: 150 },
        target_position: { x: 100, y: 200, z: 300 },
        file_path: '/tmp/mcp_screenshot_pos.png',
      };
      const mockBridge = makeMockBridge({ responseData: lookAtData });
      const { server, handlers } = makeStubServer();
      registerViewportTools(server, mockBridge);

      setupFsForScreenshot('/tmp/mcp_screenshot_pos.png', 'pos-png');

      const handler = handlers.get('ue_look_at')!;
      await handler({ target: { x: 100, y: 200, z: 300 }, screenshot: true });

      const call = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.payload).toHaveProperty('target_position', { x: 100, y: 200, z: 300 });
      expect(call.payload).not.toHaveProperty('target_label');
    });

    it('actor not found error: returns isError:true with actor_not_found', async () => {
      const mockBridge = makeMockBridge({ responseSuccess: false, responseError: 'actor_not_found' });
      const { server, handlers } = makeStubServer();
      registerViewportTools(server, mockBridge);

      const handler = handlers.get('ue_look_at')!;
      const result = await handler({ target: 'NonExistent_Actor', screenshot: true }) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text!);
      expect(parsed.error).toBe('actor_not_found');
    });

    it('without screenshot: returns text-only result with camera data', async () => {
      const lookAtData = {
        camera_position: { x: 100, y: 0, z: 150 },
        target_position: { x: 0, y: 0, z: 0 },
      };
      const mockBridge = makeMockBridge({ responseData: lookAtData });
      const { server, handlers } = makeStubServer();
      registerViewportTools(server, mockBridge);

      const handler = handlers.get('ue_look_at')!;
      const result = await handler({ target: 'SomeActor', screenshot: false }) as ToolResultShape;

      expect(result.isError).toBeFalsy();
      expect(result.content.find((b) => b.type === 'image')).toBeUndefined();
      expect(result.content[0].text).toContain('camera_position');
    });

    it('plugin not connected: returns plugin_not_connected error', async () => {
      const mockBridge = makeMockBridge({ throwDisconnect: true });
      const { server, handlers } = makeStubServer();
      registerViewportTools(server, mockBridge);

      const handler = handlers.get('ue_look_at')!;
      const result = await handler({ target: 'AnyActor' }) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text!);
      expect(parsed.error).toBe('plugin_not_connected');
    });
  });

  // -------------------------------------------------------------------------
  // ue_orbit_review  (VIS-04)
  // -------------------------------------------------------------------------
  describe('ue_orbit_review', () => {
    it('happy path with 4 default angles: sends 4 bridge calls and returns 4 image blocks', async () => {
      const makeLookAtData = (yaw: number) => ({
        camera_position: { x: yaw, y: 0, z: 50 },
        target_position: { x: 0, y: 0, z: 0 },
        file_path: `/tmp/mcp_screenshot_orbit_${yaw}.png`,
      });

      const disconnectedError = {
        error: 'plugin_not_connected' as const,
        message: 'Test: plugin not connected',
        required_plugin: true as const,
      };

      const mockSendCommand = vi.fn()
        .mockResolvedValueOnce({ success: true, correlationId: 'c1', data: makeLookAtData(0) })
        .mockResolvedValueOnce({ success: true, correlationId: 'c2', data: makeLookAtData(90) })
        .mockResolvedValueOnce({ success: true, correlationId: 'c3', data: makeLookAtData(180) })
        .mockResolvedValueOnce({ success: true, correlationId: 'c4', data: makeLookAtData(270) });

      const mockBridge = {
        isConnected: vi.fn().mockReturnValue(true),
        getDisconnectedError: vi.fn().mockReturnValue(disconnectedError),
        sendCommand: mockSendCommand,
        destroy: vi.fn(),
      } as unknown as PluginBridgeClient;

      const { server, handlers } = makeStubServer();
      registerViewportTools(server, mockBridge);

      // Set up fs overrides for all 4 angle screenshots
      for (const yaw of [0, 90, 180, 270]) {
        setupFsForScreenshot(`/tmp/mcp_screenshot_orbit_${yaw}.png`, 'orbit-png');
      }

      const handler = handlers.get('ue_orbit_review')!;
      const result = await handler({ target: 'SM_Cube', angles: [0, 90, 180, 270] }) as ToolResultShape;

      expect(mockSendCommand).toHaveBeenCalledTimes(4);
      const imageBlocks = result.content.filter((b) => b.type === 'image');
      expect(imageBlocks.length).toBe(4);
    });

    it('partial failure: one angle fails, returns 3 image blocks + 1 error text block', async () => {
      const makeLookAtData = (yaw: number) => ({
        camera_position: { x: yaw, y: 0, z: 50 },
        target_position: { x: 0, y: 0, z: 0 },
        file_path: `/tmp/mcp_screenshot_orbit_pf_${yaw}.png`,
      });

      const disconnectedError = {
        error: 'plugin_not_connected' as const,
        message: 'Test: plugin not connected',
        required_plugin: true as const,
      };

      const mockSendCommand = vi.fn()
        .mockResolvedValueOnce({ success: true, correlationId: 'c1', data: makeLookAtData(0) })
        .mockResolvedValueOnce({ success: false, correlationId: 'c2', error: 'camera_move_failed' })
        .mockResolvedValueOnce({ success: true, correlationId: 'c3', data: makeLookAtData(180) })
        .mockResolvedValueOnce({ success: true, correlationId: 'c4', data: makeLookAtData(270) });

      const mockBridge = {
        isConnected: vi.fn().mockReturnValue(true),
        getDisconnectedError: vi.fn().mockReturnValue(disconnectedError),
        sendCommand: mockSendCommand,
        destroy: vi.fn(),
      } as unknown as PluginBridgeClient;

      const { server, handlers } = makeStubServer();
      registerViewportTools(server, mockBridge);

      // Set up fs overrides for the 3 successful angle screenshots (yaw 90 will fail at bridge level)
      for (const yaw of [0, 180, 270]) {
        setupFsForScreenshot(`/tmp/mcp_screenshot_orbit_pf_${yaw}.png`, 'partial-orbit-png');
      }

      const handler = handlers.get('ue_orbit_review')!;
      const result = await handler({ target: 'SM_Cube', angles: [0, 90, 180, 270] }) as ToolResultShape;

      const imageBlocks = result.content.filter((b) => b.type === 'image');
      expect(imageBlocks.length).toBe(3);
      const errorBlock = result.content.find(
        (b) => b.type === 'text' && b.text?.includes('camera_move_failed')
      );
      expect(errorBlock).toBeDefined();
    });

    it('plugin not connected: returns plugin_not_connected error', async () => {
      const mockBridge = makeMockBridge({ throwDisconnect: true });
      const { server, handlers } = makeStubServer();
      registerViewportTools(server, mockBridge);

      const handler = handlers.get('ue_orbit_review')!;
      // Must supply angles since Zod defaults are not applied when calling handler directly
      const result = await handler({ target: 'SM_Cube', angles: [0, 90] }) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text!);
      expect(parsed.error).toBe('plugin_not_connected');
    });
  });

  // -------------------------------------------------------------------------
  // ue_iterate_scene  (VIS-05)
  // -------------------------------------------------------------------------
  describe('ue_iterate_scene', () => {
    it('happy path: takes screenshot then queries frustum actors, returns image + scene_context', async () => {
      const screenshotData = {
        file_path: '/tmp/mcp_screenshot_iterate.png',
        width: 1280,
        height: 720,
      };
      const frustumData = {
        camera_position: { x: 0, y: 0, z: 100 },
        actor_count: 2,
        actors: [
          { label: 'SM_Cube', class_name: 'StaticMeshActor', distance: 500 },
          { label: 'PointLight_0', class_name: 'PointLight', distance: 300 },
        ],
      };

      const disconnectedError = {
        error: 'plugin_not_connected' as const,
        message: 'Test: plugin not connected',
        required_plugin: true as const,
      };

      const mockSendCommand = vi.fn()
        .mockResolvedValueOnce({ success: true, correlationId: 'c1', data: screenshotData })
        .mockResolvedValueOnce({ success: true, correlationId: 'c2', data: frustumData });

      const mockBridge = {
        isConnected: vi.fn().mockReturnValue(true),
        getDisconnectedError: vi.fn().mockReturnValue(disconnectedError),
        sendCommand: mockSendCommand,
        destroy: vi.fn(),
      } as unknown as PluginBridgeClient;

      const { server, handlers } = makeStubServer();
      registerViewportTools(server, mockBridge);

      setupFsForScreenshot('/tmp/mcp_screenshot_iterate.png', 'iterate-png');

      const handler = handlers.get('ue_iterate_scene')!;
      const result = await handler({ include_actors: true }) as ToolResultShape;

      expect(mockSendCommand).toHaveBeenCalledTimes(2);
      expect(mockSendCommand.mock.calls[0][0].type).toBe('viewport.screenshot');
      expect(mockSendCommand.mock.calls[1][0].type).toBe('viewport.frustumActors');

      const imageBlock = result.content.find((b) => b.type === 'image');
      expect(imageBlock).toBeDefined();

      const contextBlock = result.content.find(
        (b) => b.type === 'text' && b.text?.includes('actors')
      );
      expect(contextBlock).toBeDefined();
    });

    it('without actors (include_actors: false): only screenshot call made', async () => {
      const screenshotData = {
        file_path: '/tmp/mcp_screenshot_noactors.png',
        width: 1280,
        height: 720,
      };

      const disconnectedError = {
        error: 'plugin_not_connected' as const,
        message: 'Test: plugin not connected',
        required_plugin: true as const,
      };

      const mockSendCommand = vi.fn()
        .mockResolvedValueOnce({ success: true, correlationId: 'c1', data: screenshotData });

      const mockBridge = {
        isConnected: vi.fn().mockReturnValue(true),
        getDisconnectedError: vi.fn().mockReturnValue(disconnectedError),
        sendCommand: mockSendCommand,
        destroy: vi.fn(),
      } as unknown as PluginBridgeClient;

      const { server, handlers } = makeStubServer();
      registerViewportTools(server, mockBridge);

      setupFsForScreenshot('/tmp/mcp_screenshot_noactors.png', 'noactors-png');

      const handler = handlers.get('ue_iterate_scene')!;
      await handler({ include_actors: false });

      expect(mockSendCommand).toHaveBeenCalledTimes(1);
      expect(mockSendCommand.mock.calls[0][0].type).toBe('viewport.screenshot');
    });

    it('plugin not connected: returns plugin_not_connected error', async () => {
      const mockBridge = makeMockBridge({ throwDisconnect: true });
      const { server, handlers } = makeStubServer();
      registerViewportTools(server, mockBridge);

      const handler = handlers.get('ue_iterate_scene')!;
      const result = await handler({}) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text!);
      expect(parsed.error).toBe('plugin_not_connected');
    });
  });

  // -------------------------------------------------------------------------
  // ue_fly_through  (VIS-06)
  // -------------------------------------------------------------------------
  describe('ue_fly_through', () => {
    it('happy path with 3 waypoints: sends 6 bridge calls (camera+screenshot per waypoint) and returns 3 image blocks', async () => {
      const makeScreenshotData = (i: number) => ({
        file_path: `/tmp/mcp_screenshot_fly_${i}.png`,
        width: 1280,
        height: 720,
      });

      const disconnectedError = {
        error: 'plugin_not_connected' as const,
        message: 'Test: plugin not connected',
        required_plugin: true as const,
      };

      const mockSendCommand = vi.fn()
        // Waypoint 1: camera + screenshot
        .mockResolvedValueOnce({ success: true, correlationId: 'c1', data: {} })
        .mockResolvedValueOnce({ success: true, correlationId: 'c2', data: makeScreenshotData(1) })
        // Waypoint 2: camera + screenshot
        .mockResolvedValueOnce({ success: true, correlationId: 'c3', data: {} })
        .mockResolvedValueOnce({ success: true, correlationId: 'c4', data: makeScreenshotData(2) })
        // Waypoint 3: camera + screenshot
        .mockResolvedValueOnce({ success: true, correlationId: 'c5', data: {} })
        .mockResolvedValueOnce({ success: true, correlationId: 'c6', data: makeScreenshotData(3) });

      const mockBridge = {
        isConnected: vi.fn().mockReturnValue(true),
        getDisconnectedError: vi.fn().mockReturnValue(disconnectedError),
        sendCommand: mockSendCommand,
        destroy: vi.fn(),
      } as unknown as PluginBridgeClient;

      const { server, handlers } = makeStubServer();
      registerViewportTools(server, mockBridge);

      // Set up fs overrides for the 3 waypoint screenshots
      for (let i = 1; i <= 3; i++) {
        setupFsForScreenshot(`/tmp/mcp_screenshot_fly_${i}.png`, 'fly-png');
      }

      const waypoints = [
        { location: { x: 0, y: 0, z: 100 }, look_at: { x: 500, y: 0, z: 0 }, label: 'Start' },
        { location: { x: 500, y: 0, z: 100 }, look_at: { x: 1000, y: 0, z: 0 }, label: 'Mid' },
        { location: { x: 1000, y: 0, z: 100 }, look_at: { x: 500, y: 0, z: 0 }, label: 'End' },
      ];

      const handler = handlers.get('ue_fly_through')!;
      const result = await handler({ waypoints }) as ToolResultShape;

      expect(mockSendCommand).toHaveBeenCalledTimes(6);
      expect(mockSendCommand.mock.calls[0][0].type).toBe('viewport.camera');
      expect(mockSendCommand.mock.calls[1][0].type).toBe('viewport.screenshot');

      const imageBlocks = result.content.filter((b) => b.type === 'image');
      expect(imageBlocks.length).toBe(3);
    });

    it('single waypoint: works with minimum 1 waypoint and returns 1 image block', async () => {
      const disconnectedError = {
        error: 'plugin_not_connected' as const,
        message: 'Test: plugin not connected',
        required_plugin: true as const,
      };

      const mockSendCommand = vi.fn()
        .mockResolvedValueOnce({ success: true, correlationId: 'c1', data: {} })
        .mockResolvedValueOnce({ success: true, correlationId: 'c2', data: { file_path: '/tmp/mcp_screenshot_single.png' } });

      const mockBridge = {
        isConnected: vi.fn().mockReturnValue(true),
        getDisconnectedError: vi.fn().mockReturnValue(disconnectedError),
        sendCommand: mockSendCommand,
        destroy: vi.fn(),
      } as unknown as PluginBridgeClient;

      const { server, handlers } = makeStubServer();
      registerViewportTools(server, mockBridge);

      setupFsForScreenshot('/tmp/mcp_screenshot_single.png', 'single-wp-png');

      const handler = handlers.get('ue_fly_through')!;
      const result = await handler({
        waypoints: [{ location: { x: 0, y: 0, z: 100 }, look_at: { x: 500, y: 0, z: 0 } }],
      }) as ToolResultShape;

      expect(mockSendCommand).toHaveBeenCalledTimes(2);
      const imageBlocks = result.content.filter((b) => b.type === 'image');
      expect(imageBlocks.length).toBe(1);
    });

    it('plugin not connected: returns plugin_not_connected error', async () => {
      const mockBridge = makeMockBridge({ throwDisconnect: true });
      const { server, handlers } = makeStubServer();
      registerViewportTools(server, mockBridge);

      const handler = handlers.get('ue_fly_through')!;
      const result = await handler({
        waypoints: [{ location: { x: 0, y: 0, z: 100 }, look_at: { x: 500, y: 0, z: 0 } }],
      }) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text!);
      expect(parsed.error).toBe('plugin_not_connected');
    });
  });

  // -------------------------------------------------------------------------
  // ue_focus_actor  (VIS-07)
  // -------------------------------------------------------------------------
  describe('ue_focus_actor', () => {
    it('happy path: returns image block + actor details in text block', async () => {
      const focusData = {
        actor_label: 'SM_RockLarge',
        actor_class: 'StaticMeshActor',
        actor_position: { x: 1000, y: 500, z: 0 },
        actor_bounds: { origin: { x: 1000, y: 500, z: 100 }, extent: { x: 200, y: 200, z: 100 } },
        camera_position: { x: 600, y: 100, z: 300 },
        file_path: '/tmp/mcp_screenshot_focus.png',
      };
      const mockBridge = makeMockBridge({ responseData: focusData });
      const { server, handlers } = makeStubServer();
      registerViewportTools(server, mockBridge);

      setupFsForScreenshot('/tmp/mcp_screenshot_focus.png', 'focus-actor-png');

      const handler = handlers.get('ue_focus_actor')!;
      const result = await handler({ actor_label: 'SM_RockLarge', screenshot: true }) as ToolResultShape;

      expect(result.isError).toBeFalsy();
      const imageBlock = result.content.find((b) => b.type === 'image');
      expect(imageBlock).toBeDefined();
      const textBlock = result.content.find(
        (b) => b.type === 'text' && b.text?.includes('actor_label')
      );
      expect(textBlock).toBeDefined();
    });

    it('actor not found: returns isError:true with actor_not_found', async () => {
      const mockBridge = makeMockBridge({ responseSuccess: false, responseError: 'actor_not_found' });
      const { server, handlers } = makeStubServer();
      registerViewportTools(server, mockBridge);

      const handler = handlers.get('ue_focus_actor')!;
      const result = await handler({ actor_label: 'NonExistent_001', screenshot: true }) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text!);
      expect(parsed.error).toBe('actor_not_found');
    });

    it('without screenshot: no image block in result', async () => {
      const focusData = {
        actor_label: 'SM_Box',
        actor_class: 'StaticMeshActor',
        actor_position: { x: 200, y: 100, z: 0 },
        actor_bounds: { origin: { x: 200, y: 100, z: 50 }, extent: { x: 50, y: 50, z: 50 } },
        camera_position: { x: 0, y: 0, z: 200 },
      };
      const mockBridge = makeMockBridge({ responseData: focusData });
      const { server, handlers } = makeStubServer();
      registerViewportTools(server, mockBridge);

      const handler = handlers.get('ue_focus_actor')!;
      const result = await handler({ actor_label: 'SM_Box', screenshot: false }) as ToolResultShape;

      expect(result.isError).toBeFalsy();
      expect(result.content.find((b) => b.type === 'image')).toBeUndefined();
      expect(result.content[0].text).toContain('actor_label');
    });

    it('plugin not connected: returns plugin_not_connected error', async () => {
      const mockBridge = makeMockBridge({ throwDisconnect: true });
      const { server, handlers } = makeStubServer();
      registerViewportTools(server, mockBridge);

      const handler = handlers.get('ue_focus_actor')!;
      const result = await handler({ actor_label: 'AnyActor' }) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text!);
      expect(parsed.error).toBe('plugin_not_connected');
    });
  });

  // -------------------------------------------------------------------------
  // ue_cleanup_screenshots  (VIS-08)
  // -------------------------------------------------------------------------
  describe('ue_cleanup_screenshots', () => {
    it('happy path with confirm:true: returns deleted_count in response', async () => {
      const cleanupData = {
        deleted_count: 5,
        bytes_freed: 10485760,
        kept_count: 0,
        screenshot_dir: '/tmp/mcp_screenshots',
      };
      const mockBridge = makeMockBridge({ responseData: cleanupData });
      const { server, handlers } = makeStubServer();
      registerViewportTools(server, mockBridge);

      const handler = handlers.get('ue_cleanup_screenshots')!;
      const result = await handler({ confirm: true, keep_last: 0 }) as ToolResultShape;

      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'viewport.cleanupScreenshots',
          payload: { keep_last: 0 },
        })
      );
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('deleted_count');
      const parsed = JSON.parse(result.content[0].text!);
      expect(parsed.deleted_count).toBe(5);
      expect(parsed.bytes_freed).toBe(10485760);
    });

    it('with keep_last:2: payload forwards keep_last correctly', async () => {
      const cleanupData = {
        deleted_count: 3,
        bytes_freed: 5242880,
        kept_count: 2,
        screenshot_dir: '/tmp/mcp_screenshots',
      };
      const mockBridge = makeMockBridge({ responseData: cleanupData });
      const { server, handlers } = makeStubServer();
      registerViewportTools(server, mockBridge);

      const handler = handlers.get('ue_cleanup_screenshots')!;
      await handler({ confirm: true, keep_last: 2 });

      const call = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.payload).toHaveProperty('keep_last', 2);
    });

    it('plugin not connected: returns plugin_not_connected error', async () => {
      const mockBridge = makeMockBridge({ throwDisconnect: true });
      const { server, handlers } = makeStubServer();
      registerViewportTools(server, mockBridge);

      const handler = handlers.get('ue_cleanup_screenshots')!;
      const result = await handler({ confirm: true }) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text!);
      expect(parsed.error).toBe('plugin_not_connected');
    });
  });

  // -------------------------------------------------------------------------
  // Structural checks
  // -------------------------------------------------------------------------
  describe('tool registration', () => {
    it('registers exactly sixteen tools', () => {
      const mockBridge = makeMockBridge({});
      const { server, handlers } = makeStubServer();
      registerViewportTools(server, mockBridge);

      expect(handlers.size).toBe(16);
    });

    it('registers all expected tool names including 7 new Phase 31 visual review tools', () => {
      const mockBridge = makeMockBridge({});
      const { server, handlers } = makeStubServer();
      registerViewportTools(server, mockBridge);

      const expectedTools = [
        // Phase 12 tools
        'ue_editor_state',
        'ue_pie_start',
        'ue_pie_stop',
        'ue_pie_logs',
        'ue_pie_game_state',
        'ue_viewport_screenshot',
        'ue_viewport_camera',
        'ue_viewport_render_mode',
        'ue_viewport_hires_screenshot',
        // Phase 31 tools
        'ue_visual_review',
        'ue_look_at',
        'ue_orbit_review',
        'ue_iterate_scene',
        'ue_fly_through',
        'ue_focus_actor',
        'ue_cleanup_screenshots',
      ];
      for (const name of expectedTools) {
        expect(handlers.has(name), `Tool "${name}" should be registered`).toBe(true);
      }
    });

    it('all render modes accepted by ue_viewport_render_mode: lit, unlit, wireframe, collision, detail_lighting', async () => {
      const validModes = ['lit', 'unlit', 'wireframe', 'collision', 'detail_lighting'];
      for (const mode of validModes) {
        const mockBridge = makeMockBridge({ responseData: { applied: true } });
        const { server, handlers } = makeStubServer();
        registerViewportTools(server, mockBridge);

        const handler = handlers.get('ue_viewport_render_mode')!;
        const result = await handler({ mode }) as ToolResultShape;
        expect(result.isError).toBeFalsy();
      }
    });
  });
});
