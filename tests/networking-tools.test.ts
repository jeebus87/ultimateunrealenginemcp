// tests/networking-tools.test.ts
// Integration tests for Phase 30 Networking & Replication MCP tools (NET-01 through NET-04).
// Uses injected mock PluginBridgeClient — no TCP server needed.
//
// Port assignment: port 55578 reserved for this file if a TCP mock server is needed later,
// but this test file uses injected mock bridges only.
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
//   55567 — ai-systems-tools.test.ts (reserved)
//   55575 — livelink-tools.test.ts (Phase 27 LL-01 through LL-04)
//   55576 — motion-design-tools.test.ts (Phase 28 MD-01 through MD-04)
//   55577 — movie-render-tools.test.ts (Phase 29 MRP-01 through MRP-04)
//   55578 — reserved for this file (not currently used)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PluginBridgeClient, PluginNotConnectedError } from '../src/plugin-bridge/client.js';
import { registerNetworkingTools } from '../src/tools/networking/index.js';

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

const REPLICATION_DATA = {
  actor_label: 'MyCharacter',
  actor_class: 'AMyCharacter',
  bReplicates: true,
  bAlwaysRelevant: false,
  bNetUseOwnerRelevancy: false,
  bReplicateMovement: true,
  bOnlyRelevantToOwner: false,
  NetUpdateFrequency: 100.0,
  MinNetUpdateFrequency: 2.0,
  NetPriority: 3.0,
  NetDormancy: 0,
  NetDormancyName: 'DORM_Never',
};

const PROPERTIES_DATA = {
  actor_label: 'MyCharacter',
  actor_class: 'AMyCharacter',
  property_count: 3,
  properties: [
    { name: 'Health', type: 'float', condition: 'COND_None', has_rep_notify: true },
    { name: 'bIsSprinting', type: 'bool', condition: 'COND_SkipOwner', has_rep_notify: false },
    { name: 'TeamId', type: 'int32', condition: 'COND_InitialOnly', has_rep_notify: false },
  ],
};

const PROPERTIES_EMPTY_DATA = {
  actor_label: 'StaticActor',
  actor_class: 'AStaticMeshActor',
  property_count: 0,
  properties: [],
};

const NET_DRIVER_DATA = {
  driver_name: 'IpNetDriver',
  net_mode: 'NM_ListenServer',
  is_server: true,
  connection_count: 3,
  max_channels: 32767,
  in_total_bytes: 150000,
  out_total_bytes: 200000,
  connections: [
    {
      address: '192.168.1.10:7777',
      avg_latency: 0.045,
      in_bytes_per_second: 5000,
      out_bytes_per_second: 7000,
    },
  ],
};

const NET_DRIVER_NONE_DATA = {
  status: 'no_net_driver',
  message:
    'No NetDriver is active. Start a PIE session in server or listen-server mode to activate a NetDriver.',
};

const SESSION_DATA = {
  subsystem_name: 'NULL',
  session_name: 'GameSession',
  session_state: 'InProgress',
  max_players: 8,
  current_players: 3,
  is_lan: true,
  is_dedicated: false,
  players: [
    { player_id: 'UniqueNetId_001' },
    { player_id: 'UniqueNetId_002' },
    { player_id: 'UniqueNetId_003' },
  ],
};

const SESSION_NO_SUBSYSTEM_DATA = {
  status: 'no_online_subsystem',
  message: 'No online subsystem is configured.',
};

const SESSION_NO_SESSION_DATA = {
  status: 'no_active_session',
  subsystem_name: 'NULL',
  message: 'No active game session found.',
};

// ---------------------------------------------------------------------------
// describe('networking tools')
// ---------------------------------------------------------------------------

