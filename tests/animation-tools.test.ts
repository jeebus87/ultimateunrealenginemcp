// tests/animation-tools.test.ts
// Integration tests for all five animation tool handlers (ANIM-01 through ANIM-05).
// Uses injected mock PluginBridgeClient — no TCP server needed; handlers accept an
// injected bridge parameter via their exported function signatures.
//
// Port assignment comment: port 55565 is reserved for this file if a TCP mock server
// is needed later, but this test file uses injected mock bridges only.
//
// Port assignments (project-wide reference):
//   55557 — real UE Editor plugin (not running in tests)
//   55560 — plugin-bridge.test.ts mock server
//   55561 — blueprint-tools.test.ts mock server
//   55562 — bridge-cpp-tools.test.ts mock server
//   55563 — blueprint-write-tools.test.ts mock server
//   55564 — validation-tools.test.ts mock server
//   55565 — reserved for this file (not currently used)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  handleListAnimationAssets,
  handleInspectAnimBlueprint,
  handleInspectMontage,
  handleInspectBlendSpace,
  handleReadRetargetMappings,
  registerAnimationTools,
} from '../src/tools/animation/index.js';
import { PluginBridgeClient, PluginNotConnectedError } from '../src/plugin-bridge/client.js';
import type {
  AnimationListResult,
  AnimBlueprintInspectResult,
  MontageInspectResult,
  BlendSpaceInspectResult,
  RetargetMappingsResult,
} from '../src/tools/animation/types.js';

// ---------------------------------------------------------------------------
// Suppress unused-import warnings for type-only imports
// ---------------------------------------------------------------------------
type _UnusedImports =
  | AnimationListResult
  | AnimBlueprintInspectResult
  | MontageInspectResult
  | BlendSpaceInspectResult
  | RetargetMappingsResult;

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

const ANIM_LIST_DATA = {
  assets: [
    {
      asset_path: '/Game/Animations/ABP_Character',
      asset_name: 'ABP_Character',
      asset_type: 'AnimBlueprint',
    },
  ],
  count: 1,
};

const ANIM_BP_DATA = {
  asset_path: '/Game/Animations/ABP_Character',
  skeleton: '/Game/Characters/SK_Mannequin',
  state_machines: [
    {
      name: 'Locomotion',
      states: [{ name: 'Idle', animation_asset: '/Game/Animations/Idle_Anim' }],
      transitions: [{ source_state: 'Idle', target_state: 'Walk', duration: 0.2 }],
    },
  ],
};

const MONTAGE_DATA = {
  asset_path: '/Game/Animations/AM_Attack',
  sections: [{ name: 'WindUp', linked_sequence: 'Attack_Start' }],
  notifies: [{ name: 'HitNotify', trigger_time: 0.35 }],
  slots: ['DefaultSlot'],
};

const BLEND_SPACE_DATA = {
  asset_path: '/Game/Animations/BS_Locomotion',
  is_1d: false,
  axes: [{ name: 'Speed', min: 0, max: 600, grid_divisions: 4 }],
  samples: [{ animation: '/Game/Animations/Walk', x: 200, y: 0, z: 0 }],
};

const RETARGET_DATA = {
  asset_path: '/Game/Retarget/RTG_Mannequin',
  source_rig: '/Game/Rigs/IK_Mannequin',
  target_rig: '/Game/Rigs/IK_MetaHuman',
  chain_mappings: [{ source_chain: 'Spine', target_chain: 'Spine' }],
};

// ---------------------------------------------------------------------------
// Group 1: handleListAnimationAssets — plugin disconnected (ANIM-01)
// ---------------------------------------------------------------------------

