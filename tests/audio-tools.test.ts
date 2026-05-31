// tests/audio-tools.test.ts
// Integration tests for Phase 23 audio MCP tools (AUD-01 through AUD-04).
// Uses injected mock PluginBridgeClient — no TCP server needed; handlers accept an
// injected bridge parameter via their exported function signatures.
//
// Requirements covered: AUD-01 (ue_list_sound_assets), AUD-02 (ue_inspect_metasound),
//   AUD-03 (ue_inspect_sound_cue), AUD-04 (ue_query_audio_insights)
//
// Port assignment comment: port 55571 is reserved for this file if a TCP mock server
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
//   55567 — ai-systems-tools.test.ts (reserved)
//   55568 — reserved
//   55569 — reserved
//   55570 — reserved
//   55571 — reserved for this file (not currently used)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PluginBridgeClient, PluginNotConnectedError } from '../src/plugin-bridge/client.js';
import {
  handleListSoundAssets,
  handleInspectMetasound,
  handleInspectSoundCue,
  handleQueryAudioInsights,
  registerAudioTools,
} from '../src/tools/audio/index.js';
import type {
  SoundAssetListResult,
  MetaSoundInspectResult,
  SoundCueInspectResult,
  AudioInsightsResult,
} from '../src/tools/audio/types.js';

// ---------------------------------------------------------------------------
// Suppress unused-import warnings for type-only imports
// ---------------------------------------------------------------------------
type _UnusedImports =
  | SoundAssetListResult
  | MetaSoundInspectResult
  | SoundCueInspectResult
  | AudioInsightsResult;

// ---------------------------------------------------------------------------
// Hoist known-issues mock to prevent store.ts from touching the filesystem
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
// Realistic mock response data constants (per plan specification)
// ---------------------------------------------------------------------------

const SOUND_LIST_DATA: SoundAssetListResult = {
  assets: [
    {
      asset_path: '/Game/Audio/SFX_Explosion',
      asset_name: 'SFX_Explosion',
      asset_type: 'SoundWave',
      duration: 2.5,
      sample_rate: 48000,
      num_channels: 2,
      compression_name: 'OGG',
    },
    {
      asset_path: '/Game/Audio/SC_Footstep',
      asset_name: 'SC_Footstep',
      asset_type: 'SoundCue',
      duration: 0,
      sample_rate: 0,
      num_channels: 0,
      compression_name: 'Unknown',
    },
    {
      asset_path: '/Game/Audio/MS_Ambience',
      asset_name: 'MS_Ambience',
      asset_type: 'MetaSound',
      duration: 0,
      sample_rate: 0,
      num_channels: 0,
      compression_name: 'Unknown',
    },
  ],
  count: 3,
};

const METASOUND_INSPECT_DATA: MetaSoundInspectResult = {
  asset_path: '/Game/Audio/MS_Ambience',
  nodes: [
    { node_id: 'node-001', node_class_name: 'MetasoundOscillator', node_name: 'Sine Oscillator' },
    { node_id: 'node-002', node_class_name: 'MetasoundGain', node_name: 'Volume' },
    { node_id: 'node-003', node_class_name: 'MetasoundOutput', node_name: 'Audio Output' },
  ],
  edges: [
    { from_node: 'node-001', from_output: 'Audio Out', to_node: 'node-002', to_input: 'Audio In' },
    { from_node: 'node-002', from_output: 'Audio Out', to_node: 'node-003', to_input: 'Audio In' },
  ],
  inputs: [
    { name: 'Frequency', type_name: 'Float' },
    { name: 'Amplitude', type_name: 'Float' },
  ],
  outputs: [
    { name: 'Audio', type_name: 'Audio' },
  ],
};

const SOUNDCUE_INSPECT_DATA: SoundCueInspectResult = {
  asset_path: '/Game/Audio/SC_Footstep',
  first_node: {
    node_name: 'Modulator0',
    node_class: 'SoundNodeModulator',
    pitch_min: 0.9,
    pitch_max: 1.1,
    volume_min: 0.8,
    volume_max: 1.0,
    children: [
      {
        node_name: 'WavePlayer0',
        node_class: 'SoundNodeWavePlayer',
        wave_asset_path: '/Game/Audio/SFX_Step_Concrete',
        children: [],
      },
    ],
  },
  cue_attenuation: {
    inner_radius: 400,
    falloff_distance: 2000,
    falloff_model: 'NaturalSound',
    spatialization_method: 'Binaural',
  },
};

