// tests/blueprint-write-tools.test.ts
// Integration tests for Blueprint Write MCP tool handlers (BPW-01 through BPW-05).
// Uses injected mock PluginBridgeClient for disconnected and error-response tests
// (Groups 1-5), and a mock TCP server on port 55563 for round-trip command tests
// (Groups 6-10).
//
// Port assignments:
//   55557 — real UE Editor plugin (not running in tests)
//   55560 — plugin-bridge.test.ts mock server
//   55561 — blueprint-tools.test.ts mock server
//   55562 — bridge-cpp-tools.test.ts mock server
//   55563 — this file's mock server (no conflict)

import * as net from 'net';
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import {
  handleCreateBlueprint,
  handleAddBlueprintNode,
  handleConnectBlueprintPins,
  handleAddBlueprintVariable,
  handleSetBlueprintDefault,
} from '../src/tools/blueprint/index.js';
import { PluginBridgeClient, PluginNotConnectedError } from '../src/plugin-bridge/client.js';
import type {
  BlueprintCreateResult,
  BlueprintAddNodeResult,
  BlueprintConnectResult,
  BlueprintAddVariableResult,
  BlueprintSetDefaultResult,
} from '../src/tools/blueprint/types.js';

// ---------------------------------------------------------------------------
// makeMockBridge helper
// Creates a lightweight in-process mock of PluginBridgeClient for disconnected
// and error-response tests (Groups 1–5). This avoids any TCP overhead.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Group 1 — handleCreateBlueprint disconnected (BPW-01)
// ---------------------------------------------------------------------------

