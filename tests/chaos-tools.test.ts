// tests/chaos-tools.test.ts
// Integration tests for Phase 26 Chaos physics MCP tools (CHAOS-01 through CHAOS-04).
// Uses injected mock PluginBridgeClient — no TCP server needed; handlers accept an
// injected bridge parameter via exported handler functions and registerChaosTools.
//
// Port assignments (project-wide reference):
//   55557 — real UE Editor plugin (not running in tests)
//   55560 — plugin-bridge.test.ts mock server
//   55561 — blueprint-tools.test.ts mock server
//   55562 — bridge-cpp-tools.test.ts mock server
//   55563 — blueprint-write-tools.test.ts mock server
//   55564 — validation-tools.test.ts mock server
//   55565 — animation-tools.test.ts mock server
//   55566 — collision-physics-tools.test.ts (reserved)
//   55573 — gas-tools.test.ts (Phase 25 GAS-01 through GAS-04)
//   55574 — chaos-tools.test.ts (this file, Phase 26 CHAOS-01 through CHAOS-04)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PluginBridgeClient, PluginNotConnectedError } from '../src/plugin-bridge/client.js';
import {
  handleInspectGeometryCollection,
  handleResetDestruction,
  handleReadClothParams,
  handleManagePhysicsCache,
  registerChaosTools,
} from '../src/tools/chaos/index.js';

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

const GC_INSPECT_DATA = {
  asset_path: '/Game/Destruction/GC_Wall',
  actor_label: '',
  bone_count: 25,
  levels: [
    { level: 0, bone_count: 1 },
    { level: 1, bone_count: 4 },
    { level: 2, bone_count: 20 },
  ],
  hierarchy: [
    { index: 0, parent: -1, children: [1, 2, 3, 4], level: 0, name: 'Root' },
    { index: 1, parent: 0, children: [5, 6, 7, 8, 9], level: 1, name: 'Cluster_0' },
  ],
  damage_thresholds: [500.0, 250.0, 100.0],
};

const GC_INSPECT_BY_ACTOR_DATA = {
  asset_path: '',
  actor_label: 'GC_Wall_01',
  bone_count: 25,
  levels: [
    { level: 0, bone_count: 1 },
    { level: 1, bone_count: 4 },
    { level: 2, bone_count: 20 },
  ],
  hierarchy: [
    { index: 0, parent: -1, children: [1, 2, 3, 4], level: 0, name: 'Root' },
  ],
  damage_thresholds: [500.0, 250.0],
};

const DESTRUCTION_RESET_DATA = {
  actor_label: 'GC_Wall_01',
  success: true,
  bone_count: 25,
};

const CLOTH_PARAMS_DATA = {
  actor_label: 'SK_Character',
  asset_path: '',
  cloth_assets: [
    {
      asset_name: 'Cape_Cloth',
      self_collision_thickness: 1.0,
      friction: 0.4,
      damping: 0.01,
      gravity_scale: 1.0,
      wind_drag: 0.5,
      wind_lift: 0.3,
      bend_stiffness: 0.8,
      stretch_stiffness: 1.0,
      shear_stiffness: 0.6,
    },
  ],
};

const PHYSICS_CACHE_QUERY_DATA = {
  action: 'query',
  status: 'recording',
  frame_count: 150,
  time_range: { start: 0.0, end: 5.0 },
};

const PHYSICS_CACHE_START_DATA = {
  action: 'start',
  status: 'recording',
  frame_count: 0,
  time_range: { start: 0.0, end: 0.0 },
};

const PHYSICS_CACHE_STOP_DATA = {
  action: 'stop',
  status: 'stopped',
  frame_count: 300,
  time_range: { start: 0.0, end: 10.0 },
};

// ---------------------------------------------------------------------------
// describe('ue_inspect_geometry_collection (CHAOS-01)')
// ---------------------------------------------------------------------------

