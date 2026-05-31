// tests/motion-design-tools.test.ts
// Integration tests for Phase 28 Motion Design MCP tools (MD-01 through MD-04).
// Uses injected mock PluginBridgeClient — no TCP server needed; handlers accept an
// injected bridge parameter via their exported function signatures.
//
// Port assignment comment: port 55576 is reserved for this file if a TCP mock server
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
//   55566 — collision-physics-tools.test.ts (reserved)
//   55573 — gas-tools.test.ts (Phase 25 GAS-01 through GAS-04)
//   55575 — livelink-tools.test.ts (Phase 27 LL-01 through LL-04)
//   55576 — reserved for this file (not currently used)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PluginBridgeClient, PluginNotConnectedError } from '../src/plugin-bridge/client.js';
import {
  registerMotionDesignTools,
  handleListSceneStates,
  handleTriggerSceneTransition,
  handleInspectTransitionLogic,
  handleManageRemoteControl,
} from '../src/tools/motion-design/index.js';

// ---------------------------------------------------------------------------
// known-issues mock — hoisted so withKnownIssues picks it up at import time
// ---------------------------------------------------------------------------

vi.mock('../src/tools/known-issues/store.js', () => ({
  readKnownIssues: vi.fn().mockResolvedValue([]),
}));

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
// Realistic mock response data constants
// ---------------------------------------------------------------------------

const SCENE_STATES_DATA = {
  machines: [
    {
      machine_name: 'MainShowMachine',
      current_state: 'StateA',
      states: [
        { name: 'StateA', category: 'Intro', is_active: true },
        { name: 'StateB', category: 'Main', is_active: false },
        { name: 'StateC', category: 'Outro', is_active: false },
      ],
    },
    {
      machine_name: 'LowerThirdMachine',
      current_state: 'Hidden',
      states: [
        { name: 'Hidden', category: 'Default', is_active: true },
        { name: 'Visible', category: 'Active', is_active: false },
      ],
    },
  ],
};

const TRANSITION_RESULT_DATA = {
  new_state: 'StateB',
  applied_properties: [
    { name: 'Title', value: 'Breaking News' },
    { name: 'SubTitle', value: 'Live Coverage' },
  ],
};

const TRANSITION_LOGIC_DATA = {
  asset_path: '/Game/MotionDesign/TL_MainShow',
  transitions: [
    {
      in_label: 'StateA',
      out_label: 'StateB',
      level_sequence_path: '/Game/MotionDesign/LS_AtoB',
      layer_changes: [
        { layer_name: 'IntroLayer', visibility: 'Hidden' },
        { layer_name: 'MainLayer', visibility: 'Visible' },
      ],
    },
    {
      in_label: 'StateB',
      out_label: 'StateC',
      level_sequence_path: '/Game/MotionDesign/LS_BtoC',
      layer_changes: [
        { layer_name: 'MainLayer', visibility: 'Hidden' },
        { layer_name: 'OutroLayer', visibility: 'Visible' },
      ],
    },
  ],
};

const REMOTE_CONTROL_LIST_DATA = {
  preset_path: '/Game/RC/RC_MainShow',
  action: 'list',
  properties: [
    { name: 'TitleText', type: 'string', value: 'Hello World' },
    { name: 'BackgroundOpacity', type: 'float', value: 0.85 },
  ],
  functions: [
    { name: 'TriggerIntro' },
    { name: 'TriggerOutro' },
  ],
};

const REMOTE_CONTROL_GET_DATA = {
  preset_path: '/Game/RC/RC_MainShow',
  action: 'get',
  property: { name: 'TitleText', type: 'string', value: 'Hello World' },
};

const REMOTE_CONTROL_SET_DATA = {
  preset_path: '/Game/RC/RC_MainShow',
  action: 'set',
  property: { name: 'TitleText', type: 'string', value: 'Updated Title' },
};

const REMOTE_CONTROL_CALL_DATA = {
  preset_path: '/Game/RC/RC_MainShow',
  action: 'call',
  call_result: { function_name: 'TriggerIntro', success: true, result: 42 },
};

// ---------------------------------------------------------------------------
// Group 1: registerMotionDesignTools
// ---------------------------------------------------------------------------

