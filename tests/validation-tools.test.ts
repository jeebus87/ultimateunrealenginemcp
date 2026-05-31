// tests/validation-tools.test.ts
// Integration tests for all four validation tool handlers (VAL-01 through VAL-04).
// Uses injected mock PluginBridgeClient for disconnected and error-response tests
// (Groups 1–8), and a mock TCP server on port 55564 for round-trip command tests
// (Group 9).
//
// Port assignments:
//   55557 — real UE Editor plugin (not running in tests)
//   55560 — plugin-bridge.test.ts mock server
//   55561 — blueprint-tools.test.ts mock server
//   55562 — bridge-cpp-tools.test.ts mock server
//   55563 — blueprint-write-tools.test.ts mock server
//   55564 — this file's mock server (no conflict)

import * as net from 'net';
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import {
  handleValidateAsset,
  handleValidateFolder,
  handleValidateProject,
  handleCheckBlueprint,
} from '../src/tools/validation/index.js';
import { PluginBridgeClient, PluginNotConnectedError } from '../src/plugin-bridge/client.js';
import type {
  ValidationAssetResult,
  ValidationFolderResult,
  ValidationProjectResult,
  BlueprintCompileResult,
} from '../src/tools/validation/types.js';

// ---------------------------------------------------------------------------
// makeMockBridge helper
// Creates a lightweight in-process mock of PluginBridgeClient for disconnected
// and error-response tests (Groups 1–8). This avoids any TCP overhead.
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
// Group 1 — handleValidateAsset disconnected (VAL-01)
// ---------------------------------------------------------------------------

describe('Group 1: handleValidateAsset — plugin disconnected (VAL-01)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns isError:true when bridge throws PluginNotConnectedError', async () => {
    const bridge = makeMockBridge({ throwDisconnect: true });
    const result = await handleValidateAsset({ asset_path: '/Game/BP_Test' }, bridge);
    expect(result.isError).toBe(true);
  });

  it('returns plugin_not_connected JSON with required_plugin:true in content[0].text', async () => {
    const bridge = makeMockBridge({ throwDisconnect: true });
    const result = await handleValidateAsset({ asset_path: '/Game/BP_Test' }, bridge);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('plugin_not_connected');
    expect(parsed.required_plugin).toBe(true);
  });

  it('content[0].type is "text" on disconnected path', async () => {
    const bridge = makeMockBridge({ throwDisconnect: true });
    const result = await handleValidateAsset({ asset_path: '/Game/BP_Test' }, bridge);
    expect(result.content[0].type).toBe('text');
  });
});

// ---------------------------------------------------------------------------
// Group 2 — handleValidateAsset error responses (VAL-01)
// ---------------------------------------------------------------------------