describe('ue_inspect_geometry_collection (CHAOS-01)', () => {
  let mockBridge: PluginBridgeClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockBridge = makeMockBridge({ responseData: GC_INSPECT_DATA });
  });

  it('returns fracture hierarchy with bone count and levels on success (asset_path)', async () => {
    const result = await handleInspectGeometryCollection(
      { asset_path: '/Game/Destruction/GC_Wall' },
      mockBridge
    ) as ToolResultShape;
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.bone_count).toBe(25);
    expect(parsed.levels).toHaveLength(3);
    expect(parsed.hierarchy[0].name).toBe('Root');
    expect(parsed.damage_thresholds).toEqual([500.0, 250.0, 100.0]);
  });

  it('returns hierarchy by actor_label', async () => {
    mockBridge = makeMockBridge({ responseData: GC_INSPECT_BY_ACTOR_DATA });
    const result = await handleInspectGeometryCollection(
      { actor_label: 'GC_Wall_01' },
      mockBridge
    ) as ToolResultShape;
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.actor_label).toBe('GC_Wall_01');
    expect(parsed.bone_count).toBe(25);
  });

  it('sends correct command type chaos.geometryCollection', async () => {
    await handleInspectGeometryCollection(
      { asset_path: '/Game/Destruction/GC_Wall' },
      mockBridge
    );
    expect(mockBridge.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'chaos.geometryCollection' })
    );
  });

  it('includes only provided fields in payload (asset_path without actor_label)', async () => {
    await handleInspectGeometryCollection({ asset_path: '/Game/GC' }, mockBridge);
    const call = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.payload).toHaveProperty('asset_path', '/Game/GC');
    expect(call.payload).not.toHaveProperty('actor_label');
  });

  it('returns isError on command failure', async () => {
    mockBridge = makeMockBridge({ responseSuccess: false, responseError: 'asset_not_found' });
    const result = await handleInspectGeometryCollection(
      { asset_path: '/Game/Missing/GC' },
      mockBridge
    ) as ToolResultShape;
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('asset_not_found');
  });

  it('returns plugin_not_connected when bridge disconnected', async () => {
    mockBridge = makeMockBridge({ throwDisconnect: true });
    const result = await handleInspectGeometryCollection(
      { asset_path: '/Game/Destruction/GC_Wall' },
      mockBridge
    ) as ToolResultShape;
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('plugin_not_connected');
  });
});

// ---------------------------------------------------------------------------
// describe('ue_reset_destruction (CHAOS-02)')
// ---------------------------------------------------------------------------

describe('ue_reset_destruction (CHAOS-02)', () => {
  let mockBridge: PluginBridgeClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockBridge = makeMockBridge({ responseData: DESTRUCTION_RESET_DATA });
  });

  it('returns success with bone count after destruction reset', async () => {
    const result = await handleResetDestruction(
      { actor_label: 'GC_Wall_01' },
      mockBridge
    ) as ToolResultShape;
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.bone_count).toBe(25);
    expect(parsed.actor_label).toBe('GC_Wall_01');
  });

  it('sends correct command type chaos.resetDestruction with actor_label', async () => {
    await handleResetDestruction({ actor_label: 'GC_Wall_01' }, mockBridge);
    expect(mockBridge.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'chaos.resetDestruction',
        payload: expect.objectContaining({ actor_label: 'GC_Wall_01' }),
      })
    );
  });

  it('returns isError when actor not found', async () => {
    mockBridge = makeMockBridge({ responseSuccess: false, responseError: 'actor_not_found' });
    const result = await handleResetDestruction(
      { actor_label: 'NonExistentActor' },
      mockBridge
    ) as ToolResultShape;
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('actor_not_found');
  });

  it('returns isError on command failure (no geometry collection component)', async () => {
    mockBridge = makeMockBridge({
      responseSuccess: false,
      responseError: 'no_geometry_collection_component',
    });
    const result = await handleResetDestruction(
      { actor_label: 'SM_Cube' },
      mockBridge
    ) as ToolResultShape;
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('no_geometry_collection_component');
  });

  it('returns plugin_not_connected when bridge disconnected', async () => {
    mockBridge = makeMockBridge({ throwDisconnect: true });
    const result = await handleResetDestruction(
      { actor_label: 'GC_Wall_01' },
      mockBridge
    ) as ToolResultShape;
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('plugin_not_connected');
  });
});

// ---------------------------------------------------------------------------
// describe('ue_read_cloth_params (CHAOS-03)')
// ---------------------------------------------------------------------------

describe('ue_read_cloth_params (CHAOS-03)', () => {
  let mockBridge: PluginBridgeClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockBridge = makeMockBridge({ responseData: CLOTH_PARAMS_DATA });
  });

  it('returns cloth asset parameters on success', async () => {
    const result = await handleReadClothParams(
      { actor_label: 'SK_Character' },
      mockBridge
    ) as ToolResultShape;
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.cloth_assets).toHaveLength(1);
    const asset = parsed.cloth_assets[0];
    expect(asset.asset_name).toBe('Cape_Cloth');
    expect(asset.bend_stiffness).toBe(0.8);
    expect(asset.friction).toBe(0.4);
  });

  it('sends correct command type chaos.cloth', async () => {
    await handleReadClothParams({ actor_label: 'SK_Character' }, mockBridge);
    expect(mockBridge.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'chaos.cloth' })
    );
  });

  it('includes actor_label in payload when provided', async () => {
    await handleReadClothParams({ actor_label: 'SK_Character' }, mockBridge);
    expect(mockBridge.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'chaos.cloth',
        payload: expect.objectContaining({ actor_label: 'SK_Character' }),
      })
    );
  });

  it('includes asset_path in payload when provided', async () => {
    await handleReadClothParams({ asset_path: '/Game/Cloth/Cape_Asset' }, mockBridge);
    expect(mockBridge.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'chaos.cloth',
        payload: expect.objectContaining({ asset_path: '/Game/Cloth/Cape_Asset' }),
      })
    );
    const call = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.payload).not.toHaveProperty('actor_label');
  });

  it('returns isError on command failure', async () => {
    mockBridge = makeMockBridge({
      responseSuccess: false,
      responseError: 'chaos_cloth_not_available',
    });
    const result = await handleReadClothParams(
      { actor_label: 'SK_Character' },
      mockBridge
    ) as ToolResultShape;
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('chaos_cloth_not_available');
  });

  it('returns plugin_not_connected when bridge disconnected', async () => {
    mockBridge = makeMockBridge({ throwDisconnect: true });
    const result = await handleReadClothParams(
      { actor_label: 'SK_Character' },
      mockBridge
    ) as ToolResultShape;
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('plugin_not_connected');
  });
});

