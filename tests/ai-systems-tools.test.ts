// tests/ai-systems-tools.test.ts
// Integration tests for all five AI system tool handlers (AI-01 through AI-05).
// Uses injected mock PluginBridgeClient — no TCP server needed; handlers accept an
// injected bridge parameter via their exported function signatures.
//
// Requirements covered: AI-01 (ue_inspect_behavior_tree), AI-02 (ue_inspect_state_tree),
//   AI-03 (ue_inspect_blackboard), AI-04 (ue_inspect_eqs), AI-05 (ue_query_navmesh)
//
// Port assignment comment: port 55567 is reserved for this file if a TCP mock server
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
//   55566 — worldpartition-tools.test.ts (reserved)
//   55567 — reserved for this file (not currently used)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  handleInspectBehaviorTree,
  handleInspectStateTree,
  handleInspectBlackboard,
  handleInspectEqs,
  handleQueryNavmesh,
  registerAISystemsTools,
} from '../src/tools/ai-systems/index.js';
import { PluginBridgeClient, PluginNotConnectedError } from '../src/plugin-bridge/client.js';
import type {
  BehaviorTreeInspectResult,
  StateTreeInspectResult,
  BlackboardInspectResult,
  EQSInspectResult,
  NavMeshQueryResult,
} from '../src/tools/ai-systems/types.js';

// ---------------------------------------------------------------------------
// Suppress unused-import warnings for type-only imports
// ---------------------------------------------------------------------------
type _UnusedImports =
  | BehaviorTreeInspectResult
  | StateTreeInspectResult
  | BlackboardInspectResult
  | EQSInspectResult
  | NavMeshQueryResult;

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
// Realistic mock response data constants (per plan specification)
// ---------------------------------------------------------------------------

const BT_INSPECT_DATA: BehaviorTreeInspectResult = {
  asset_path: '/Game/AI/BT_EnemyLogic',
  root_node: {
    node_name: 'Root',
    node_class: 'BTComposite_Selector',
    node_type: 'Composite',
    decorators: [],
    services: [
      {
        node_name: 'UpdateBB',
        node_class: 'BTService_UpdateBlackboard',
        node_type: 'Service',
        decorators: [],
        services: [],
        children: [],
      },
    ],
    children: [
      {
        node_name: 'AttackSequence',
        node_class: 'BTComposite_Sequence',
        node_type: 'Composite',
        decorators: [
          {
            node_name: 'IsInRange',
            node_class: 'BTDecorator_IsInRange',
            node_type: 'Decorator',
            decorators: [],
            services: [],
            children: [],
          },
        ],
        services: [],
        children: [
          {
            node_name: 'MoveToTarget',
            node_class: 'BTTask_MoveTo',
            node_type: 'Task',
            decorators: [],
            services: [],
            children: [],
          },
        ],
      },
    ],
  },
};

const ST_INSPECT_DATA: StateTreeInspectResult = {
  asset_path: '/Game/AI/ST_NPCBehavior',
  states: [
    {
      name: 'Idle',
      type: 'State',
      parent_state: '',
      tasks: ['IdleTask'],
      transitions: [{ target_state: 'Patrol', condition: 'SeeEnemy == false' }],
    },
    {
      name: 'Patrol',
      type: 'State',
      parent_state: '',
      tasks: ['PatrolTask'],
      transitions: [{ target_state: 'Combat', condition: 'SeeEnemy == true' }],
    },
  ],
};

const BB_INSPECT_DATA: BlackboardInspectResult = {
  asset_path: '/Game/AI/BB_EnemyData',
  keys: [
    { key_name: 'TargetActor', key_type: 'BlackboardKeyType_Object', instance_synced: true },
    { key_name: 'PatrolIndex', key_type: 'BlackboardKeyType_Int', instance_synced: false },
    { key_name: 'LastKnownLocation', key_type: 'BlackboardKeyType_Vector', instance_synced: false },
  ],
  parent_asset: '',
};

const EQS_INSPECT_DATA: EQSInspectResult = {
  asset_path: '/Game/AI/EQS_FindCover',
  options: [
    {
      generator_class: 'EnvQueryGenerator_SimpleGrid',
      generator_name: 'GridGenerator',
      tests: [
        { test_class: 'EnvQueryTest_Trace', test_purpose: 'Visibility', scoring_equation: 'Linear' },
        { test_class: 'EnvQueryTest_Distance', test_purpose: 'DistanceToQuerier', scoring_equation: 'InverseLinear' },
      ],
    },
  ],
};

