// tests/input-tools.test.ts
// Integration tests for Phase 14 Enhanced Input Management tools.
// Uses mock PluginBridgeClient injected into registerInputTools.
// Does NOT spin up a real TCP server or real McpServer.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PluginBridgeClient, PluginNotConnectedError } from '../src/plugin-bridge/client.js';
import { registerInputTools } from '../src/tools/input/index.js';

// ---------------------------------------------------------------------------
// known-issues mock — hoisted so withKnownIssues picks it up at import time
// ---------------------------------------------------------------------------

vi.mock('../src/tools/known-issues/store.js', () => ({
  readKnownIssues: vi.fn().mockResolvedValue([]),
}));

import { readKnownIssues } from '../src/tools/known-issues/store.js';
const mockReadKnownIssues = vi.mocked(readKnownIssues);

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
// describe('input tools')
// ---------------------------------------------------------------------------

describe('input tools', () => {

  beforeEach(() => {
    // Reset known-issues mock to return no issues by default
    mockReadKnownIssues.mockResolvedValue([]);
  });

  // -------------------------------------------------------------------------
  // ue_list_input_actions
  // -------------------------------------------------------------------------
  describe('ue_list_input_actions', () => {
    it('happy path: returns actions array with name, path, valueType fields', async () => {
      const actionsData = {
        actions: [
          { name: 'IA_Jump', path: '/Game/Input/IA_Jump', valueType: 'bool' },
          { name: 'IA_Move', path: '/Game/Input/IA_Move', valueType: 'Axis2D' },
        ],
      };
      const mockBridge = makeMockBridge({ responseData: actionsData });
      const { server, handlers } = makeStubServer();
      registerInputTools(server, mockBridge);

      const handler = handlers.get('ue_list_input_actions')!;
      const result = await handler({}) as ToolResultShape;

      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'input.listActions' })
      );
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('actions');
      expect(result.content[0].text).toContain('IA_Jump');
    });

    it('empty actions array: returns success with empty array (not an error)', async () => {
      const mockBridge = makeMockBridge({ responseData: { actions: [] } });
      const { server, handlers } = makeStubServer();
      registerInputTools(server, mockBridge);

      const handler = handlers.get('ue_list_input_actions')!;
      const result = await handler({}) as ToolResultShape;

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.actions).toEqual([]);
    });

    it('known-issues warning: prepends warning content item when issue matches tool name', async () => {
      mockReadKnownIssues.mockResolvedValue([
        {
          id: 'ISSUE-001',
          description: 'Test issue affecting ue_list_input_actions',
          affectedTools: ['ue_list_input_actions'],
          rootCause: 'Asset registry race',
          resolution: 'Retry after one second',
          dateAdded: '2026-05-30',
          status: 'active' as const,
        },
      ]);
      const mockBridge = makeMockBridge({ responseData: { actions: [] } });
      const { server, handlers } = makeStubServer();
      registerInputTools(server, mockBridge);

      const handler = handlers.get('ue_list_input_actions')!;
      const result = await handler({}) as ToolResultShape;

      // Warning prepended + data = 2 items
      expect(result.content).toHaveLength(2);
      expect(result.content[0].text).toContain('[KNOWN ISSUE ISSUE-001]');
    });

    it('disconnected: returns isError:true with plugin_not_connected JSON', async () => {
      const mockBridge = makeMockBridge({ throwDisconnect: true });
      const { server, handlers } = makeStubServer();
      registerInputTools(server, mockBridge);

      const handler = handlers.get('ue_list_input_actions')!;
      const result = await handler({}) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('plugin_not_connected');
    });

    it('bridge command error: returns isError:true with { error } JSON', async () => {
      const mockBridge = makeMockBridge({ responseSuccess: false, responseError: 'asset_registry_unavailable' });
      const { server, handlers } = makeStubServer();
      registerInputTools(server, mockBridge);

      const handler = handlers.get('ue_list_input_actions')!;
      const result = await handler({}) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('asset_registry_unavailable');
    });

    it('sends command type input.listActions (command type verification)', async () => {
      const mockBridge = makeMockBridge({ responseData: { actions: [] } });
      const { server, handlers } = makeStubServer();
      registerInputTools(server, mockBridge);

      const handler = handlers.get('ue_list_input_actions')!;
      await handler({});

      const call = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.type).toBe('input.listActions');
    });
  });

  // -------------------------------------------------------------------------
  // ue_create_input_action
  // -------------------------------------------------------------------------
  describe('ue_create_input_action', () => {
    it('happy path bool: sendCommand called with correct type and payload', async () => {
      const createData = { assetPath: '/Game/Input/IA_Jump', valueType: 'bool' };
      const mockBridge = makeMockBridge({ responseData: createData });
      const { server, handlers } = makeStubServer();
      registerInputTools(server, mockBridge);

      const handler = handlers.get('ue_create_input_action')!;
      const result = await handler({
        asset_path: '/Game/Input/IA_Jump',
        value_type: 'bool',
      }) as ToolResultShape;

      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'input.createAction',
          payload: { asset_path: '/Game/Input/IA_Jump', value_type: 'bool' },
        })
      );
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('assetPath');
    });

    it('happy path Axis2D: sendCommand called with Axis2D value_type', async () => {
      const mockBridge = makeMockBridge({ responseData: { assetPath: '/Game/Input/IA_Move', valueType: 'Axis2D' } });
      const { server, handlers } = makeStubServer();
      registerInputTools(server, mockBridge);

      const handler = handlers.get('ue_create_input_action')!;
      const result = await handler({
        asset_path: '/Game/Input/IA_Move',
        value_type: 'Axis2D',
      }) as ToolResultShape;

      const call = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.payload).toHaveProperty('value_type', 'Axis2D');
      expect(result.isError).toBeFalsy();
    });

    it('happy path float: sendCommand called with float value_type', async () => {
      const mockBridge = makeMockBridge({ responseData: { assetPath: '/Game/Input/IA_Throttle', valueType: 'float' } });
      const { server, handlers } = makeStubServer();
      registerInputTools(server, mockBridge);

      const handler = handlers.get('ue_create_input_action')!;
      await handler({ asset_path: '/Game/Input/IA_Throttle', value_type: 'float' });

      const call = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.payload).toHaveProperty('value_type', 'float');
    });

    it('happy path Axis3D: sendCommand called with Axis3D value_type', async () => {
      const mockBridge = makeMockBridge({ responseData: { assetPath: '/Game/Input/IA_Look', valueType: 'Axis3D' } });
      const { server, handlers } = makeStubServer();
      registerInputTools(server, mockBridge);

      const handler = handlers.get('ue_create_input_action')!;
      await handler({ asset_path: '/Game/Input/IA_Look', value_type: 'Axis3D' });

      const call = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.payload).toHaveProperty('value_type', 'Axis3D');
    });

    it('payload completeness: sendCommand payload contains both asset_path and value_type', async () => {
      const mockBridge = makeMockBridge({ responseData: { assetPath: '/Game/Input/IA_Dash', valueType: 'float' } });
      const { server, handlers } = makeStubServer();
      registerInputTools(server, mockBridge);

      const handler = handlers.get('ue_create_input_action')!;
      await handler({ asset_path: '/Game/Input/IA_Dash', value_type: 'float' });

      const call = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.payload).toHaveProperty('asset_path', '/Game/Input/IA_Dash');
      expect(call.payload).toHaveProperty('value_type', 'float');
    });

    it('disconnected: returns isError:true with plugin_not_connected JSON', async () => {
      const mockBridge = makeMockBridge({ throwDisconnect: true });
      const { server, handlers } = makeStubServer();
      registerInputTools(server, mockBridge);

      const handler = handlers.get('ue_create_input_action')!;
      const result = await handler({
        asset_path: '/Game/Input/IA_Jump',
        value_type: 'bool',
      }) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('plugin_not_connected');
    });

    it('bridge error invalid_asset_path: returns isError:true', async () => {
      const mockBridge = makeMockBridge({ responseSuccess: false, responseError: 'invalid_asset_path' });
      const { server, handlers } = makeStubServer();
      registerInputTools(server, mockBridge);

      const handler = handlers.get('ue_create_input_action')!;
      const result = await handler({
        asset_path: '/Game/Input/IA_Jump',
        value_type: 'bool',
      }) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('invalid_asset_path');
    });
  });

  // -------------------------------------------------------------------------
  // ue_list_input_contexts
  // -------------------------------------------------------------------------
  describe('ue_list_input_contexts', () => {
    it('happy path: returns contexts array with name, path, bindings fields', async () => {
      const contextsData = {
        contexts: [
          {
            name: 'IMC_Default',
            path: '/Game/Input/IMC_Default',
            bindings: [
              { action: '/Game/Input/IA_Jump', key: 'SpaceBar' },
            ],
          },
        ],
      };
      const mockBridge = makeMockBridge({ responseData: contextsData });
      const { server, handlers } = makeStubServer();
      registerInputTools(server, mockBridge);

      const handler = handlers.get('ue_list_input_contexts')!;
      const result = await handler({}) as ToolResultShape;

      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'input.listContexts' })
      );
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('contexts');
      expect(result.content[0].text).toContain('IMC_Default');
    });

    it('contexts include bindings array per context entry', async () => {
      const contextsData = {
        contexts: [
          {
            name: 'IMC_Default',
            path: '/Game/Input/IMC_Default',
            bindings: [
              { action: '/Game/Input/IA_Jump', key: 'SpaceBar' },
              { action: '/Game/Input/IA_Move', key: 'Gamepad_LeftStick' },
            ],
          },
        ],
      };
      const mockBridge = makeMockBridge({ responseData: contextsData });
      const { server, handlers } = makeStubServer();
      registerInputTools(server, mockBridge);

      const handler = handlers.get('ue_list_input_contexts')!;
      const result = await handler({}) as ToolResultShape;

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.contexts[0].bindings).toHaveLength(2);
      expect(parsed.contexts[0].bindings[0]).toMatchObject({ action: '/Game/Input/IA_Jump', key: 'SpaceBar' });
    });

    it('empty contexts array: returns success with empty array (not an error)', async () => {
      const mockBridge = makeMockBridge({ responseData: { contexts: [] } });
      const { server, handlers } = makeStubServer();
      registerInputTools(server, mockBridge);

      const handler = handlers.get('ue_list_input_contexts')!;
      const result = await handler({}) as ToolResultShape;

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.contexts).toEqual([]);
    });

    it('disconnected: returns isError:true with plugin_not_connected JSON', async () => {
      const mockBridge = makeMockBridge({ throwDisconnect: true });
      const { server, handlers } = makeStubServer();
      registerInputTools(server, mockBridge);

      const handler = handlers.get('ue_list_input_contexts')!;
      const result = await handler({}) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('plugin_not_connected');
    });

    it('bridge error: returns isError:true with { error } JSON', async () => {
      const mockBridge = makeMockBridge({ responseSuccess: false, responseError: 'no_contexts_found' });
      const { server, handlers } = makeStubServer();
      registerInputTools(server, mockBridge);

      const handler = handlers.get('ue_list_input_contexts')!;
      const result = await handler({}) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('no_contexts_found');
    });

    it('sends command type input.listContexts (command type verification)', async () => {
      const mockBridge = makeMockBridge({ responseData: { contexts: [] } });
      const { server, handlers } = makeStubServer();
      registerInputTools(server, mockBridge);

      const handler = handlers.get('ue_list_input_contexts')!;
      await handler({});

      const call = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.type).toBe('input.listContexts');
    });
  });

  // -------------------------------------------------------------------------
  // ue_add_input_binding
  // -------------------------------------------------------------------------
  describe('ue_add_input_binding', () => {
    it('happy path: sendCommand called with correct type and payload', async () => {
      const bindingData = { bound: true, action: '/Game/Input/IA_Jump', key: 'SpaceBar' };
      const mockBridge = makeMockBridge({ responseData: bindingData });
      const { server, handlers } = makeStubServer();
      registerInputTools(server, mockBridge);

      const handler = handlers.get('ue_add_input_binding')!;
      const result = await handler({
        asset_path: '/Game/Input/IMC_Default',
        action_path: '/Game/Input/IA_Jump',
        key: 'SpaceBar',
      }) as ToolResultShape;

      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'input.addBinding',
          payload: {
            asset_path: '/Game/Input/IMC_Default',
            action_path: '/Game/Input/IA_Jump',
            key: 'SpaceBar',
          },
        })
      );
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('bound');
    });

    it('payload completeness: payload includes all three required fields asset_path, action_path, key', async () => {
      const mockBridge = makeMockBridge({ responseData: { bound: true, action: '/Game/Input/IA_Jump', key: 'SpaceBar' } });
      const { server, handlers } = makeStubServer();
      registerInputTools(server, mockBridge);

      const handler = handlers.get('ue_add_input_binding')!;
      await handler({
        asset_path: '/Game/Input/IMC_Default',
        action_path: '/Game/Input/IA_Jump',
        key: 'SpaceBar',
      });

      const call = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.payload).toHaveProperty('asset_path', '/Game/Input/IMC_Default');
      expect(call.payload).toHaveProperty('action_path', '/Game/Input/IA_Jump');
      expect(call.payload).toHaveProperty('key', 'SpaceBar');
    });

    it('gamepad key: payload contains correct key string Gamepad_FaceButton_Bottom', async () => {
      const mockBridge = makeMockBridge({ responseData: { bound: true, action: '/Game/Input/IA_Jump', key: 'Gamepad_FaceButton_Bottom' } });
      const { server, handlers } = makeStubServer();
      registerInputTools(server, mockBridge);

      const handler = handlers.get('ue_add_input_binding')!;
      await handler({
        asset_path: '/Game/Input/IMC_Default',
        action_path: '/Game/Input/IA_Jump',
        key: 'Gamepad_FaceButton_Bottom',
      });

      const call = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.payload).toHaveProperty('key', 'Gamepad_FaceButton_Bottom');
    });

    it('disconnected: returns isError:true with plugin_not_connected JSON', async () => {
      const mockBridge = makeMockBridge({ throwDisconnect: true });
      const { server, handlers } = makeStubServer();
      registerInputTools(server, mockBridge);

      const handler = handlers.get('ue_add_input_binding')!;
      const result = await handler({
        asset_path: '/Game/Input/IMC_Default',
        action_path: '/Game/Input/IA_Jump',
        key: 'SpaceBar',
      }) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('plugin_not_connected');
    });

    it('bridge error context_not_found: returns isError:true', async () => {
      const mockBridge = makeMockBridge({ responseSuccess: false, responseError: 'context_not_found' });
      const { server, handlers } = makeStubServer();
      registerInputTools(server, mockBridge);

      const handler = handlers.get('ue_add_input_binding')!;
      const result = await handler({
        asset_path: '/Game/Input/IMC_Default',
        action_path: '/Game/Input/IA_Jump',
        key: 'NotAKey',
      }) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('context_not_found');
    });

    it('different key strings: SpaceBar key is forwarded as-is', async () => {
      const mockBridge = makeMockBridge({ responseData: { bound: true, action: '/Game/Input/IA_Jump', key: 'SpaceBar' } });
      const { server, handlers } = makeStubServer();
      registerInputTools(server, mockBridge);

      const handler = handlers.get('ue_add_input_binding')!;
      await handler({
        asset_path: '/Game/Input/IMC_Default',
        action_path: '/Game/Input/IA_Jump',
        key: 'SpaceBar',
      });

      const call = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.payload.key).toBe('SpaceBar');
    });
  });

  // -------------------------------------------------------------------------
  // Structural checks
  // -------------------------------------------------------------------------
  describe('tool registration', () => {
    it('registers exactly four tools', () => {
      const mockBridge = makeMockBridge({});
      const { server, handlers } = makeStubServer();
      registerInputTools(server, mockBridge);

      expect(handlers.size).toBe(4);
    });

    it('registers all expected tool names', () => {
      const mockBridge = makeMockBridge({});
      const { server, handlers } = makeStubServer();
      registerInputTools(server, mockBridge);

      const expectedTools = [
        'ue_list_input_actions',
        'ue_create_input_action',
        'ue_list_input_contexts',
        'ue_add_input_binding',
      ];
      for (const name of expectedTools) {
        expect(handlers.has(name), `Tool "${name}" should be registered`).toBe(true);
      }
    });
  });
});
