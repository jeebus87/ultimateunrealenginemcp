// tests/bridge-cpp-tools.test.ts
// Integration tests for Blueprint-C++ bridge tool handlers (BPC-01, BPC-02, BPC-03).
//
// Port assignments:
//   55562 — this file's mock server (no conflict with blueprint-tools.test.ts on 55561)
//
// Test strategy:
//   - handleCppExposedMembers: reads from a real fixture file (tests/fixtures/BPExposed.h)
//     — no fs mocking needed, pure parser logic exercised end-to-end.
//   - handleFindBlueprintSubclasses / handleTraceCppInBlueprints: disconnected-state tests
//     use the module-level bridge (port 55557, nothing listening in CI).
//   - Mock TCP server tests: a dedicated PluginBridgeClient on port 55562 exercises
//     the full command/response round-trip for both plugin commands.

import * as net from 'net';
import * as path from 'path';
import { handleCppExposedMembers, handleFindBlueprintSubclasses, handleTraceCppInBlueprints } from '../src/tools/blueprint/index.js';
import { PluginBridgeClient } from '../src/plugin-bridge/client.js';
import type { CppExposedMember, BlueprintSubclassResult, CppUsageResult } from '../src/tools/blueprint/types.js';

// Absolute path to the fixture file — within PROJECT_ROOT so validatePath accepts it.
const FIXTURE_PATH = path.resolve(process.cwd(), 'tests', 'fixtures', 'BPExposed.h');

// ---------------------------------------------------------------------------
// Group 1: handleCppExposedMembers — UPROPERTY filtering
// ---------------------------------------------------------------------------

describe('handleCppExposedMembers — UPROPERTY filtering', () => {
  let members: CppExposedMember[];

  beforeAll(async () => {
    const result = await handleCppExposedMembers({ file_path: FIXTURE_PATH });
    expect(result.isError).toBeUndefined();
    members = JSON.parse(result.content[0]!.text) as CppExposedMember[];
  });

  it('returns BlueprintReadWrite property Health with kind=property', () => {
    const health = members.find(m => m.name === 'Health');
    expect(health).toBeDefined();
    expect(health!.kind).toBe('property');
  });

  it('returns BlueprintReadOnly property Level with kind=property', () => {
    const level = members.find(m => m.name === 'Level');
    expect(level).toBeDefined();
    expect(level!.kind).toBe('property');
  });

  it('does not include InternalValue (no Blueprint specifier)', () => {
    const internalValue = members.find(m => m.name === 'InternalValue');
    expect(internalValue).toBeUndefined();
  });

  it('blueprintSpecifiers array for Health contains only BlueprintReadWrite', () => {
    const health = members.find(m => m.name === 'Health');
    expect(health).toBeDefined();
    expect(health!.blueprintSpecifiers).toEqual(['BlueprintReadWrite']);
  });
});

// ---------------------------------------------------------------------------
// Group 2: handleCppExposedMembers — UFUNCTION filtering
// ---------------------------------------------------------------------------

describe('handleCppExposedMembers — UFUNCTION filtering', () => {
  let members: CppExposedMember[];

  beforeAll(async () => {
    const result = await handleCppExposedMembers({ file_path: FIXTURE_PATH });
    expect(result.isError).toBeUndefined();
    members = JSON.parse(result.content[0]!.text) as CppExposedMember[];
  });

  it('returns BlueprintCallable function Attack with kind=function', () => {
    const attack = members.find(m => m.name === 'Attack');
    expect(attack).toBeDefined();
    expect(attack!.kind).toBe('function');
  });

  it('returns BlueprintPure function GetHealthPercent with kind=function', () => {
    const fn = members.find(m => m.name === 'GetHealthPercent');
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe('function');
  });

  it('returns BlueprintImplementableEvent function OnDamageTaken', () => {
    const fn = members.find(m => m.name === 'OnDamageTaken');
    expect(fn).toBeDefined();
    expect(fn!.blueprintSpecifiers).toContain('BlueprintImplementableEvent');
  });

  it('does not include InternalOnly (no Blueprint specifier)', () => {
    const fn = members.find(m => m.name === 'InternalOnly');
    expect(fn).toBeUndefined();
  });

  it('each result has name, specifiers, blueprintSpecifiers, line fields', () => {
    for (const member of members) {
      expect(typeof member.name).toBe('string');
      expect(Array.isArray(member.specifiers)).toBe(true);
      expect(Array.isArray(member.blueprintSpecifiers)).toBe(true);
      expect(typeof member.line).toBe('number');
    }
  });
});

