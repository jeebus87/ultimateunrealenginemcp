// tests/livelink-tools.test.ts
// Integration tests for Phase 27 Live Link MCP tools (LL-01 through LL-04).
// Uses injected mock PluginBridgeClient — no TCP server needed; handlers accept an
// injected bridge parameter via their exported function signatures.
//
// Port assignment comment: port 55575 is reserved for this file if a TCP mock server
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
//   55575 — reserved for this file (not currently used)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PluginBridgeClient, PluginNotConnectedError } from '../src/plugin-bridge/client.js';
import {
  registerLiveLinkTools,
  handleListLiveLinkSources,
  handleListLiveLinkSubjects,
  handleControlLiveLinkSubject,
  handlePreviewLiveLinkData,
} from '../src/tools/livelink/index.js';

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

const SOURCES_DATA = {
  sources: [
    {
      source_id: 'A1B2C3D4-E5F6-7890-ABCD-EF1234567890',
      source_type: 'LiveLinkMessageBusSource',
      machine_name: 'MOCAP-PC-01',
      status: 'Active',
    },
    {
      source_id: 'F0E1D2C3-B4A5-6789-0123-456789ABCDEF',
      source_type: 'LiveLinkMessageBusSource',
      machine_name: 'CAMERA-STATION',
      status: 'Inactive',
    },
  ],
  count: 2,
};

const SOURCES_EMPTY_DATA = {
  sources: [],
  count: 0,
  message:
    'Live Link plugin is not enabled. Enable it in Plugins > Animation > Live Link to use this command.',
};

const SUBJECTS_DATA = {
  subjects: [
    {
      subject_name: 'MocapActor',
      source_id: 'A1B2C3D4-E5F6-7890-ABCD-EF1234567890',
      role: 'Animation',
      enabled: true,
    },
    {
      subject_name: 'VirtualCamera1',
      source_id: 'A1B2C3D4-E5F6-7890-ABCD-EF1234567890',
      role: 'Camera',
      enabled: true,
    },
    {
      subject_name: 'TrackerProp',
      source_id: 'F0E1D2C3-B4A5-6789-0123-456789ABCDEF',
      role: 'Transform',
      enabled: false,
    },
  ],
  count: 3,
};

const CONTROL_PAUSE_DATA = {
  subject_name: 'MocapActor',
  enabled: false,
  message: 'Subject paused',
};

const CONTROL_RESUME_DATA = {
  subject_name: 'MocapActor',
  enabled: true,
  message: 'Subject resumed',
};

const PREVIEW_TRANSFORM_DATA = {
  subject_name: 'TrackerProp',
  role: 'Transform',
  available: true,
  frame_data: {
    location: { x: 100.0, y: 200.0, z: 50.0 },
    rotation: { roll: 0.0, pitch: 15.5, yaw: 90.0 },
    scale: { x: 1.0, y: 1.0, z: 1.0 },
  },
};

const PREVIEW_CAMERA_DATA = {
  subject_name: 'VirtualCamera1',
  role: 'Camera',
  available: true,
  frame_data: {
    field_of_view: 90.0,
    aspect_ratio: 1.777,
    focal_length: 35.0,
    aperture: 2.8,
    focus_distance: 500.0,
    transform: {
      location: { x: 0.0, y: 0.0, z: 180.0 },
      rotation: { roll: 0.0, pitch: -10.0, yaw: 45.0 },
      scale: { x: 1.0, y: 1.0, z: 1.0 },
    },
  },
};

const PREVIEW_ANIMATION_DATA = {
  subject_name: 'MocapActor',
  role: 'Animation',
  available: true,
  frame_data: {
    bone_names: [
      'Root',
      'Pelvis',
      'Spine_01',
      'Spine_02',
      'Spine_03',
      'Neck',
      'Head',
      'LeftShoulder',
      'LeftArm',
      'LeftForearm',
    ],
    bone_count: 10,
    total_bones: 65,
    bone_transforms: [
      {
        bone_name: 'Root',
        location: { x: 0, y: 0, z: 0 },
        rotation: { roll: 0, pitch: 0, yaw: 0 },
      },
      {
        bone_name: 'Pelvis',
        location: { x: 0, y: 0, z: 95.5 },
        rotation: { roll: 0, pitch: 2.1, yaw: 0 },
      },
    ],
  },
};

const PREVIEW_UNAVAILABLE_DATA = {
  subject_name: 'DisconnectedSubject',
  role: 'Transform',
  available: false,
  message: 'No frame data available for subject. Source may be disconnected or not streaming.',
};

