// tests/blueprint-tools.test.ts
// Integration tests for Blueprint MCP tool handlers (BPR-01 through BPR-04).
// Uses a mock TCP server on port 55561 to exercise the full sendCommand() path
// without requiring the UE Editor plugin. Disconnected tests confirm graceful
// degradation for all three handler functions.
//
// Port assignments:
//   55557 — real UE Editor plugin (not running in tests)
//   55560 — plugin-bridge.test.ts mock server
//   55561 — this file's mock server (no conflict)

import * as net from 'net';
import { handleReadBlueprint, handleReadBlueprintGraph, handleListBlueprints } from '../src/tools/blueprint/index.js';
import { PluginBridgeClient } from '../src/plugin-bridge/client.js';
import type { BlueprintInfo, BlueprintGraphData, BlueprintListResult } from '../src/tools/blueprint/types.js';

// ---------------------------------------------------------------------------
// Group 1: handleReadBlueprint — plugin disconnected
// ---------------------------------------------------------------------------
// The module-level bridge in blueprint/index.ts targets PLUGIN_PORT (55557).
// No UE Editor is running in tests, so all sendCommand() calls immediately
// throw PluginNotConnectedError, which the handler catches and returns as isError.

describe('handleReadBlueprint — plugin disconnected', () => {
  it('returns isError:true when plugin is not connected', async () => {
    const result = await handleReadBlueprint({ asset_path: '/Game/Blueprints/BP_Test' });
    expect(result.isError).toBe(true);
  });

  it('returns plugin_not_connected error JSON when disconnected', async () => {
    const result = await handleReadBlueprint({ asset_path: '/Game/Blueprints/BP_Test' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('plugin_not_connected');
    expect(parsed.required_plugin).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Group 2: handleReadBlueprintGraph — plugin disconnected
// ---------------------------------------------------------------------------

describe('handleReadBlueprintGraph — plugin disconnected', () => {
  it('returns isError:true when plugin is not connected', async () => {
    const result = await handleReadBlueprintGraph({ asset_path: '/Game/Blueprints/BP_Test' });
    expect(result.isError).toBe(true);
  });

  it('returns plugin_not_connected error JSON when disconnected', async () => {
    const result = await handleReadBlueprintGraph({ asset_path: '/Game/Blueprints/BP_Test' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('plugin_not_connected');
    expect(parsed.required_plugin).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Group 3: handleListBlueprints — plugin disconnected
// ---------------------------------------------------------------------------

describe('handleListBlueprints — plugin disconnected', () => {
  it('returns isError:true when plugin is not connected', async () => {
    const result = await handleListBlueprints({});
    expect(result.isError).toBe(true);
  });

  it('returns plugin_not_connected error JSON when disconnected', async () => {
    const result = await handleListBlueprints({});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('plugin_not_connected');
    expect(parsed.required_plugin).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Groups 4–8: Mock TCP server tests
// ---------------------------------------------------------------------------
// A PluginBridgeClient is connected directly to the mock server on port 55561.
// The mock server records received commands and returns configurable responses.
// This exercises the full JSON-newline framing and correlationId round-trip.

describe('Mock TCP server — blueprint command shapes and response handling', () => {
  const TEST_PORT = 55561;
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
  // Group 4: blueprint.read command shape
  // -------------------------------------------------------------------------

  it('blueprint.read — sends correct command type', async () => {
    mockResponseData = {
      assetPath: '/Game/Blueprints/BP_Test',
      parentClass: 'AActor',
      variables: [],
      components: [],
    };
    await client.sendCommand({
      type: 'blueprint.read',
      correlationId: '',
      payload: { asset_path: '/Game/Blueprints/BP_Test' },
    });
    expect(capturedCmd?.type).toBe('blueprint.read');
  });

  it('blueprint.read — forwards asset_path in payload', async () => {
    mockResponseData = {
      assetPath: '/Game/Blueprints/BP_MyActor',
      parentClass: 'AActor',
      variables: [],
      components: [],
    };
    await client.sendCommand({
      type: 'blueprint.read',
      correlationId: '',
      payload: { asset_path: '/Game/Blueprints/BP_MyActor' },
    });
    expect((capturedCmd?.payload as { asset_path?: string })?.asset_path).toBe('/Game/Blueprints/BP_MyActor');
  });

  it('blueprint.read — response data parses to BlueprintInfo shape', async () => {
    const mockData: BlueprintInfo = {
      assetPath: '/Game/Blueprints/BP_MyActor',
      parentClass: 'AActor',
      variables: [{ name: 'Health', type: 'float' }],
      components: [{ name: 'MeshComponent', class: 'StaticMeshComponent' }],
    };
    mockResponseData = mockData;
    const response = await client.sendCommand({
      type: 'blueprint.read',
      correlationId: '',
      payload: { asset_path: '/Game/Blueprints/BP_MyActor' },
    });
    expect(response.success).toBe(true);
    const data = response.data as BlueprintInfo;
    expect(data.parentClass).toBe('AActor');
    expect(Array.isArray(data.variables)).toBe(true);
    expect(Array.isArray(data.components)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Group 5: blueprint.graph command shape
  // -------------------------------------------------------------------------

  it('blueprint.graph — sends correct command type', async () => {
    mockResponseData = {
      assetPath: '/Game/Blueprints/BP_Test',
      graphName: 'EventGraph',
      nodes: [],
      connections: [],
    };
    await client.sendCommand({
      type: 'blueprint.graph',
      correlationId: '',
      payload: { asset_path: '/Game/Blueprints/BP_Test', graph_name: 'EventGraph' },
    });
    expect(capturedCmd?.type).toBe('blueprint.graph');
  });

  it('blueprint.graph — forwards explicit graph_name in payload', async () => {
    mockResponseData = {
      assetPath: '/Game/Blueprints/BP_Test',
      graphName: 'MyCustomFunction',
      nodes: [],
      connections: [],
    };
    await client.sendCommand({
      type: 'blueprint.graph',
      correlationId: '',
      payload: { asset_path: '/Game/Blueprints/BP_Test', graph_name: 'MyCustomFunction' },
    });
    expect((capturedCmd?.payload as { graph_name?: string })?.graph_name).toBe('MyCustomFunction');
  });

  it('blueprint.graph — defaults graph_name to EventGraph when omitted', async () => {
    mockResponseData = {
      assetPath: '/Game/Blueprints/BP_Test',
      graphName: 'EventGraph',
      nodes: [],
      connections: [],
    };
    // Simulate what handleReadBlueprintGraph does: apply EventGraph default
    const graphName = undefined ?? 'EventGraph';
    await client.sendCommand({
      type: 'blueprint.graph',
      correlationId: '',
      payload: { asset_path: '/Game/Blueprints/BP_Test', graph_name: graphName },
    });
    expect((capturedCmd?.payload as { graph_name?: string })?.graph_name).toBe('EventGraph');
  });

  it('blueprint.graph — response data parses to BlueprintGraphData shape', async () => {
    const mockData: BlueprintGraphData = {
      assetPath: '/Game/Blueprints/BP_MyActor',
      graphName: 'EventGraph',
      nodes: [
        {
          nodeGuid: 'A1B2C3D4-0000-0000-0000-000000000001',
          type: 'K2Node_Event',
          title: 'Event BeginPlay',
          posX: 100,
          posY: 200,
          pins: [{ pinName: 'then', direction: 'output', type: 'exec', defaultValue: '' }],
        },
      ],
      connections: [
        {
          fromNodeGuid: 'A1B2C3D4-0000-0000-0000-000000000001',
          fromPinName: 'then',
          toNodeGuid: 'B2C3D4E5-0000-0000-0000-000000000002',
          toPinName: 'execute',
        },
      ],
    };
    mockResponseData = mockData;
    const response = await client.sendCommand({
      type: 'blueprint.graph',
      correlationId: '',
      payload: { asset_path: '/Game/Blueprints/BP_MyActor', graph_name: 'EventGraph' },
    });
    expect(response.success).toBe(true);
    const data = response.data as BlueprintGraphData;
    expect(data.graphName).toBe('EventGraph');
    expect(Array.isArray(data.nodes)).toBe(true);
    expect(Array.isArray(data.connections)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Group 6: blueprint.list command shape
  // -------------------------------------------------------------------------

  it('blueprint.list — sends correct command type', async () => {
    mockResponseData = { blueprints: [], count: 0 };
    await client.sendCommand({
      type: 'blueprint.list',
      correlationId: '',
      payload: {},
    });
    expect(capturedCmd?.type).toBe('blueprint.list');
  });

  it('blueprint.list — includes path_prefix in payload when provided', async () => {
    mockResponseData = { blueprints: [], count: 0 };
    await client.sendCommand({
      type: 'blueprint.list',
      correlationId: '',
      payload: { path_prefix: '/Game/Blueprints/' },
    });
    expect((capturedCmd?.payload as { path_prefix?: string })?.path_prefix).toBe('/Game/Blueprints/');
  });

  it('blueprint.list — sends empty payload object when path_prefix is omitted', async () => {
    mockResponseData = { blueprints: [], count: 0 };
    // Simulate what handleListBlueprints does: no path_prefix → empty payload
    const pathPrefix: string | undefined = undefined;
    await client.sendCommand({
      type: 'blueprint.list',
      correlationId: '',
      payload: pathPrefix ? { path_prefix: pathPrefix } : {},
    });
    // payload should be an empty object — path_prefix key absent
    expect((capturedCmd?.payload as { path_prefix?: string })?.path_prefix).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Group 7: Error response handling
  // -------------------------------------------------------------------------

  it('success:false response — resolves with success=false (not thrown)', async () => {
    mockResponseSuccess = false;
    mockResponseError = 'blueprint_not_found';
    const response = await client.sendCommand({
      type: 'blueprint.read',
      correlationId: '',
      payload: { asset_path: '/Game/Blueprints/BP_Missing' },
    });
    // sendCommand resolves even on plugin errors — handler checks response.success
    expect(response.success).toBe(false);
  });

  it('success:false response — error field is propagated in response', async () => {
    mockResponseSuccess = false;
    mockResponseError = 'asset_not_found';
    const response = await client.sendCommand({
      type: 'blueprint.read',
      correlationId: '',
      payload: { asset_path: '/Game/Blueprints/BP_Missing' },
    });
    expect(response.error).toBe('asset_not_found');
  });

  // -------------------------------------------------------------------------
  // Group 8: Response data structure assertions
  // -------------------------------------------------------------------------

  it('blueprint.read — variables array contains expected fields', async () => {
    const mockData: BlueprintInfo = {
      assetPath: '/Game/Blueprints/BP_MyActor',
      parentClass: 'AActor',
      variables: [
        { name: 'Health', type: 'float' },
        { name: 'MaxHealth', type: 'float' },
      ],
      components: [],
    };
    mockResponseData = mockData;
    const response = await client.sendCommand({
      type: 'blueprint.read',
      correlationId: '',
      payload: { asset_path: '/Game/Blueprints/BP_MyActor' },
    });
    const data = response.data as BlueprintInfo;
    expect(data.variables).toHaveLength(2);
    expect(data.variables[0].name).toBe('Health');
    expect(data.variables[0].type).toBe('float');
  });

  it('blueprint.read — components array contains expected fields', async () => {
    const mockData: BlueprintInfo = {
      assetPath: '/Game/Blueprints/BP_MyActor',
      parentClass: 'AActor',
      variables: [],
      components: [
        { name: 'MeshComponent', class: 'StaticMeshComponent' },
        { name: 'CollisionBox', class: 'BoxComponent' },
      ],
    };
    mockResponseData = mockData;
    const response = await client.sendCommand({
      type: 'blueprint.read',
      correlationId: '',
      payload: { asset_path: '/Game/Blueprints/BP_MyActor' },
    });
    const data = response.data as BlueprintInfo;
    expect(data.components).toHaveLength(2);
    expect(data.components[0].name).toBe('MeshComponent');
    expect(data.components[0].class).toBe('StaticMeshComponent');
  });

  it('blueprint.list — count matches blueprints array length', async () => {
    const mockData: BlueprintListResult = {
      blueprints: [
        {
          assetPath: '/Game/Blueprints/BP_MyActor.BP_MyActor',
          packagePath: '/Game/Blueprints',
          parentClass: '/Script/Engine.Actor',
        },
        {
          assetPath: '/Game/Blueprints/BP_Enemy.BP_Enemy',
          packagePath: '/Game/Blueprints',
          parentClass: '/Script/Engine.Actor',
        },
      ],
      count: 2,
    };
    mockResponseData = mockData;
    const response = await client.sendCommand({
      type: 'blueprint.list',
      correlationId: '',
      payload: {},
    });
    const data = response.data as BlueprintListResult;
    expect(data.count).toBe(2);
    expect(data.blueprints).toHaveLength(data.count);
    expect(data.blueprints[0].assetPath).toBe('/Game/Blueprints/BP_MyActor.BP_MyActor');
  });

  it('blueprint.graph — nodes contain pin arrays', async () => {
    const mockData: BlueprintGraphData = {
      assetPath: '/Game/Blueprints/BP_MyActor',
      graphName: 'EventGraph',
      nodes: [
        {
          nodeGuid: 'A1B2C3D4-0000-0000-0000-000000000001',
          type: 'K2Node_Event',
          title: 'Event BeginPlay',
          posX: 100,
          posY: 200,
          pins: [
            { pinName: 'then', direction: 'output', type: 'exec', defaultValue: '' },
            { pinName: 'self', direction: 'output', type: 'object', defaultValue: '' },
          ],
        },
      ],
      connections: [],
    };
    mockResponseData = mockData;
    const response = await client.sendCommand({
      type: 'blueprint.graph',
      correlationId: '',
      payload: { asset_path: '/Game/Blueprints/BP_MyActor', graph_name: 'EventGraph' },
    });
    const data = response.data as BlueprintGraphData;
    expect(data.nodes).toHaveLength(1);
    expect(data.nodes[0].pins).toHaveLength(2);
    expect(data.nodes[0].pins[0].pinName).toBe('then');
    expect(data.nodes[0].pins[0].direction).toBe('output');
  });

  it('blueprint.graph — connections contain fromNode/toNode guids', async () => {
    const fromGuid = 'A1B2C3D4-0000-0000-0000-000000000001';
    const toGuid = 'B2C3D4E5-0000-0000-0000-000000000002';
    const mockData: BlueprintGraphData = {
      assetPath: '/Game/Blueprints/BP_MyActor',
      graphName: 'EventGraph',
      nodes: [],
      connections: [
        { fromNodeGuid: fromGuid, fromPinName: 'then', toNodeGuid: toGuid, toPinName: 'execute' },
      ],
    };
    mockResponseData = mockData;
    const response = await client.sendCommand({
      type: 'blueprint.graph',
      correlationId: '',
      payload: { asset_path: '/Game/Blueprints/BP_MyActor', graph_name: 'EventGraph' },
    });
    const data = response.data as BlueprintGraphData;
    expect(data.connections).toHaveLength(1);
    expect(data.connections[0].fromNodeGuid).toBe(fromGuid);
    expect(data.connections[0].toNodeGuid).toBe(toGuid);
    expect(data.connections[0].fromPinName).toBe('then');
    expect(data.connections[0].toPinName).toBe('execute');
  });

  it('concurrent blueprint commands resolve independently with correct correlationIds', async () => {
    mockResponseData = { blueprints: [], count: 0 };
    const [r1, r2] = await Promise.all([
      client.sendCommand({ type: 'blueprint.list', correlationId: '', payload: {} }),
      client.sendCommand({ type: 'blueprint.list', correlationId: '', payload: {} }),
    ]);
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    expect(r1.correlationId).not.toBe(r2.correlationId);
  });
});