const INSIGHTS_AVAILABLE_DATA: AudioInsightsResult = {
  available: true,
  active_sound_count: 12,
  max_channels: 32,
  recent_events: [
    { event_name: 'SFX_Explosion', timestamp: 1716000000 },
    { event_name: 'Music_MainTheme', timestamp: 1716000001 },
  ],
};

const INSIGHTS_UNAVAILABLE_DATA: AudioInsightsResult = {
  available: false,
  message: 'AudioInsights plugin is not enabled. Enable it in Plugins > Audio > Audio Insights to use this command.',
  recent_events: [],
};

// ---------------------------------------------------------------------------
// ue_list_sound_assets (AUD-01) — 5 tests
// ---------------------------------------------------------------------------

describe('ue_list_sound_assets (AUD-01)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns sound asset list on success', async () => {
    const bridge = makeMockBridge({ responseData: SOUND_LIST_DATA });
    const result = await handleListSoundAssets({}, bridge);
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result as ToolResultShape).content[0].text);
    expect(Array.isArray(parsed.assets)).toBe(true);
    expect(parsed.assets).toHaveLength(3);
    expect(parsed.count).toBe(3);
    expect(parsed.assets[0].asset_type).toBe('SoundWave');
    expect(parsed.assets[0].duration).toBe(2.5);
    expect(parsed.assets[0].sample_rate).toBe(48000);
  });

  it('returns filtered list when type_filter provided', async () => {
    const bridge = makeMockBridge({ responseData: SOUND_LIST_DATA });
    await handleListSoundAssets({ type_filter: 'SoundWave' }, bridge);
    expect(bridge.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audio.list',
        payload: expect.objectContaining({ type_filter: 'SoundWave' }),
      })
    );
  });

  it('omits type_filter from payload when not provided', async () => {
    const bridge = makeMockBridge({ responseData: SOUND_LIST_DATA });
    await handleListSoundAssets({}, bridge);
    const call = (bridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.type).toBe('audio.list');
    expect(call.payload).not.toHaveProperty('type_filter');
  });

  it('returns isError on command failure', async () => {
    const bridge = makeMockBridge({
      responseSuccess: false,
      responseError: 'Registry query failed',
    });
    const result = await handleListSoundAssets({}, bridge);
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result as ToolResultShape).content[0].text);
    expect(parsed.error).toBe('Registry query failed');
  });

  it('returns plugin_not_connected when bridge disconnected', async () => {
    const bridge = makeMockBridge({ throwDisconnect: true });
    const result = await handleListSoundAssets({}, bridge);
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result as ToolResultShape).content[0].text);
    expect(parsed.error).toBe('plugin_not_connected');
    expect(parsed.required_plugin).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ue_inspect_metasound (AUD-02) — 5 tests
// ---------------------------------------------------------------------------