describe('registerMotionDesignTools', () => {
  it('registers exactly 4 tools on the server', () => {
    const mockBridge = makeMockBridge({});
    const { server, handlers } = makeStubServer();
    registerMotionDesignTools(server, mockBridge);
    expect(handlers.size).toBe(4);
  });

  it('registers expected tool names', () => {
    const mockBridge = makeMockBridge({});
    const { server, handlers } = makeStubServer();
    registerMotionDesignTools(server, mockBridge);
    expect(handlers.has('ue_list_scene_states')).toBe(true);
    expect(handlers.has('ue_trigger_scene_transition')).toBe(true);
    expect(handlers.has('ue_inspect_transition_logic')).toBe(true);
    expect(handlers.has('ue_manage_remote_control')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Group 2: handleListSceneStates (MD-01)
// ---------------------------------------------------------------------------

describe('handleListSceneStates (MD-01)', () => {
  let mockBridge: PluginBridgeClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockBridge = makeMockBridge({ responseData: SCENE_STATES_DATA });
  });

  it('returns scene state machines on success', async () => {
    const result = await handleListSceneStates({}, mockBridge) as ToolResultShape;
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(Array.isArray(parsed.machines)).toBe(true);
    expect(parsed.machines).toHaveLength(2);
    expect(parsed.machines[0].machine_name).toBe('MainShowMachine');
    expect(parsed.machines[0].current_state).toBe('StateA');
    expect(Array.isArray(parsed.machines[0].states)).toBe(true);
    expect(parsed.machines[0].states[0].name).toBe('StateA');
    expect(parsed.machines[0].states[0].is_active).toBe(true);
    expect(parsed.machines[1].machine_name).toBe('LowerThirdMachine');
  });

  it('forwards rundown_path in payload when provided', async () => {
    await handleListSceneStates({ rundown_path: '/Game/MD/RD_Main' }, mockBridge);
    expect(mockBridge.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'motiondesign.sceneStates',
        payload: expect.objectContaining({ rundown_path: '/Game/MD/RD_Main' }),
      })
    );
  });

  it('returns isError when plugin disconnected', async () => {
    mockBridge = makeMockBridge({ throwDisconnect: true });
    const result = await handleListSceneStates({}, mockBridge) as ToolResultShape;
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('plugin_not_connected');
    expect(parsed.required_plugin).toBe(true);
  });

  it('returns isError on command-level failure', async () => {
    mockBridge = makeMockBridge({
      responseSuccess: false,
      responseError: 'motion_design_plugin_not_enabled',
    });
    const result = await handleListSceneStates({}, mockBridge) as ToolResultShape;
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('motion_design_plugin_not_enabled');
  });
});

// ---------------------------------------------------------------------------
// Group 3: handleTriggerSceneTransition (MD-02)
// ---------------------------------------------------------------------------

describe('handleTriggerSceneTransition (MD-02)', () => {
  let mockBridge: PluginBridgeClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockBridge = makeMockBridge({ responseData: TRANSITION_RESULT_DATA });
  });

  it('returns new state on successful transition', async () => {
    const result = await handleTriggerSceneTransition(
      { rundown_path: '/Game/MD/RD_Main', target_state: 'StateB' },
      mockBridge
    ) as ToolResultShape;
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.new_state).toBe('StateB');
    expect(Array.isArray(parsed.applied_properties)).toBe(true);
    expect(parsed.applied_properties[0].name).toBe('Title');
    expect(parsed.applied_properties[0].value).toBe('Breaking News');
  });

  it('forwards target_state and rundown_path in payload', async () => {
    await handleTriggerSceneTransition(
      { rundown_path: '/Game/MD/RD_Main', target_state: 'StateB' },
      mockBridge
    );
    expect(mockBridge.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'motiondesign.transition',
        payload: expect.objectContaining({
          rundown_path: '/Game/MD/RD_Main',
          target_state: 'StateB',
        }),
      })
    );
  });

  it('forwards optional properties in payload', async () => {
    await handleTriggerSceneTransition(
      {
        rundown_path: '/Game/MD/RD_Main',
        target_state: 'StateB',
        properties: { brightness: 0.8, title: 'Live' },
      },
      mockBridge
    );
    expect(mockBridge.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          properties: { brightness: 0.8, title: 'Live' },
        }),
      })
    );
  });

  it('returns isError when plugin disconnected', async () => {
    mockBridge = makeMockBridge({ throwDisconnect: true });
    const result = await handleTriggerSceneTransition(
      { rundown_path: '/Game/MD/RD_Main', target_state: 'StateB' },
      mockBridge
    ) as ToolResultShape;
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('plugin_not_connected');
  });

  it('returns isError on command failure (state_not_found)', async () => {
    mockBridge = makeMockBridge({
      responseSuccess: false,
      responseError: 'state_not_found',
    });
    const result = await handleTriggerSceneTransition(
      { rundown_path: '/Game/MD/RD_Main', target_state: 'NonExistentState' },
      mockBridge
    ) as ToolResultShape;
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('state_not_found');
  });
});