describe('Group 1: handleListAnimationAssets — plugin disconnected (ANIM-01)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns isError:true when bridge throws PluginNotConnectedError', async () => {
    const bridge = makeMockBridge({ throwDisconnect: true });
    const result = await handleListAnimationAssets({}, bridge);
    expect(result.isError).toBe(true);
  });

  it('returns plugin_not_connected JSON with required_plugin:true in content[0].text', async () => {
    const bridge = makeMockBridge({ throwDisconnect: true });
    const result = await handleListAnimationAssets({}, bridge);
    const parsed = JSON.parse((result as ToolResultShape).content[0].text);
    expect(parsed.error).toBe('plugin_not_connected');
    expect(parsed.required_plugin).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Group 2: handleListAnimationAssets — happy path (ANIM-01)
// ---------------------------------------------------------------------------

describe('Group 2: handleListAnimationAssets — happy path (ANIM-01)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends animation.list command with empty payload when no type_filter', async () => {
    const bridge = makeMockBridge({ responseData: ANIM_LIST_DATA });
    await handleListAnimationAssets({}, bridge);
    expect(bridge.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'animation.list',
        payload: {},
      })
    );
  });

  it('sends animation.list command with type_filter in payload when provided', async () => {
    const bridge = makeMockBridge({ responseData: ANIM_LIST_DATA });
    await handleListAnimationAssets({ type_filter: 'AnimBlueprint' }, bridge);
    expect(bridge.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'animation.list',
        payload: { type_filter: 'AnimBlueprint' },
      })
    );
  });

  it('returns assets array from response data', async () => {
    const bridge = makeMockBridge({ responseData: ANIM_LIST_DATA });
    const result = await handleListAnimationAssets({}, bridge);
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result as ToolResultShape).content[0].text);
    expect(Array.isArray(parsed.assets)).toBe(true);
    expect(parsed.assets[0].asset_path).toBe('/Game/Animations/ABP_Character');
    expect(parsed.assets[0].asset_type).toBe('AnimBlueprint');
    expect(parsed.count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Group 3: handleInspectAnimBlueprint — plugin disconnected (ANIM-02)
// ---------------------------------------------------------------------------

describe('Group 3: handleInspectAnimBlueprint — plugin disconnected (ANIM-02)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns isError:true when bridge throws PluginNotConnectedError', async () => {
    const bridge = makeMockBridge({ throwDisconnect: true });
    const result = await handleInspectAnimBlueprint(
      { asset_path: '/Game/Animations/ABP_Character' },
      bridge
    );
    expect(result.isError).toBe(true);
  });

  it('returns plugin_not_connected JSON with required_plugin:true in content[0].text', async () => {
    const bridge = makeMockBridge({ throwDisconnect: true });
    const result = await handleInspectAnimBlueprint(
      { asset_path: '/Game/Animations/ABP_Character' },
      bridge
    );
    const parsed = JSON.parse((result as ToolResultShape).content[0].text);
    expect(parsed.error).toBe('plugin_not_connected');
    expect(parsed.required_plugin).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Group 4: handleInspectAnimBlueprint — happy path (ANIM-02)
// ---------------------------------------------------------------------------

describe('Group 4: handleInspectAnimBlueprint — happy path (ANIM-02)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends animation.inspectAnimBP command with asset_path payload', async () => {
    const bridge = makeMockBridge({ responseData: ANIM_BP_DATA });
    await handleInspectAnimBlueprint(
      { asset_path: '/Game/Animations/ABP_Character' },
      bridge
    );
    expect(bridge.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'animation.inspectAnimBP',
        payload: { asset_path: '/Game/Animations/ABP_Character' },
      })
    );
  });

  it('returns state_machines array with states and transitions from response data', async () => {
    const bridge = makeMockBridge({ responseData: ANIM_BP_DATA });
    const result = await handleInspectAnimBlueprint(
      { asset_path: '/Game/Animations/ABP_Character' },
      bridge
    );
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result as ToolResultShape).content[0].text);
    expect(parsed.skeleton).toBe('/Game/Characters/SK_Mannequin');
    expect(Array.isArray(parsed.state_machines)).toBe(true);
    expect(parsed.state_machines[0].name).toBe('Locomotion');
    expect(parsed.state_machines[0].states[0].name).toBe('Idle');
    expect(parsed.state_machines[0].transitions[0].source_state).toBe('Idle');
    expect(parsed.state_machines[0].transitions[0].duration).toBe(0.2);
  });
});

// ---------------------------------------------------------------------------
// Group 5: handleInspectMontage — plugin disconnected (ANIM-03)
// ---------------------------------------------------------------------------

