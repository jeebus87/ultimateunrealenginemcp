// tests/worldpartition-tools.test.ts
// Integration tests for all four World Partition tool handlers (WP-01 through WP-04).
// Uses injected mock PluginBridgeClient — no TCP server needed; handlers accept an
// injected bridge parameter via their exported function signatures.
//
// Requirements covered: WP-01 (ue_read_world_partition), WP-02 (ue_manage_data_layers),
//   WP-03 (ue_inspect_streaming_sources), WP-04 (ue_trigger_hlod_generation)
//
// Port assignment comment: port 55566 is reserved for this file if a TCP mock server
// is needed later, but this test file uses injected mock bridges only.
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
import {
  handleReadWorldPartition,
  handleManageDataLayers,
  handleInspectStreamingSources,
  handleTriggerHlodGeneration,
  registerWorldPartitionTools,
} from '../src/tools/worldpartition/index.js';
import { PluginBridgeClient, PluginNotConnectedError } from '../src/plugin-bridge/client.js';
import type {
  WorldPartitionSettingsResult,
  DataLayersResult,
  StreamingSourcesResult,
  HlodResult,
} from '../src/tools/worldpartition/types.js';

// ---------------------------------------------------------------------------
// Suppress unused-import warnings for type-only imports
// ---------------------------------------------------------------------------
type _UnusedImports =
  | WorldPartitionSettingsResult
  | DataLayersResult
  | StreamingSourcesResult
  | HlodResult;

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

const WP_SETTINGS_DATA = {
  grid_size: 12800,
  loading_range: 25600,
  enable_streaming: true,
  runtime_hash_name: 'UWorldPartitionRuntimeSpatialHash',
};

const DATA_LAYERS_LIST_DATA = {
  layers: [
    {
      name: 'Gameplay',
      type: 'Runtime',
      initial_runtime_state: 'Activated',
      is_initially_visible: true,
    },
    {
      name: 'Cinematic',
      type: 'Editor',
      initial_runtime_state: 'Unloaded',
      is_initially_visible: false,
    },
  ],
  count: 2,
};

const DATA_LAYER_CREATED_DATA = {
  layer: {
    name: 'NewLayer',
    type: 'Runtime',
    initial_runtime_state: 'Unloaded',
    is_initially_visible: true,
  },
};

const DATA_LAYER_TOGGLED_DATA = {
  layer: {
    name: 'Gameplay',
    type: 'Runtime',
    initial_runtime_state: 'Loaded',
    is_initially_visible: true,
  },
};

const DATA_LAYER_ASSIGNED_DATA = {
  actor_label: 'BP_Enemy_01',
  layer_name: 'Gameplay',
  success: true,
};

const STREAMING_SOURCES_DATA = {
  streaming_sources: [
    {
      actor_label: 'StreamingVolume_0',
      component_name: 'StreamingSource',
      target_state: 'Activated',
      shapes: ['Box'],
      priority: 1,
    },
  ],
  count: 1,
};

const HLOD_INSPECT_DATA = {
  hlod_layers: [
    {
      layer_name: 'HLODLayer0',
      cell_size: 25600,
      loading_range: 51200,
      hlod_level: 0,
      is_spatially_loaded: true,
    },
  ],
  count: 1,
};

const HLOD_GENERATE_DATA = {
  status: 'triggered',
  message: 'HLOD generation started. Check editor logs for progress.',
};

// ---------------------------------------------------------------------------
// Group 1: handleReadWorldPartition — plugin disconnected (WP-01)
// ---------------------------------------------------------------------------

describe('Group 1: handleReadWorldPartition — plugin disconnected (WP-01)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns isError:true when bridge throws PluginNotConnectedError', async () => {
    const bridge = makeMockBridge({ throwDisconnect: true });
    const result = await handleReadWorldPartition({}, bridge);
    expect(result.isError).toBe(true);
  });

  it('returns plugin_not_connected JSON with required_plugin:true in content[0].text', async () => {
    const bridge = makeMockBridge({ throwDisconnect: true });
    const result = await handleReadWorldPartition({}, bridge);
    const parsed = JSON.parse((result as ToolResultShape).content[0].text);
    expect(parsed.error).toBe('plugin_not_connected');
    expect(parsed.required_plugin).toBe(true);
  });

  it('content[0].type is text', async () => {
    const bridge = makeMockBridge({ throwDisconnect: true });
    const result = await handleReadWorldPartition({}, bridge);
    expect((result as ToolResultShape).content[0].type).toBe('text');
  });
});

// ---------------------------------------------------------------------------
// Group 2: handleReadWorldPartition — happy path (WP-01)
// ---------------------------------------------------------------------------