// ---------------------------------------------------------------------------
// describe("ue_list_livelink_sources (LL-01)")
// ---------------------------------------------------------------------------

describe('ue_list_livelink_sources (LL-01)', () => {
  let mockBridge: PluginBridgeClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockBridge = makeMockBridge({ responseData: SOURCES_DATA });
  });

  it('returns sources with type, machine name, and status on success', async () => {
    const result = await handleListLiveLinkSources({} as Record<string, never>, mockBridge) as ToolResultShape;
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(Array.isArray(parsed.sources)).toBe(true);
    expect(parsed.sources).toHaveLength(2);
    expect(parsed.sources[0].source_id).toBe('A1B2C3D4-E5F6-7890-ABCD-EF1234567890');
    expect(parsed.sources[0].source_type).toBe('LiveLinkMessageBusSource');
    expect(parsed.sources[0].machine_name).toBe('MOCAP-PC-01');
    expect(parsed.sources[0].status).toBe('Active');
    expect(parsed.sources[1].machine_name).toBe('CAMERA-STATION');
    expect(parsed.sources[1].status).toBe('Inactive');
    expect(parsed.count).toBe(2);
  });

  it('returns empty list with message when Live Link not enabled', async () => {
    mockBridge = makeMockBridge({ responseData: SOURCES_EMPTY_DATA });
    const result = await handleListLiveLinkSources({} as Record<string, never>, mockBridge) as ToolResultShape;
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(Array.isArray(parsed.sources)).toBe(true);
    expect(parsed.sources).toHaveLength(0);
    expect(parsed.count).toBe(0);
    expect(parsed.message).toContain('Live Link plugin is not enabled');
  });

  it('returns plugin_not_connected when bridge is disconnected', async () => {
    mockBridge = makeMockBridge({ throwDisconnect: true });
    const result = await handleListLiveLinkSources({} as Record<string, never>, mockBridge) as ToolResultShape;
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('plugin_not_connected');
    expect(parsed.required_plugin).toBe(true);
  });

  it('returns isError on command-level failure', async () => {
    mockBridge = makeMockBridge({ responseSuccess: false, responseError: 'internal error' });
    const result = await handleListLiveLinkSources({} as Record<string, never>, mockBridge) as ToolResultShape;
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('internal error');
  });

  it('sends livelink.sources command type', async () => {
    await handleListLiveLinkSources({} as Record<string, never>, mockBridge);
    expect(mockBridge.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'livelink.sources' })
    );
  });
});

// ---------------------------------------------------------------------------
// describe("ue_list_livelink_subjects (LL-02)")
// ---------------------------------------------------------------------------

describe('ue_list_livelink_subjects (LL-02)', () => {
  let mockBridge: PluginBridgeClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockBridge = makeMockBridge({ responseData: SUBJECTS_DATA });
  });

  it('returns subjects with name, role, source_id, and enabled state', async () => {
    const result = await handleListLiveLinkSubjects({} as Record<string, never>, mockBridge) as ToolResultShape;
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(Array.isArray(parsed.subjects)).toBe(true);
    expect(parsed.subjects).toHaveLength(3);
    expect(parsed.subjects[0].subject_name).toBe('MocapActor');
    expect(parsed.subjects[0].role).toBe('Animation');
    expect(parsed.subjects[0].enabled).toBe(true);
    expect(parsed.subjects[1].subject_name).toBe('VirtualCamera1');
    expect(parsed.subjects[1].role).toBe('Camera');
    expect(parsed.subjects[2].subject_name).toBe('TrackerProp');
    expect(parsed.subjects[2].role).toBe('Transform');
    expect(parsed.subjects[2].enabled).toBe(false);
    expect(parsed.count).toBe(3);
  });

  it('returns empty list when no subjects exist', async () => {
    mockBridge = makeMockBridge({ responseData: { subjects: [], count: 0 } });
    const result = await handleListLiveLinkSubjects({} as Record<string, never>, mockBridge) as ToolResultShape;
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(Array.isArray(parsed.subjects)).toBe(true);
    expect(parsed.subjects).toHaveLength(0);
    expect(parsed.count).toBe(0);
  });

  it('returns plugin_not_connected when bridge is disconnected', async () => {
    mockBridge = makeMockBridge({ throwDisconnect: true });
    const result = await handleListLiveLinkSubjects({} as Record<string, never>, mockBridge) as ToolResultShape;
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('plugin_not_connected');
    expect(parsed.required_plugin).toBe(true);
  });

  it('returns isError on command-level failure', async () => {
    mockBridge = makeMockBridge({ responseSuccess: false, responseError: 'subjects_unavailable' });
    const result = await handleListLiveLinkSubjects({} as Record<string, never>, mockBridge) as ToolResultShape;
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('subjects_unavailable');
  });

  it('sends livelink.subjects command type', async () => {
    await handleListLiveLinkSubjects({} as Record<string, never>, mockBridge);
    expect(mockBridge.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'livelink.subjects' })
    );
  });
});

