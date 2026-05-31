// tests/pcg-tools.test.ts
// Integration tests for Phase 24 PCG Framework MCP tool handlers.
// Uses injected mock PluginBridgeClient — no real TCP server needed.
// All four PCG tools are tested: happy paths, disconnection, command failures,
// optional parameter handling, payload correctness, and registration.

import { describe, it, expect, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PluginBridgeClient, PluginNotConnectedError } from '../src/plugin-bridge/client.js';
import { registerPCGTools } from '../src/tools/pcg/index.js';

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
// Mock response data
// ---------------------------------------------------------------------------

const PCG_LIST_DATA = {
  graphs: [
    {
      asset_path: '/Game/PCG/MyGraph',
      node_count: 5,
      has_component: true,
      actor_label: 'PCGActor',
    },
  ],
  count: 1,
};

const PCG_INSPECT_DATA = {
  asset_path: '/Game/PCG/MyGraph',
  node_count: 3,
  nodes: [
    {
      label: 'Surface Sampler',
      type: 'PCGSurfaceSamplerSettings',
      enabled: true,
      input_pins: [],
      output_pins: ['Out'],
    },
  ],
  connections: [
    {
      from_node: 'Surface Sampler',
      from_pin: 'Out',
      to_node: 'Static Mesh Spawner',
      to_pin: 'In',
    },
  ],
  parameters: [
    {
      name: 'PointsPerSquareMeter',
      type: 'float',
      default_value: '10.0',
    },
  ],
};

const PCG_EXECUTE_DATA = {
  actor_label: 'PCGActor',
  executed: true,
  generation_triggered: true,
};

const PCG_RESULTS_DATA = {
  actor_label: 'PCGActor',
  point_count: 1500,
  data_entry_count: 3,
  warnings: [],
};

const PCG_RESULTS_WARNINGS_DATA = {
  actor_label: 'PCGActor',
  point_count: 0,
  data_entry_count: 0,
  warnings: ['No valid surfaces found'],
};

// ---------------------------------------------------------------------------
// pcg tools
// ---------------------------------------------------------------------------