describe('ue_inspect_metasound (AUD-02)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns MetaSound graph data on success', async () => {
    const bridge = makeMockBridge({ responseData: METASOUND_INSPECT_DATA });
    const result = await handleInspectMetasound(
      { asset_path: '/Game/Audio/MS_Ambience' },
      bridge
    );
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result as ToolResultShape).content[0].text);
    expect(Array.isArray(parsed.nodes)).toBe(true);
    expect(parsed.nodes).toHaveLength(3);
    expect(Array.isArray(parsed.edges)).toBe(true);
    expect(parsed.edges).toHaveLength(2);
    expect(Array.isArray(parsed.inputs)).toBe(true);
    expect(parsed.inputs).toHaveLength(2);
    expect(Array.isArray(parsed.outputs)).toBe(true);
    expect(parsed.outputs).toHaveLength(1);
  });

  it('returns correct node class names', async () => {
    const bridge = makeMockBridge({ responseData: METASOUND_INSPECT_DATA });
    const result = await handleInspectMetasound(
      { asset_path: '/Game/Audio/MS_Ambience' },
      bridge
    );
    const parsed = JSON.parse((result as ToolResultShape).content[0].text);
    expect(parsed.nodes[0].node_class_name).toBe('MetasoundOscillator');
    expect(parsed.nodes[0].node_id).toBe('node-001');
    expect(parsed.nodes[1].node_class_name).toBe('MetasoundGain');
  });

  it('sends correct command type audio.metasound', async () => {
    const bridge = makeMockBridge({ responseData: METASOUND_INSPECT_DATA });
    await handleInspectMetasound({ asset_path: '/Game/Audio/MS_Ambience' }, bridge);
    expect(bridge.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audio.metasound',
        payload: expect.objectContaining({ asset_path: '/Game/Audio/MS_Ambience' }),
      })
    );
  });

  it('returns isError on command failure', async () => {
    const bridge = makeMockBridge({
      responseSuccess: false,
      responseError: 'MetaSound asset not found',
    });
    const result = await handleInspectMetasound(
      { asset_path: '/Game/Audio/MS_Missing' },
      bridge
    );
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result as ToolResultShape).content[0].text);
    expect(parsed.error).toBe('MetaSound asset not found');
  });

  it('returns plugin_not_connected when bridge disconnected', async () => {
    const bridge = makeMockBridge({ throwDisconnect: true });
    const result = await handleInspectMetasound(
      { asset_path: '/Game/Audio/MS_Ambience' },
      bridge
    );
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result as ToolResultShape).content[0].text);
    expect(parsed.error).toBe('plugin_not_connected');
    expect(parsed.required_plugin).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ue_inspect_sound_cue (AUD-03) — 5 tests
// ---------------------------------------------------------------------------

describe('ue_inspect_sound_cue (AUD-03)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns SoundCue node tree on success', async () => {
    const bridge = makeMockBridge({ responseData: SOUNDCUE_INSPECT_DATA });
    const result = await handleInspectSoundCue(
      { asset_path: '/Game/Audio/SC_Footstep' },
      bridge
    );
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result as ToolResultShape).content[0].text);
    expect(parsed.first_node.node_class).toBe('SoundNodeModulator');
    expect(parsed.first_node.node_name).toBe('Modulator0');
    expect(Array.isArray(parsed.first_node.children)).toBe(true);
    expect(parsed.first_node.children).toHaveLength(1);
  });

  it('includes attenuation settings', async () => {
    const bridge = makeMockBridge({ responseData: SOUNDCUE_INSPECT_DATA });
    const result = await handleInspectSoundCue(
      { asset_path: '/Game/Audio/SC_Footstep' },
      bridge
    );
    const parsed = JSON.parse((result as ToolResultShape).content[0].text);
    expect(parsed.cue_attenuation).toBeDefined();
    expect(parsed.cue_attenuation.falloff_model).toBe('NaturalSound');
    expect(parsed.cue_attenuation.spatialization_method).toBe('Binaural');
    expect(parsed.cue_attenuation.inner_radius).toBe(400);
    expect(parsed.cue_attenuation.falloff_distance).toBe(2000);
  });

  it('includes wave player specific fields', async () => {
    const bridge = makeMockBridge({ responseData: SOUNDCUE_INSPECT_DATA });
    const result = await handleInspectSoundCue(
      { asset_path: '/Game/Audio/SC_Footstep' },
      bridge
    );
    const parsed = JSON.parse((result as ToolResultShape).content[0].text);
    const wavePlayer = parsed.first_node.children[0];
    expect(wavePlayer.node_class).toBe('SoundNodeWavePlayer');
    expect(wavePlayer.wave_asset_path).toBe('/Game/Audio/SFX_Step_Concrete');
    expect(wavePlayer.children).toHaveLength(0);
  });

  it('returns isError on command failure', async () => {
    const bridge = makeMockBridge({
      responseSuccess: false,
      responseError: 'SoundCue asset not found',
    });
    const result = await handleInspectSoundCue(
      { asset_path: '/Game/Audio/SC_Missing' },
      bridge
    );
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result as ToolResultShape).content[0].text);
    expect(parsed.error).toBe('SoundCue asset not found');
  });

  it('returns plugin_not_connected when bridge disconnected', async () => {
    const bridge = makeMockBridge({ throwDisconnect: true });
    const result = await handleInspectSoundCue(
      { asset_path: '/Game/Audio/SC_Footstep' },
      bridge
    );
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result as ToolResultShape).content[0].text);
    expect(parsed.error).toBe('plugin_not_connected');
    expect(parsed.required_plugin).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ue_query_audio_insights (AUD-04) — 7 tests