// ---------------------------------------------------------------------------
// describe("ue_control_livelink_subject (LL-03)")
// ---------------------------------------------------------------------------

describe('ue_control_livelink_subject (LL-03)', () => {
  let mockBridge: PluginBridgeClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockBridge = makeMockBridge({ responseData: CONTROL_PAUSE_DATA });
  });

  it('pauses a subject and returns confirmation', async () => {
    mockBridge = makeMockBridge({ responseData: CONTROL_PAUSE_DATA });
    const result = await handleControlLiveLinkSubject(
      { subject_name: 'MocapActor', enabled: false },
      mockBridge
    ) as ToolResultShape;
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.subject_name).toBe('MocapActor');
    expect(parsed.enabled).toBe(false);
    expect(parsed.message).toBe('Subject paused');
  });

  it('resumes a subject and returns confirmation', async () => {
    mockBridge = makeMockBridge({ responseData: CONTROL_RESUME_DATA });
    const result = await handleControlLiveLinkSubject(
      { subject_name: 'MocapActor', enabled: true },
      mockBridge
    ) as ToolResultShape;
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.subject_name).toBe('MocapActor');
    expect(parsed.enabled).toBe(true);
    expect(parsed.message).toBe('Subject resumed');
  });

  it('sends subject_name and enabled in payload', async () => {
    await handleControlLiveLinkSubject(
      { subject_name: 'MocapActor', enabled: false },
      mockBridge
    );
    expect(mockBridge.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'livelink.control',
        payload: expect.objectContaining({
          subject_name: 'MocapActor',
          enabled: false,
        }),
      })
    );
  });

  it('returns plugin_not_connected when bridge is disconnected', async () => {
    mockBridge = makeMockBridge({ throwDisconnect: true });
    const result = await handleControlLiveLinkSubject(
      { subject_name: 'MocapActor', enabled: false },
      mockBridge
    ) as ToolResultShape;
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('plugin_not_connected');
    expect(parsed.required_plugin).toBe(true);
  });

  it('returns isError on command-level failure', async () => {
    mockBridge = makeMockBridge({
      responseSuccess: false,
      responseError: 'Subject not found: UnknownSubject',
    });
    const result = await handleControlLiveLinkSubject(
      { subject_name: 'UnknownSubject', enabled: true },
      mockBridge
    ) as ToolResultShape;
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('Subject not found: UnknownSubject');
  });

  it('sends livelink.control command type', async () => {
    await handleControlLiveLinkSubject(
      { subject_name: 'MocapActor', enabled: true },
      mockBridge
    );
    expect(mockBridge.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'livelink.control' })
    );
  });
});

// ---------------------------------------------------------------------------
// describe("ue_preview_livelink_data (LL-04)")
// ---------------------------------------------------------------------------