const NAVMESH_STATUS_DATA: NavMeshQueryResult = {
  build_status: 'built',
  bounds: {
    min: { x: -5000, y: -5000, z: 0 },
    max: { x: 5000, y: 5000, z: 500 },
  },
  nav_data_class: 'RecastNavMesh-Default',
  agent_radius: 35,
  agent_height: 144,
};

const NAVMESH_REACHABILITY_DATA: NavMeshQueryResult = {
  build_status: 'built',
  bounds: {
    min: { x: -5000, y: -5000, z: 0 },
    max: { x: 5000, y: 5000, z: 500 },
  },
  nav_data_class: 'RecastNavMesh-Default',
  agent_radius: 35,
  agent_height: 144,
  reachability: {
    is_reachable: true,
    path_length: 1250.5,
    path_cost: 1250.5,
  },
};

// ---------------------------------------------------------------------------
// ue_inspect_behavior_tree (AI-01) — 4 tests
// ---------------------------------------------------------------------------

describe('ue_inspect_behavior_tree (AI-01)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns BT node hierarchy on success', async () => {
    const bridge = makeMockBridge({ responseData: BT_INSPECT_DATA });
    const result = await handleInspectBehaviorTree(
      { asset_path: '/Game/AI/BT_EnemyLogic' },
      bridge
    );
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result as ToolResultShape).content[0].text);
    expect(parsed.root_node.node_name).toBe('Root');
    expect(Array.isArray(parsed.root_node.children)).toBe(true);
    expect(parsed.root_node.children).toHaveLength(1);
    expect(Array.isArray(parsed.root_node.services)).toBe(true);
    expect(parsed.root_node.services).toHaveLength(1);
  });

  it('returns isError on command failure', async () => {
    const bridge = makeMockBridge({ responseSuccess: false, responseError: 'Asset not found' });
    const result = await handleInspectBehaviorTree(
      { asset_path: '/Game/AI/BT_Missing' },
      bridge
    );
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result as ToolResultShape).content[0].text);
    expect(parsed.error).toBe('Asset not found');
  });

  it('returns plugin_not_connected when bridge disconnected', async () => {
    const bridge = makeMockBridge({ throwDisconnect: true });
    const result = await handleInspectBehaviorTree(
      { asset_path: '/Game/AI/BT_EnemyLogic' },
      bridge
    );
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result as ToolResultShape).content[0].text);
    expect(parsed.error).toBe('plugin_not_connected');
  });

  it('sends correct command type ai.behaviorTree', async () => {
    const bridge = makeMockBridge({ responseData: BT_INSPECT_DATA });
    await handleInspectBehaviorTree({ asset_path: '/Game/AI/BT_EnemyLogic' }, bridge);
    expect(bridge.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'ai.behaviorTree',
        payload: { asset_path: '/Game/AI/BT_EnemyLogic' },
      })
    );
  });
});

// ---------------------------------------------------------------------------
// ue_inspect_state_tree (AI-02) — 4 tests
// ---------------------------------------------------------------------------

describe('ue_inspect_state_tree (AI-02)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns states and transitions on success', async () => {
    const bridge = makeMockBridge({ responseData: ST_INSPECT_DATA });
    const result = await handleInspectStateTree(
      { asset_path: '/Game/AI/ST_NPCBehavior' },
      bridge
    );
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result as ToolResultShape).content[0].text);
    expect(Array.isArray(parsed.states)).toBe(true);
    expect(parsed.states).toHaveLength(2);
    expect(parsed.states[0].name).toBe('Idle');
    expect(parsed.states[0].transitions[0].target_state).toBe('Patrol');
  });

  it('returns isError on command failure', async () => {
    const bridge = makeMockBridge({ responseSuccess: false, responseError: 'Asset not found' });
    const result = await handleInspectStateTree(
      { asset_path: '/Game/AI/ST_Missing' },
      bridge
    );
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result as ToolResultShape).content[0].text);
    expect(parsed.error).toBe('Asset not found');
  });

  it('returns plugin_not_connected when bridge disconnected', async () => {
    const bridge = makeMockBridge({ throwDisconnect: true });
    const result = await handleInspectStateTree(
      { asset_path: '/Game/AI/ST_NPCBehavior' },
      bridge
    );
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result as ToolResultShape).content[0].text);
    expect(parsed.error).toBe('plugin_not_connected');
  });

  it('sends correct command type ai.stateTree', async () => {
    const bridge = makeMockBridge({ responseData: ST_INSPECT_DATA });
    await handleInspectStateTree({ asset_path: '/Game/AI/ST_NPCBehavior' }, bridge);
    expect(bridge.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'ai.stateTree',
        payload: { asset_path: '/Game/AI/ST_NPCBehavior' },
      })
    );
  });
});