describe('Group 2: handleValidateAsset — plugin error responses (VAL-01)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns isError:true when plugin responds with asset_not_found', async () => {
    const bridge = makeMockBridge({
      responseSuccess: false,
      responseError: 'asset_not_found',
    });
    const result = await handleValidateAsset({ asset_path: '/Game/Missing' }, bridge);
    expect(result.isError).toBe(true);
  });

  it('error text contains the error code when plugin responds with asset_not_found', async () => {
    const bridge = makeMockBridge({
      responseSuccess: false,
      responseError: 'asset_not_found',
    });
    const result = await handleValidateAsset({ asset_path: '/Game/Missing' }, bridge);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('asset_not_found');
  });

  it('returns isError:true when plugin responds with invalid_asset_path', async () => {
    const bridge = makeMockBridge({
      responseSuccess: false,
      responseError: 'invalid_asset_path',
    });
    const result = await handleValidateAsset({ asset_path: 'bad-path' }, bridge);
    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Group 3 — handleValidateAsset success path (VAL-01)
// ---------------------------------------------------------------------------

describe('Group 3: handleValidateAsset — success path (VAL-01)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('isError is undefined on success (not false)', async () => {
    const bridge = makeMockBridge({
      responseData: {
        assetPath: '/Game/BP_Test',
        valid: true,
        numErrors: 0,
        numWarnings: 0,
      } satisfies ValidationAssetResult,
    });
    const result = await handleValidateAsset({ asset_path: '/Game/BP_Test' }, bridge);
    expect(result.isError).toBeUndefined();
  });

  it('content[0].text is valid JSON with assetPath, valid, numErrors, numWarnings', async () => {
    const mockData: ValidationAssetResult = {
      assetPath: '/Game/BP_Test',
      valid: true,
      numErrors: 0,
      numWarnings: 2,
    };
    const bridge = makeMockBridge({ responseData: mockData });
    const result = await handleValidateAsset({ asset_path: '/Game/BP_Test' }, bridge);
    const parsed = JSON.parse(result.content[0].text) as ValidationAssetResult;
    expect(parsed.assetPath).toBe('/Game/BP_Test');
    expect(parsed.valid).toBe(true);
    expect(parsed.numErrors).toBe(0);
    expect(parsed.numWarnings).toBe(2);
  });

  it('valid is true when numErrors is 0', async () => {
    const bridge = makeMockBridge({
      responseData: {
        assetPath: '/Game/BP_Clean',
        valid: true,
        numErrors: 0,
        numWarnings: 0,
      } satisfies ValidationAssetResult,
    });
    const result = await handleValidateAsset({ asset_path: '/Game/BP_Clean' }, bridge);
    const parsed = JSON.parse(result.content[0].text) as ValidationAssetResult;
    expect(parsed.valid).toBe(true);
  });

  it('content array has exactly one item on success', async () => {
    const bridge = makeMockBridge({
      responseData: {
        assetPath: '/Game/BP_Test',
        valid: false,
        numErrors: 3,
        numWarnings: 1,
      } satisfies ValidationAssetResult,
    });
    const result = await handleValidateAsset({ asset_path: '/Game/BP_Test' }, bridge);
    expect(result.content).toHaveLength(1);
  });

  it('content[0].type is "text" on success', async () => {
    const bridge = makeMockBridge({
      responseData: {
        assetPath: '/Game/BP_Test',
        valid: true,
        numErrors: 0,
        numWarnings: 0,
      } satisfies ValidationAssetResult,
    });
    const result = await handleValidateAsset({ asset_path: '/Game/BP_Test' }, bridge);
    expect(result.content[0].type).toBe('text');
  });
});

// ---------------------------------------------------------------------------
// Group 4 — handleValidateFolder (VAL-02)
// ---------------------------------------------------------------------------