describe('Group 2: handleReadWorldPartition — happy path (WP-01)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns WP settings JSON with grid_size, loading_range, enable_streaming, runtime_hash_name', async () => {
    const bridge = makeMockBridge({ responseData: WP_SETTINGS_DATA });
    const result = await handleReadWorldPartition({}, bridge);
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result as ToolResultShape).content[0].text);
    expect(parsed.grid_size).toBe(12800);
    expect(parsed.loading_range).toBe(25600);
    expect(parsed.enable_streaming).toBe(true);
    expect(parsed.runtime_hash_name).toBe('UWorldPartitionRuntimeSpatialHash');
  });

  it('isError is undefined (not set) on success', async () => {
    const bridge = makeMockBridge({ responseData: WP_SETTINGS_DATA });
    const result = await handleReadWorldPartition({}, bridge);
    expect(result.isError).toBeUndefined();
  });

  it('sends command type worldpartition.settings to bridge', async () => {
    const bridge = makeMockBridge({ responseData: WP_SETTINGS_DATA });
    await handleReadWorldPartition({}, bridge);
    expect(bridge.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'worldpartition.settings',
      })
    );
  });
});

// ---------------------------------------------------------------------------
// Group 3: handleManageDataLayers — plugin disconnected (WP-02)
// ---------------------------------------------------------------------------

describe('Group 3: handleManageDataLayers — plugin disconnected (WP-02)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns isError:true when bridge throws PluginNotConnectedError', async () => {
    const bridge = makeMockBridge({ throwDisconnect: true });
    const result = await handleManageDataLayers({ action: 'list' }, bridge);
    expect(result.isError).toBe(true);
  });

  it('returns plugin_not_connected JSON in content[0].text', async () => {
    const bridge = makeMockBridge({ throwDisconnect: true });
    const result = await handleManageDataLayers({ action: 'list' }, bridge);
    const parsed = JSON.parse((result as ToolResultShape).content[0].text);
    expect(parsed.error).toBe('plugin_not_connected');
    expect(parsed.required_plugin).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Group 4: handleManageDataLayers — list action (WP-02)
// ---------------------------------------------------------------------------

describe('Group 4: handleManageDataLayers — list action (WP-02)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns layers array with count on success', async () => {
    const bridge = makeMockBridge({ responseData: DATA_LAYERS_LIST_DATA });
    const result = await handleManageDataLayers({ action: 'list' }, bridge);
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result as ToolResultShape).content[0].text);
    expect(Array.isArray(parsed.layers)).toBe(true);
    expect(parsed.layers[0].name).toBe('Gameplay');
    expect(parsed.layers[1].name).toBe('Cinematic');
    expect(parsed.count).toBe(2);
  });

  it('sends command type worldpartition.dataLayers with action list in payload', async () => {
    const bridge = makeMockBridge({ responseData: DATA_LAYERS_LIST_DATA });
    await handleManageDataLayers({ action: 'list' }, bridge);
    expect(bridge.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'worldpartition.dataLayers',
        payload: expect.objectContaining({ action: 'list' }),
      })
    );
  });

  it('payload includes action field', async () => {
    const bridge = makeMockBridge({ responseData: DATA_LAYERS_LIST_DATA });
    await handleManageDataLayers({ action: 'list' }, bridge);
    const call = (bridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.payload).toHaveProperty('action', 'list');
  });
});

// ---------------------------------------------------------------------------
// Group 5: handleManageDataLayers — create action (WP-02)
// ---------------------------------------------------------------------------

describe('Group 5: handleManageDataLayers — create action (WP-02)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns created layer on success', async () => {
    const bridge = makeMockBridge({ responseData: DATA_LAYER_CREATED_DATA });
    const result = await handleManageDataLayers(
      { action: 'create', layer_name: 'NewLayer', layer_type: 'Runtime' },
      bridge
    );
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result as ToolResultShape).content[0].text);
    expect(parsed.layer.name).toBe('NewLayer');
    expect(parsed.layer.type).toBe('Runtime');
  });

  it('sends payload with action create, layer_name, layer_type', async () => {
    const bridge = makeMockBridge({ responseData: DATA_LAYER_CREATED_DATA });
    await handleManageDataLayers(
      { action: 'create', layer_name: 'NewLayer', layer_type: 'Runtime' },
      bridge
    );
    expect(bridge.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'worldpartition.dataLayers',
        payload: expect.objectContaining({
          action: 'create',
          layer_name: 'NewLayer',
          layer_type: 'Runtime',
        }),
      })
    );
  });
});

// ---------------------------------------------------------------------------
// Group 6: handleManageDataLayers — toggle action (WP-02)
// ---------------------------------------------------------------------------