// ---------------------------------------------------------------------------
// ue_inspect_blackboard (AI-03) — 4 tests
// ---------------------------------------------------------------------------

describe('ue_inspect_blackboard (AI-03)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns blackboard keys with types on success', async () => {
    const bridge = makeMockBridge({ responseData: BB_INSPECT_DATA });
    const result = await handleInspectBlackboard(
      { asset_path: '/Game/AI/BB_EnemyData' },
      bridge
    );
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result as ToolResultShape).content[0].text);
    expect(Array.isArray(parsed.keys)).toBe(true);
    expect(parsed.keys).toHaveLength(3);
    expect(parsed.keys[0].key_name).toBe('TargetActor');
    expect(parsed.keys[0].key_type).toBe('BlackboardKeyType_Object');
    expect(parsed.keys[0].instance_synced).toBe(true);
  });

  it('returns isError on command failure', async () => {
    const bridge = makeMockBridge({ responseSuccess: false, responseError: 'Asset not found' });
    const result = await handleInspectBlackboard(
      { asset_path: '/Game/AI/BB_Missing' },
      bridge
    );
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result as ToolResultShape).content[0].text);
    expect(parsed.error).toBe('Asset not found');
  });

  it('returns plugin_not_connected when bridge disconnected', async () => {
    const bridge = makeMockBridge({ throwDisconnect: true });
    const result = await handleInspectBlackboard(
      { asset_path: '/Game/AI/BB_EnemyData' },
      bridge
    );
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result as ToolResultShape).content[0].text);
    expect(parsed.error).toBe('plugin_not_connected');
  });

  it('sends correct command type ai.blackboard', async () => {
    const bridge = makeMockBridge({ responseData: BB_INSPECT_DATA });
    await handleInspectBlackboard({ asset_path: '/Game/AI/BB_EnemyData' }, bridge);
    expect(bridge.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'ai.blackboard',
        payload: { asset_path: '/Game/AI/BB_EnemyData' },
      })
    );
  });
});

// ---------------------------------------------------------------------------
// ue_inspect_eqs (AI-04) — 4 tests
// ---------------------------------------------------------------------------

describe('ue_inspect_eqs (AI-04)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns EQS options with generators and tests on success', async () => {
    const bridge = makeMockBridge({ responseData: EQS_INSPECT_DATA });
    const result = await handleInspectEqs(
      { asset_path: '/Game/AI/EQS_FindCover' },
      bridge
    );
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result as ToolResultShape).content[0].text);
    expect(Array.isArray(parsed.options)).toBe(true);
    expect(parsed.options).toHaveLength(1);
    expect(parsed.options[0].generator_class).toBe('EnvQueryGenerator_SimpleGrid');
    expect(Array.isArray(parsed.options[0].tests)).toBe(true);
    expect(parsed.options[0].tests).toHaveLength(2);
  });

  it('returns isError on command failure', async () => {
    const bridge = makeMockBridge({ responseSuccess: false, responseError: 'Asset not found' });
    const result = await handleInspectEqs(
      { asset_path: '/Game/AI/EQS_Missing' },
      bridge
    );
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result as ToolResultShape).content[0].text);
    expect(parsed.error).toBe('Asset not found');
  });

  it('returns plugin_not_connected when bridge disconnected', async () => {
    const bridge = makeMockBridge({ throwDisconnect: true });
    const result = await handleInspectEqs(
      { asset_path: '/Game/AI/EQS_FindCover' },
      bridge
    );
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result as ToolResultShape).content[0].text);
    expect(parsed.error).toBe('plugin_not_connected');
  });

  it('sends correct command type ai.eqs', async () => {
    const bridge = makeMockBridge({ responseData: EQS_INSPECT_DATA });
    await handleInspectEqs({ asset_path: '/Game/AI/EQS_FindCover' }, bridge);
    expect(bridge.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'ai.eqs',
        payload: { asset_path: '/Game/AI/EQS_FindCover' },
      })
    );
  });
});

// ---------------------------------------------------------------------------
// ue_query_navmesh (AI-05) — 7 tests
// ---------------------------------------------------------------------------