describe('Group 4: handleValidateFolder — disconnected and success (VAL-02)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns isError:true with plugin_not_connected when bridge throws', async () => {
    const bridge = makeMockBridge({ throwDisconnect: true });
    const result = await handleValidateFolder({ folder_path: '/Game/Blueprints' }, bridge);
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('plugin_not_connected');
  });

  it('returns folderPath, numAssets, numValid, numInvalid, numWarnings on success', async () => {
    const mockData: ValidationFolderResult = {
      folderPath: '/Game/Blueprints',
      numAssets: 10,
      numValid: 8,
      numInvalid: 2,
      numWarnings: 5,
    };
    const bridge = makeMockBridge({ responseData: mockData });
    const result = await handleValidateFolder({ folder_path: '/Game/Blueprints' }, bridge);
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text) as ValidationFolderResult;
    expect(parsed.folderPath).toBe('/Game/Blueprints');
    expect(parsed.numAssets).toBe(10);
    expect(parsed.numValid).toBe(8);
    expect(parsed.numInvalid).toBe(2);
    expect(parsed.numWarnings).toBe(5);
  });

  it('empty folder_path with error bridge response returns isError:true (does not crash)', async () => {
    const bridge = makeMockBridge({
      responseSuccess: false,
      responseError: 'folder_not_found',
    });
    const result = await handleValidateFolder({ folder_path: '' }, bridge);
    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Group 5 — handleValidateProject (VAL-03)
// ---------------------------------------------------------------------------

describe('Group 5: handleValidateProject — disconnected and success (VAL-03)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns isError:true when bridge throws PluginNotConnectedError', async () => {
    const bridge = makeMockBridge({ throwDisconnect: true });
    const result = await handleValidateProject({} as Record<string, never>, bridge);
    expect(result.isError).toBe(true);
  });

  it('returns numRequested, numValid, numInvalid, numWarnings, numUnableToValidate on success', async () => {
    const mockData: ValidationProjectResult = {
      numRequested: 100,
      numValid: 90,
      numInvalid: 7,
      numWarnings: 20,
      numUnableToValidate: 3,
    };
    const bridge = makeMockBridge({ responseData: mockData });
    const result = await handleValidateProject({} as Record<string, never>, bridge);
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text) as ValidationProjectResult;
    expect(parsed.numRequested).toBe(100);
    expect(parsed.numValid).toBe(90);
    expect(parsed.numInvalid).toBe(7);
    expect(parsed.numWarnings).toBe(20);
    expect(parsed.numUnableToValidate).toBe(3);
  });

  it('called with empty object does not throw', async () => {
    const bridge = makeMockBridge({
      responseData: {
        numRequested: 0,
        numValid: 0,
        numInvalid: 0,
        numWarnings: 0,
        numUnableToValidate: 0,
      } satisfies ValidationProjectResult,
    });
    await expect(
      handleValidateProject({} as Record<string, never>, bridge)
    ).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Group 6 — handleCheckBlueprint disconnected (VAL-04)
// ---------------------------------------------------------------------------

describe('Group 6: handleCheckBlueprint — plugin disconnected (VAL-04)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns isError:true when bridge throws PluginNotConnectedError', async () => {
    const bridge = makeMockBridge({ throwDisconnect: true });
    const result = await handleCheckBlueprint({ asset_path: '/Game/BP_Test' }, bridge);
    expect(result.isError).toBe(true);
  });

  it('plugin_not_connected error JSON has required_plugin:true', async () => {
    const bridge = makeMockBridge({ throwDisconnect: true });
    const result = await handleCheckBlueprint({ asset_path: '/Game/BP_Test' }, bridge);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('plugin_not_connected');
    expect(parsed.required_plugin).toBe(true);
  });

  it('returns isError:true when plugin responds with asset_not_found', async () => {
    const bridge = makeMockBridge({
      responseSuccess: false,
      responseError: 'asset_not_found',
    });
    const result = await handleCheckBlueprint({ asset_path: '/Game/Missing_BP' }, bridge);
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('asset_not_found');
  });
});

// ---------------------------------------------------------------------------
// Group 7 — handleCheckBlueprint success paths (VAL-04)
// ---------------------------------------------------------------------------

describe('Group 7: handleCheckBlueprint — success paths (VAL-04)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('compiled:true, status:"up_to_date", errorMessage:"" on clean compile', async () => {
    const mockData: BlueprintCompileResult = {
      assetPath: '/Game/BP_Clean',
      compiled: true,
      status: 'up_to_date',
      errorMessage: '',
    };
    const bridge = makeMockBridge({ responseData: mockData });
    const result = await handleCheckBlueprint({ asset_path: '/Game/BP_Clean' }, bridge);
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text) as BlueprintCompileResult;
    expect(parsed.compiled).toBe(true);
    expect(parsed.status).toBe('up_to_date');
    expect(parsed.errorMessage).toBe('');
  });

  it('compiled:false, status:"error", non-empty errorMessage on compile failure', async () => {
    const mockData: BlueprintCompileResult = {
      assetPath: '/Game/BP_Broken',
      compiled: false,
      status: 'error',
      errorMessage: 'Unresolved pin reference on node PrintString',
    };
    const bridge = makeMockBridge({ responseData: mockData });
    const result = await handleCheckBlueprint({ asset_path: '/Game/BP_Broken' }, bridge);
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text) as BlueprintCompileResult;
    expect(parsed.compiled).toBe(false);
    expect(parsed.status).toBe('error');
    expect(parsed.errorMessage.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Group 8 — sendCommand payload verification (all four handlers)
// ---------------------------------------------------------------------------

describe('Group 8: sendCommand payload verification — command type strings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('handleValidateAsset calls sendCommand with type "validate.asset"', async () => {
    const bridge = makeMockBridge({
      responseData: {
        assetPath: '/Game/BP_Test',
        valid: true,
        numErrors: 0,
        numWarnings: 0,
      } satisfies ValidationAssetResult,
    });
    await handleValidateAsset({ asset_path: '/Game/BP_Test' }, bridge);
    expect(bridge.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'validate.asset' })
    );
  });

  it('handleValidateAsset sends payload.asset_path matching the input', async () => {
    const bridge = makeMockBridge({
      responseData: {
        assetPath: '/Game/BP_Payload',
        valid: true,
        numErrors: 0,
        numWarnings: 0,
      } satisfies ValidationAssetResult,
    });
    await handleValidateAsset({ asset_path: '/Game/BP_Payload' }, bridge);
    expect(bridge.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'validate.asset',
        payload: expect.objectContaining({ asset_path: '/Game/BP_Payload' }),
      })
    );
  });

  it('handleValidateFolder calls sendCommand with type "validate.folder"', async () => {
    const bridge = makeMockBridge({
      responseData: {
        folderPath: '/Game/Blueprints',
        numAssets: 5,
        numValid: 5,
        numInvalid: 0,
        numWarnings: 0,
      } satisfies ValidationFolderResult,
    });
    await handleValidateFolder({ folder_path: '/Game/Blueprints' }, bridge);
    expect(bridge.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'validate.folder' })
    );
  });

  it('handleValidateProject calls sendCommand with type "validate.project"', async () => {
    const bridge = makeMockBridge({
      responseData: {
        numRequested: 10,
        numValid: 10,
        numInvalid: 0,
        numWarnings: 0,
        numUnableToValidate: 0,
      } satisfies ValidationProjectResult,
    });
    await handleValidateProject({} as Record<string, never>, bridge);
    expect(bridge.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'validate.project' })
    );
  });

  it('handleCheckBlueprint calls sendCommand with type "validate.blueprint"', async () => {
    const bridge = makeMockBridge({
      responseData: {
        assetPath: '/Game/BP_Test',
        compiled: true,
        status: 'up_to_date',
        errorMessage: '',
      } satisfies BlueprintCompileResult,
    });
    await handleCheckBlueprint({ asset_path: '/Game/BP_Test' }, bridge);
    expect(bridge.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'validate.blueprint' })
    );
  });
});