// ---------------------------------------------------------------------------
// Group 4: handleInspectTransitionLogic (MD-03)
// ---------------------------------------------------------------------------

describe('handleInspectTransitionLogic (MD-03)', () => {
  let mockBridge: PluginBridgeClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockBridge = makeMockBridge({ responseData: TRANSITION_LOGIC_DATA });
  });

  it('returns transition entries on success', async () => {
    const result = await handleInspectTransitionLogic(
      { asset_path: '/Game/MotionDesign/TL_MainShow' },
      mockBridge
    ) as ToolResultShape;
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.asset_path).toBe('/Game/MotionDesign/TL_MainShow');
    expect(Array.isArray(parsed.transitions)).toBe(true);
    expect(parsed.transitions).toHaveLength(2);
    expect(parsed.transitions[0].in_label).toBe('StateA');
    expect(parsed.transitions[0].out_label).toBe('StateB');
    expect(parsed.transitions[0].level_sequence_path).toBe('/Game/MotionDesign/LS_AtoB');
    expect(Array.isArray(parsed.transitions[0].layer_changes)).toBe(true);
    expect(parsed.transitions[0].layer_changes[0].layer_name).toBe('IntroLayer');
    expect(parsed.transitions[0].layer_changes[0].visibility).toBe('Hidden');
  });

  it('forwards asset_path in payload', async () => {
    await handleInspectTransitionLogic(
      { asset_path: '/Game/MotionDesign/TL_MainShow' },
      mockBridge
    );
    expect(mockBridge.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'motiondesign.transitionLogic',
        payload: expect.objectContaining({ asset_path: '/Game/MotionDesign/TL_MainShow' }),
      })
    );
  });

  it('returns isError when plugin disconnected', async () => {
    mockBridge = makeMockBridge({ throwDisconnect: true });
    const result = await handleInspectTransitionLogic(
      { asset_path: '/Game/MotionDesign/TL_MainShow' },
      mockBridge
    ) as ToolResultShape;
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('plugin_not_connected');
  });

  it('returns isError on command failure', async () => {
    mockBridge = makeMockBridge({
      responseSuccess: false,
      responseError: 'transition_logic_asset_not_found',
    });
    const result = await handleInspectTransitionLogic(
      { asset_path: '/Game/MotionDesign/TL_Missing' },
      mockBridge
    ) as ToolResultShape;
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('transition_logic_asset_not_found');
  });
});

// ---------------------------------------------------------------------------
// Group 5: handleManageRemoteControl (MD-04)
// ---------------------------------------------------------------------------