describe('Group 6: handleManageDataLayers — toggle action (WP-02)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns toggled layer on success', async () => {
    const bridge = makeMockBridge({ responseData: DATA_LAYER_TOGGLED_DATA });
    const result = await handleManageDataLayers(
      { action: 'toggle', layer_name: 'Gameplay', initial_state: 'Loaded' },
      bridge
    );
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result as ToolResultShape).content[0].text);
    expect(parsed.layer.name).toBe('Gameplay');
    expect(parsed.layer.initial_runtime_state).toBe('Loaded');
  });

  it('sends payload with action toggle, layer_name, initial_state', async () => {
    const bridge = makeMockBridge({ responseData: DATA_LAYER_TOGGLED_DATA });
    await handleManageDataLayers(
      { action: 'toggle', layer_name: 'Gameplay', initial_state: 'Loaded' },
      bridge
    );
    expect(bridge.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'worldpartition.dataLayers',
        payload: expect.objectContaining({
          action: 'toggle',
          layer_name: 'Gameplay',
          initial_state: 'Loaded',
        }),
      })
    );
  });
});

// ---------------------------------------------------------------------------
// Group 7: handleManageDataLayers — assign_actor action (WP-02)
// ---------------------------------------------------------------------------

describe('Group 7: handleManageDataLayers — assign_actor action (WP-02)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns assign result on success', async () => {
    const bridge = makeMockBridge({ responseData: DATA_LAYER_ASSIGNED_DATA });
    const result = await handleManageDataLayers(
      { action: 'assign_actor', layer_name: 'Gameplay', actor_label: 'BP_Enemy_01' },
      bridge
    );
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result as ToolResultShape).content[0].text);
    expect(parsed.actor_label).toBe('BP_Enemy_01');
    expect(parsed.layer_name).toBe('Gameplay');
    expect(parsed.success).toBe(true);
  });

  it('sends payload with action assign_actor, layer_name, actor_label', async () => {
    const bridge = makeMockBridge({ responseData: DATA_LAYER_ASSIGNED_DATA });
    await handleManageDataLayers(
      { action: 'assign_actor', layer_name: 'Gameplay', actor_label: 'BP_Enemy_01' },
      bridge
    );
    expect(bridge.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'worldpartition.dataLayers',
        payload: expect.objectContaining({
          action: 'assign_actor',
          layer_name: 'Gameplay',
          actor_label: 'BP_Enemy_01',
        }),
      })
    );
  });
});

// ---------------------------------------------------------------------------
// Group 8: handleInspectStreamingSources — plugin disconnected (WP-03)
// ---------------------------------------------------------------------------

describe('Group 8: handleInspectStreamingSources — plugin disconnected (WP-03)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns isError:true when disconnected', async () => {
    const bridge = makeMockBridge({ throwDisconnect: true });
    const result = await handleInspectStreamingSources({}, bridge);
    expect(result.isError).toBe(true);
  });

  it('returns plugin_not_connected JSON in content[0].text', async () => {
    const bridge = makeMockBridge({ throwDisconnect: true });
    const result = await handleInspectStreamingSources({}, bridge);
    const parsed = JSON.parse((result as ToolResultShape).content[0].text);
    expect(parsed.error).toBe('plugin_not_connected');
    expect(parsed.required_plugin).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Group 9: handleInspectStreamingSources — happy path (WP-03)
// ---------------------------------------------------------------------------

describe('Group 9: handleInspectStreamingSources — happy path (WP-03)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns streaming_sources array with count', async () => {
    const bridge = makeMockBridge({ responseData: STREAMING_SOURCES_DATA });
    const result = await handleInspectStreamingSources({}, bridge);
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result as ToolResultShape).content[0].text);
    expect(Array.isArray(parsed.streaming_sources)).toBe(true);
    expect(parsed.streaming_sources[0].actor_label).toBe('StreamingVolume_0');
    expect(parsed.streaming_sources[0].target_state).toBe('Activated');
    expect(parsed.count).toBe(1);
  });

  it('sends worldpartition.streamingSources command', async () => {
    const bridge = makeMockBridge({ responseData: STREAMING_SOURCES_DATA });
    await handleInspectStreamingSources({}, bridge);
    expect(bridge.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'worldpartition.streamingSources',
      })
    );
  });

  it('passes actor_label filter in payload when provided', async () => {
    const bridge = makeMockBridge({ responseData: STREAMING_SOURCES_DATA });
    await handleInspectStreamingSources({ actor_label: 'StreamingVolume_0' }, bridge);
    expect(bridge.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'worldpartition.streamingSources',
        payload: expect.objectContaining({ actor_label: 'StreamingVolume_0' }),
      })
    );
  });
});

