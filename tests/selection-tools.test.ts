// tests/selection-tools.test.ts
// Integration tests for Phase 19 Actor Selection and Duplication tools.
// Uses mock PluginBridgeClient injected into registerSelectionTools.
// Port assignment comment: port 55567 is reserved for this file if a TCP mock server is needed later.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PluginBridgeClient, PluginNotConnectedError } from '../src/plugin-bridge/client.js';
import { registerSelectionTools } from '../src/tools/selection/index.js';

// ---------------------------------------------------------------------------
// known-issues mock — hoisted so withKnownIssues picks it up at import time
// ---------------------------------------------------------------------------

vi.mock('../src/tools/known-issues/store.js', () => ({
  readKnownIssues: vi.fn().mockResolvedValue([]),
}));

import { readKnownIssues } from '../src/tools/known-issues/store.js';
const mockReadKnownIssues = vi.mocked(readKnownIssues);

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

type ToolResultContent = Array<{ type: string; text: string }>;
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

// ---------------------------------------------------------------------------
// describe('selection tools')
// ---------------------------------------------------------------------------

describe('selection tools', () => {

  beforeEach(() => {
    // Reset known-issues mock to return no issues by default
    mockReadKnownIssues.mockResolvedValue([]);
  });

  // -------------------------------------------------------------------------
  // ue_select_actors
  // -------------------------------------------------------------------------
  describe('ue_select_actors', () => {
    it('happy path by label: returns selected_count in response', async () => {
      const responseData = {
        selected_count: 2,
        actors: [
          { label: 'Cube1', class: 'StaticMeshActor', selected: true },
          { label: 'Cube2', class: 'StaticMeshActor', selected: true },
        ],
      };
      const mockBridge = makeMockBridge({ responseData });
      const { server, handlers } = makeStubServer();
      registerSelectionTools(server, mockBridge);

      const handler = handlers.get('ue_select_actors')!;
      const result = await handler({ actors: ['Cube1', 'Cube2'] }) as ToolResultShape;

      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'selection.select' })
      );
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('selected_count');
    });

    it('happy path by class_filter: payload has class_filter forwarded', async () => {
      const mockBridge = makeMockBridge({ responseData: { selected_count: 3, actors: [] } });
      const { server, handlers } = makeStubServer();
      registerSelectionTools(server, mockBridge);

      const handler = handlers.get('ue_select_actors')!;
      await handler({ class_filter: 'PointLight' });

      const call = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.payload).toHaveProperty('class_filter', 'PointLight');
    });

    it('deselect action: payload has action deselect', async () => {
      const mockBridge = makeMockBridge({ responseData: { selected_count: 0, actors: [] } });
      const { server, handlers } = makeStubServer();
      registerSelectionTools(server, mockBridge);

      const handler = handlers.get('ue_select_actors')!;
      await handler({ actors: ['Cube1'], action: 'deselect' });

      const call = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.payload).toHaveProperty('action', 'deselect');
    });

    it('wildcard pattern: payload actors array contains Light*', async () => {
      const mockBridge = makeMockBridge({ responseData: { selected_count: 5, actors: [] } });
      const { server, handlers } = makeStubServer();
      registerSelectionTools(server, mockBridge);

      const handler = handlers.get('ue_select_actors')!;
      await handler({ actors: ['Light*'] });

      const call = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.payload.actors).toContain('Light*');
    });

    it('disconnected: returns isError:true with plugin_not_connected JSON', async () => {
      const mockBridge = makeMockBridge({ throwDisconnect: true });
      const { server, handlers } = makeStubServer();
      registerSelectionTools(server, mockBridge);

      const handler = handlers.get('ue_select_actors')!;
      const result = await handler({ actors: ['Cube1'] }) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('plugin_not_connected');
    });

    it('command error no_world_open: returns isError:true with error string', async () => {
      const mockBridge = makeMockBridge({ responseSuccess: false, responseError: 'no_world_open' });
      const { server, handlers } = makeStubServer();
      registerSelectionTools(server, mockBridge);

      const handler = handlers.get('ue_select_actors')!;
      const result = await handler({ actors: ['Cube1'] }) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('no_world_open');
    });

    it('command type verification: sendCommand type is exactly selection.select', async () => {
      const mockBridge = makeMockBridge({ responseData: { selected_count: 1, actors: [] } });
      const { server, handlers } = makeStubServer();
      registerSelectionTools(server, mockBridge);

      const handler = handlers.get('ue_select_actors')!;
      await handler({ actors: ['Cube1'] });

      const call = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.type).toBe('selection.select');
    });
  });

  // -------------------------------------------------------------------------
  // ue_get_selection
  // -------------------------------------------------------------------------
  describe('ue_get_selection', () => {
    it('happy path current mode: returns count in response', async () => {
      const responseData = {
        count: 3,
        actors: [
          {
            label: 'Cube',
            class: 'StaticMeshActor',
            location: { x: 0, y: 0, z: 0 },
            rotation: { pitch: 0, yaw: 0, roll: 0 },
            scale: { x: 1, y: 1, z: 1 },
          },
          {
            label: 'Light1',
            class: 'PointLight',
            location: { x: 100, y: 0, z: 200 },
            rotation: { pitch: 0, yaw: 0, roll: 0 },
            scale: { x: 1, y: 1, z: 1 },
          },
          {
            label: 'Camera1',
            class: 'CameraActor',
            location: { x: -200, y: 0, z: 100 },
            rotation: { pitch: 0, yaw: 90, roll: 0 },
            scale: { x: 1, y: 1, z: 1 },
          },
        ],
      };
      const mockBridge = makeMockBridge({ responseData });
      const { server, handlers } = makeStubServer();
      registerSelectionTools(server, mockBridge);

      const handler = handlers.get('ue_get_selection')!;
      const result = await handler({}) as ToolResultShape;

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('count');
    });

    it('select all mode: payload mode is all', async () => {
      const mockBridge = makeMockBridge({ responseData: { count: 10, actors: [] } });
      const { server, handlers } = makeStubServer();
      registerSelectionTools(server, mockBridge);

      const handler = handlers.get('ue_get_selection')!;
      await handler({ mode: 'all' });

      const call = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.payload).toHaveProperty('mode', 'all');
    });

    it('select none mode: payload mode is none', async () => {
      const mockBridge = makeMockBridge({ responseData: { count: 0, actors: [] } });
      const { server, handlers } = makeStubServer();
      registerSelectionTools(server, mockBridge);

      const handler = handlers.get('ue_get_selection')!;
      await handler({ mode: 'none' });

      const call = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.payload).toHaveProperty('mode', 'none');
    });

    it('invert mode: payload mode is invert', async () => {
      const mockBridge = makeMockBridge({ responseData: { count: 5, actors: [] } });
      const { server, handlers } = makeStubServer();
      registerSelectionTools(server, mockBridge);

      const handler = handlers.get('ue_get_selection')!;
      await handler({ mode: 'invert' });

      const call = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.payload).toHaveProperty('mode', 'invert');
    });

    it('empty selection: returns not isError with empty actors array', async () => {
      const mockBridge = makeMockBridge({ responseData: { count: 0, actors: [] } });
      const { server, handlers } = makeStubServer();
      registerSelectionTools(server, mockBridge);

      const handler = handlers.get('ue_get_selection')!;
      const result = await handler({}) as ToolResultShape;

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(Array.isArray(parsed.actors)).toBe(true);
      expect(parsed.actors).toHaveLength(0);
    });

    it('disconnected: returns isError:true with plugin_not_connected JSON', async () => {
      const mockBridge = makeMockBridge({ throwDisconnect: true });
      const { server, handlers } = makeStubServer();
      registerSelectionTools(server, mockBridge);

      const handler = handlers.get('ue_get_selection')!;
      const result = await handler({}) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('plugin_not_connected');
    });

    it('command type verification: sendCommand type is exactly selection.get', async () => {
      const mockBridge = makeMockBridge({ responseData: { count: 0, actors: [] } });
      const { server, handlers } = makeStubServer();
      registerSelectionTools(server, mockBridge);

      const handler = handlers.get('ue_get_selection')!;
      await handler({});

      const call = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.type).toBe('selection.get');
    });
  });

  // -------------------------------------------------------------------------
  // ue_duplicate_actors
  // -------------------------------------------------------------------------
  describe('ue_duplicate_actors', () => {
    it('happy path with offset: payload offset matches provided offset', async () => {
      const responseData = {
        duplicated_count: 2,
        actors: [
          { label: 'Cube1_Copy', class: 'StaticMeshActor', location: { x: 100, y: 0, z: 0 } },
          { label: 'Cube2_Copy', class: 'StaticMeshActor', location: { x: 300, y: 0, z: 50 } },
        ],
      };
      const mockBridge = makeMockBridge({ responseData });
      const { server, handlers } = makeStubServer();
      registerSelectionTools(server, mockBridge);

      const handler = handlers.get('ue_duplicate_actors')!;
      const result = await handler({ offset: { x: 200, y: 0, z: 50 } }) as ToolResultShape;

      const call = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.payload.offset).toEqual({ x: 200, y: 0, z: 50 });
      expect(result.isError).toBeFalsy();
    });

    it('default offset: handler sends an offset field in payload when no offset provided', async () => {
      const mockBridge = makeMockBridge({ responseData: { duplicated_count: 1, actors: [] } });
      const { server, handlers } = makeStubServer();
      registerSelectionTools(server, mockBridge);

      const handler = handlers.get('ue_duplicate_actors')!;
      await handler({});

      const call = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.payload).toHaveProperty('offset');
    });

    it('no selection: returns not isError with empty actors array', async () => {
      const mockBridge = makeMockBridge({ responseData: { duplicated_count: 0, actors: [] } });
      const { server, handlers } = makeStubServer();
      registerSelectionTools(server, mockBridge);

      const handler = handlers.get('ue_duplicate_actors')!;
      const result = await handler({}) as ToolResultShape;

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.duplicated_count).toBe(0);
    });

    it('disconnected: returns isError:true with plugin_not_connected JSON', async () => {
      const mockBridge = makeMockBridge({ throwDisconnect: true });
      const { server, handlers } = makeStubServer();
      registerSelectionTools(server, mockBridge);

      const handler = handlers.get('ue_duplicate_actors')!;
      const result = await handler({}) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('plugin_not_connected');
    });

    it('command error no_actors_selected: returns isError:true', async () => {
      const mockBridge = makeMockBridge({ responseSuccess: false, responseError: 'no_actors_selected' });
      const { server, handlers } = makeStubServer();
      registerSelectionTools(server, mockBridge);

      const handler = handlers.get('ue_duplicate_actors')!;
      const result = await handler({}) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('no_actors_selected');
    });

    it('known-issues warning: prepends warning content item when issue matches ue_duplicate_actors', async () => {
      mockReadKnownIssues.mockResolvedValue([
        {
          id: 'ISSUE-019',
          description: 'Test issue affecting ue_duplicate_actors',
          affectedTools: ['ue_duplicate_actors'],
          rootCause: 'Editor transaction stack',
          resolution: 'Save level before duplicating',
          dateAdded: '2026-05-30',
          status: 'active' as const,
        },
      ]);
      const mockBridge = makeMockBridge({ responseData: { duplicated_count: 1, actors: [] } });
      const { server, handlers } = makeStubServer();
      registerSelectionTools(server, mockBridge);

      const handler = handlers.get('ue_duplicate_actors')!;
      const result = await handler({}) as ToolResultShape;

      // Warning prepended + data = 2 items
      expect(result.content).toHaveLength(2);
      expect(result.content[0].text).toContain('[KNOWN ISSUE');
    });

    it('command type verification: sendCommand type is exactly selection.duplicate', async () => {
      const mockBridge = makeMockBridge({ responseData: { duplicated_count: 1, actors: [] } });
      const { server, handlers } = makeStubServer();
      registerSelectionTools(server, mockBridge);

      const handler = handlers.get('ue_duplicate_actors')!;
      await handler({});

      const call = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.type).toBe('selection.duplicate');
    });
  });

  // -------------------------------------------------------------------------
  // ue_convert_actor
  // -------------------------------------------------------------------------
  describe('ue_convert_actor', () => {
    it('happy path: returns new_label in response', async () => {
      const responseData = {
        success: true,
        new_label: 'BP_MyActor_1',
        new_class: 'BP_MyActor_C',
        location: { x: 0, y: 0, z: 100 },
      };
      const mockBridge = makeMockBridge({ responseData });
      const { server, handlers } = makeStubServer();
      registerSelectionTools(server, mockBridge);

      const handler = handlers.get('ue_convert_actor')!;
      const result = await handler({
        actor_label: 'Cube1',
        target_class: 'StaticMeshActor',
      }) as ToolResultShape;

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('new_label');
    });

    it('Blueprint class path: target_class full path forwarded correctly', async () => {
      const mockBridge = makeMockBridge({
        responseData: {
          success: true,
          new_label: 'BP_MyActor_1',
          new_class: 'BP_MyActor_C',
          location: { x: 0, y: 0, z: 0 },
        },
      });
      const { server, handlers } = makeStubServer();
      registerSelectionTools(server, mockBridge);

      const handler = handlers.get('ue_convert_actor')!;
      await handler({
        actor_label: 'Cube1',
        target_class: '/Game/BP_MyActor.BP_MyActor_C',
      });

      const call = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.payload).toHaveProperty('target_class', '/Game/BP_MyActor.BP_MyActor_C');
    });

    it('actor not found: returns isError:true with actor_not_found error', async () => {
      const mockBridge = makeMockBridge({ responseSuccess: false, responseError: 'actor_not_found' });
      const { server, handlers } = makeStubServer();
      registerSelectionTools(server, mockBridge);

      const handler = handlers.get('ue_convert_actor')!;
      const result = await handler({
        actor_label: 'NonExistent',
        target_class: 'StaticMeshActor',
      }) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('actor_not_found');
    });

    it('invalid target class: returns isError:true with invalid_target_class error', async () => {
      const mockBridge = makeMockBridge({ responseSuccess: false, responseError: 'invalid_target_class' });
      const { server, handlers } = makeStubServer();
      registerSelectionTools(server, mockBridge);

      const handler = handlers.get('ue_convert_actor')!;
      const result = await handler({
        actor_label: 'Cube1',
        target_class: 'NotAClass',
      }) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('invalid_target_class');
    });

    it('disconnected: returns isError:true with plugin_not_connected JSON', async () => {
      const mockBridge = makeMockBridge({ throwDisconnect: true });
      const { server, handlers } = makeStubServer();
      registerSelectionTools(server, mockBridge);

      const handler = handlers.get('ue_convert_actor')!;
      const result = await handler({
        actor_label: 'Cube1',
        target_class: 'StaticMeshActor',
      }) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('plugin_not_connected');
    });

    it('command type verification: sendCommand type is exactly selection.convert', async () => {
      const mockBridge = makeMockBridge({
        responseData: {
          success: true,
          new_label: 'BP_MyActor_1',
          new_class: 'BP_MyActor_C',
          location: { x: 0, y: 0, z: 0 },
        },
      });
      const { server, handlers } = makeStubServer();
      registerSelectionTools(server, mockBridge);

      const handler = handlers.get('ue_convert_actor')!;
      await handler({ actor_label: 'Cube1', target_class: 'StaticMeshActor' });

      const call = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.type).toBe('selection.convert');
    });
  });

});
