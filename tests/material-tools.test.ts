// tests/material-tools.test.ts
// Integration tests for Phase 15 material MCP tools.
// Uses mock PluginBridgeClient injected into registerMaterialTools — no real TCP server.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PluginBridgeClient, PluginNotConnectedError } from '../src/plugin-bridge/client.js';
import { registerMaterialTools } from '../src/tools/material/index.js';

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
// describe('material tools')
// ---------------------------------------------------------------------------

describe('material tools', () => {

  // -------------------------------------------------------------------------
  // ue_material_params
  // -------------------------------------------------------------------------
  describe('ue_material_params', () => {
    let mockBridge: PluginBridgeClient;

    beforeEach(() => {
      mockBridge = makeMockBridge({
        responseData: {
          parameters: [
            { name: 'Roughness', type: 'scalar', value: 0.5 },
            { name: 'BaseColor', type: 'vector', value: { r: 1, g: 0, b: 0, a: 1 } },
            { name: 'NormalMap', type: 'texture', value: '/Game/Textures/T_Rock_N' },
          ],
        },
      });
    });

    it('success: returns parameters array with scalar/vector/texture entries from plugin response', async () => {
      const { server, handlers } = makeStubServer();
      registerMaterialTools(server, mockBridge);

      const handler = handlers.get('ue_material_params')!;
      const result = await handler({ asset_path: '/Game/Materials/M_Rock' }) as ToolResultShape;

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.parameters).toHaveLength(3);
      expect(parsed.parameters[0]).toHaveProperty('name', 'Roughness');
      expect(parsed.parameters[0]).toHaveProperty('type', 'scalar');
      expect(parsed.parameters[0]).toHaveProperty('value', 0.5);
    });

    it('success: sends material.params command with correct asset_path payload', async () => {
      const { server, handlers } = makeStubServer();
      registerMaterialTools(server, mockBridge);

      const handler = handlers.get('ue_material_params')!;
      await handler({ asset_path: '/Game/Materials/M_Rock' });

      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'material.params',
          payload: { asset_path: '/Game/Materials/M_Rock' },
        })
      );
    });

    it('error: returns isError:true with error JSON when plugin returns success:false', async () => {
      mockBridge = makeMockBridge({ responseSuccess: false, responseError: 'asset_not_found' });
      const { server, handlers } = makeStubServer();
      registerMaterialTools(server, mockBridge);

      const handler = handlers.get('ue_material_params')!;
      const result = await handler({ asset_path: '/Game/Materials/M_Missing' }) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('asset_not_found');
    });

    it('disconnected: returns plugin_not_connected JSON when bridge throws PluginNotConnectedError', async () => {
      mockBridge = makeMockBridge({ throwDisconnect: true });
      const { server, handlers } = makeStubServer();
      registerMaterialTools(server, mockBridge);

      const handler = handlers.get('ue_material_params')!;
      const result = await handler({ asset_path: '/Game/Materials/M_Rock' }) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('plugin_not_connected');
    });

    it('payload shape: data.parameters is present in the result text', async () => {
      const { server, handlers } = makeStubServer();
      registerMaterialTools(server, mockBridge);

      const handler = handlers.get('ue_material_params')!;
      const result = await handler({ asset_path: '/Game/Materials/MI_Rock_Red' }) as ToolResultShape;

      expect(result.content[0].text).toContain('parameters');
    });
  });

  // -------------------------------------------------------------------------
  // ue_create_material_instance
  // -------------------------------------------------------------------------
  describe('ue_create_material_instance', () => {
    let mockBridge: PluginBridgeClient;

    beforeEach(() => {
      mockBridge = makeMockBridge({
        responseData: {
          instance_path: '/Game/Materials/MI_Rock_Red',
          parent_path: '/Game/Materials/M_Rock',
          success: true,
        },
      });
    });

    it('success: returns instance_path from plugin response', async () => {
      const { server, handlers } = makeStubServer();
      registerMaterialTools(server, mockBridge);

      const handler = handlers.get('ue_create_material_instance')!;
      const result = await handler({
        parent_path: '/Game/Materials/M_Rock',
        instance_path: '/Game/Materials',
        instance_name: 'MI_Rock_Red',
      }) as ToolResultShape;

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.instance_path).toBe('/Game/Materials/MI_Rock_Red');
    });

    it('success: sends material.createInstance with parent_path, instance_path, instance_name', async () => {
      const { server, handlers } = makeStubServer();
      registerMaterialTools(server, mockBridge);

      const handler = handlers.get('ue_create_material_instance')!;
      await handler({
        parent_path: '/Game/Materials/M_Rock',
        instance_path: '/Game/Materials',
        instance_name: 'MI_Rock_Red',
      });

      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'material.createInstance',
          payload: {
            parent_path: '/Game/Materials/M_Rock',
            instance_path: '/Game/Materials',
            instance_name: 'MI_Rock_Red',
          },
        })
      );
    });

    it('error: returns isError:true when plugin returns success:false (e.g. parent_material_not_found)', async () => {
      mockBridge = makeMockBridge({ responseSuccess: false, responseError: 'parent_material_not_found' });
      const { server, handlers } = makeStubServer();
      registerMaterialTools(server, mockBridge);

      const handler = handlers.get('ue_create_material_instance')!;
      const result = await handler({
        parent_path: '/Game/Materials/M_Missing',
        instance_path: '/Game/Materials',
        instance_name: 'MI_Missing',
      }) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('parent_material_not_found');
    });

    it('disconnected: returns plugin_not_connected JSON', async () => {
      mockBridge = makeMockBridge({ throwDisconnect: true });
      const { server, handlers } = makeStubServer();
      registerMaterialTools(server, mockBridge);

      const handler = handlers.get('ue_create_material_instance')!;
      const result = await handler({
        parent_path: '/Game/Materials/M_Rock',
        instance_path: '/Game/Materials',
        instance_name: 'MI_Rock_Red',
      }) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('plugin_not_connected');
    });

    it('payload: verifies all three required fields forwarded to sendCommand', async () => {
      const { server, handlers } = makeStubServer();
      registerMaterialTools(server, mockBridge);

      const handler = handlers.get('ue_create_material_instance')!;
      await handler({
        parent_path: '/Game/Materials/M_Brick',
        instance_path: '/Game/Instances',
        instance_name: 'MI_Brick_Old',
      });

      const call = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.type).toBe('material.createInstance');
      expect(call.payload).toHaveProperty('parent_path', '/Game/Materials/M_Brick');
      expect(call.payload).toHaveProperty('instance_path', '/Game/Instances');
      expect(call.payload).toHaveProperty('instance_name', 'MI_Brick_Old');
    });
  });

  // -------------------------------------------------------------------------
  // ue_set_material_param
  // -------------------------------------------------------------------------
  describe('ue_set_material_param', () => {
    let mockBridge: PluginBridgeClient;

    beforeEach(() => {
      mockBridge = makeMockBridge({
        responseData: {
          asset_path: '/Game/Materials/MI_Rock_Red',
          param_name: 'Roughness',
          applied: true,
        },
      });
    });

    it('scalar: sends material.setParam with param_type "scalar" and float value', async () => {
      const { server, handlers } = makeStubServer();
      registerMaterialTools(server, mockBridge);

      const handler = handlers.get('ue_set_material_param')!;
      await handler({
        asset_path: '/Game/Materials/MI_Rock_Red',
        param_name: 'Roughness',
        param_type: 'scalar',
        value: 0.75,
      });

      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'material.setParam',
          payload: expect.objectContaining({
            param_type: 'scalar',
            value: 0.75,
          }),
        })
      );
    });

    it('vector: sends material.setParam with param_type "vector" and {r,g,b,a} value object', async () => {
      const { server, handlers } = makeStubServer();
      registerMaterialTools(server, mockBridge);

      const handler = handlers.get('ue_set_material_param')!;
      await handler({
        asset_path: '/Game/Materials/MI_Rock_Red',
        param_name: 'BaseColor',
        param_type: 'vector',
        value: { r: 0.8, g: 0.2, b: 0.1, a: 1.0 },
      });

      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'material.setParam',
          payload: expect.objectContaining({
            param_type: 'vector',
            value: { r: 0.8, g: 0.2, b: 0.1, a: 1.0 },
          }),
        })
      );
    });

    it('texture: sends material.setParam with param_type "texture" and asset path string value', async () => {
      const { server, handlers } = makeStubServer();
      registerMaterialTools(server, mockBridge);

      const handler = handlers.get('ue_set_material_param')!;
      await handler({
        asset_path: '/Game/Materials/MI_Rock_Red',
        param_name: 'NormalMap',
        param_type: 'texture',
        value: '/Game/Textures/T_Rock_N',
      });

      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'material.setParam',
          payload: expect.objectContaining({
            param_type: 'texture',
            value: '/Game/Textures/T_Rock_N',
          }),
        })
      );
    });

    it('success: returns applied:true from plugin response', async () => {
      const { server, handlers } = makeStubServer();
      registerMaterialTools(server, mockBridge);

      const handler = handlers.get('ue_set_material_param')!;
      const result = await handler({
        asset_path: '/Game/Materials/MI_Rock_Red',
        param_name: 'Roughness',
        param_type: 'scalar',
        value: 0.5,
      }) as ToolResultShape;

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.applied).toBe(true);
    });

    it('error: returns isError:true when plugin returns success:false (e.g. material_instance_not_found)', async () => {
      mockBridge = makeMockBridge({ responseSuccess: false, responseError: 'material_instance_not_found' });
      const { server, handlers } = makeStubServer();
      registerMaterialTools(server, mockBridge);

      const handler = handlers.get('ue_set_material_param')!;
      const result = await handler({
        asset_path: '/Game/Materials/MI_Missing',
        param_name: 'Roughness',
        param_type: 'scalar',
        value: 0.5,
      }) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('material_instance_not_found');
    });

    it('error: returns isError:true when plugin returns success:false (e.g. invalid_param_type)', async () => {
      mockBridge = makeMockBridge({ responseSuccess: false, responseError: 'invalid_param_type' });
      const { server, handlers } = makeStubServer();
      registerMaterialTools(server, mockBridge);

      const handler = handlers.get('ue_set_material_param')!;
      const result = await handler({
        asset_path: '/Game/Materials/MI_Rock_Red',
        param_name: 'Roughness',
        param_type: 'scalar',
        value: 0.5,
      }) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('invalid_param_type');
    });

    it('disconnected: returns plugin_not_connected JSON', async () => {
      mockBridge = makeMockBridge({ throwDisconnect: true });
      const { server, handlers } = makeStubServer();
      registerMaterialTools(server, mockBridge);

      const handler = handlers.get('ue_set_material_param')!;
      const result = await handler({
        asset_path: '/Game/Materials/MI_Rock_Red',
        param_name: 'Roughness',
        param_type: 'scalar',
        value: 0.5,
      }) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('plugin_not_connected');
    });
  });

  // -------------------------------------------------------------------------
  // ue_actor_materials
  // -------------------------------------------------------------------------
  describe('ue_actor_materials', () => {
    let mockBridge: PluginBridgeClient;

    beforeEach(() => {
      mockBridge = makeMockBridge({
        responseData: {
          materials: ['/Game/Materials/M_Rock', '/Game/Materials/M_Dirt'],
          count: 2,
        },
      });
    });

    it('actor_label: sends material.actorMaterials with actor_label in payload', async () => {
      const { server, handlers } = makeStubServer();
      registerMaterialTools(server, mockBridge);

      const handler = handlers.get('ue_actor_materials')!;
      await handler({ actor_label: 'StaticMeshActor_0' });

      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'material.actorMaterials',
          payload: expect.objectContaining({ actor_label: 'StaticMeshActor_0' }),
        })
      );
    });

    it('asset_path: sends material.actorMaterials with asset_path in payload', async () => {
      const { server, handlers } = makeStubServer();
      registerMaterialTools(server, mockBridge);

      const handler = handlers.get('ue_actor_materials')!;
      await handler({ asset_path: '/Game/Meshes/SM_Rock' });

      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'material.actorMaterials',
          payload: expect.objectContaining({ asset_path: '/Game/Meshes/SM_Rock' }),
        })
      );
    });

    it('both: sends payload containing both actor_label and asset_path when both provided', async () => {
      const { server, handlers } = makeStubServer();
      registerMaterialTools(server, mockBridge);

      const handler = handlers.get('ue_actor_materials')!;
      await handler({
        actor_label: 'StaticMeshActor_0',
        asset_path: '/Game/Meshes/SM_Rock',
      });

      const call = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.type).toBe('material.actorMaterials');
      expect(call.payload).toHaveProperty('actor_label', 'StaticMeshActor_0');
      expect(call.payload).toHaveProperty('asset_path', '/Game/Meshes/SM_Rock');
    });

    it('success: returns materials array and count from plugin response', async () => {
      const { server, handlers } = makeStubServer();
      registerMaterialTools(server, mockBridge);

      const handler = handlers.get('ue_actor_materials')!;
      const result = await handler({ actor_label: 'StaticMeshActor_0' }) as ToolResultShape;

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.materials).toHaveLength(2);
      expect(parsed.count).toBe(2);
      expect(parsed.materials[0]).toBe('/Game/Materials/M_Rock');
    });

    it('error: returns isError:true when plugin returns success:false (e.g. actor_not_found)', async () => {
      mockBridge = makeMockBridge({ responseSuccess: false, responseError: 'actor_not_found' });
      const { server, handlers } = makeStubServer();
      registerMaterialTools(server, mockBridge);

      const handler = handlers.get('ue_actor_materials')!;
      const result = await handler({ actor_label: 'NonExistentActor' }) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('actor_not_found');
    });

    it('error: returns isError:true when plugin returns success:false (e.g. static_mesh_not_found)', async () => {
      mockBridge = makeMockBridge({ responseSuccess: false, responseError: 'static_mesh_not_found' });
      const { server, handlers } = makeStubServer();
      registerMaterialTools(server, mockBridge);

      const handler = handlers.get('ue_actor_materials')!;
      const result = await handler({ asset_path: '/Game/Meshes/SM_Missing' }) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('static_mesh_not_found');
    });

    it('disconnected: returns plugin_not_connected JSON', async () => {
      mockBridge = makeMockBridge({ throwDisconnect: true });
      const { server, handlers } = makeStubServer();
      registerMaterialTools(server, mockBridge);

      const handler = handlers.get('ue_actor_materials')!;
      const result = await handler({ actor_label: 'StaticMeshActor_0' }) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('plugin_not_connected');
    });

    it('empty payload: sends material.actorMaterials with empty payload when no args provided (plugin validates)', async () => {
      const { server, handlers } = makeStubServer();
      registerMaterialTools(server, mockBridge);

      const handler = handlers.get('ue_actor_materials')!;
      await handler({});

      const call = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.type).toBe('material.actorMaterials');
      expect(call.payload).toEqual({});
    });
  });

  // -------------------------------------------------------------------------
  // Structural checks
  // -------------------------------------------------------------------------
  describe('tool registration', () => {
    it('registers exactly four material tools', () => {
      const mockBridge = makeMockBridge({});
      const { server, handlers } = makeStubServer();
      registerMaterialTools(server, mockBridge);

      expect(handlers.size).toBe(4);
    });

    it('registers all expected tool names', () => {
      const mockBridge = makeMockBridge({});
      const { server, handlers } = makeStubServer();
      registerMaterialTools(server, mockBridge);

      const expectedTools = [
        'ue_material_params',
        'ue_create_material_instance',
        'ue_set_material_param',
        'ue_actor_materials',
      ];
      for (const name of expectedTools) {
        expect(handlers.has(name), `Tool "${name}" should be registered`).toBe(true);
      }
    });
  });
});