// ---------------------------------------------------------------------------

describe('ue_query_audio_insights (AUD-04)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns Audio Insights data when available', async () => {
    const bridge = makeMockBridge({ responseData: INSIGHTS_AVAILABLE_DATA });
    const result = await handleQueryAudioInsights({}, bridge);
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result as ToolResultShape).content[0].text);
    expect(parsed.available).toBe(true);
    expect(parsed.active_sound_count).toBe(12);
    expect(parsed.max_channels).toBe(32);
  });

  it('returns recent events', async () => {
    const bridge = makeMockBridge({ responseData: INSIGHTS_AVAILABLE_DATA });
    const result = await handleQueryAudioInsights({}, bridge);
    const parsed = JSON.parse((result as ToolResultShape).content[0].text);
    expect(Array.isArray(parsed.recent_events)).toBe(true);
    expect(parsed.recent_events).toHaveLength(2);
    expect(parsed.recent_events[0].event_name).toBe('SFX_Explosion');
    expect(parsed.recent_events[1].event_name).toBe('Music_MainTheme');
  });

  it('returns informative message when AudioInsights not enabled', async () => {
    const bridge = makeMockBridge({ responseData: INSIGHTS_UNAVAILABLE_DATA });
    const result = await handleQueryAudioInsights({}, bridge);
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result as ToolResultShape).content[0].text);
    expect(parsed.available).toBe(false);
    expect(typeof parsed.message).toBe('string');
    expect(parsed.message).toContain('not enabled');
  });

  it('sends correct command type audio.insights', async () => {
    const bridge = makeMockBridge({ responseData: INSIGHTS_AVAILABLE_DATA });
    await handleQueryAudioInsights({}, bridge);
    expect(bridge.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audio.insights',
      })
    );
  });

  it('sends empty payload', async () => {
    const bridge = makeMockBridge({ responseData: INSIGHTS_AVAILABLE_DATA });
    await handleQueryAudioInsights({}, bridge);
    const call = (bridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.type).toBe('audio.insights');
    expect(call.payload).toEqual({});
  });

  it('returns isError on command failure', async () => {
    const bridge = makeMockBridge({
      responseSuccess: false,
      responseError: 'audio_insights_error',
    });
    const result = await handleQueryAudioInsights({}, bridge);
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result as ToolResultShape).content[0].text);
    expect(parsed.error).toBe('audio_insights_error');
  });

  it('returns plugin_not_connected when bridge disconnected', async () => {
    const bridge = makeMockBridge({ throwDisconnect: true });
    const result = await handleQueryAudioInsights({}, bridge);
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result as ToolResultShape).content[0].text);
    expect(parsed.error).toBe('plugin_not_connected');
    expect(parsed.required_plugin).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// registerAudioTools — 5 tests
// ---------------------------------------------------------------------------

describe('registerAudioTools', () => {
  it('registers exactly four tools', () => {
    const mockBridge = makeMockBridge({});
    const { server, handlers } = makeStubServer();
    registerAudioTools(server, mockBridge);
    expect(handlers.size).toBe(4);
  });

  it('registers ue_list_sound_assets tool', () => {
    const mockBridge = makeMockBridge({});
    const { server, handlers } = makeStubServer();
    registerAudioTools(server, mockBridge);
    expect(handlers.has('ue_list_sound_assets')).toBe(true);
  });

  it('registers ue_inspect_metasound tool', () => {
    const mockBridge = makeMockBridge({});
    const { server, handlers } = makeStubServer();
    registerAudioTools(server, mockBridge);
    expect(handlers.has('ue_inspect_metasound')).toBe(true);
  });

  it('registers ue_inspect_sound_cue tool', () => {
    const mockBridge = makeMockBridge({});
    const { server, handlers } = makeStubServer();
    registerAudioTools(server, mockBridge);
    expect(handlers.has('ue_inspect_sound_cue')).toBe(true);
  });

  it('registers ue_query_audio_insights tool', () => {
    const mockBridge = makeMockBridge({});
    const { server, handlers } = makeStubServer();
    registerAudioTools(server, mockBridge);
    expect(handlers.has('ue_query_audio_insights')).toBe(true);
  });
});