// ---------------------------------------------------------------------------
// Group 3: handleCppExposedMembers — member counts and error cases
// ---------------------------------------------------------------------------

describe('handleCppExposedMembers — member counts and error cases', () => {
  it('returns exactly 5 Blueprint-exposed members from BPExposed.h fixture', async () => {
    const result = await handleCppExposedMembers({ file_path: FIXTURE_PATH });
    expect(result.isError).toBeUndefined();
    const members = JSON.parse(result.content[0]!.text) as CppExposedMember[];
    // Expect: Health, Level, Attack, GetHealthPercent, OnDamageTaken
    expect(members).toHaveLength(5);
  });

  it('ANoExposures hidden members do not appear in results', async () => {
    const result = await handleCppExposedMembers({ file_path: FIXTURE_PATH });
    expect(result.isError).toBeUndefined();
    const members = JSON.parse(result.content[0]!.text) as CppExposedMember[];
    const hiddenProp = members.find(m => m.name === 'HiddenProp');
    const hiddenFunc = members.find(m => m.name === 'HiddenFunc');
    expect(hiddenProp).toBeUndefined();
    expect(hiddenFunc).toBeUndefined();
  });

  it('returnType is present for functions and undefined for properties', async () => {
    const result = await handleCppExposedMembers({ file_path: FIXTURE_PATH });
    const members = JSON.parse(result.content[0]!.text) as CppExposedMember[];
    for (const member of members) {
      if (member.kind === 'function') {
        expect(member.returnType).toBeDefined();
        expect(typeof member.returnType).toBe('string');
      } else {
        // Properties use 'type' field, not returnType
        expect(member.type).toBeDefined();
      }
    }
  });

  it('returns isError:true when file_path is outside PROJECT_ROOT (path traversal rejection)', async () => {
    const result = await handleCppExposedMembers({ file_path: '../../../../etc/passwd' });
    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Group 4: handleFindBlueprintSubclasses — plugin disconnected
// ---------------------------------------------------------------------------

describe('handleFindBlueprintSubclasses — plugin disconnected', () => {
  it('returns isError:true when plugin is not connected', async () => {
    const result = await handleFindBlueprintSubclasses({ class_name: 'AMyActor' });
    expect(result.isError).toBe(true);
  });

  it('returns plugin_not_connected error JSON when disconnected', async () => {
    const result = await handleFindBlueprintSubclasses({ class_name: 'AMyActor' });
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.error).toBe('plugin_not_connected');
  });

  it('required_plugin is true in the error response', async () => {
    const result = await handleFindBlueprintSubclasses({ class_name: 'AMyActor' });
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.required_plugin).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Group 5: Mock TCP server — blueprint.subclasses and blueprint.cppUsage commands
// ---------------------------------------------------------------------------

describe('Mock TCP server — blueprint.subclasses and blueprint.cppUsage commands', () => {
  const TEST_PORT = 55562;
  let server: net.Server;
  let client: PluginBridgeClient;

  // Captured command from the mock server socket handler
  let capturedCmd: { type: string; correlationId: string; payload?: unknown } | null = null;
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

    // Wait for client to connect (backoff starts at 1s — poll isConnected())
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

  // ---- blueprint.subclasses ----

  it('sends blueprint.subclasses command type', async () => {
    mockResponseData = { className: 'AMyActor', subclasses: [], count: 0 };
    await client.sendCommand({
      type: 'blueprint.subclasses',
      correlationId: '',
      payload: { class_name: 'AMyActor' },
    });
    expect(capturedCmd?.type).toBe('blueprint.subclasses');
  });

  it('forwards class_name in blueprint.subclasses payload', async () => {
    mockResponseData = { className: 'AMyActor', subclasses: [], count: 0 };
    await client.sendCommand({
      type: 'blueprint.subclasses',
      correlationId: '',
      payload: { class_name: 'AMyActor' },
    });
    expect((capturedCmd?.payload as { class_name?: string })?.class_name).toBe('AMyActor');
  });

  it('parses BlueprintSubclassResult response: className matches', async () => {
    const mockData: BlueprintSubclassResult = {
      className: 'AMyActor',
      subclasses: [
        { assetPath: '/Game/Blueprints/BP_Child', packagePath: '/Game/Blueprints', parentClassTag: '/Script/MyGame.AMyActor' },
      ],
      count: 1,
    };
    mockResponseData = mockData;
    const response = await client.sendCommand({
      type: 'blueprint.subclasses',
      correlationId: '',
      payload: { class_name: 'AMyActor' },
    });
    const data = response.data as BlueprintSubclassResult;
    expect(data.className).toBe('AMyActor');
  });

  it('parses BlueprintSubclassResult response: subclasses is an array', async () => {
    const mockData: BlueprintSubclassResult = {
      className: 'ABaseEnemy',
      subclasses: [
        { assetPath: '/Game/Blueprints/BP_Goblin', packagePath: '/Game/Blueprints', parentClassTag: '/Script/MyGame.ABaseEnemy' },
        { assetPath: '/Game/Blueprints/BP_Orc', packagePath: '/Game/Blueprints', parentClassTag: '/Script/MyGame.ABaseEnemy' },
      ],
      count: 2,
    };
    mockResponseData = mockData;
    const response = await client.sendCommand({
      type: 'blueprint.subclasses',
      correlationId: '',
      payload: { class_name: 'ABaseEnemy' },
    });
    const data = response.data as BlueprintSubclassResult;
    expect(Array.isArray(data.subclasses)).toBe(true);
    expect(data.subclasses).toHaveLength(2);
  });

  it('blueprint.subclasses — count field equals subclasses array length', async () => {
    const mockData: BlueprintSubclassResult = {
      className: 'AMyActor',
      subclasses: [
        { assetPath: '/Game/BP_A', packagePath: '/Game', parentClassTag: '/Script/MyGame.AMyActor' },
        { assetPath: '/Game/BP_B', packagePath: '/Game', parentClassTag: '/Script/MyGame.AMyActor' },
        { assetPath: '/Game/BP_C', packagePath: '/Game', parentClassTag: '/Script/MyGame.AMyActor' },
      ],
      count: 3,
    };
    mockResponseData = mockData;
    const response = await client.sendCommand({
      type: 'blueprint.subclasses',
      correlationId: '',
      payload: { class_name: 'AMyActor' },
    });
    const data = response.data as BlueprintSubclassResult;
    expect(data.count).toBe(data.subclasses.length);
  });

  it('handles success:false from plugin — resolves with success=false (not thrown)', async () => {
    mockResponseSuccess = false;
    mockResponseError = 'class_not_found';
    const response = await client.sendCommand({
      type: 'blueprint.subclasses',
      correlationId: '',
      payload: { class_name: 'AMissingClass' },
    });
    expect(response.success).toBe(false);
    expect(response.error).toBe('class_not_found');
  });

  // ---- blueprint.cppUsage ----

  it('sends blueprint.cppUsage command type', async () => {
    mockResponseData = { className: 'AMyActor', memberName: 'Attack', usages: [], count: 0 };
    await client.sendCommand({
      type: 'blueprint.cppUsage',
      correlationId: '',
      payload: { class_name: 'AMyActor', member_name: 'Attack' },
    });
    expect(capturedCmd?.type).toBe('blueprint.cppUsage');
  });

  it('forwards class_name and member_name in blueprint.cppUsage payload', async () => {
    mockResponseData = { className: 'AMyActor', memberName: 'Health', usages: [], count: 0 };
    await client.sendCommand({
      type: 'blueprint.cppUsage',
      correlationId: '',
      payload: { class_name: 'AMyActor', member_name: 'Health' },
    });
    const payload = capturedCmd?.payload as { class_name?: string; member_name?: string };
    expect(payload?.class_name).toBe('AMyActor');
    expect(payload?.member_name).toBe('Health');
  });

  it('parses CppUsageResult: usages array and count present', async () => {
    const mockData: CppUsageResult = {
      className: 'AMyActor',
      memberName: 'Attack',
      usages: [
        { assetPath: '/Game/Blueprints/BP_Player', graphName: 'EventGraph', nodeType: 'K2Node_CallFunction', nodeTitle: 'Attack' },
      ],
      count: 1,
    };
    mockResponseData = mockData;
    const response = await client.sendCommand({
      type: 'blueprint.cppUsage',
      correlationId: '',
      payload: { class_name: 'AMyActor', member_name: 'Attack' },
    });
    const data = response.data as CppUsageResult;
    expect(Array.isArray(data.usages)).toBe(true);
    expect(typeof data.count).toBe('number');
  });

  it('blueprint.cppUsage — usages entries have all required fields (assetPath, graphName, nodeType, nodeTitle)', async () => {
    const mockData: CppUsageResult = {
      className: 'AMyActor',
      memberName: 'Attack',
      usages: [
        { assetPath: '/Game/Blueprints/BP_Player', graphName: 'EventGraph', nodeType: 'K2Node_CallFunction', nodeTitle: 'Attack' },
        { assetPath: '/Game/Blueprints/BP_Enemy', graphName: 'OnBattle', nodeType: 'K2Node_CallFunction', nodeTitle: 'Attack' },
      ],
      count: 2,
    };
    mockResponseData = mockData;
    const response = await client.sendCommand({
      type: 'blueprint.cppUsage',
      correlationId: '',
      payload: { class_name: 'AMyActor', member_name: 'Attack' },
    });
    const data = response.data as CppUsageResult;
    for (const entry of data.usages) {
      expect(typeof entry.assetPath).toBe('string');
      expect(typeof entry.graphName).toBe('string');
      expect(typeof entry.nodeType).toBe('string');
      expect(typeof entry.nodeTitle).toBe('string');
    }
  });

  it('concurrent blueprint.subclasses and blueprint.cppUsage commands resolve independently', async () => {
    mockResponseData = { className: 'AMyActor', subclasses: [], count: 0 };
    const [r1, r2] = await Promise.all([
      client.sendCommand({ type: 'blueprint.subclasses', correlationId: '', payload: { class_name: 'AMyActor' } }),
      client.sendCommand({ type: 'blueprint.cppUsage', correlationId: '', payload: { class_name: 'AMyActor', member_name: 'Health' } }),
    ]);
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    expect(r1.correlationId).not.toBe(r2.correlationId);
  });
});

// ---------------------------------------------------------------------------
// Group 6: handleTraceCppInBlueprints — plugin disconnected
// ---------------------------------------------------------------------------

describe('handleTraceCppInBlueprints — plugin disconnected', () => {
  it('returns isError:true when plugin is not connected', async () => {
    const result = await handleTraceCppInBlueprints({ class_name: 'AMyActor', member_name: 'Attack' });
    expect(result.isError).toBe(true);
  });

  it('returns plugin_not_connected error JSON when disconnected', async () => {
    const result = await handleTraceCppInBlueprints({ class_name: 'AMyActor', member_name: 'Attack' });
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.error).toBe('plugin_not_connected');
    expect(parsed.required_plugin).toBe(true);
  });
});