describe('Group 5: handleInspectMontage — plugin disconnected (ANIM-03)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns isError:true when bridge throws PluginNotConnectedError', async () => {
    const bridge = makeMockBridge({ throwDisconnect: true });
    const result = await handleInspectMontage(
      { asset_path: '/Game/Animations/AM_Attack' },
      bridge
    );
    expect(result.isError).toBe(true);
  });

  it('returns plugin_not_connected JSON with required_plugin:true in content[0].text', async () => {
    const bridge = makeMockBridge({ throwDisconnect: true });
    const result = await handleInspectMontage(
      { asset_path: '/Game/Animations/AM_Attack' },
      bridge
    );
    const parsed = JSON.parse((result as ToolResultShape).content[0].text);
    expect(parsed.error).toBe('plugin_not_connected');
    expect(parsed.required_plugin).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Group 6: handleInspectMontage — happy path (ANIM-03)
// ---------------------------------------------------------------------------

describe('Group 6: handleInspectMontage — happy path (ANIM-03)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends animation.inspectMontage command with asset_path payload', async () => {
    const bridge = makeMockBridge({ responseData: MONTAGE_DATA });
    await handleInspectMontage(
      { asset_path: '/Game/Animations/AM_Attack' },
      bridge
    );
    expect(bridge.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'animation.inspectMontage',
        payload: { asset_path: '/Game/Animations/AM_Attack' },
      })
    );
  });

  it('returns sections, notifies, and slots from response data', async () => {
    const bridge = makeMockBridge({ responseData: MONTAGE_DATA });
    const result = await handleInspectMontage(
      { asset_path: '/Game/Animations/AM_Attack' },
      bridge
    );
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result as ToolResultShape).content[0].text);
    expect(Array.isArray(parsed.sections)).toBe(true);
    expect(parsed.sections[0].name).toBe('WindUp');
    expect(parsed.sections[0].linked_sequence).toBe('Attack_Start');
    expect(Array.isArray(parsed.notifies)).toBe(true);
    expect(parsed.notifies[0].name).toBe('HitNotify');
    expect(parsed.notifies[0].trigger_time).toBe(0.35);
    expect(Array.isArray(parsed.slots)).toBe(true);
    expect(parsed.slots[0]).toBe('DefaultSlot');
  });
});

// ---------------------------------------------------------------------------
// Group 7: handleInspectBlendSpace — plugin disconnected (ANIM-04)
// ---------------------------------------------------------------------------

describe('Group 7: handleInspectBlendSpace — plugin disconnected (ANIM-04)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns isError:true when bridge throws PluginNotConnectedError', async () => {
    const bridge = makeMockBridge({ throwDisconnect: true });
    const result = await handleInspectBlendSpace(
      { asset_path: '/Game/Animations/BS_Locomotion' },
      bridge
    );
    expect(result.isError).toBe(true);
  });

  it('returns plugin_not_connected JSON with required_plugin:true in content[0].text', async () => {
    const bridge = makeMockBridge({ throwDisconnect: true });
    const result = await handleInspectBlendSpace(
      { asset_path: '/Game/Animations/BS_Locomotion' },
      bridge
    );
    const parsed = JSON.parse((result as ToolResultShape).content[0].text);
    expect(parsed.error).toBe('plugin_not_connected');
    expect(parsed.required_plugin).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Group 8: handleInspectBlendSpace — happy path (ANIM-04)
// ---------------------------------------------------------------------------

describe('Group 8: handleInspectBlendSpace — happy path (ANIM-04)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends animation.inspectBlendSpace command with asset_path payload', async () => {
    const bridge = makeMockBridge({ responseData: BLEND_SPACE_DATA });
    await handleInspectBlendSpace(
      { asset_path: '/Game/Animations/BS_Locomotion' },
      bridge
    );
    expect(bridge.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'animation.inspectBlendSpace',
        payload: { asset_path: '/Game/Animations/BS_Locomotion' },
      })
    );
  });

  it('returns axes and samples from response data', async () => {
    const bridge = makeMockBridge({ responseData: BLEND_SPACE_DATA });
    const result = await handleInspectBlendSpace(
      { asset_path: '/Game/Animations/BS_Locomotion' },
      bridge
    );
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result as ToolResultShape).content[0].text);
    expect(parsed.is_1d).toBe(false);
    expect(Array.isArray(parsed.axes)).toBe(true);
    expect(parsed.axes[0].name).toBe('Speed');
    expect(parsed.axes[0].min).toBe(0);
    expect(parsed.axes[0].max).toBe(600);
    expect(parsed.axes[0].grid_divisions).toBe(4);
    expect(Array.isArray(parsed.samples)).toBe(true);
    expect(parsed.samples[0].animation).toBe('/Game/Animations/Walk');
    expect(parsed.samples[0].x).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Group 9: handleReadRetargetMappings — plugin disconnected (ANIM-05)
