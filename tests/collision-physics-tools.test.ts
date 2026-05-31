// tests/collision-physics-tools.test.ts
// Integration tests for Phase 20 collision-physics MCP tools (PHY-01 through PHY-04).
// Uses injected mock PluginBridgeClient — no TCP server needed; handlers accept an
// injected bridge parameter via registerCollisionPhysicsTools.
//
// Port assignments (project-wide reference):
//   55557 — real UE Editor plugin (not running in tests)
//   55560 — plugin-bridge.test.ts mock server
//   55561 — blueprint-tools.test.ts mock server
//   55562 — bridge-cpp-tools.test.ts mock server
//   55563 — blueprint-write-tools.test.ts mock server
//   55564 — validation-tools.test.ts mock server
//   55565 — animation-tools.test.ts (reserved)
//   55566 — reserved for this file (not currently used)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PluginBridgeClient, PluginNotConnectedError } from '../src/plugin-bridge/client.js';
import { registerCollisionPhysicsTools } from '../src/tools/collision-physics/index.js';

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
// Realistic mock response data (per plan specification)
// ---------------------------------------------------------------------------

const COLLISION_READ_DATA = {
  profile_name: 'BlockAll',
  collision_enabled: 'QueryAndPhysics',
  object_type: 1,
  object_type_name: 'WorldStatic',
  responses: [
    { channel: 0, channel_name: 'WorldStatic', response: 'Block' },
  ],
};

const COLLISION_SET_DATA = {
  profile_name: 'Custom',
  collision_enabled: 'QueryAndPhysics',
  object_type: 0,
  object_type_name: 'WorldDynamic',
  responses: [
    { channel: 0, channel_name: 'WorldStatic', response: 'Block' },
    { channel: 1, channel_name: 'WorldDynamic', response: 'Overlap' },
  ],
};

const PHYSICS_MATERIAL_DATA = {
  asset_path: '/Game/PhysMats/PM_Rock',
  friction: 0.7,
  restitution: 0.3,
  density: 1.0,
  surface_type: 1,
  surface_type_name: 'Default',
};

const PHYSICS_ASSET_DATA = {
  asset_path: '/Game/SK_Mannequin_PhysicsAsset',
  bodies: [
    {
      bone_name: 'pelvis',
      primitives: [{ type: 'capsule', radius: 10.0, length: 20.0 }],
      mass_override: null,
    },
  ],
};

// ---------------------------------------------------------------------------
// describe('collision-physics tools')
// ---------------------------------------------------------------------------