describe('handleCreateBlueprint — plugin disconnected (BPW-01)', () => {
  it('returns isError:true when bridge throws PluginNotConnectedError', async () => {
    const bridge = makeMockBridge({ throwDisconnect: true });
    const result = await handleCreateBlueprint(
      { parent_class: 'AActor', asset_path: '/Game/BP_Test' },
      bridge
    );
    expect(result.isError).toBe(true);
  });

  it('returns plugin_not_connected error JSON with required_plugin:true', async () => {
    const bridge = makeMockBridge({ throwDisconnect: true });
    const result = await handleCreateBlueprint(
      { parent_class: 'AActor', asset_path: '/Game/BP_Test' },
      bridge
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('plugin_not_connected');
    expect(parsed.required_plugin).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Group 2 — handleAddBlueprintNode disconnected (BPW-02)
// ---------------------------------------------------------------------------

describe('handleAddBlueprintNode — plugin disconnected (BPW-02)', () => {
  it('returns isError:true when bridge throws PluginNotConnectedError', async () => {
    const bridge = makeMockBridge({ throwDisconnect: true });
    const result = await handleAddBlueprintNode(
      { asset_path: '/Game/BP_Test', graph_name: 'EventGraph', node_type: 'K2Node_CallFunction' },
      bridge
    );
    expect(result.isError).toBe(true);
  });

  it('returns plugin_not_connected error JSON with required_plugin:true', async () => {
    const bridge = makeMockBridge({ throwDisconnect: true });
    const result = await handleAddBlueprintNode(
      { asset_path: '/Game/BP_Test', graph_name: 'EventGraph', node_type: 'K2Node_CallFunction' },
      bridge
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('plugin_not_connected');
    expect(parsed.required_plugin).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Group 3 — handleConnectBlueprintPins disconnected (BPW-03)
// ---------------------------------------------------------------------------

describe('handleConnectBlueprintPins — plugin disconnected (BPW-03)', () => {
  it('returns isError:true when bridge throws PluginNotConnectedError', async () => {
    const bridge = makeMockBridge({ throwDisconnect: true });
    const result = await handleConnectBlueprintPins(
      {
        asset_path: '/Game/BP_Test',
        from_node_guid: 'GUID-A',
        from_pin_name: 'then',
        to_node_guid: 'GUID-B',
        to_pin_name: 'execute',
      },
      bridge
    );
    expect(result.isError).toBe(true);
  });

  it('returns plugin_not_connected error JSON with required_plugin:true', async () => {
    const bridge = makeMockBridge({ throwDisconnect: true });
    const result = await handleConnectBlueprintPins(
      {
        asset_path: '/Game/BP_Test',
        from_node_guid: 'GUID-A',
        from_pin_name: 'then',
        to_node_guid: 'GUID-B',
        to_pin_name: 'execute',
      },
      bridge
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('plugin_not_connected');
    expect(parsed.required_plugin).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Group 4 — handleAddBlueprintVariable disconnected (BPW-04)
// ---------------------------------------------------------------------------

describe('handleAddBlueprintVariable — plugin disconnected (BPW-04)', () => {
  it('returns isError:true when bridge throws PluginNotConnectedError', async () => {
    const bridge = makeMockBridge({ throwDisconnect: true });
    const result = await handleAddBlueprintVariable(
      { asset_path: '/Game/BP_Test', variable_name: 'Health', variable_type: 'float' },
      bridge
    );
    expect(result.isError).toBe(true);
  });

  it('returns plugin_not_connected error JSON with required_plugin:true', async () => {
    const bridge = makeMockBridge({ throwDisconnect: true });
    const result = await handleAddBlueprintVariable(
      { asset_path: '/Game/BP_Test', variable_name: 'Health', variable_type: 'float' },
      bridge
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('plugin_not_connected');
    expect(parsed.required_plugin).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Group 5 — handleSetBlueprintDefault disconnected (BPW-05)
// ---------------------------------------------------------------------------

describe('handleSetBlueprintDefault — plugin disconnected and success (BPW-05)', () => {
  it('returns isError:true when bridge throws PluginNotConnectedError', async () => {
    const bridge = makeMockBridge({ throwDisconnect: true });
    const result = await handleSetBlueprintDefault(
      {
        asset_path: '/Game/BP_Test',
        target_type: 'variable',
        target_name: 'Health',
        default_value: '100.0',
      },
      bridge
    );
    expect(result.isError).toBe(true);
  });

  it('returns plugin_not_connected error JSON with required_plugin:true', async () => {
    const bridge = makeMockBridge({ throwDisconnect: true });
    const result = await handleSetBlueprintDefault(
      {
        asset_path: '/Game/BP_Test',
        target_type: 'variable',
        target_name: 'Health',
        default_value: '100.0',
      },
      bridge
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('plugin_not_connected');
    expect(parsed.required_plugin).toBe(true);
  });

  it('handleSetBlueprintDefault — returns success JSON when bridge responds with success', async () => {
    const bridge = makeMockBridge({
      responseData: {
        set: true,
        targetType: 'variable',
        targetName: 'Health',
        defaultValue: '100.0',
      },
    });
    const result = await handleSetBlueprintDefault(
      {
        asset_path: '/Game/BP_Test',
        target_type: 'variable',
        target_name: 'Health',
        default_value: '100.0',
      },
      bridge
    );
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text) as BlueprintSetDefaultResult;
    expect(parsed.set).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Groups 6–10: Mock TCP server round-trip tests
// A PluginBridgeClient connects to the mock server on port 55563.
// The mock server records the received command and returns configurable responses.
// This exercises the full JSON-newline framing and correlationId round-trip path.
// ---------------------------------------------------------------------------

describe('Mock TCP server — Blueprint write command shapes and response handling', () => {
  const TEST_PORT = 55563;
  let server: net.Server;
  let client: PluginBridgeClient;

  // Captured command from the mock server socket handler
  let capturedCmd: { type: string; correlationId: string; payload?: unknown } | null = null;
  // Configurable mock response data for the next request
  let mockResponseData: unknown = null;
  let mockResponseSuccess = true;
  let mockResponseError: string | undefined = undefined;

  // Active socket reference (set on each connection)
  let activeSocket: net.Socket | null = null;

  beforeAll(async () => {
    // Start mock TCP server
    server = net.createServer((socket) => {
      activeSocket = socket;
      let buf = '';
      socket.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        let idx: number;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) { continue; }
          try {
            const cmd = JSON.parse(line) as { type: string; correlationId: string; payload?: unknown };
            capturedCmd = cmd;
            const response = mockResponseSuccess
              ? { success: true, correlationId: cmd.correlationId, data: mockResponseData }
              : { success: false, correlationId: cmd.correlationId, error: mockResponseError ?? 'plugin_error' };
            socket.write(JSON.stringify(response) + '\n', 'utf8');
          } catch {
            // ignore bad JSON
          }
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(TEST_PORT, '127.0.0.1', resolve));

    // Connect test client to mock server
    client = new PluginBridgeClient(TEST_PORT);

    // Wait for client to connect (backoff starts at 1s)
    await new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const interval = setInterval(() => {
        if (client.isConnected()) {
          clearInterval(interval);
          resolve();
        } else if (Date.now() - start > 5000) {
          clearInterval(interval);
          reject(new Error('Test client did not connect to mock server within 5 seconds'));
        }
      }, 50);
    });
  });

  afterAll(async () => {
    client?.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    );
  });

  beforeEach(() => {
    capturedCmd = null;
    mockResponseData = null;
    mockResponseSuccess = true;
    mockResponseError = undefined;
  });

  // -------------------------------------------------------------------------
  // Group 6 — blueprint.create command shape (BPW-01)
  // -------------------------------------------------------------------------

  it('blueprint.create — sends command with type "blueprint.create"', async () => {
    mockResponseData = { assetPath: '/Game/BP_Test', parentClass: 'AActor' };
    await client.sendCommand({
      type: 'blueprint.create',
      correlationId: '',
      payload: { parent_class: 'AActor', asset_path: '/Game/BP_Test' },
    });
    expect(capturedCmd?.type).toBe('blueprint.create');
  });

  it('blueprint.create — payload contains parent_class and asset_path', async () => {
    mockResponseData = { assetPath: '/Game/BP_Test', parentClass: 'AActor' };
    await client.sendCommand({
      type: 'blueprint.create',
      correlationId: '',
      payload: { parent_class: 'AActor', asset_path: '/Game/BP_Test' },
    });
    const payload = capturedCmd?.payload as { parent_class?: string; asset_path?: string };
    expect(payload?.parent_class).toBe('AActor');
    expect(payload?.asset_path).toBe('/Game/BP_Test');
  });

  it('blueprint.create — response data parses to BlueprintCreateResult shape', async () => {
    const mockData: BlueprintCreateResult = { assetPath: '/Game/BP_Test', parentClass: 'AActor' };
    mockResponseData = mockData;
    const response = await client.sendCommand({
      type: 'blueprint.create',
      correlationId: '',
      payload: { parent_class: 'AActor', asset_path: '/Game/BP_Test' },
    });
    expect(response.success).toBe(true);
    const data = response.data as BlueprintCreateResult;
    expect(data.assetPath).toBe('/Game/BP_Test');
    expect(data.parentClass).toBe('AActor');
  });

  // -------------------------------------------------------------------------
  // Group 7 — blueprint.addNode command shape (BPW-02)
  // -------------------------------------------------------------------------

  it('blueprint.addNode — sends command with type "blueprint.addNode"', async () => {
    mockResponseData = { nodeGuid: 'GUID-NEW', type: 'K2Node_CallFunction', posX: 100, posY: 200 };
    await client.sendCommand({
      type: 'blueprint.addNode',
      correlationId: '',
      payload: {
        asset_path: '/Game/BP_Test',
        graph_name: 'EventGraph',
        node_type: 'K2Node_CallFunction',
        pos_x: 100,
        pos_y: 200,
      },
    });
    expect(capturedCmd?.type).toBe('blueprint.addNode');
  });

  it('blueprint.addNode — payload contains asset_path, graph_name, node_type, pos_x, pos_y', async () => {
    mockResponseData = { nodeGuid: 'GUID-NEW', type: 'K2Node_CallFunction', posX: 100, posY: 200 };
    await client.sendCommand({
      type: 'blueprint.addNode',
      correlationId: '',
      payload: {
        asset_path: '/Game/BP_Test',
        graph_name: 'EventGraph',
        node_type: 'K2Node_CallFunction',
        pos_x: 100,
        pos_y: 200,
      },
    });
    const payload = capturedCmd?.payload as {
      asset_path?: string;
      graph_name?: string;
      node_type?: string;
      pos_x?: number;
      pos_y?: number;
    };
    expect(payload?.asset_path).toBe('/Game/BP_Test');
    expect(payload?.graph_name).toBe('EventGraph');
    expect(payload?.node_type).toBe('K2Node_CallFunction');
    expect(payload?.pos_x).toBe(100);
    expect(payload?.pos_y).toBe(200);
  });

  it('blueprint.addNode — response data parses to BlueprintAddNodeResult shape', async () => {
    const mockData: BlueprintAddNodeResult = {
      nodeGuid: 'GUID-NEW',
      type: 'K2Node_CallFunction',
      posX: 100,
      posY: 200,
    };
    mockResponseData = mockData;
    const response = await client.sendCommand({
      type: 'blueprint.addNode',
      correlationId: '',
      payload: {
        asset_path: '/Game/BP_Test',
        graph_name: 'EventGraph',
        node_type: 'K2Node_CallFunction',
        pos_x: 100,
        pos_y: 200,
      },
    });
    expect(response.success).toBe(true);
    const data = response.data as BlueprintAddNodeResult;
    expect(typeof data.nodeGuid).toBe('string');
    expect(data.posX).toBe(100);
  });

  // -------------------------------------------------------------------------
  // Group 8 — blueprint.connectPins command shape (BPW-03)
  // -------------------------------------------------------------------------

  it('blueprint.connectPins — sends command with type "blueprint.connectPins"', async () => {
    mockResponseData = {
      connected: true,
      fromNodeGuid: 'GUID-A',
      fromPinName: 'then',
      toNodeGuid: 'GUID-B',
      toPinName: 'execute',
    };
    await client.sendCommand({
      type: 'blueprint.connectPins',
      correlationId: '',
      payload: {
        asset_path: '/Game/BP_Test',
        graph_name: 'EventGraph',
        from_node_guid: 'GUID-A',
        from_pin_name: 'then',
        to_node_guid: 'GUID-B',
        to_pin_name: 'execute',
      },
    });
    expect(capturedCmd?.type).toBe('blueprint.connectPins');
  });

  it('blueprint.connectPins — payload contains all six required fields', async () => {
    mockResponseData = {
      connected: true,
      fromNodeGuid: 'GUID-A',
      fromPinName: 'then',
      toNodeGuid: 'GUID-B',
      toPinName: 'execute',
    };
    await client.sendCommand({
      type: 'blueprint.connectPins',
      correlationId: '',
      payload: {
        asset_path: '/Game/BP_Test',
        graph_name: 'EventGraph',
        from_node_guid: 'GUID-A',
        from_pin_name: 'then',
        to_node_guid: 'GUID-B',
        to_pin_name: 'execute',
      },
    });
    const payload = capturedCmd?.payload as {
      asset_path?: string;
      graph_name?: string;
      from_node_guid?: string;
      from_pin_name?: string;
      to_node_guid?: string;
      to_pin_name?: string;
    };
    expect(payload?.asset_path).toBe('/Game/BP_Test');
    expect(payload?.graph_name).toBe('EventGraph');
    expect(payload?.from_node_guid).toBe('GUID-A');
    expect(payload?.from_pin_name).toBe('then');
    expect(payload?.to_node_guid).toBe('GUID-B');
    expect(payload?.to_pin_name).toBe('execute');
  });

  it('blueprint.connectPins — response data parses to BlueprintConnectResult shape with connected:true', async () => {
    const mockData: BlueprintConnectResult = {
      connected: true,
      fromNodeGuid: 'GUID-A',
      fromPinName: 'then',
      toNodeGuid: 'GUID-B',
      toPinName: 'execute',
    };
    mockResponseData = mockData;
    const response = await client.sendCommand({
      type: 'blueprint.connectPins',
      correlationId: '',
      payload: {
        asset_path: '/Game/BP_Test',
        graph_name: 'EventGraph',
        from_node_guid: 'GUID-A',
        from_pin_name: 'then',
        to_node_guid: 'GUID-B',
        to_pin_name: 'execute',
      },
    });
    expect(response.success).toBe(true);
    const data = response.data as BlueprintConnectResult;
    expect(data.connected).toBe(true);
    expect(data.fromNodeGuid).toBe('GUID-A');
    expect(data.toNodeGuid).toBe('GUID-B');
  });

  // -------------------------------------------------------------------------
  // Group 9 — blueprint.addVariable command shape (BPW-04)
  // -------------------------------------------------------------------------

  it('blueprint.addVariable — sends command with type "blueprint.addVariable"', async () => {
    mockResponseData = { variableName: 'Health', variableType: 'float' };
    await client.sendCommand({
      type: 'blueprint.addVariable',
      correlationId: '',
      payload: {
        asset_path: '/Game/BP_Test',
        variable_name: 'Health',
        variable_type: 'float',
      },
    });
    expect(capturedCmd?.type).toBe('blueprint.addVariable');
  });

  it('blueprint.addVariable — payload contains variable_name and variable_type', async () => {
    mockResponseData = { variableName: 'Health', variableType: 'float' };
    await client.sendCommand({
      type: 'blueprint.addVariable',
      correlationId: '',
      payload: {
        asset_path: '/Game/BP_Test',
        variable_name: 'Health',
        variable_type: 'float',
      },
    });
    const payload = capturedCmd?.payload as {
      asset_path?: string;
      variable_name?: string;
      variable_type?: string;
    };
    expect(payload?.variable_name).toBe('Health');
    expect(payload?.variable_type).toBe('float');
  });

  it('blueprint.addVariable — response data parses to BlueprintAddVariableResult shape', async () => {
    const mockData: BlueprintAddVariableResult = {
      variableName: 'Health',
      variableType: 'float',
    };
    mockResponseData = mockData;
    const response = await client.sendCommand({
      type: 'blueprint.addVariable',
      correlationId: '',
      payload: {
        asset_path: '/Game/BP_Test',
        variable_name: 'Health',
        variable_type: 'float',
      },
    });
    expect(response.success).toBe(true);
    const data = response.data as BlueprintAddVariableResult;
    expect(data.variableName).toBe('Health');
    expect(data.variableType).toBe('float');
  });

  // -------------------------------------------------------------------------
  // Group 10 — blueprint.setDefault + cross-cutting tests (BPW-05)
  // -------------------------------------------------------------------------

  it('blueprint.setDefault — sends command with type "blueprint.setDefault"', async () => {
    mockResponseData = {
      set: true,
      targetType: 'variable',
      targetName: 'Health',
      defaultValue: '100.0',
    };
    await client.sendCommand({
      type: 'blueprint.setDefault',
      correlationId: '',
      payload: {
        asset_path: '/Game/BP_Test',
        target_type: 'variable',
        target_name: 'Health',
        default_value: '100.0',
      },
    });
    expect(capturedCmd?.type).toBe('blueprint.setDefault');
  });

  it('blueprint.setDefault — payload contains target_type, target_name, default_value', async () => {
    mockResponseData = {
      set: true,
      targetType: 'variable',
      targetName: 'Health',
      defaultValue: '100.0',
    };
    await client.sendCommand({
      type: 'blueprint.setDefault',
      correlationId: '',
      payload: {
        asset_path: '/Game/BP_Test',
        target_type: 'variable',
        target_name: 'Health',
        default_value: '100.0',
      },
    });
    const payload = capturedCmd?.payload as {
      target_type?: string;
      target_name?: string;
      default_value?: string;
    };
    expect(payload?.target_type).toBe('variable');
    expect(payload?.target_name).toBe('Health');
    expect(payload?.default_value).toBe('100.0');
  });

  it('blueprint.setDefault — response data has set:true for variable target', async () => {
    const mockData: BlueprintSetDefaultResult = {
      set: true,
      targetType: 'variable',
      targetName: 'Health',
      defaultValue: '100.0',
    };
    mockResponseData = mockData;
    const response = await client.sendCommand({
      type: 'blueprint.setDefault',
      correlationId: '',
      payload: {
        asset_path: '/Game/BP_Test',
        target_type: 'variable',
        target_name: 'Health',
        default_value: '100.0',
      },
    });
    expect(response.success).toBe(true);
    const data = response.data as BlueprintSetDefaultResult;
    expect(data.set).toBe(true);
    expect(data.targetType).toBe('variable');
  });

  it('plugin error response — success:false with blueprint_not_found is surfaced correctly', async () => {
    mockResponseSuccess = false;
    mockResponseError = 'blueprint_not_found';
    const response = await client.sendCommand({
      type: 'blueprint.create',
      correlationId: '',
      payload: { parent_class: 'AActor', asset_path: '/Game/BP_Missing' },
    });
    expect(response.success).toBe(false);
    expect(response.error).toBe('blueprint_not_found');
  });

  it('concurrent write commands — resolve independently with distinct correlationIds', async () => {
    mockResponseData = { variableName: 'Health', variableType: 'float' };
    const [r1, r2] = await Promise.all([
      client.sendCommand({
        type: 'blueprint.addVariable',
        correlationId: '',
        payload: { asset_path: '/Game/BP_Test', variable_name: 'Health', variable_type: 'float' },
      }),
      client.sendCommand({
        type: 'blueprint.addVariable',
        correlationId: '',
        payload: { asset_path: '/Game/BP_Test', variable_name: 'Speed', variable_type: 'float' },
      }),
    ]);
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    expect(r1.correlationId).not.toBe(r2.correlationId);
  });
});