// ---------------------------------------------------------------------------

describe('Group 9: handleReadRetargetMappings — plugin disconnected (ANIM-05)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns isError:true when bridge throws PluginNotConnectedError', async () => {
    const bridge = makeMockBridge({ throwDisconnect: true });
    const result = await handleReadRetargetMappings(
      { asset_path: '/Game/Retarget/RTG_Mannequin' },
      bridge
    );
    expect(result.isError).toBe(true);
  });

  it('returns plugin_not_connected JSON with required_plugin:true in content[0].text', async () => {
    const bridge = makeMockBridge({ throwDisconnect: true });
    const result = await handleReadRetargetMappings(
      { asset_path: '/Game/Retarget/RTG_Mannequin' },
      bridge
    );
    const parsed = JSON.parse((result as ToolResultShape).content[0].text);
    expect(parsed.error).toBe('plugin_not_connected');
    expect(parsed.required_plugin).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Group 10: handleReadRetargetMappings — happy path (ANIM-05)
// ---------------------------------------------------------------------------

describe('Group 10: handleReadRetargetMappings — happy path (ANIM-05)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends animation.retargetMappings command with asset_path payload', async () => {
    const bridge = makeMockBridge({ responseData: RETARGET_DATA });
    await handleReadRetargetMappings(
      { asset_path: '/Game/Retarget/RTG_Mannequin' },
      bridge
    );
    expect(bridge.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'animation.retargetMappings',
        payload: { asset_path: '/Game/Retarget/RTG_Mannequin' },
      })
    );
  });

  it('returns source_rig, target_rig, and chain_mappings from response data', async () => {
    const bridge = makeMockBridge({ responseData: RETARGET_DATA });
    const result = await handleReadRetargetMappings(
      { asset_path: '/Game/Retarget/RTG_Mannequin' },
      bridge
    );
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result as ToolResultShape).content[0].text);
    expect(parsed.source_rig).toBe('/Game/Rigs/IK_Mannequin');
    expect(parsed.target_rig).toBe('/Game/Rigs/IK_MetaHuman');
    expect(Array.isArray(parsed.chain_mappings)).toBe(true);
    expect(parsed.chain_mappings[0].source_chain).toBe('Spine');
    expect(parsed.chain_mappings[0].target_chain).toBe('Spine');
  });
});

// ---------------------------------------------------------------------------
// Group 11: Command error handling (all tools)
// ---------------------------------------------------------------------------

describe('Group 11: command error handling (all tools)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('handleListAnimationAssets returns isError:true when response.success is false', async () => {
    const bridge = makeMockBridge({ responseSuccess: false, responseError: 'asset_registry_unavailable' });
    const result = await handleListAnimationAssets({}, bridge);
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result as ToolResultShape).content[0].text);
    expect(parsed.error).toBe('asset_registry_unavailable');
  });

  it('handleInspectAnimBlueprint returns isError:true when response.error is set', async () => {
    const bridge = makeMockBridge({ responseSuccess: false, responseError: 'asset_not_found' });
    const result = await handleInspectAnimBlueprint(
      { asset_path: '/Game/Animations/Missing_ABP' },
      bridge
    );
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result as ToolResultShape).content[0].text);
    expect(parsed.error).toBe('asset_not_found');
  });
});

// ---------------------------------------------------------------------------
// Group 12: registerAnimationTools registration (all)
// ---------------------------------------------------------------------------

describe('Group 12: registerAnimationTools registration', () => {
  it('registers exactly 5 tools on the stub server', () => {
    const mockBridge = makeMockBridge({});
    const { server, handlers } = makeStubServer();
    registerAnimationTools(server, mockBridge);
    expect(handlers.size).toBe(5);
  });

  it('tool names are: ue_list_animation_assets, ue_inspect_anim_blueprint, ue_inspect_montage, ue_inspect_blend_space, ue_read_retarget_mappings', () => {
    const mockBridge = makeMockBridge({});
    const { server, handlers } = makeStubServer();
    registerAnimationTools(server, mockBridge);

    const expectedTools = [
      'ue_list_animation_assets',
      'ue_inspect_anim_blueprint',
      'ue_inspect_montage',
      'ue_inspect_blend_space',
      'ue_read_retarget_mappings',
    ];
    for (const name of expectedTools) {
      expect(handlers.has(name), `Tool "${name}" should be registered`).toBe(true);
    }
  });
});
