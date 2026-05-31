// tests/movie-render-tools.test.ts
// Integration tests for Phase 29 Movie Render Pipeline MCP tools (MRP-01 through MRP-04).
// Uses injected mock PluginBridgeClient — no TCP server needed.
//
// Port assignment: port 55577 reserved for this file if a TCP mock server is needed later,
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
//   55566 — collision-physics-tools.test.ts (reserved)
//   55573 — gas-tools.test.ts (Phase 25 GAS-01 through GAS-04)
//   55575 — livelink-tools.test.ts (Phase 27 LL-01 through LL-04)
//   55576 — motion-design-tools.test.ts (Phase 28 MD-01 through MD-04)
//   55577 — reserved for this file (not currently used)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PluginBridgeClient, PluginNotConnectedError } from '../src/plugin-bridge/client.js';
import { registerMovieRenderTools } from '../src/tools/movie-render/index.js';

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

const QUEUE_DATA = {
  jobs: [
    {
      job_name: 'MySequence',
      sequence_path: '/Game/Cinematics/MySequence',
      status: 'pending',
      progress: 0.0,
      output_directory: '{project}/Saved/MovieRenders',
      filename_format: '{sequence_name}_{frame_number}',
      resolution_x: 1920,
      resolution_y: 1080,
    },
    {
      job_name: 'FinalShot',
      sequence_path: '/Game/Cinematics/FinalShot',
      status: 'in_progress',
      progress: 0.45,
      output_directory: '/ProjectOutput/Renders',
      filename_format: '{sequence_name}_{frame_number}',
      resolution_x: 3840,
      resolution_y: 2160,
    },
  ],
  count: 2,
};

const QUEUE_EMPTY_DATA = {
  jobs: [],
  count: 0,
};

const ADD_JOB_DATA = {
  job_name: 'MySequence',
  sequence_path: '/Game/Cinematics/MySequence',
  format: 'exr',
  resolution_x: 3840,
  resolution_y: 2160,
  frame_start: 0,
  frame_end: 120,
  output_directory: '/ProjectOutput/Renders',
  added: true,
};

const CONTROL_START_DATA = {
  action: 'start',
  started: true,
  is_rendering: true,
};

const CONTROL_STOP_DATA = {
  action: 'stop',
  stopped: true,
  is_rendering: false,
};

const CONTROL_PROGRESS_DATA = {
  action: 'progress',
  is_rendering: true,
  total_jobs: 3,
  current_job_index: 1,
  progress: 0.33,
};

const CONFIGURE_DATA = {
  sequence_path: '/Game/Cinematics/MySequence',
  configured: true,
  configured_fields: ['filename_format', 'burn_in_text', 'exr_metadata'],
};

// ---------------------------------------------------------------------------
// describe('movie render tools')
// ---------------------------------------------------------------------------