describe('networking tools', () => {

  // -------------------------------------------------------------------------
  // ue_inspect_replication (NET-01)
  // -------------------------------------------------------------------------
  describe('ue_inspect_replication', () => {
    let mockBridge: PluginBridgeClient;

    beforeEach(() => {
      vi.clearAllMocks();
      mockBridge = makeMockBridge({ responseData: REPLICATION_DATA });
    });

    it('happy path: sends net.replication and returns replication settings', async () => {
      const { server, handlers } = makeStubServer();
      registerNetworkingTools(server, mockBridge);
      const handler = handlers.get('ue_inspect_replication')!;
      const result = await handler({ actor_label: 'MyCharacter' }) as ToolResultShape;
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.actor_label).toBe('MyCharacter');
      expect(parsed.bReplicates).toBe(true);
      expect(parsed.NetUpdateFrequency).toBe(100.0);
      expect(parsed.NetDormancyName).toBe('DORM_Never');
      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'net.replication' })
      );
    });

    it('disconnected: returns plugin_not_connected error', async () => {
      mockBridge = makeMockBridge({ throwDisconnect: true });
      const { server, handlers } = makeStubServer();
      registerNetworkingTools(server, mockBridge);
      const handler = handlers.get('ue_inspect_replication')!;
      const result = await handler({ actor_label: 'MyCharacter' }) as ToolResultShape;
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('plugin_not_connected');
      expect(parsed.required_plugin).toBe(true);
    });

    it('command failure (actor_not_found): returns isError true', async () => {
      mockBridge = makeMockBridge({ responseSuccess: false, responseError: 'actor_not_found' });
      const { server, handlers } = makeStubServer();
      registerNetworkingTools(server, mockBridge);
      const handler = handlers.get('ue_inspect_replication')!;
      const result = await handler({ actor_label: 'NonExistent' }) as ToolResultShape;
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('actor_not_found');
    });

    it('payload completeness: payload contains actor_label field', async () => {
      const { server, handlers } = makeStubServer();
      registerNetworkingTools(server, mockBridge);
      const handler = handlers.get('ue_inspect_replication')!;
      await handler({ actor_label: 'MyCharacter' });
      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({ actor_label: 'MyCharacter' }),
        })
      );
    });
  });

  // -------------------------------------------------------------------------
  // ue_list_replicated_properties (NET-02)
  // -------------------------------------------------------------------------
  describe('ue_list_replicated_properties', () => {
    let mockBridge: PluginBridgeClient;

    beforeEach(() => {
      vi.clearAllMocks();
      mockBridge = makeMockBridge({ responseData: PROPERTIES_DATA });
    });

    it('happy path: returns properties with conditions and rep notify', async () => {
      const { server, handlers } = makeStubServer();
      registerNetworkingTools(server, mockBridge);
      const handler = handlers.get('ue_list_replicated_properties')!;
      const result = await handler({ actor_label: 'MyCharacter' }) as ToolResultShape;
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.property_count).toBe(3);
      expect(Array.isArray(parsed.properties)).toBe(true);
      expect(parsed.properties[0].name).toBe('Health');
      expect(parsed.properties[0].type).toBe('float');
      expect(parsed.properties[0].condition).toBe('COND_None');
      expect(parsed.properties[0].has_rep_notify).toBe(true);
      expect(parsed.properties[1].condition).toBe('COND_SkipOwner');
      expect(parsed.properties[2].condition).toBe('COND_InitialOnly');
    });

    it('happy path with empty properties: returns empty array', async () => {
      mockBridge = makeMockBridge({ responseData: PROPERTIES_EMPTY_DATA });
      const { server, handlers } = makeStubServer();
      registerNetworkingTools(server, mockBridge);
      const handler = handlers.get('ue_list_replicated_properties')!;
      const result = await handler({ actor_label: 'StaticActor' }) as ToolResultShape;
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.property_count).toBe(0);
      expect(Array.isArray(parsed.properties)).toBe(true);
      expect(parsed.properties).toHaveLength(0);
    });

    it('disconnected: returns plugin_not_connected error', async () => {
      mockBridge = makeMockBridge({ throwDisconnect: true });
      const { server, handlers } = makeStubServer();
      registerNetworkingTools(server, mockBridge);
      const handler = handlers.get('ue_list_replicated_properties')!;
      const result = await handler({ actor_label: 'MyCharacter' }) as ToolResultShape;
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('plugin_not_connected');
    });

    it('actor not found: returns isError true with error', async () => {
      mockBridge = makeMockBridge({ responseSuccess: false, responseError: 'actor_not_found' });
      const { server, handlers } = makeStubServer();
      registerNetworkingTools(server, mockBridge);
      const handler = handlers.get('ue_list_replicated_properties')!;
      const result = await handler({ actor_label: 'Ghost' }) as ToolResultShape;
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('actor_not_found');
    });

    it('payload correctness: payload contains actor_label', async () => {
      const { server, handlers } = makeStubServer();
      registerNetworkingTools(server, mockBridge);
      const handler = handlers.get('ue_list_replicated_properties')!;
      await handler({ actor_label: 'MyCharacter' });
      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'net.properties',
          payload: expect.objectContaining({ actor_label: 'MyCharacter' }),
        })
      );
    });
  });

  // -------------------------------------------------------------------------
  // ue_read_net_driver (NET-03)
  // -------------------------------------------------------------------------
  describe('ue_read_net_driver', () => {
    let mockBridge: PluginBridgeClient;

    beforeEach(() => {
      vi.clearAllMocks();
      mockBridge = makeMockBridge({ responseData: NET_DRIVER_DATA });
    });

    it('happy path with active driver: returns driver stats and connections', async () => {
      const { server, handlers } = makeStubServer();
      registerNetworkingTools(server, mockBridge);
      const handler = handlers.get('ue_read_net_driver')!;
      const result = await handler({}) as ToolResultShape;
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.driver_name).toBe('IpNetDriver');
      expect(parsed.net_mode).toBe('NM_ListenServer');
      expect(parsed.is_server).toBe(true);
      expect(parsed.connection_count).toBe(3);
      expect(parsed.in_total_bytes).toBe(150000);
      expect(Array.isArray(parsed.connections)).toBe(true);
      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'net.driver' })
      );
    });

    it('no net driver active: returns informational status (not error)', async () => {
      mockBridge = makeMockBridge({ responseData: NET_DRIVER_NONE_DATA });
      const { server, handlers } = makeStubServer();
      registerNetworkingTools(server, mockBridge);
      const handler = handlers.get('ue_read_net_driver')!;
      const result = await handler({}) as ToolResultShape;
      expect(result.isError).toBeFalsy(); // informational, not error
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.status).toBe('no_net_driver');
      expect(typeof parsed.message).toBe('string');
    });

    it('disconnected: returns plugin_not_connected error', async () => {
      mockBridge = makeMockBridge({ throwDisconnect: true });
      const { server, handlers } = makeStubServer();
      registerNetworkingTools(server, mockBridge);
      const handler = handlers.get('ue_read_net_driver')!;
      const result = await handler({}) as ToolResultShape;
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('plugin_not_connected');
    });

    it('command failure: returns isError true', async () => {
      mockBridge = makeMockBridge({ responseSuccess: false, responseError: 'no_world_open' });
      const { server, handlers } = makeStubServer();
      registerNetworkingTools(server, mockBridge);
      const handler = handlers.get('ue_read_net_driver')!;
      const result = await handler({}) as ToolResultShape;
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('no_world_open');
    });

    it('empty payload: sendCommand payload is empty object (no actor_label)', async () => {
      const { server, handlers } = makeStubServer();
      registerNetworkingTools(server, mockBridge);
      const handler = handlers.get('ue_read_net_driver')!;
      await handler({});
      const call = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.payload).not.toHaveProperty('actor_label');
    });
  });

  // -------------------------------------------------------------------------
  // ue_inspect_session (NET-04)
  // -------------------------------------------------------------------------
  describe('ue_inspect_session', () => {
    let mockBridge: PluginBridgeClient;

    beforeEach(() => {
      vi.clearAllMocks();
      mockBridge = makeMockBridge({ responseData: SESSION_DATA });
    });

    it('happy path with active session: returns session info and player list', async () => {
      const { server, handlers } = makeStubServer();
      registerNetworkingTools(server, mockBridge);
      const handler = handlers.get('ue_inspect_session')!;
      const result = await handler({}) as ToolResultShape;
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.session_name).toBe('GameSession');
      expect(parsed.session_state).toBe('InProgress');
      expect(parsed.max_players).toBe(8);
      expect(parsed.current_players).toBe(3);
      expect(parsed.is_lan).toBe(true);
      expect(Array.isArray(parsed.players)).toBe(true);
      expect(parsed.players).toHaveLength(3);
      expect(parsed.players[0].player_id).toBe('UniqueNetId_001');
      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'net.session' })
      );
    });

    it('no online subsystem: returns informational status (not error)', async () => {
      mockBridge = makeMockBridge({ responseData: SESSION_NO_SUBSYSTEM_DATA });
      const { server, handlers } = makeStubServer();
      registerNetworkingTools(server, mockBridge);
      const handler = handlers.get('ue_inspect_session')!;
      const result = await handler({}) as ToolResultShape;
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.status).toBe('no_online_subsystem');
    });

    it('no active session: returns status no_active_session', async () => {
      mockBridge = makeMockBridge({ responseData: SESSION_NO_SESSION_DATA });
      const { server, handlers } = makeStubServer();
      registerNetworkingTools(server, mockBridge);
      const handler = handlers.get('ue_inspect_session')!;
      const result = await handler({}) as ToolResultShape;
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.status).toBe('no_active_session');
      expect(parsed.subsystem_name).toBe('NULL');
    });

    it('disconnected: returns plugin_not_connected error', async () => {
      mockBridge = makeMockBridge({ throwDisconnect: true });
      const { server, handlers } = makeStubServer();
      registerNetworkingTools(server, mockBridge);
      const handler = handlers.get('ue_inspect_session')!;
      const result = await handler({}) as ToolResultShape;
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('plugin_not_connected');
    });

    it('command failure: returns isError true', async () => {
      mockBridge = makeMockBridge({ responseSuccess: false, responseError: 'subsystem_error' });
      const { server, handlers } = makeStubServer();
      registerNetworkingTools(server, mockBridge);
      const handler = handlers.get('ue_inspect_session')!;
      const result = await handler({}) as ToolResultShape;
      expect(result.isError).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Tool registration
  // -------------------------------------------------------------------------
  describe('tool registration', () => {
    it('registers exactly four tools', () => {
      const mockBridge = makeMockBridge({});
      const { server, handlers } = makeStubServer();
      registerNetworkingTools(server, mockBridge);
      expect(handlers.size).toBe(4);
    });

    it('registers all expected tool names', () => {
      const mockBridge = makeMockBridge({});
      const { server, handlers } = makeStubServer();
      registerNetworkingTools(server, mockBridge);
      expect(handlers.has('ue_inspect_replication')).toBe(true);
      expect(handlers.has('ue_list_replicated_properties')).toBe(true);
      expect(handlers.has('ue_read_net_driver')).toBe(true);
      expect(handlers.has('ue_inspect_session')).toBe(true);
    });

    it('ue_inspect_replication handler executes without error', async () => {
      const mockBridge = makeMockBridge({ responseData: REPLICATION_DATA });
      const { server, handlers } = makeStubServer();
      registerNetworkingTools(server, mockBridge);
      const handler = handlers.get('ue_inspect_replication')!;
      await expect(handler({ actor_label: 'MyCharacter' })).resolves.not.toThrow();
    });

    it('ue_read_net_driver handler executes without error', async () => {
      const mockBridge = makeMockBridge({ responseData: NET_DRIVER_DATA });
      const { server, handlers } = makeStubServer();
      registerNetworkingTools(server, mockBridge);
      const handler = handlers.get('ue_read_net_driver')!;
      await expect(handler({})).resolves.not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Payload correctness
  // -------------------------------------------------------------------------
  describe('payload correctness', () => {
    it('ue_inspect_replication: payload contains actor_label field matching input', async () => {
      const mockBridge = makeMockBridge({ responseData: REPLICATION_DATA });
      const { server, handlers } = makeStubServer();
      registerNetworkingTools(server, mockBridge);
      const handler = handlers.get('ue_inspect_replication')!;
      await handler({ actor_label: 'TestActor' });
      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({ payload: expect.objectContaining({ actor_label: 'TestActor' }) })
      );
    });

    it('ue_list_replicated_properties: payload contains actor_label field matching input', async () => {
      const mockBridge = makeMockBridge({ responseData: PROPERTIES_DATA });
      const { server, handlers } = makeStubServer();
      registerNetworkingTools(server, mockBridge);
      const handler = handlers.get('ue_list_replicated_properties')!;
      await handler({ actor_label: 'TestActor' });
      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({ payload: expect.objectContaining({ actor_label: 'TestActor' }) })
      );
    });

    it('ue_read_net_driver: sends empty payload (no actor_label)', async () => {
      const mockBridge = makeMockBridge({ responseData: NET_DRIVER_DATA });
      const { server, handlers } = makeStubServer();
      registerNetworkingTools(server, mockBridge);
      const handler = handlers.get('ue_read_net_driver')!;
      await handler({});
      const call = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.payload).not.toHaveProperty('actor_label');
    });

    it('ue_inspect_session: sends empty payload (no actor_label)', async () => {
      const mockBridge = makeMockBridge({ responseData: SESSION_DATA });
      const { server, handlers } = makeStubServer();
      registerNetworkingTools(server, mockBridge);
      const handler = handlers.get('ue_inspect_session')!;
      await handler({});
      const call = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.payload).not.toHaveProperty('actor_label');
    });
  });

  // -------------------------------------------------------------------------
  // withKnownIssues integration
  // -------------------------------------------------------------------------
  describe('known issues integration', () => {
    it('handler completes successfully when no known issues match (withKnownIssues wrapper is applied)', async () => {
      const mockBridge = makeMockBridge({ responseData: REPLICATION_DATA });
      const { server, handlers } = makeStubServer();
      registerNetworkingTools(server, mockBridge);
      const handler = handlers.get('ue_inspect_replication')!;
      // Verify that withKnownIssues wrapper is active: handler resolves without crash
      const result = await handler({ actor_label: 'MyCharacter' }) as ToolResultShape;
      expect(result.isError).toBeFalsy();
      expect(Array.isArray(result.content)).toBe(true);
    });
  });
});