// ---------------------------------------------------------------------------
// Group 9 — Mock TCP server round-trip tests (port 55564)
// A PluginBridgeClient connects to the mock server on port 55564.
// This exercises the full JSON-newline framing and correlationId round-trip path.
// ---------------------------------------------------------------------------

describe('Group 9: Mock TCP server — validation round-trip on port 55564', () => {
  const TEST_PORT = 55564;
  let server: net.Server;
  let client: PluginBridgeClient;

  // Configurable mock response data for the next request
  let mockResponseData: unknown = null;
  let mockResponseSuccess = true;
  let mockResponseError: string | undefined = undefined;

  beforeAll(async () => {
    // Start mock TCP server
    server = net.createServer((socket) => {
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
            const response = mockResponseSuccess
              ? { success: true, correlationId: cmd.correlationId, data: mockResponseData }
              : { success: false, correlationId: cmd.correlationId, error: mockResponseError ?? 'plugin_error' };
            socket.write(JSON.stringify(response) + '\n', 'utf8');
          } catch {
            // ignore malformed JSON
          }
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(TEST_PORT, '127.0.0.1', resolve));

    // Connect test client to mock server
    client = new PluginBridgeClient(TEST_PORT);

    // Wait for client to connect (poll with timeout)
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
    mockResponseData = null;
    mockResponseSuccess = true;
    mockResponseError = undefined;
  });

  it('handleValidateAsset round-trip — sends validate.asset and receives non-error result', async () => {
    const assetResult: ValidationAssetResult = {
      assetPath: '/Game/Test',
      valid: true,
      numErrors: 0,
      numWarnings: 0,
    };
    mockResponseData = assetResult;
    const result = await handleValidateAsset({ asset_path: '/Game/Test' }, client);
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text) as ValidationAssetResult;
    expect(parsed.assetPath).toBe('/Game/Test');
    expect(parsed.valid).toBe(true);
    expect(parsed.numErrors).toBe(0);
  });

  it('handleCheckBlueprint round-trip — sends validate.blueprint and receives BlueprintCompileResult', async () => {
    const bpResult: BlueprintCompileResult = {
      assetPath: '/Game/BP_Test',
      compiled: true,
      status: 'up_to_date',
      errorMessage: '',
    };
    mockResponseData = bpResult;
    const result = await handleCheckBlueprint({ asset_path: '/Game/BP_Test' }, client);
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text) as BlueprintCompileResult;
    expect(parsed.assetPath).toBe('/Game/BP_Test');
    expect(parsed.compiled).toBe(true);
    expect(parsed.status).toBe('up_to_date');
    expect(parsed.errorMessage).toBe('');
  });

  it('plugin error response — success:false with asset_not_found surfaced as isError:true', async () => {
    mockResponseSuccess = false;
    mockResponseError = 'asset_not_found';
    const result = await handleValidateAsset({ asset_path: '/Game/Missing' }, client);
    expect(result.isError).toBe(true);
  });
});