describe('ue_query_navmesh (AI-05)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns NavMesh status and bounds on success (no reachability)', async () => {
    const bridge = makeMockBridge({ responseData: NAVMESH_STATUS_DATA });
    const result = await handleQueryNavmesh({}, bridge);
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result as ToolResultShape).content[0].text);
    expect(parsed.build_status).toBe('built');
    expect(parsed.bounds).toBeDefined();
    expect(parsed.bounds.min.x).toBe(-5000);
    expect(parsed.bounds.max.x).toBe(5000);
    expect(parsed.reachability).toBeUndefined();
  });

  it('returns reachability data when start/end points provided', async () => {
    const bridge = makeMockBridge({ responseData: NAVMESH_REACHABILITY_DATA });
    const result = await handleQueryNavmesh(
      {
        start_point: { x: 0, y: 0, z: 0 },
        end_point: { x: 1000, y: 0, z: 0 },
      },
      bridge
    );
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result as ToolResultShape).content[0].text);
    expect(parsed.reachability).toBeDefined();
    expect(parsed.reachability.is_reachable).toBe(true);
    expect(parsed.reachability.path_length).toBe(1250.5);
  });

  it('sends start_point and end_point in payload when provided', async () => {
    const bridge = makeMockBridge({ responseData: NAVMESH_REACHABILITY_DATA });
    const startPoint = { x: 0, y: 0, z: 0 };
    const endPoint = { x: 1000, y: 0, z: 0 };
    await handleQueryNavmesh({ start_point: startPoint, end_point: endPoint }, bridge);
    expect(bridge.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'ai.navmesh',
        payload: {
          start_point: startPoint,
          end_point: endPoint,
        },
      })
    );
  });

  it('omits start_point and end_point from payload when not provided', async () => {
    const bridge = makeMockBridge({ responseData: NAVMESH_STATUS_DATA });
    await handleQueryNavmesh({}, bridge);
    expect(bridge.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'ai.navmesh',
        payload: {},
      })
    );
    const callArg = (bridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArg.payload).not.toHaveProperty('start_point');
    expect(callArg.payload).not.toHaveProperty('end_point');
  });

  it('returns isError on command failure', async () => {
    const bridge = makeMockBridge({ responseSuccess: false, responseError: 'navmesh_not_built' });
    const result = await handleQueryNavmesh({}, bridge);
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result as ToolResultShape).content[0].text);
    expect(parsed.error).toBe('navmesh_not_built');
  });

  it('returns plugin_not_connected when bridge disconnected', async () => {
    const bridge = makeMockBridge({ throwDisconnect: true });
    const result = await handleQueryNavmesh({}, bridge);
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result as ToolResultShape).content[0].text);
    expect(parsed.error).toBe('plugin_not_connected');
  });

  it('sends correct command type ai.navmesh', async () => {
    const bridge = makeMockBridge({ responseData: NAVMESH_STATUS_DATA });
    await handleQueryNavmesh({}, bridge);
    expect(bridge.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'ai.navmesh',
      })
    );
  });
});

// ---------------------------------------------------------------------------
// registerAISystemsTools — 4 tests
// ---------------------------------------------------------------------------

describe('registerAISystemsTools', () => {
  it('registers exactly five tools', () => {
    const mockBridge = makeMockBridge({});
    const { server, handlers } = makeStubServer();
    registerAISystemsTools(server, mockBridge);
    expect(handlers.size).toBe(5);
  });

  it('registers ue_inspect_behavior_tree tool', () => {
    const mockBridge = makeMockBridge({});
    const { server, handlers } = makeStubServer();
    registerAISystemsTools(server, mockBridge);
    expect(handlers.has('ue_inspect_behavior_tree')).toBe(true);
  });

  it('registers ue_inspect_state_tree tool', () => {
    const mockBridge = makeMockBridge({});
    const { server, handlers } = makeStubServer();
    registerAISystemsTools(server, mockBridge);
    expect(handlers.has('ue_inspect_state_tree')).toBe(true);
  });

  it('registers all five expected tool names', () => {
    const mockBridge = makeMockBridge({});
    const { server, handlers } = makeStubServer();
    registerAISystemsTools(server, mockBridge);
    const expectedTools = [
      'ue_inspect_behavior_tree',
      'ue_inspect_state_tree',
      'ue_inspect_blackboard',
      'ue_inspect_eqs',
      'ue_query_navmesh',
    ];
    for (const name of expectedTools) {
      expect(handlers.has(name), `Tool "${name}" should be registered`).toBe(true);
    }
  });
});