// ---------------------------------------------------------------------------
// Group 10: handleTriggerHlodGeneration — plugin disconnected (WP-04)
// ---------------------------------------------------------------------------

describe('Group 10: handleTriggerHlodGeneration — plugin disconnected (WP-04)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns isError:true when disconnected', async () => {
    const bridge = makeMockBridge({ throwDisconnect: true });
    const result = await handleTriggerHlodGeneration({ action: 'inspect' }, bridge);
    expect(result.isError).toBe(true);
  });

  it('returns plugin_not_connected JSON in content[0].text', async () => {
    const bridge = makeMockBridge({ throwDisconnect: true });
    const result = await handleTriggerHlodGeneration({ action: 'inspect' }, bridge);
    const parsed = JSON.parse((result as ToolResultShape).content[0].text);
    expect(parsed.error).toBe('plugin_not_connected');
    expect(parsed.required_plugin).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Group 11: handleTriggerHlodGeneration — inspect action (WP-04)
// ---------------------------------------------------------------------------

describe('Group 11: handleTriggerHlodGeneration — inspect action (WP-04)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns hlod_layers array with count', async () => {
    const bridge = makeMockBridge({ responseData: HLOD_INSPECT_DATA });
    const result = await handleTriggerHlodGeneration({ action: 'inspect' }, bridge);
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result as ToolResultShape).content[0].text);
    expect(Array.isArray(parsed.hlod_layers)).toBe(true);
    expect(parsed.hlod_layers[0].layer_name).toBe('HLODLayer0');
    expect(parsed.hlod_layers[0].cell_size).toBe(25600);
    expect(parsed.hlod_layers[0].hlod_level).toBe(0);
    expect(parsed.hlod_layers[0].is_spatially_loaded).toBe(true);
    expect(parsed.count).toBe(1);
  });

  it('sends worldpartition.hlod with action inspect', async () => {
    const bridge = makeMockBridge({ responseData: HLOD_INSPECT_DATA });
    await handleTriggerHlodGeneration({ action: 'inspect' }, bridge);
    expect(bridge.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'worldpartition.hlod',
        payload: expect.objectContaining({ action: 'inspect' }),
      })
    );
  });
});

// ---------------------------------------------------------------------------
// Group 12: handleTriggerHlodGeneration — generate action (WP-04)
// ---------------------------------------------------------------------------

describe('Group 12: handleTriggerHlodGeneration — generate action (WP-04)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns status and message', async () => {
    const bridge = makeMockBridge({ responseData: HLOD_GENERATE_DATA });
    const result = await handleTriggerHlodGeneration({ action: 'generate' }, bridge);
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result as ToolResultShape).content[0].text);
    expect(parsed.status).toBe('triggered');
    expect(parsed.message).toBe('HLOD generation started. Check editor logs for progress.');
  });

  it('sends worldpartition.hlod with action generate', async () => {
    const bridge = makeMockBridge({ responseData: HLOD_GENERATE_DATA });
    await handleTriggerHlodGeneration({ action: 'generate' }, bridge);
    expect(bridge.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'worldpartition.hlod',
        payload: expect.objectContaining({ action: 'generate' }),
      })
    );
  });
});

// ---------------------------------------------------------------------------
// Group 13: handleManageDataLayers — command error (WP-02)
// ---------------------------------------------------------------------------

describe('Group 13: handleManageDataLayers — command error (WP-02)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns isError:true with error JSON when response.success is false', async () => {
    const bridge = makeMockBridge({
      responseSuccess: false,
      responseError: 'data_layer_not_found',
    });
    const result = await handleManageDataLayers({ action: 'toggle', layer_name: 'Missing' }, bridge);
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result as ToolResultShape).content[0].text);
    expect(parsed.error).toBe('data_layer_not_found');
  });
});

// ---------------------------------------------------------------------------
// Group 14: registerWorldPartitionTools — registration (all WP)
// ---------------------------------------------------------------------------

describe('Group 14: registerWorldPartitionTools — registration (all WP)', () => {
  it('registers all four WP tool names on the stub server', () => {
    const mockBridge = makeMockBridge({});
    const { server, handlers } = makeStubServer();
    registerWorldPartitionTools(server, mockBridge);

    const expectedTools = [
      'ue_read_world_partition',
      'ue_manage_data_layers',
      'ue_inspect_streaming_sources',
      'ue_trigger_hlod_generation',
    ];
    expect(handlers.size).toBe(4);
    for (const name of expectedTools) {
      expect(handlers.has(name), `Tool "${name}" should be registered`).toBe(true);
    }
  });
});