// ---------------------------------------------------------------------------
// describe('ue_manage_physics_cache (CHAOS-04)')
// ---------------------------------------------------------------------------

describe('ue_manage_physics_cache (CHAOS-04)', () => {
  let mockBridge: PluginBridgeClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockBridge = makeMockBridge({ responseData: PHYSICS_CACHE_QUERY_DATA });
  });

  it('returns cache query status on success', async () => {
    const result = await handleManagePhysicsCache(
      { action: 'query' },
      mockBridge
    ) as ToolResultShape;
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe('recording');
    expect(parsed.frame_count).toBe(150);
    expect(parsed.action).toBe('query');
    expect(parsed.time_range.end).toBe(5.0);
  });

  it('returns started status on start action', async () => {
    mockBridge = makeMockBridge({ responseData: PHYSICS_CACHE_START_DATA });
    const result = await handleManagePhysicsCache(
      { action: 'start' },
      mockBridge
    ) as ToolResultShape;
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe('recording');
    expect(parsed.frame_count).toBe(0);
  });

  it('returns stopped status on stop action', async () => {
    mockBridge = makeMockBridge({ responseData: PHYSICS_CACHE_STOP_DATA });
    const result = await handleManagePhysicsCache(
      { action: 'stop' },
      mockBridge
    ) as ToolResultShape;
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe('stopped');
    expect(parsed.frame_count).toBe(300);
    expect(parsed.time_range.end).toBe(10.0);
  });

  it('sends correct command type chaos.physicsCache', async () => {
    await handleManagePhysicsCache({ action: 'query' }, mockBridge);
    expect(mockBridge.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'chaos.physicsCache' })
    );
  });

  it('includes actor_label in payload when provided', async () => {
    await handleManagePhysicsCache(
      { action: 'query', actor_label: 'GC_Wall_01' },
      mockBridge
    );
    expect(mockBridge.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'chaos.physicsCache',
        payload: expect.objectContaining({
          action: 'query',
          actor_label: 'GC_Wall_01',
        }),
      })
    );
  });

  it('returns isError on command failure', async () => {
    mockBridge = makeMockBridge({
      responseSuccess: false,
      responseError: 'physics_cache_not_available',
    });
    const result = await handleManagePhysicsCache(
      { action: 'query' },
      mockBridge
    ) as ToolResultShape;
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('physics_cache_not_available');
  });

  it('returns plugin_not_connected when bridge disconnected', async () => {
    mockBridge = makeMockBridge({ throwDisconnect: true });
    const result = await handleManagePhysicsCache(
      { action: 'query' },
      mockBridge
    ) as ToolResultShape;
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('plugin_not_connected');
  });
});

// ---------------------------------------------------------------------------
// describe('registerChaosTools')
// ---------------------------------------------------------------------------

describe('registerChaosTools', () => {
  it('registers exactly four tools', () => {
    const mockBridge = makeMockBridge({});
    const { server, handlers } = makeStubServer();
    registerChaosTools(server, mockBridge);
    expect(handlers.size).toBe(4);
  });

  it('registers all four expected tool names', () => {
    const mockBridge = makeMockBridge({});
    const { server, handlers } = makeStubServer();
    registerChaosTools(server, mockBridge);
    const expectedTools = [
      'ue_inspect_geometry_collection',
      'ue_reset_destruction',
      'ue_read_cloth_params',
      'ue_manage_physics_cache',
    ];
    for (const name of expectedTools) {
      expect(handlers.has(name), `Tool "${name}" should be registered`).toBe(true);
    }
  });

  it('tools call sendCommand via injected bridge', async () => {
    const mockBridge = makeMockBridge({ responseData: GC_INSPECT_DATA });
    const { server, handlers } = makeStubServer();
    registerChaosTools(server, mockBridge);

    const gcHandler = handlers.get('ue_inspect_geometry_collection')!;
    await gcHandler({ asset_path: '/Game/Destruction/GC_Wall' });
    expect(mockBridge.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'chaos.geometryCollection' })
    );
  });
});