describe('pcg tools', () => {

  // -------------------------------------------------------------------------
  // ue_list_pcg_graphs
  // -------------------------------------------------------------------------
  describe('ue_list_pcg_graphs', () => {
    it('happy path: sends pcg.list with empty payload, returns array of graphs', async () => {
      const mockBridge = makeMockBridge({ responseData: PCG_LIST_DATA });
      const { server, handlers } = makeStubServer();
      registerPCGTools(server, mockBridge);

      const handler = handlers.get('ue_list_pcg_graphs')!;
      const result = await handler({}) as ToolResultShape;

      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'pcg.list',
          payload: {},
        })
      );
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(Array.isArray(parsed.graphs)).toBe(true);
      expect(parsed.graphs[0].asset_path).toBe('/Game/PCG/MyGraph');
      expect(parsed.graphs[0].node_count).toBe(5);
      expect(parsed.graphs[0].has_component).toBe(true);
      expect(parsed.graphs[0].actor_label).toBe('PCGActor');
      expect(parsed.count).toBe(1);
    });

    it('disconnected: returns isError:true with plugin_not_connected', async () => {
      const mockBridge = makeMockBridge({ throwDisconnect: true });
      const { server, handlers } = makeStubServer();
      registerPCGTools(server, mockBridge);

      const handler = handlers.get('ue_list_pcg_graphs')!;
      const result = await handler({}) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('plugin_not_connected');
      expect(parsed.required_plugin).toBe(true);
    });

    it('command failure (registry_error): returns isError:true with error string', async () => {
      const mockBridge = makeMockBridge({ responseSuccess: false, responseError: 'registry_error' });
      const { server, handlers } = makeStubServer();
      registerPCGTools(server, mockBridge);

      const handler = handlers.get('ue_list_pcg_graphs')!;
      const result = await handler({}) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('registry_error');
    });
  });

  // -------------------------------------------------------------------------
  // ue_inspect_pcg_graph
  // -------------------------------------------------------------------------
  describe('ue_inspect_pcg_graph', () => {
    it('happy path: sends pcg.inspect with asset_path, returns nodes/connections/parameters', async () => {
      const mockBridge = makeMockBridge({ responseData: PCG_INSPECT_DATA });
      const { server, handlers } = makeStubServer();
      registerPCGTools(server, mockBridge);

      const handler = handlers.get('ue_inspect_pcg_graph')!;
      const result = await handler({ asset_path: '/Game/PCG/MyGraph' }) as ToolResultShape;

      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'pcg.inspect',
          payload: { asset_path: '/Game/PCG/MyGraph' },
        })
      );
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(Array.isArray(parsed.nodes)).toBe(true);
      expect(parsed.nodes[0].label).toBe('Surface Sampler');
      expect(Array.isArray(parsed.connections)).toBe(true);
      expect(parsed.connections[0].from_node).toBe('Surface Sampler');
      expect(parsed.connections[0].to_node).toBe('Static Mesh Spawner');
      expect(Array.isArray(parsed.parameters)).toBe(true);
      expect(parsed.parameters[0].name).toBe('PointsPerSquareMeter');
    });

    it('disconnected: returns isError:true with plugin_not_connected', async () => {
      const mockBridge = makeMockBridge({ throwDisconnect: true });
      const { server, handlers } = makeStubServer();
      registerPCGTools(server, mockBridge);

      const handler = handlers.get('ue_inspect_pcg_graph')!;
      const result = await handler({ asset_path: '/Game/PCG/MyGraph' }) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('plugin_not_connected');
      expect(parsed.required_plugin).toBe(true);
    });

    it('graph not found: returns isError:true with graph_not_found', async () => {
      const mockBridge = makeMockBridge({ responseSuccess: false, responseError: 'graph_not_found' });
      const { server, handlers } = makeStubServer();
      registerPCGTools(server, mockBridge);

      const handler = handlers.get('ue_inspect_pcg_graph')!;
      const result = await handler({ asset_path: '/Game/PCG/Missing' }) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('graph_not_found');
    });

    it('invalid asset path: returns isError:true with invalid_asset_path', async () => {
      const mockBridge = makeMockBridge({ responseSuccess: false, responseError: 'invalid_asset_path' });
      const { server, handlers } = makeStubServer();
      registerPCGTools(server, mockBridge);

      const handler = handlers.get('ue_inspect_pcg_graph')!;
      const result = await handler({ asset_path: 'bad-path' }) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('invalid_asset_path');
    });
  });

  // -------------------------------------------------------------------------
  // ue_execute_pcg_graph
  // -------------------------------------------------------------------------
  describe('ue_execute_pcg_graph', () => {
    it('happy path without parameter_overrides: sends pcg.execute with actor_label only', async () => {
      const mockBridge = makeMockBridge({ responseData: PCG_EXECUTE_DATA });
      const { server, handlers } = makeStubServer();
      registerPCGTools(server, mockBridge);

      const handler = handlers.get('ue_execute_pcg_graph')!;
      const result = await handler({ actor_label: 'PCGActor' }) as ToolResultShape;

      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'pcg.execute',
        })
      );
      const call = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.payload.actor_label).toBe('PCGActor');
      expect('parameter_overrides' in call.payload).toBe(false);
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.executed).toBe(true);
      expect(parsed.generation_triggered).toBe(true);
    });

    it('happy path with parameter_overrides: sends pcg.execute with both actor_label and parameter_overrides', async () => {
      const mockBridge = makeMockBridge({ responseData: PCG_EXECUTE_DATA });
      const { server, handlers } = makeStubServer();
      registerPCGTools(server, mockBridge);

      const handler = handlers.get('ue_execute_pcg_graph')!;
      await handler({
        actor_label: 'PCGActor',
        parameter_overrides: { PointsPerSquareMeter: 20, Seed: 42 },
      });

      const call = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.payload.actor_label).toBe('PCGActor');
      expect(call.payload.parameter_overrides).toBeDefined();
      expect(call.payload.parameter_overrides.PointsPerSquareMeter).toBe(20);
      expect(call.payload.parameter_overrides.Seed).toBe(42);
    });

    it('disconnected: returns isError:true with plugin_not_connected', async () => {
      const mockBridge = makeMockBridge({ throwDisconnect: true });
      const { server, handlers } = makeStubServer();
      registerPCGTools(server, mockBridge);

      const handler = handlers.get('ue_execute_pcg_graph')!;
      const result = await handler({ actor_label: 'PCGActor' }) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('plugin_not_connected');
      expect(parsed.required_plugin).toBe(true);
    });

    it('actor not found: returns isError:true with actor_not_found', async () => {
      const mockBridge = makeMockBridge({ responseSuccess: false, responseError: 'actor_not_found' });
      const { server, handlers } = makeStubServer();
      registerPCGTools(server, mockBridge);

      const handler = handlers.get('ue_execute_pcg_graph')!;
      const result = await handler({ actor_label: 'NonExistentActor' }) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('actor_not_found');
    });

    it('pcg component not found: returns isError:true with pcg_component_not_found', async () => {
      const mockBridge = makeMockBridge({ responseSuccess: false, responseError: 'pcg_component_not_found' });
      const { server, handlers } = makeStubServer();
      registerPCGTools(server, mockBridge);

      const handler = handlers.get('ue_execute_pcg_graph')!;
      const result = await handler({ actor_label: 'ActorWithoutPCG' }) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('pcg_component_not_found');
    });
  });

  // -------------------------------------------------------------------------
  // ue_query_pcg_results
  // -------------------------------------------------------------------------
  describe('ue_query_pcg_results', () => {
    it('happy path: sends pcg.results with actor_label, returns point count and data entries', async () => {
      const mockBridge = makeMockBridge({ responseData: PCG_RESULTS_DATA });
      const { server, handlers } = makeStubServer();
      registerPCGTools(server, mockBridge);

      const handler = handlers.get('ue_query_pcg_results')!;
      const result = await handler({ actor_label: 'PCGActor' }) as ToolResultShape;

      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'pcg.results',
          payload: { actor_label: 'PCGActor' },
        })
      );
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.point_count).toBe(1500);
      expect(parsed.data_entry_count).toBe(3);
      expect(Array.isArray(parsed.warnings)).toBe(true);
      expect(parsed.warnings.length).toBe(0);
    });

    it('happy path with warnings: response includes non-empty warnings array', async () => {
      const mockBridge = makeMockBridge({ responseData: PCG_RESULTS_WARNINGS_DATA });
      const { server, handlers } = makeStubServer();
      registerPCGTools(server, mockBridge);

      const handler = handlers.get('ue_query_pcg_results')!;
      const result = await handler({ actor_label: 'PCGActor' }) as ToolResultShape;

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.point_count).toBe(0);
      expect(Array.isArray(parsed.warnings)).toBe(true);
      expect(parsed.warnings[0]).toBe('No valid surfaces found');
    });

    it('disconnected: returns isError:true with plugin_not_connected', async () => {
      const mockBridge = makeMockBridge({ throwDisconnect: true });
      const { server, handlers } = makeStubServer();
      registerPCGTools(server, mockBridge);

      const handler = handlers.get('ue_query_pcg_results')!;
      const result = await handler({ actor_label: 'PCGActor' }) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('plugin_not_connected');
      expect(parsed.required_plugin).toBe(true);
    });

    it('actor not found: returns isError:true with actor_not_found', async () => {
      const mockBridge = makeMockBridge({ responseSuccess: false, responseError: 'actor_not_found' });
      const { server, handlers } = makeStubServer();
      registerPCGTools(server, mockBridge);

      const handler = handlers.get('ue_query_pcg_results')!;
      const result = await handler({ actor_label: 'NonExistentActor' }) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('actor_not_found');
    });

    it('pcg not generated: returns isError:true with pcg_not_generated', async () => {
      const mockBridge = makeMockBridge({ responseSuccess: false, responseError: 'pcg_not_generated' });
      const { server, handlers } = makeStubServer();
      registerPCGTools(server, mockBridge);

      const handler = handlers.get('ue_query_pcg_results')!;
      const result = await handler({ actor_label: 'PCGActor' }) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('pcg_not_generated');
    });
  });

  // -------------------------------------------------------------------------
  // tool registration
  // -------------------------------------------------------------------------
  describe('tool registration', () => {
    it('registers exactly four tools', () => {
      const mockBridge = makeMockBridge({});
      const { server, handlers } = makeStubServer();
      registerPCGTools(server, mockBridge);
      expect(handlers.size).toBe(4);
    });

    it('registers all expected tool names', () => {
      const mockBridge = makeMockBridge({});
      const { server, handlers } = makeStubServer();
      registerPCGTools(server, mockBridge);

      const expectedTools = [
        'ue_list_pcg_graphs',
        'ue_inspect_pcg_graph',
        'ue_execute_pcg_graph',
        'ue_query_pcg_results',
      ];
      for (const name of expectedTools) {
        expect(handlers.has(name), `Tool "${name}" should be registered`).toBe(true);
      }
    });

    it('ue_list_pcg_graphs is callable with empty args and returns no error', async () => {
      const mockBridge = makeMockBridge({ responseData: PCG_LIST_DATA });
      const { server, handlers } = makeStubServer();
      registerPCGTools(server, mockBridge);

      const handler = handlers.get('ue_list_pcg_graphs')!;
      const result = await handler({}) as ToolResultShape;
      expect(result.isError).toBeFalsy();
    });
  });

  // -------------------------------------------------------------------------
  // payload correctness
  // -------------------------------------------------------------------------
  describe('payload correctness', () => {
    it('ue_inspect_pcg_graph: payload contains asset_path field', async () => {
      const mockBridge = makeMockBridge({ responseData: PCG_INSPECT_DATA });
      const { server, handlers } = makeStubServer();
      registerPCGTools(server, mockBridge);

      const handler = handlers.get('ue_inspect_pcg_graph')!;
      await handler({ asset_path: '/Game/PCG/TestGraph' });

      const call = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.payload.asset_path).toBe('/Game/PCG/TestGraph');
    });

    it('ue_execute_pcg_graph: parameter_overrides absent when not provided', async () => {
      const mockBridge = makeMockBridge({ responseData: PCG_EXECUTE_DATA });
      const { server, handlers } = makeStubServer();
      registerPCGTools(server, mockBridge);

      const handler = handlers.get('ue_execute_pcg_graph')!;
      await handler({ actor_label: 'PCGActor' });

      const call = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect('parameter_overrides' in call.payload).toBe(false);
    });

    it('ue_execute_pcg_graph: parameter_overrides present when provided, with mixed number and string values', async () => {
      const mockBridge = makeMockBridge({ responseData: PCG_EXECUTE_DATA });
      const { server, handlers } = makeStubServer();
      registerPCGTools(server, mockBridge);

      const handler = handlers.get('ue_execute_pcg_graph')!;
      await handler({
        actor_label: 'PCGActor',
        parameter_overrides: { Density: 5, Tag: 'forest', Seed: 99 },
      });

      const call = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.payload.parameter_overrides).toBeDefined();
      expect(call.payload.parameter_overrides.Density).toBe(5);
      expect(call.payload.parameter_overrides.Tag).toBe('forest');
      expect(call.payload.parameter_overrides.Seed).toBe(99);
    });

    it('ue_query_pcg_results: payload contains actor_label field', async () => {
      const mockBridge = makeMockBridge({ responseData: PCG_RESULTS_DATA });
      const { server, handlers } = makeStubServer();
      registerPCGTools(server, mockBridge);

      const handler = handlers.get('ue_query_pcg_results')!;
      await handler({ actor_label: 'MyPCGActor' });

      const call = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.payload.actor_label).toBe('MyPCGActor');
    });

    it('ue_list_pcg_graphs: sends empty object payload', async () => {
      const mockBridge = makeMockBridge({ responseData: PCG_LIST_DATA });
      const { server, handlers } = makeStubServer();
      registerPCGTools(server, mockBridge);

      const handler = handlers.get('ue_list_pcg_graphs')!;
      await handler({});

      const call = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.type).toBe('pcg.list');
      expect(call.payload).toEqual({});
    });
  });

});