describe('handleManageRemoteControl (MD-04)', () => {
  let mockBridge: PluginBridgeClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockBridge = makeMockBridge({ responseData: REMOTE_CONTROL_LIST_DATA });
  });

  it('list action returns properties and functions', async () => {
    const result = await handleManageRemoteControl(
      { preset_path: '/Game/RC/RC_MainShow', action: 'list' },
      mockBridge
    ) as ToolResultShape;
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.action).toBe('list');
    expect(Array.isArray(parsed.properties)).toBe(true);
    expect(parsed.properties).toHaveLength(2);
    expect(parsed.properties[0].name).toBe('TitleText');
    expect(parsed.properties[0].type).toBe('string');
    expect(Array.isArray(parsed.functions)).toBe(true);
    expect(parsed.functions[0].name).toBe('TriggerIntro');
  });

  it('get action returns single property', async () => {
    mockBridge = makeMockBridge({ responseData: REMOTE_CONTROL_GET_DATA });
    const result = await handleManageRemoteControl(
      { preset_path: '/Game/RC/RC_MainShow', action: 'get', property_name: 'TitleText' },
      mockBridge
    ) as ToolResultShape;
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.action).toBe('get');
    expect(parsed.property.name).toBe('TitleText');
    expect(parsed.property.type).toBe('string');
    expect(parsed.property.value).toBe('Hello World');
  });

  it('set action returns updated property', async () => {
    mockBridge = makeMockBridge({ responseData: REMOTE_CONTROL_SET_DATA });
    const result = await handleManageRemoteControl(
      {
        preset_path: '/Game/RC/RC_MainShow',
        action: 'set',
        property_name: 'TitleText',
        value: 'Updated Title',
      },
      mockBridge
    ) as ToolResultShape;
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.action).toBe('set');
    expect(parsed.property.name).toBe('TitleText');
    expect(parsed.property.value).toBe('Updated Title');
  });

  it('call action returns function result', async () => {
    mockBridge = makeMockBridge({ responseData: REMOTE_CONTROL_CALL_DATA });
    const result = await handleManageRemoteControl(
      { preset_path: '/Game/RC/RC_MainShow', action: 'call', function_name: 'TriggerIntro' },
      mockBridge
    ) as ToolResultShape;
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.action).toBe('call');
    expect(parsed.call_result.function_name).toBe('TriggerIntro');
    expect(parsed.call_result.success).toBe(true);
    expect(parsed.call_result.result).toBe(42);
  });

  it('forwards preset_path and action in payload', async () => {
    await handleManageRemoteControl(
      { preset_path: '/Game/RC/RC_MainShow', action: 'list' },
      mockBridge
    );
    expect(mockBridge.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'motiondesign.remoteControl',
        payload: expect.objectContaining({
          preset_path: '/Game/RC/RC_MainShow',
          action: 'list',
        }),
      })
    );
  });

  it('forwards property_name for get action', async () => {
    await handleManageRemoteControl(
      { preset_path: '/Game/RC/RC_MainShow', action: 'get', property_name: 'TitleText' },
      mockBridge
    );
    expect(mockBridge.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ property_name: 'TitleText' }),
      })
    );
  });

  it('forwards value for set action', async () => {
    await handleManageRemoteControl(
      {
        preset_path: '/Game/RC/RC_MainShow',
        action: 'set',
        property_name: 'BackgroundOpacity',
        value: 0.5,
      },
      mockBridge
    );
    expect(mockBridge.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ value: 0.5 }),
      })
    );
  });

  it('returns isError when plugin disconnected', async () => {
    mockBridge = makeMockBridge({ throwDisconnect: true });
    const result = await handleManageRemoteControl(
      { preset_path: '/Game/RC/RC_MainShow', action: 'list' },
      mockBridge
    ) as ToolResultShape;
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('plugin_not_connected');
    expect(parsed.required_plugin).toBe(true);
  });

  it('returns isError on command failure (preset_not_found)', async () => {
    mockBridge = makeMockBridge({
      responseSuccess: false,
      responseError: 'preset_not_found',
    });
    const result = await handleManageRemoteControl(
      { preset_path: '/Game/RC/RC_Missing', action: 'list' },
      mockBridge
    ) as ToolResultShape;
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('preset_not_found');
  });
});

// ---------------------------------------------------------------------------
// Group 6: shared error handling
// ---------------------------------------------------------------------------

describe('shared error handling', () => {
  it('all handlers return structured plugin_not_connected JSON', async () => {
    const disconnectBridge = makeMockBridge({ throwDisconnect: true });

    const results = await Promise.all([
      handleListSceneStates({}, disconnectBridge),
      handleTriggerSceneTransition(
        { rundown_path: '/Game/MD/RD_Main', target_state: 'StateA' },
        disconnectBridge
      ),
      handleInspectTransitionLogic({ asset_path: '/Game/MotionDesign/TL_Main' }, disconnectBridge),
      handleManageRemoteControl(
        { preset_path: '/Game/RC/RC_Main', action: 'list' },
        disconnectBridge
      ),
    ]);

    for (const result of results) {
      const r = result as ToolResultShape;
      expect(r.isError).toBe(true);
      const parsed = JSON.parse(r.content[0].text);
      expect(parsed.error).toBe('plugin_not_connected');
    }
  });

  it('all handlers return isError:true on command failure', async () => {
    const failBridge = makeMockBridge({ responseSuccess: false, responseError: 'command_failed' });

    const results = await Promise.all([
      handleListSceneStates({}, failBridge),
      handleTriggerSceneTransition(
        { rundown_path: '/Game/MD/RD_Main', target_state: 'StateA' },
        failBridge
      ),
      handleInspectTransitionLogic({ asset_path: '/Game/MotionDesign/TL_Main' }, failBridge),
      handleManageRemoteControl({ preset_path: '/Game/RC/RC_Main', action: 'list' }, failBridge),
    ]);

    for (const result of results) {
      expect((result as ToolResultShape).isError).toBe(true);
    }
  });

  it('all handlers return isError:undefined on success', async () => {
    const successBridge = makeMockBridge({ responseData: { ok: true } });

    const results = await Promise.all([
      handleListSceneStates({}, successBridge),
      handleTriggerSceneTransition(
        { rundown_path: '/Game/MD/RD_Main', target_state: 'StateA' },
        successBridge
      ),
      handleInspectTransitionLogic({ asset_path: '/Game/MotionDesign/TL_Main' }, successBridge),
      handleManageRemoteControl({ preset_path: '/Game/RC/RC_Main', action: 'list' }, successBridge),
    ]);

    for (const result of results) {
      expect((result as ToolResultShape).isError).toBeFalsy();
    }
  });
});