describe('ue_preview_livelink_data (LL-04)', () => {
  let mockBridge: PluginBridgeClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockBridge = makeMockBridge({ responseData: PREVIEW_TRANSFORM_DATA });
  });

  it('returns transform data for Transform role subject', async () => {
    mockBridge = makeMockBridge({ responseData: PREVIEW_TRANSFORM_DATA });
    const result = await handlePreviewLiveLinkData(
      { subject_name: 'TrackerProp' },
      mockBridge
    ) as ToolResultShape;
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.subject_name).toBe('TrackerProp');
    expect(parsed.role).toBe('Transform');
    expect(parsed.available).toBe(true);
    expect(parsed.frame_data.location.x).toBe(100.0);
    expect(parsed.frame_data.location.y).toBe(200.0);
    expect(parsed.frame_data.location.z).toBe(50.0);
    expect(parsed.frame_data.rotation.pitch).toBe(15.5);
    expect(parsed.frame_data.rotation.yaw).toBe(90.0);
    expect(parsed.frame_data.scale.x).toBe(1.0);
  });

  it('returns camera data for Camera role subject', async () => {
    mockBridge = makeMockBridge({ responseData: PREVIEW_CAMERA_DATA });
    const result = await handlePreviewLiveLinkData(
      { subject_name: 'VirtualCamera1' },
      mockBridge
    ) as ToolResultShape;
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.subject_name).toBe('VirtualCamera1');
    expect(parsed.role).toBe('Camera');
    expect(parsed.available).toBe(true);
    expect(parsed.frame_data.field_of_view).toBe(90.0);
    expect(parsed.frame_data.aperture).toBe(2.8);
    expect(parsed.frame_data.focus_distance).toBe(500.0);
    expect(parsed.frame_data.focal_length).toBe(35.0);
    expect(parsed.frame_data.transform.location.z).toBe(180.0);
    expect(parsed.frame_data.transform.rotation.pitch).toBe(-10.0);
  });

  it('returns animation data with capped bone count for Animation role subject', async () => {
    mockBridge = makeMockBridge({ responseData: PREVIEW_ANIMATION_DATA });
    const result = await handlePreviewLiveLinkData(
      { subject_name: 'MocapActor' },
      mockBridge
    ) as ToolResultShape;
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.subject_name).toBe('MocapActor');
    expect(parsed.role).toBe('Animation');
    expect(parsed.available).toBe(true);
    expect(Array.isArray(parsed.frame_data.bone_names)).toBe(true);
    expect(parsed.frame_data.bone_names).toHaveLength(10);
    expect(parsed.frame_data.bone_count).toBe(10);
    expect(parsed.frame_data.total_bones).toBe(65);
    expect(Array.isArray(parsed.frame_data.bone_transforms)).toBe(true);
    expect(parsed.frame_data.bone_transforms[0].bone_name).toBe('Root');
    expect(parsed.frame_data.bone_transforms[1].bone_name).toBe('Pelvis');
    expect(parsed.frame_data.bone_transforms[1].location.z).toBe(95.5);
  });

  it('returns available:false with message when frame data unavailable', async () => {
    mockBridge = makeMockBridge({ responseData: PREVIEW_UNAVAILABLE_DATA });
    const result = await handlePreviewLiveLinkData(
      { subject_name: 'DisconnectedSubject' },
      mockBridge
    ) as ToolResultShape;
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.subject_name).toBe('DisconnectedSubject');
    expect(parsed.available).toBe(false);
    expect(parsed.message).toContain('No frame data available');
  });

  it('sends subject_name in payload', async () => {
    await handlePreviewLiveLinkData({ subject_name: 'MocapActor' }, mockBridge);
    expect(mockBridge.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ subject_name: 'MocapActor' }),
      })
    );
  });

  it('returns plugin_not_connected when bridge is disconnected', async () => {
    mockBridge = makeMockBridge({ throwDisconnect: true });
    const result = await handlePreviewLiveLinkData(
      { subject_name: 'MocapActor' },
      mockBridge
    ) as ToolResultShape;
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('plugin_not_connected');
    expect(parsed.required_plugin).toBe(true);
  });

  it('returns isError on command-level failure', async () => {
    mockBridge = makeMockBridge({ responseSuccess: false, responseError: 'preview_unavailable' });
    const result = await handlePreviewLiveLinkData(
      { subject_name: 'MocapActor' },
      mockBridge
    ) as ToolResultShape;
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('preview_unavailable');
  });

  it('sends livelink.preview command type', async () => {
    await handlePreviewLiveLinkData({ subject_name: 'MocapActor' }, mockBridge);
    expect(mockBridge.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'livelink.preview' })
    );
  });
});

// ---------------------------------------------------------------------------
// describe("registerLiveLinkTools")
// ---------------------------------------------------------------------------

describe('registerLiveLinkTools', () => {
  it('registers exactly four tools on the server', () => {
    const mockBridge = makeMockBridge({});
    const { server, handlers } = makeStubServer();
    registerLiveLinkTools(server, mockBridge);
    expect(handlers.size).toBe(4);
  });

  it('registers tools with correct names', () => {
    const mockBridge = makeMockBridge({});
    const { server, handlers } = makeStubServer();
    registerLiveLinkTools(server, mockBridge);
    expect(handlers.has('ue_list_livelink_sources')).toBe(true);
    expect(handlers.has('ue_list_livelink_subjects')).toBe(true);
    expect(handlers.has('ue_control_livelink_subject')).toBe(true);
    expect(handlers.has('ue_preview_livelink_data')).toBe(true);
  });

  it('accepts optional bridge parameter without error', () => {
    const mockBridge = makeMockBridge({ connected: true });
    const { server } = makeStubServer();
    expect(() => registerLiveLinkTools(server, mockBridge)).not.toThrow();
  });
});
