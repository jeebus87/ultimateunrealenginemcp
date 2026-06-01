// tests/editor.test.ts
// Integration tests for Phase 9 editor tools.
// Uses a mock PluginBridgeClient injected into registerEditorTools.
// Does NOT spin up a real TCP server or real McpServer.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PluginBridgeClient, PluginNotConnectedError } from '../src/plugin-bridge/client.js';
import { registerEditorTools } from '../src/tools/editor/index.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Create a minimal mock PluginBridgeClient for testing.
 * sendCommand resolves with success response by default.
 * Pass connected:false to simulate a disconnected plugin.
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

  const mock = {
    isConnected: vi.fn().mockReturnValue(opts.connected ?? true),
    getDisconnectedError: vi.fn().mockReturnValue(disconnectedError),
    sendCommand: sendCommandImpl,
    destroy: vi.fn(),
  } as unknown as PluginBridgeClient;

  return mock;
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
// describe('editor tools')
// ---------------------------------------------------------------------------

describe('editor tools', () => {
  // -------------------------------------------------------------------------
  // ue_list_actors
  // -------------------------------------------------------------------------
  describe('ue_list_actors', () => {
    it('calls sendCommand with { type: "actor.list" } and returns data as JSON text', async () => {
      const actorList = [{ label: 'Floor', class: 'StaticMeshActor' }];
      const mockBridge = makeMockBridge({ responseData: actorList });
      const { server, handlers } = makeStubServer();
      registerEditorTools(server, mockBridge);

      const handler = handlers.get('ue_list_actors')!;
      const result = await handler({}) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'actor.list' })
      );
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toBe(JSON.stringify(actorList));
    });

    it('returns plugin_not_connected error when bridge throws PluginNotConnectedError', async () => {
      const mockBridge = makeMockBridge({ throwDisconnect: true });
      const { server, handlers } = makeStubServer();
      registerEditorTools(server, mockBridge);

      const handler = handlers.get('ue_list_actors')!;
      const result = await handler({}) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('plugin_not_connected');
    });

    it('returns isError:true when command responds with success:false', async () => {
      const mockBridge = makeMockBridge({ responseSuccess: false, responseError: 'no_world_open' });
      const { server, handlers } = makeStubServer();
      registerEditorTools(server, mockBridge);

      const handler = handlers.get('ue_list_actors')!;
      const result = await handler({}) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('no_world_open');
    });
  });

  // -------------------------------------------------------------------------
  // ue_spawn_actor
  // -------------------------------------------------------------------------
  describe('ue_spawn_actor', () => {
    const spawnArgs = {
      class_name: 'AStaticMeshActor',
      location: { x: 100, y: 0, z: 0 },
    };

    it('calls sendCommand with actor.spawn type and correct payload', async () => {
      const mockBridge = makeMockBridge({ responseData: { actor_label: 'StaticMeshActor_1' } });
      const { server, handlers } = makeStubServer();
      registerEditorTools(server, mockBridge);

      const handler = handlers.get('ue_spawn_actor')!;
      await handler(spawnArgs);

      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'actor.spawn',
          payload: { class_name: 'AStaticMeshActor', location: { x: 100, y: 0, z: 0 } },
        })
      );
    });

    it('returns the spawned actor label in response text', async () => {
      const responseData = { actor_label: 'StaticMeshActor_1' };
      const mockBridge = makeMockBridge({ responseData });
      const { server, handlers } = makeStubServer();
      registerEditorTools(server, mockBridge);

      const handler = handlers.get('ue_spawn_actor')!;
      const result = await handler(spawnArgs) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBeFalsy();
      const text = result.content[0].text;
      expect(text).toContain('StaticMeshActor_1');
    });

    it('returns plugin_not_connected error when bridge throws PluginNotConnectedError', async () => {
      const mockBridge = makeMockBridge({ throwDisconnect: true });
      const { server, handlers } = makeStubServer();
      registerEditorTools(server, mockBridge);

      const handler = handlers.get('ue_spawn_actor')!;
      const result = await handler(spawnArgs) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('plugin_not_connected');
    });

    it('returns isError:true when command responds with success:false', async () => {
      const mockBridge = makeMockBridge({ responseSuccess: false, responseError: 'spawn_failed' });
      const { server, handlers } = makeStubServer();
      registerEditorTools(server, mockBridge);

      const handler = handlers.get('ue_spawn_actor')!;
      const result = await handler(spawnArgs) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // ue_transform_actor
  // -------------------------------------------------------------------------
  describe('ue_transform_actor', () => {
    it('sends payload with location only when only location provided', async () => {
      const mockBridge = makeMockBridge({ responseData: {} });
      const { server, handlers } = makeStubServer();
      registerEditorTools(server, mockBridge);

      const handler = handlers.get('ue_transform_actor')!;
      await handler({ actor_label: 'Floor', location: { x: 0, y: 0, z: 100 } });

      const call = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.type).toBe('actor.transform');
      expect(call.payload).toHaveProperty('location', { x: 0, y: 0, z: 100 });
      expect(call.payload).not.toHaveProperty('rotation');
      expect(call.payload).not.toHaveProperty('scale');
    });

    it('sends payload with location, rotation, and scale when all provided', async () => {
      const mockBridge = makeMockBridge({ responseData: {} });
      const { server, handlers } = makeStubServer();
      registerEditorTools(server, mockBridge);

      const handler = handlers.get('ue_transform_actor')!;
      await handler({
        actor_label: 'Floor',
        location: { x: 0, y: 0, z: 0 },
        rotation: { pitch: 0, yaw: 90, roll: 0 },
        scale: { x: 2, y: 2, z: 2 },
      });

      const call = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.payload).toHaveProperty('location');
      expect(call.payload).toHaveProperty('rotation', { pitch: 0, yaw: 90, roll: 0 });
      expect(call.payload).toHaveProperty('scale', { x: 2, y: 2, z: 2 });
    });

    it('sends payload with scale only when only scale provided', async () => {
      const mockBridge = makeMockBridge({ responseData: {} });
      const { server, handlers } = makeStubServer();
      registerEditorTools(server, mockBridge);

      const handler = handlers.get('ue_transform_actor')!;
      await handler({ actor_label: 'Floor', scale: { x: 3, y: 3, z: 3 } });

      const call = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.payload).toHaveProperty('scale', { x: 3, y: 3, z: 3 });
      expect(call.payload).not.toHaveProperty('location');
      expect(call.payload).not.toHaveProperty('rotation');
    });

    it('returns plugin_not_connected error when bridge throws PluginNotConnectedError', async () => {
      const mockBridge = makeMockBridge({ throwDisconnect: true });
      const { server, handlers } = makeStubServer();
      registerEditorTools(server, mockBridge);

      const handler = handlers.get('ue_transform_actor')!;
      const result = await handler({ actor_label: 'Floor', location: { x: 0, y: 0, z: 0 } }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('plugin_not_connected');
    });
  });

  // -------------------------------------------------------------------------
  // ue_delete_actor
  // -------------------------------------------------------------------------
  describe('ue_delete_actor', () => {
    it('calls sendCommand with actor.delete type and actor_label payload', async () => {
      const mockBridge = makeMockBridge({ responseData: {} });
      const { server, handlers } = makeStubServer();
      registerEditorTools(server, mockBridge);

      const handler = handlers.get('ue_delete_actor')!;
      await handler({ actor_label: 'MyActor' });

      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'actor.delete',
          payload: { actor_label: 'MyActor' },
        })
      );
    });

    it('returns isError:true when command returns actor_not_found error', async () => {
      const mockBridge = makeMockBridge({ responseSuccess: false, responseError: 'actor_not_found' });
      const { server, handlers } = makeStubServer();
      registerEditorTools(server, mockBridge);

      const handler = handlers.get('ue_delete_actor')!;
      const result = await handler({ actor_label: 'Ghost' }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('actor_not_found');
    });

    it('returns plugin_not_connected error when bridge throws PluginNotConnectedError', async () => {
      const mockBridge = makeMockBridge({ throwDisconnect: true });
      const { server, handlers } = makeStubServer();
      registerEditorTools(server, mockBridge);

      const handler = handlers.get('ue_delete_actor')!;
      const result = await handler({ actor_label: 'MyActor' }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('plugin_not_connected');
    });
  });

  // -------------------------------------------------------------------------
  // ue_query_assets
  // -------------------------------------------------------------------------
  describe('ue_query_assets', () => {
    it('calls sendCommand with asset.query and empty payload when no filters', async () => {
      const mockBridge = makeMockBridge({ responseData: [] });
      const { server, handlers } = makeStubServer();
      registerEditorTools(server, mockBridge);

      const handler = handlers.get('ue_query_assets')!;
      await handler({});

      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'asset.query',
          payload: {},
        })
      );
    });

    it('maps asset_type to asset_class in payload when filter provided', async () => {
      const mockBridge = makeMockBridge({ responseData: [] });
      const { server, handlers } = makeStubServer();
      registerEditorTools(server, mockBridge);

      const handler = handlers.get('ue_query_assets')!;
      await handler({ asset_type: 'StaticMesh' });

      const call = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.payload).toHaveProperty('asset_class', 'StaticMesh');
      expect(call.payload).not.toHaveProperty('asset_type');
    });

    it('returns plugin_not_connected error when bridge throws PluginNotConnectedError', async () => {
      const mockBridge = makeMockBridge({ throwDisconnect: true });
      const { server, handlers } = makeStubServer();
      registerEditorTools(server, mockBridge);

      const handler = handlers.get('ue_query_assets')!;
      const result = await handler({}) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('plugin_not_connected');
    });
  });

  // -------------------------------------------------------------------------
  // ue_trace_references
  // -------------------------------------------------------------------------
  describe('ue_trace_references', () => {
    it('calls sendCommand with asset.references and package_path payload', async () => {
      const refData = { referencers: [], dependencies: [] };
      const mockBridge = makeMockBridge({ responseData: refData });
      const { server, handlers } = makeStubServer();
      registerEditorTools(server, mockBridge);

      const handler = handlers.get('ue_trace_references')!;
      const result = await handler({ package_path: '/Game/Meshes/SM_Rock' }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'asset.references',
          payload: { package_path: '/Game/Meshes/SM_Rock' },
        })
      );
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toBe(JSON.stringify(refData));
    });

    it('returns plugin_not_connected error when bridge throws PluginNotConnectedError', async () => {
      const mockBridge = makeMockBridge({ throwDisconnect: true });
      const { server, handlers } = makeStubServer();
      registerEditorTools(server, mockBridge);

      const handler = handlers.get('ue_trace_references')!;
      const result = await handler({ package_path: '/Game/Meshes/SM_Rock' }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('plugin_not_connected');
    });
  });

  // -------------------------------------------------------------------------
  // ue_read_level_layout
  // -------------------------------------------------------------------------
  describe('ue_read_level_layout', () => {
    it('calls sendCommand with level.layout and returns data as JSON text', async () => {
      const layoutData = { level_name: 'TestLevel', actors: [], streaming_levels: [] };
      const mockBridge = makeMockBridge({ responseData: layoutData });
      const { server, handlers } = makeStubServer();
      registerEditorTools(server, mockBridge);

      const handler = handlers.get('ue_read_level_layout')!;
      const result = await handler({}) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'level.layout' })
      );
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toBe(JSON.stringify(layoutData));
    });

    it('returns plugin_not_connected error when bridge throws PluginNotConnectedError', async () => {
      const mockBridge = makeMockBridge({ throwDisconnect: true });
      const { server, handlers } = makeStubServer();
      registerEditorTools(server, mockBridge);

      const handler = handlers.get('ue_read_level_layout')!;
      const result = await handler({}) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('plugin_not_connected');
    });
  });

  // -------------------------------------------------------------------------
  // Structural checks
  // -------------------------------------------------------------------------
  describe('tool registration', () => {
    it('registers exactly ten tools', () => {
      const mockBridge = makeMockBridge({});
      const { server, handlers } = makeStubServer();
      registerEditorTools(server, mockBridge);

      expect(handlers.size).toBe(10);
    });

    it('registers all expected tool names', () => {
      const mockBridge = makeMockBridge({});
      const { server, handlers } = makeStubServer();
      registerEditorTools(server, mockBridge);

      const expectedTools = [
        'ue_list_actors',
        'ue_spawn_actor',
        'ue_transform_actor',
        'ue_delete_actor',
        'ue_query_assets',
        'ue_trace_references',
        'ue_read_level_layout',
      ];
      for (const name of expectedTools) {
        expect(handlers.has(name), `Tool "${name}" should be registered`).toBe(true);
      }
    });

    it('does NOT register deprecated ue_move_actor tool', () => {
      const mockBridge = makeMockBridge({});
      const { server, handlers } = makeStubServer();
      registerEditorTools(server, mockBridge);

      expect(handlers.has('ue_move_actor')).toBe(false);
    });
  });
});