describe('collision-physics tools', () => {

  // -------------------------------------------------------------------------
  // ue_read_collision (PHY-01)
  // -------------------------------------------------------------------------
  describe('ue_read_collision', () => {
    let mockBridge: PluginBridgeClient;

    beforeEach(() => {
      vi.clearAllMocks();
      mockBridge = makeMockBridge({ responseData: COLLISION_READ_DATA });
    });

    it('success: returns collision profile data with profile_name, collision_enabled, object_type, and responses array', async () => {
      const { server, handlers } = makeStubServer();
      registerCollisionPhysicsTools(server, mockBridge);
      const handler = handlers.get('ue_read_collision')!;
      const result = await handler({ actor_label: 'SM_Cube' }) as ToolResultShape;
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.profile_name).toBe('BlockAll');
      expect(parsed.collision_enabled).toBe('QueryAndPhysics');
      expect(parsed.object_type).toBe(1);
      expect(parsed.object_type_name).toBe('WorldStatic');
      expect(Array.isArray(parsed.responses)).toBe(true);
      expect(parsed.responses[0].channel_name).toBe('WorldStatic');
      expect(parsed.responses[0].response).toBe('Block');
    });

    it('success: sends collision.read command with correct actor_label payload', async () => {
      const { server, handlers } = makeStubServer();
      registerCollisionPhysicsTools(server, mockBridge);
      const handler = handlers.get('ue_read_collision')!;
      await handler({ actor_label: 'SM_Cube' });
      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'collision.read',
          payload: expect.objectContaining({ actor_label: 'SM_Cube' }),
        })
      );
    });

    it('success: includes component_name in payload when provided', async () => {
      const { server, handlers } = makeStubServer();
      registerCollisionPhysicsTools(server, mockBridge);
      const handler = handlers.get('ue_read_collision')!;
      await handler({ actor_label: 'SM_Cube', component_name: 'StaticMeshComponent0' });
      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'collision.read',
          payload: expect.objectContaining({
            actor_label: 'SM_Cube',
            component_name: 'StaticMeshComponent0',
          }),
        })
      );
    });

    it('success: omits component_name from payload when not provided', async () => {
      const { server, handlers } = makeStubServer();
      registerCollisionPhysicsTools(server, mockBridge);
      const handler = handlers.get('ue_read_collision')!;
      await handler({ actor_label: 'SM_Cube' });
      const call = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.payload).not.toHaveProperty('component_name');
    });

    it('error: plugin returns success:false with error string -> isError:true result', async () => {
      mockBridge = makeMockBridge({
        responseSuccess: false,
        responseError: 'actor_not_found',
      });
      const { server, handlers } = makeStubServer();
      registerCollisionPhysicsTools(server, mockBridge);
      const handler = handlers.get('ue_read_collision')!;
      const result = await handler({ actor_label: 'NonExistent' }) as ToolResultShape;
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('actor_not_found');
    });

    it('error: plugin not connected -> returns plugin_not_connected error', async () => {
      mockBridge = makeMockBridge({ throwDisconnect: true });
      const { server, handlers } = makeStubServer();
      registerCollisionPhysicsTools(server, mockBridge);
      const handler = handlers.get('ue_read_collision')!;
      const result = await handler({ actor_label: 'SM_Cube' }) as ToolResultShape;
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('plugin_not_connected');
      expect(parsed.required_plugin).toBe(true);
    });

    it('success: parses response with empty responses array (no per-channel overrides)', async () => {
      mockBridge = makeMockBridge({
        responseData: { ...COLLISION_READ_DATA, responses: [] },
      });
      const { server, handlers } = makeStubServer();
      registerCollisionPhysicsTools(server, mockBridge);
      const handler = handlers.get('ue_read_collision')!;
      const result = await handler({ actor_label: 'SM_Cube' }) as ToolResultShape;
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(Array.isArray(parsed.responses)).toBe(true);
      expect(parsed.responses).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // ue_set_collision (PHY-02)
  // -------------------------------------------------------------------------
  describe('ue_set_collision', () => {
    let mockBridge: PluginBridgeClient;

    beforeEach(() => {
      vi.clearAllMocks();
      mockBridge = makeMockBridge({ responseData: COLLISION_SET_DATA });
    });

    it('success: sends collision.set with preset field and returns updated collision state', async () => {
      const { server, handlers } = makeStubServer();
      registerCollisionPhysicsTools(server, mockBridge);
      const handler = handlers.get('ue_set_collision')!;
      const result = await handler({
        actor_label: 'SM_Cube',
        preset: 'BlockAll',
      }) as ToolResultShape;
      expect(result.isError).toBeFalsy();
      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'collision.set',
          payload: expect.objectContaining({ preset: 'BlockAll' }),
        })
      );
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.profile_name).toBe('Custom');
      expect(parsed.collision_enabled).toBe('QueryAndPhysics');
    });

    it('success: sends collision.set with responses array for per-channel overrides', async () => {
      const { server, handlers } = makeStubServer();
      registerCollisionPhysicsTools(server, mockBridge);
      const handler = handlers.get('ue_set_collision')!;
      const responses = [
        { channel: 0, response: 'Block' as const },
        { channel: 1, response: 'Overlap' as const },
      ];
      await handler({ actor_label: 'SM_Cube', responses });
      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'collision.set',
          payload: expect.objectContaining({ responses }),
        })
      );
    });

    it('success: sends both preset and responses when both provided', async () => {
      const { server, handlers } = makeStubServer();
      registerCollisionPhysicsTools(server, mockBridge);
      const handler = handlers.get('ue_set_collision')!;
      const responses = [{ channel: 0, response: 'Block' as const }];
      await handler({ actor_label: 'SM_Cube', preset: 'Custom', responses });
      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'collision.set',
          payload: expect.objectContaining({
            preset: 'Custom',
            responses,
          }),
        })
      );
    });

    it('success: includes component_name in payload when provided', async () => {
      const { server, handlers } = makeStubServer();
      registerCollisionPhysicsTools(server, mockBridge);
      const handler = handlers.get('ue_set_collision')!;
      await handler({
        actor_label: 'SM_Cube',
        component_name: 'StaticMeshComponent0',
        preset: 'OverlapAll',
      });
      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'collision.set',
          payload: expect.objectContaining({
            component_name: 'StaticMeshComponent0',
          }),
        })
      );
    });

    it('success: omits optional fields (preset, responses, component_name) when undefined', async () => {
      const { server, handlers } = makeStubServer();
      registerCollisionPhysicsTools(server, mockBridge);
      const handler = handlers.get('ue_set_collision')!;
      await handler({ actor_label: 'SM_Cube' });
      const call = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.payload).not.toHaveProperty('preset');
      expect(call.payload).not.toHaveProperty('responses');
      expect(call.payload).not.toHaveProperty('component_name');
      expect(call.payload.actor_label).toBe('SM_Cube');
    });

    it('error: plugin returns success:false -> isError:true result', async () => {
      mockBridge = makeMockBridge({
        responseSuccess: false,
        responseError: 'component_not_found',
      });
      const { server, handlers } = makeStubServer();
      registerCollisionPhysicsTools(server, mockBridge);
      const handler = handlers.get('ue_set_collision')!;
      const result = await handler({
        actor_label: 'SM_Cube',
        preset: 'BlockAll',
      }) as ToolResultShape;
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('component_not_found');
    });

    it('error: plugin not connected -> returns plugin_not_connected error', async () => {
      mockBridge = makeMockBridge({ throwDisconnect: true });
      const { server, handlers } = makeStubServer();
      registerCollisionPhysicsTools(server, mockBridge);
      const handler = handlers.get('ue_set_collision')!;
      const result = await handler({
        actor_label: 'SM_Cube',
        preset: 'BlockAll',
      }) as ToolResultShape;
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('plugin_not_connected');
      expect(parsed.required_plugin).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // ue_manage_physical_material (PHY-03)
  // -------------------------------------------------------------------------
  describe('ue_manage_physical_material', () => {
    let mockBridge: PluginBridgeClient;

    beforeEach(() => {
      vi.clearAllMocks();
      mockBridge = makeMockBridge({ responseData: PHYSICS_MATERIAL_DATA });
    });

    it('success: read action returns friction, restitution, density, surface_type', async () => {
      const { server, handlers } = makeStubServer();
      registerCollisionPhysicsTools(server, mockBridge);
      const handler = handlers.get('ue_manage_physical_material')!;
      const result = await handler({
        asset_path: '/Game/PhysMats/PM_Rock',
        action: 'read',
      }) as ToolResultShape;
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.friction).toBe(0.7);
      expect(parsed.restitution).toBe(0.3);
      expect(parsed.density).toBe(1.0);
      expect(parsed.surface_type).toBe(1);
      expect(parsed.surface_type_name).toBe('Default');
    });

    it('success: sends physics.material with action "read" and asset_path', async () => {
      const { server, handlers } = makeStubServer();
      registerCollisionPhysicsTools(server, mockBridge);
      const handler = handlers.get('ue_manage_physical_material')!;
      await handler({ asset_path: '/Game/PhysMats/PM_Rock', action: 'read' });
      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'physics.material',
          payload: expect.objectContaining({
            action: 'read',
            asset_path: '/Game/PhysMats/PM_Rock',
          }),
        })
      );
    });

    it('success: write action sends all provided numeric fields (friction, restitution, density)', async () => {
      const { server, handlers } = makeStubServer();
      registerCollisionPhysicsTools(server, mockBridge);
      const handler = handlers.get('ue_manage_physical_material')!;
      await handler({
        asset_path: '/Game/PhysMats/PM_Rock',
        action: 'write',
        friction: 0.8,
        restitution: 0.2,
        density: 1.5,
      });
      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'physics.material',
          payload: expect.objectContaining({
            action: 'write',
            friction: 0.8,
            restitution: 0.2,
            density: 1.5,
          }),
        })
      );
    });

    it('success: write action omits undefined optional fields from payload', async () => {
      const { server, handlers } = makeStubServer();
      registerCollisionPhysicsTools(server, mockBridge);
      const handler = handlers.get('ue_manage_physical_material')!;
      await handler({
        asset_path: '/Game/PhysMats/PM_Rock',
        action: 'write',
        friction: 0.9,
      });
      const call = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.payload.friction).toBe(0.9);
      expect(call.payload).not.toHaveProperty('restitution');
      expect(call.payload).not.toHaveProperty('density');
      expect(call.payload).not.toHaveProperty('surface_type');
    });

    it('success: includes surface_type in payload when provided', async () => {
      const { server, handlers } = makeStubServer();
      registerCollisionPhysicsTools(server, mockBridge);
      const handler = handlers.get('ue_manage_physical_material')!;
      await handler({
        asset_path: '/Game/PhysMats/PM_Rock',
        action: 'write',
        surface_type: 3,
      });
      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'physics.material',
          payload: expect.objectContaining({ surface_type: 3 }),
        })
      );
    });

    it('error: plugin returns success:false -> isError:true result', async () => {
      mockBridge = makeMockBridge({
        responseSuccess: false,
        responseError: 'asset_not_found',
      });
      const { server, handlers } = makeStubServer();
      registerCollisionPhysicsTools(server, mockBridge);
      const handler = handlers.get('ue_manage_physical_material')!;
      const result = await handler({
        asset_path: '/Game/PhysMats/PM_Missing',
        action: 'read',
      }) as ToolResultShape;
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('asset_not_found');
    });

    it('error: plugin not connected -> returns plugin_not_connected error', async () => {
      mockBridge = makeMockBridge({ throwDisconnect: true });
      const { server, handlers } = makeStubServer();
      registerCollisionPhysicsTools(server, mockBridge);
      const handler = handlers.get('ue_manage_physical_material')!;
      const result = await handler({
        asset_path: '/Game/PhysMats/PM_Rock',
        action: 'read',
      }) as ToolResultShape;
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('plugin_not_connected');
      expect(parsed.required_plugin).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // ue_inspect_physics_asset (PHY-04)
  // -------------------------------------------------------------------------
  describe('ue_inspect_physics_asset', () => {
    let mockBridge: PluginBridgeClient;

    beforeEach(() => {
      vi.clearAllMocks();
      mockBridge = makeMockBridge({ responseData: PHYSICS_ASSET_DATA });
    });

    it('success: returns bodies array with bone_name and primitives for each body setup', async () => {
      const { server, handlers } = makeStubServer();
      registerCollisionPhysicsTools(server, mockBridge);
      const handler = handlers.get('ue_inspect_physics_asset')!;
      const result = await handler({
        asset_path: '/Game/SK_Mannequin_PhysicsAsset',
      }) as ToolResultShape;
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(Array.isArray(parsed.bodies)).toBe(true);
      expect(parsed.bodies[0].bone_name).toBe('pelvis');
      expect(Array.isArray(parsed.bodies[0].primitives)).toBe(true);
      expect(parsed.bodies[0].primitives[0].type).toBe('capsule');
      expect(parsed.bodies[0].primitives[0].radius).toBe(10.0);
      expect(parsed.bodies[0].primitives[0].length).toBe(20.0);
    });

    it('success: sends physics.asset command with correct asset_path payload', async () => {
      const { server, handlers } = makeStubServer();
      registerCollisionPhysicsTools(server, mockBridge);
      const handler = handlers.get('ue_inspect_physics_asset')!;
      await handler({ asset_path: '/Game/SK_Mannequin_PhysicsAsset' });
      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'physics.asset',
          payload: expect.objectContaining({
            asset_path: '/Game/SK_Mannequin_PhysicsAsset',
          }),
        })
      );
    });

    it('success: handles physics asset with multiple body types (capsules, spheres, boxes)', async () => {
      const multiBodyData = {
        asset_path: '/Game/Characters/SK_Hero_PhysicsAsset',
        bodies: [
          {
            bone_name: 'spine_01',
            primitives: [{ type: 'capsule', radius: 8.0, length: 15.0 }],
            mass_override: null,
          },
          {
            bone_name: 'head',
            primitives: [{ type: 'sphere', radius: 12.0 }],
            mass_override: 2.5,
          },
          {
            bone_name: 'hand_r',
            primitives: [{ type: 'box', x: 5.0, y: 5.0, z: 3.0 }],
            mass_override: null,
          },
        ],
      };
      mockBridge = makeMockBridge({ responseData: multiBodyData });
      const { server, handlers } = makeStubServer();
      registerCollisionPhysicsTools(server, mockBridge);
      const handler = handlers.get('ue_inspect_physics_asset')!;
      const result = await handler({
        asset_path: '/Game/Characters/SK_Hero_PhysicsAsset',
      }) as ToolResultShape;
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.bodies).toHaveLength(3);
      expect(parsed.bodies[0].primitives[0].type).toBe('capsule');
      expect(parsed.bodies[1].primitives[0].type).toBe('sphere');
      expect(parsed.bodies[1].mass_override).toBe(2.5);
      expect(parsed.bodies[2].primitives[0].type).toBe('box');
    });

    it('success: handles empty bodies array (physics asset with no setups)', async () => {
      mockBridge = makeMockBridge({
        responseData: {
          asset_path: '/Game/SK_Empty_PhysicsAsset',
          bodies: [],
        },
      });
      const { server, handlers } = makeStubServer();
      registerCollisionPhysicsTools(server, mockBridge);
      const handler = handlers.get('ue_inspect_physics_asset')!;
      const result = await handler({
        asset_path: '/Game/SK_Empty_PhysicsAsset',
      }) as ToolResultShape;
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(Array.isArray(parsed.bodies)).toBe(true);
      expect(parsed.bodies).toHaveLength(0);
    });

    it('error: plugin returns success:false -> isError:true result', async () => {
      mockBridge = makeMockBridge({
        responseSuccess: false,
        responseError: 'physics_asset_not_found',
      });
      const { server, handlers } = makeStubServer();
      registerCollisionPhysicsTools(server, mockBridge);
      const handler = handlers.get('ue_inspect_physics_asset')!;
      const result = await handler({
        asset_path: '/Game/NonExistent_PhysicsAsset',
      }) as ToolResultShape;
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('physics_asset_not_found');
    });

    it('error: plugin not connected -> returns plugin_not_connected error', async () => {
      mockBridge = makeMockBridge({ throwDisconnect: true });
      const { server, handlers } = makeStubServer();
      registerCollisionPhysicsTools(server, mockBridge);
      const handler = handlers.get('ue_inspect_physics_asset')!;
      const result = await handler({
        asset_path: '/Game/SK_Mannequin_PhysicsAsset',
      }) as ToolResultShape;
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('plugin_not_connected');
      expect(parsed.required_plugin).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Tool registration checks
  // -------------------------------------------------------------------------
  describe('registerCollisionPhysicsTools — registration', () => {
    it('registers exactly 4 tools on the stub server', () => {
      const mockBridge = makeMockBridge({});
      const { server, handlers } = makeStubServer();
      registerCollisionPhysicsTools(server, mockBridge);
      expect(handlers.size).toBe(4);
    });

    it('tool names are: ue_read_collision, ue_set_collision, ue_manage_physical_material, ue_inspect_physics_asset', () => {
      const mockBridge = makeMockBridge({});
      const { server, handlers } = makeStubServer();
      registerCollisionPhysicsTools(server, mockBridge);
      const expectedTools = [
        'ue_read_collision',
        'ue_set_collision',
        'ue_manage_physical_material',
        'ue_inspect_physics_asset',
      ];
      for (const name of expectedTools) {
        expect(handlers.has(name), `Tool "${name}" should be registered`).toBe(true);
      }
    });
  });
});