describe('movie render tools', () => {

  // -------------------------------------------------------------------------
  // ue_list_render_queue (MRP-01)
  // -------------------------------------------------------------------------
  describe('ue_list_render_queue (MRP-01)', () => {
    let mockBridge: PluginBridgeClient;

    beforeEach(() => {
      vi.clearAllMocks();
      mockBridge = makeMockBridge({ responseData: QUEUE_DATA });
    });

    it('happy path: returns job list with status, sequence path, and output settings', async () => {
      const { server, handlers } = makeStubServer();
      registerMovieRenderTools(server, mockBridge);
      const handler = handlers.get('ue_list_render_queue')!;
      const result = await handler({}) as ToolResultShape;
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(Array.isArray(parsed.jobs)).toBe(true);
      expect(parsed.jobs).toHaveLength(2);
      expect(parsed.jobs[0].sequence_path).toBe('/Game/Cinematics/MySequence');
      expect(parsed.jobs[0].status).toBe('pending');
      expect(parsed.jobs[1].status).toBe('in_progress');
      expect(parsed.jobs[1].progress).toBe(0.45);
      expect(parsed.count).toBe(2);
    });

    it('empty queue: returns jobs array with zero entries', async () => {
      mockBridge = makeMockBridge({ responseData: QUEUE_EMPTY_DATA });
      const { server, handlers } = makeStubServer();
      registerMovieRenderTools(server, mockBridge);
      const handler = handlers.get('ue_list_render_queue')!;
      const result = await handler({}) as ToolResultShape;
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(Array.isArray(parsed.jobs)).toBe(true);
      expect(parsed.jobs).toHaveLength(0);
      expect(parsed.count).toBe(0);
    });

    it('disconnect: returns plugin_not_connected error', async () => {
      mockBridge = makeMockBridge({ throwDisconnect: true });
      const { server, handlers } = makeStubServer();
      registerMovieRenderTools(server, mockBridge);
      const handler = handlers.get('ue_list_render_queue')!;
      const result = await handler({}) as ToolResultShape;
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('plugin_not_connected');
      expect(parsed.required_plugin).toBe(true);
    });

    it('command error: subsystem_unavailable returns isError true', async () => {
      mockBridge = makeMockBridge({ responseSuccess: false, responseError: 'subsystem_unavailable' });
      const { server, handlers } = makeStubServer();
      registerMovieRenderTools(server, mockBridge);
      const handler = handlers.get('ue_list_render_queue')!;
      const result = await handler({}) as ToolResultShape;
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('subsystem_unavailable');
    });

    it('payload completeness: sends movierender.queue command type', async () => {
      const { server, handlers } = makeStubServer();
      registerMovieRenderTools(server, mockBridge);
      const handler = handlers.get('ue_list_render_queue')!;
      await handler({});
      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'movierender.queue' })
      );
    });
  });

  // -------------------------------------------------------------------------
  // ue_add_render_job (MRP-02)
  // -------------------------------------------------------------------------
  describe('ue_add_render_job (MRP-02)', () => {
    let mockBridge: PluginBridgeClient;

    beforeEach(() => {
      vi.clearAllMocks();
      mockBridge = makeMockBridge({ responseData: ADD_JOB_DATA });
    });

    it('happy path with all params: returns added job data', async () => {
      const { server, handlers } = makeStubServer();
      registerMovieRenderTools(server, mockBridge);
      const handler = handlers.get('ue_add_render_job')!;
      const result = await handler({
        sequence_path: '/Game/Cinematics/MySequence',
        output_directory: '/ProjectOutput/Renders',
        format: 'exr',
        resolution_x: 3840,
        resolution_y: 2160,
        frame_start: 0,
        frame_end: 120,
      }) as ToolResultShape;
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.sequence_path).toBe('/Game/Cinematics/MySequence');
      expect(parsed.format).toBe('exr');
      expect(parsed.resolution_x).toBe(3840);
      expect(parsed.resolution_y).toBe(2160);
      expect(parsed.added).toBe(true);
    });

    it('happy path minimal: only sequence_path provided', async () => {
      const { server, handlers } = makeStubServer();
      registerMovieRenderTools(server, mockBridge);
      const handler = handlers.get('ue_add_render_job')!;
      const result = await handler({ sequence_path: '/Game/Cinematics/MySequence' }) as ToolResultShape;
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.added).toBe(true);
    });

    it('sends correct command type movierender.addJob', async () => {
      const { server, handlers } = makeStubServer();
      registerMovieRenderTools(server, mockBridge);
      const handler = handlers.get('ue_add_render_job')!;
      await handler({ sequence_path: '/Game/Cinematics/MySequence' });
      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'movierender.addJob' })
      );
    });

    it('payload includes optional format when provided', async () => {
      const { server, handlers } = makeStubServer();
      registerMovieRenderTools(server, mockBridge);
      const handler = handlers.get('ue_add_render_job')!;
      await handler({ sequence_path: '/Game/Cinematics/MySequence', format: 'exr' });
      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({ format: 'exr' }),
        })
      );
    });

    it('payload includes resolution when provided', async () => {
      const { server, handlers } = makeStubServer();
      registerMovieRenderTools(server, mockBridge);
      const handler = handlers.get('ue_add_render_job')!;
      await handler({ sequence_path: '/Game/Cinematics/MySequence', resolution_x: 3840, resolution_y: 2160 });
      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({ resolution_x: 3840, resolution_y: 2160 }),
        })
      );
    });

    it('payload includes frame range when provided', async () => {
      const { server, handlers } = makeStubServer();
      registerMovieRenderTools(server, mockBridge);
      const handler = handlers.get('ue_add_render_job')!;
      await handler({ sequence_path: '/Game/Cinematics/MySequence', frame_start: 0, frame_end: 120 });
      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({ frame_start: 0, frame_end: 120 }),
        })
      );
    });

    it('disconnect: returns plugin_not_connected error', async () => {
      mockBridge = makeMockBridge({ throwDisconnect: true });
      const { server, handlers } = makeStubServer();
      registerMovieRenderTools(server, mockBridge);
      const handler = handlers.get('ue_add_render_job')!;
      const result = await handler({ sequence_path: '/Game/Cinematics/MySequence' }) as ToolResultShape;
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('plugin_not_connected');
    });

    it('command error: returns isError true', async () => {
      mockBridge = makeMockBridge({ responseSuccess: false, responseError: 'queue_unavailable' });
      const { server, handlers } = makeStubServer();
      registerMovieRenderTools(server, mockBridge);
      const handler = handlers.get('ue_add_render_job')!;
      const result = await handler({ sequence_path: '/Game/Cinematics/MySequence' }) as ToolResultShape;
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('queue_unavailable');
    });
  });

  // -------------------------------------------------------------------------
  // ue_control_render_queue (MRP-03)
  // -------------------------------------------------------------------------
  describe('ue_control_render_queue (MRP-03)', () => {
    let mockBridge: PluginBridgeClient;

    beforeEach(() => {
      vi.clearAllMocks();
      mockBridge = makeMockBridge({ responseData: CONTROL_START_DATA });
    });

    it('happy path start: sends action=start and returns started:true', async () => {
      const { server, handlers } = makeStubServer();
      registerMovieRenderTools(server, mockBridge);
      const handler = handlers.get('ue_control_render_queue')!;
      const result = await handler({ action: 'start' }) as ToolResultShape;
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.action).toBe('start');
      expect(parsed.started).toBe(true);
      expect(parsed.is_rendering).toBe(true);
    });

    it('happy path stop: sends action=stop and returns stopped:true', async () => {
      mockBridge = makeMockBridge({ responseData: CONTROL_STOP_DATA });
      const { server, handlers } = makeStubServer();
      registerMovieRenderTools(server, mockBridge);
      const handler = handlers.get('ue_control_render_queue')!;
      const result = await handler({ action: 'stop' }) as ToolResultShape;
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.action).toBe('stop');
      expect(parsed.stopped).toBe(true);
      expect(parsed.is_rendering).toBe(false);
    });

    it('happy path progress: returns is_rendering, total_jobs, current_job_index, progress', async () => {
      mockBridge = makeMockBridge({ responseData: CONTROL_PROGRESS_DATA });
      const { server, handlers } = makeStubServer();
      registerMovieRenderTools(server, mockBridge);
      const handler = handlers.get('ue_control_render_queue')!;
      const result = await handler({ action: 'progress' }) as ToolResultShape;
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.is_rendering).toBe(true);
      expect(parsed.total_jobs).toBe(3);
      expect(parsed.current_job_index).toBe(1);
      expect(parsed.progress).toBe(0.33);
    });

    it('payload has action field: sends exact payload shape', async () => {
      const { server, handlers } = makeStubServer();
      registerMovieRenderTools(server, mockBridge);
      const handler = handlers.get('ue_control_render_queue')!;
      await handler({ action: 'start' });
      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'movierender.control',
          payload: expect.objectContaining({ action: 'start' }),
        })
      );
    });

    it('disconnect: returns plugin_not_connected error', async () => {
      mockBridge = makeMockBridge({ throwDisconnect: true });
      const { server, handlers } = makeStubServer();
      registerMovieRenderTools(server, mockBridge);
      const handler = handlers.get('ue_control_render_queue')!;
      const result = await handler({ action: 'start' }) as ToolResultShape;
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('plugin_not_connected');
    });

    it('command error already_rendering: returns isError true with error field', async () => {
      mockBridge = makeMockBridge({ responseSuccess: false, responseError: 'already_rendering' });
      const { server, handlers } = makeStubServer();
      registerMovieRenderTools(server, mockBridge);
      const handler = handlers.get('ue_control_render_queue')!;
      const result = await handler({ action: 'start' }) as ToolResultShape;
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('already_rendering');
    });

    it('command error not_rendering: returns isError true with error field', async () => {
      mockBridge = makeMockBridge({ responseSuccess: false, responseError: 'not_rendering' });
      const { server, handlers } = makeStubServer();
      registerMovieRenderTools(server, mockBridge);
      const handler = handlers.get('ue_control_render_queue')!;
      const result = await handler({ action: 'stop' }) as ToolResultShape;
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('not_rendering');
    });
  });

  // -------------------------------------------------------------------------
  // ue_configure_render_output (MRP-04)
  // -------------------------------------------------------------------------
  describe('ue_configure_render_output (MRP-04)', () => {
    let mockBridge: PluginBridgeClient;

    beforeEach(() => {
      vi.clearAllMocks();
      mockBridge = makeMockBridge({ responseData: CONFIGURE_DATA });
    });

    it('happy path with burn_in_text: returns configured:true', async () => {
      const { server, handlers } = makeStubServer();
      registerMovieRenderTools(server, mockBridge);
      const handler = handlers.get('ue_configure_render_output')!;
      const result = await handler({
        sequence_path: '/Game/Cinematics/MySequence',
        burn_in_text: { top_left: 'Scene: {sequence_name}', bottom_right: '{date}' },
      }) as ToolResultShape;
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.configured).toBe(true);
      expect(parsed.sequence_path).toBe('/Game/Cinematics/MySequence');
    });

    it('happy path with exr_metadata: returns configured:true', async () => {
      const { server, handlers } = makeStubServer();
      registerMovieRenderTools(server, mockBridge);
      const handler = handlers.get('ue_configure_render_output')!;
      const result = await handler({
        sequence_path: '/Game/Cinematics/MySequence',
        exr_metadata: { Department: 'VFX', Project: 'MyFilm', Version: '001' },
      }) as ToolResultShape;
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.configured).toBe(true);
    });

    it('happy path with filename_format: returns configured:true', async () => {
      const { server, handlers } = makeStubServer();
      registerMovieRenderTools(server, mockBridge);
      const handler = handlers.get('ue_configure_render_output')!;
      const result = await handler({
        sequence_path: '/Game/Cinematics/MySequence',
        filename_format: '{sequence_name}_{frame_number}',
      }) as ToolResultShape;
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.configured).toBe(true);
    });

    it('happy path all config: all three optional fields provided', async () => {
      const { server, handlers } = makeStubServer();
      registerMovieRenderTools(server, mockBridge);
      const handler = handlers.get('ue_configure_render_output')!;
      const result = await handler({
        sequence_path: '/Game/Cinematics/MySequence',
        burn_in_text: { top_left: 'Shot {shot_name}' },
        exr_metadata: { Department: 'VFX' },
        filename_format: '{sequence_name}_{frame_number}',
      }) as ToolResultShape;
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.configured).toBe(true);
      expect(Array.isArray(parsed.configured_fields)).toBe(true);
    });

    it('minimal config: only sequence_path, no optional fields', async () => {
      mockBridge = makeMockBridge({ responseData: { sequence_path: '/Game/Cinematics/MySequence', configured: true, configured_fields: [] } });
      const { server, handlers } = makeStubServer();
      registerMovieRenderTools(server, mockBridge);
      const handler = handlers.get('ue_configure_render_output')!;
      const result = await handler({ sequence_path: '/Game/Cinematics/MySequence' }) as ToolResultShape;
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.configured).toBe(true);
    });

    it('payload completeness: provided fields appear in sendCommand payload', async () => {
      const { server, handlers } = makeStubServer();
      registerMovieRenderTools(server, mockBridge);
      const handler = handlers.get('ue_configure_render_output')!;
      await handler({
        sequence_path: '/Game/Cinematics/MySequence',
        filename_format: '{sequence_name}_{frame_number}',
        burn_in_text: { top_left: 'Shot' },
      });
      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'movierender.configure',
          payload: expect.objectContaining({
            sequence_path: '/Game/Cinematics/MySequence',
            filename_format: '{sequence_name}_{frame_number}',
            burn_in_text: { top_left: 'Shot' },
          }),
        })
      );
    });

    it('disconnect: returns plugin_not_connected error', async () => {
      mockBridge = makeMockBridge({ throwDisconnect: true });
      const { server, handlers } = makeStubServer();
      registerMovieRenderTools(server, mockBridge);
      const handler = handlers.get('ue_configure_render_output')!;
      const result = await handler({ sequence_path: '/Game/Cinematics/MySequence' }) as ToolResultShape;
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('plugin_not_connected');
    });

    it('command error job_not_found: returns isError true', async () => {
      mockBridge = makeMockBridge({ responseSuccess: false, responseError: 'job_not_found' });
      const { server, handlers } = makeStubServer();
      registerMovieRenderTools(server, mockBridge);
      const handler = handlers.get('ue_configure_render_output')!;
      const result = await handler({ sequence_path: '/Game/Cinematics/NonExistent' }) as ToolResultShape;
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('job_not_found');
    });
  });
});
