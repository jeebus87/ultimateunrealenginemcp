// tests/sequencer.test.ts
// Integration tests for Phase 13 sequencer tools.
// Uses mock PluginBridgeClient injected into registerSequencerTools.
// Does NOT spin up a real TCP server or real McpServer.

import { describe, it, expect, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PluginBridgeClient, PluginNotConnectedError } from '../src/plugin-bridge/client.js';
import { registerSequencerTools } from '../src/tools/sequencer/index.js';

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
// describe('sequencer tools')
// ---------------------------------------------------------------------------

describe('sequencer tools', () => {

  // -------------------------------------------------------------------------
  // ue_create_sequence
  // -------------------------------------------------------------------------
  describe('ue_create_sequence', () => {
    it('happy path: sends sequencer.create command with asset_path', async () => {
      const createData = { asset_path: '/Game/Cinematics/MySeq', created: true };
      const mockBridge = makeMockBridge({ responseData: createData });
      const { server, handlers } = makeStubServer();
      registerSequencerTools(server, mockBridge);

      const handler = handlers.get('ue_create_sequence')!;
      const result = await handler({ asset_path: '/Game/Cinematics/MySeq' }) as ToolResultShape;

      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'sequencer.create',
          payload: { asset_path: '/Game/Cinematics/MySeq' },
        })
      );
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.created).toBe(true);
      expect(parsed.asset_path).toBe('/Game/Cinematics/MySeq');
    });

    it('disconnected: returns isError:true with plugin_not_connected', async () => {
      const mockBridge = makeMockBridge({ throwDisconnect: true });
      const { server, handlers } = makeStubServer();
      registerSequencerTools(server, mockBridge);

      const handler = handlers.get('ue_create_sequence')!;
      const result = await handler({ asset_path: '/Game/Cinematics/MySeq' }) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('plugin_not_connected');
    });

    it('plugin command failure: returns isError:true with error string', async () => {
      const mockBridge = makeMockBridge({ responseSuccess: false, responseError: 'asset_already_exists' });
      const { server, handlers } = makeStubServer();
      registerSequencerTools(server, mockBridge);

      const handler = handlers.get('ue_create_sequence')!;
      const result = await handler({ asset_path: '/Game/Cinematics/MySeq' }) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('asset_already_exists');
    });
  });

  // -------------------------------------------------------------------------
  // ue_list_sequence_tracks
  // -------------------------------------------------------------------------
  describe('ue_list_sequence_tracks', () => {
    it('happy path: sends sequencer.tracks command and returns tracks array', async () => {
      const tracksData = {
        tracks: [
          { binding: 'Cube', track_type: 'transform', section_count: 1, key_count: 3 },
          { binding: 'Camera', track_type: 'float', section_count: 2, key_count: 10 },
        ],
      };
      const mockBridge = makeMockBridge({ responseData: tracksData });
      const { server, handlers } = makeStubServer();
      registerSequencerTools(server, mockBridge);

      const handler = handlers.get('ue_list_sequence_tracks')!;
      const result = await handler({ asset_path: '/Game/Cinematics/MySeq' }) as ToolResultShape;

      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'sequencer.tracks',
          payload: { asset_path: '/Game/Cinematics/MySeq' },
        })
      );
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(Array.isArray(parsed.tracks)).toBe(true);
      expect(parsed.tracks[0].binding).toBe('Cube');
      expect(parsed.tracks[0].track_type).toBe('transform');
    });

    it('disconnected: returns isError:true with plugin_not_connected', async () => {
      const mockBridge = makeMockBridge({ throwDisconnect: true });
      const { server, handlers } = makeStubServer();
      registerSequencerTools(server, mockBridge);

      const handler = handlers.get('ue_list_sequence_tracks')!;
      const result = await handler({ asset_path: '/Game/Cinematics/MySeq' }) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('plugin_not_connected');
    });

    it('plugin returns sequence_not_found error: returns isError:true', async () => {
      const mockBridge = makeMockBridge({ responseSuccess: false, responseError: 'sequence_not_found' });
      const { server, handlers } = makeStubServer();
      registerSequencerTools(server, mockBridge);

      const handler = handlers.get('ue_list_sequence_tracks')!;
      const result = await handler({ asset_path: '/Game/Cinematics/Missing' }) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('sequence_not_found');
    });
  });

  // -------------------------------------------------------------------------
  // ue_add_sequence_track
  // -------------------------------------------------------------------------
  describe('ue_add_sequence_track', () => {
    it('happy path transform track: sends sequencer.addTrack with correct payload and returns binding_guid', async () => {
      const addTrackData = { binding_guid: 'GUID-ABC-123', added: true };
      const mockBridge = makeMockBridge({ responseData: addTrackData });
      const { server, handlers } = makeStubServer();
      registerSequencerTools(server, mockBridge);

      const handler = handlers.get('ue_add_sequence_track')!;
      const result = await handler({
        asset_path: '/Game/Cinematics/MySeq',
        actor_label: 'Cube',
        track_type: 'transform',
      }) as ToolResultShape;

      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'sequencer.addTrack',
          payload: {
            asset_path: '/Game/Cinematics/MySeq',
            actor_label: 'Cube',
            track_type: 'transform',
          },
        })
      );
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.binding_guid).toBe('GUID-ABC-123');
    });

    it('happy path float track: sends sequencer.addTrack with track_type float', async () => {
      const mockBridge = makeMockBridge({ responseData: { binding_guid: 'GUID-DEF-456', added: true } });
      const { server, handlers } = makeStubServer();
      registerSequencerTools(server, mockBridge);

      const handler = handlers.get('ue_add_sequence_track')!;
      await handler({
        asset_path: '/Game/Cinematics/MySeq',
        actor_label: 'MyLight',
        track_type: 'float',
      });

      const call = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.payload.track_type).toBe('float');
      expect(call.payload.actor_label).toBe('MyLight');
    });

    it('disconnected: returns isError:true with plugin_not_connected', async () => {
      const mockBridge = makeMockBridge({ throwDisconnect: true });
      const { server, handlers } = makeStubServer();
      registerSequencerTools(server, mockBridge);

      const handler = handlers.get('ue_add_sequence_track')!;
      const result = await handler({
        asset_path: '/Game/Cinematics/MySeq',
        actor_label: 'Cube',
        track_type: 'transform',
      }) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('plugin_not_connected');
    });

    it('plugin returns actor_not_found error: returns isError:true', async () => {
      const mockBridge = makeMockBridge({ responseSuccess: false, responseError: 'actor_not_found' });
      const { server, handlers } = makeStubServer();
      registerSequencerTools(server, mockBridge);

      const handler = handlers.get('ue_add_sequence_track')!;
      const result = await handler({
        asset_path: '/Game/Cinematics/MySeq',
        actor_label: 'NonExistentActor',
        track_type: 'transform',
      }) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('actor_not_found');
    });
  });

  // -------------------------------------------------------------------------
  // ue_add_keyframe
  // -------------------------------------------------------------------------
  describe('ue_add_keyframe', () => {
    it('happy path without value: sends sequencer.addKey with asset_path, track_type, frame; no value key', async () => {
      const keyframeData = { added: true, frame: 30 };
      const mockBridge = makeMockBridge({ responseData: keyframeData });
      const { server, handlers } = makeStubServer();
      registerSequencerTools(server, mockBridge);

      const handler = handlers.get('ue_add_keyframe')!;
      const result = await handler({
        asset_path: '/Game/Cinematics/MySeq',
        track_type: 'transform',
        frame: 30,
      }) as ToolResultShape;

      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'sequencer.addKey',
          payload: {
            asset_path: '/Game/Cinematics/MySeq',
            track_type: 'transform',
            frame: 30,
          },
        })
      );
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.added).toBe(true);

      // value must NOT be in payload when not provided
      const call = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.payload).not.toHaveProperty('value');
    });

    it('happy path with float value: payload includes value', async () => {
      const mockBridge = makeMockBridge({ responseData: { added: true, frame: 0 } });
      const { server, handlers } = makeStubServer();
      registerSequencerTools(server, mockBridge);

      const handler = handlers.get('ue_add_keyframe')!;
      await handler({
        asset_path: '/Game/Cinematics/MySeq',
        track_type: 'float',
        frame: 0,
        value: 1.5,
      });

      const call = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.type).toBe('sequencer.addKey');
      expect(call.payload).toHaveProperty('value', 1.5);
    });

    it('disconnected: returns isError:true with plugin_not_connected', async () => {
      const mockBridge = makeMockBridge({ throwDisconnect: true });
      const { server, handlers } = makeStubServer();
      registerSequencerTools(server, mockBridge);

      const handler = handlers.get('ue_add_keyframe')!;
      const result = await handler({
        asset_path: '/Game/Cinematics/MySeq',
        track_type: 'float',
        frame: 10,
      }) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('plugin_not_connected');
    });

    it('plugin returns track_not_found error: returns isError:true', async () => {
      const mockBridge = makeMockBridge({ responseSuccess: false, responseError: 'track_not_found' });
      const { server, handlers } = makeStubServer();
      registerSequencerTools(server, mockBridge);

      const handler = handlers.get('ue_add_keyframe')!;
      const result = await handler({
        asset_path: '/Game/Cinematics/MySeq',
        track_type: 'float',
        frame: 5,
      }) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('track_not_found');
    });
  });

  // -------------------------------------------------------------------------
  // ue_sequence_playback
  // -------------------------------------------------------------------------
  describe('ue_sequence_playback', () => {
    it('play action: sends sequencer.playback with action:play and returns current_frame', async () => {
      const playbackData = { current_frame: 0, playing: true };
      const mockBridge = makeMockBridge({ responseData: playbackData });
      const { server, handlers } = makeStubServer();
      registerSequencerTools(server, mockBridge);

      const handler = handlers.get('ue_sequence_playback')!;
      const result = await handler({
        asset_path: '/Game/Cinematics/MySeq',
        action: 'play',
      }) as ToolResultShape;

      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'sequencer.playback',
          payload: { asset_path: '/Game/Cinematics/MySeq', action: 'play' },
        })
      );
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.current_frame).toBe(0);

      // frame must NOT be in payload when not provided
      const call = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.payload).not.toHaveProperty('frame');
    });

    it('scrub action with frame: payload contains frame', async () => {
      const mockBridge = makeMockBridge({ responseData: { current_frame: 60, playing: false } });
      const { server, handlers } = makeStubServer();
      registerSequencerTools(server, mockBridge);

      const handler = handlers.get('ue_sequence_playback')!;
      await handler({
        asset_path: '/Game/Cinematics/MySeq',
        action: 'scrub',
        frame: 60,
      });

      const call = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.type).toBe('sequencer.playback');
      expect(call.payload).toHaveProperty('action', 'scrub');
      expect(call.payload).toHaveProperty('frame', 60);
    });

    it('pause action: payload contains action:pause, no frame', async () => {
      const mockBridge = makeMockBridge({ responseData: { current_frame: 30, playing: false } });
      const { server, handlers } = makeStubServer();
      registerSequencerTools(server, mockBridge);

      const handler = handlers.get('ue_sequence_playback')!;
      await handler({
        asset_path: '/Game/Cinematics/MySeq',
        action: 'pause',
      });

      const call = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.payload.action).toBe('pause');
      expect(call.payload).not.toHaveProperty('frame');
    });

    it('stop action: sendCommand called with action:stop', async () => {
      const mockBridge = makeMockBridge({ responseData: { current_frame: 0, playing: false } });
      const { server, handlers } = makeStubServer();
      registerSequencerTools(server, mockBridge);

      const handler = handlers.get('ue_sequence_playback')!;
      await handler({
        asset_path: '/Game/Cinematics/MySeq',
        action: 'stop',
      });

      const call = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.payload.action).toBe('stop');
    });

    it('disconnected: returns isError:true with plugin_not_connected', async () => {
      const mockBridge = makeMockBridge({ throwDisconnect: true });
      const { server, handlers } = makeStubServer();
      registerSequencerTools(server, mockBridge);

      const handler = handlers.get('ue_sequence_playback')!;
      const result = await handler({
        asset_path: '/Game/Cinematics/MySeq',
        action: 'play',
      }) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('plugin_not_connected');
    });

    it('plugin command failure: returns isError:true with error string', async () => {
      const mockBridge = makeMockBridge({ responseSuccess: false, responseError: 'sequence_not_loaded' });
      const { server, handlers } = makeStubServer();
      registerSequencerTools(server, mockBridge);

      const handler = handlers.get('ue_sequence_playback')!;
      const result = await handler({
        asset_path: '/Game/Cinematics/MySeq',
        action: 'play',
      }) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('sequence_not_loaded');
    });
  });

  // -------------------------------------------------------------------------
  // Structural checks
  // -------------------------------------------------------------------------
  describe('tool registration', () => {
    it('registers exactly five tools', () => {
      const mockBridge = makeMockBridge({});
      const { server, handlers } = makeStubServer();
      registerSequencerTools(server, mockBridge);

      expect(handlers.size).toBe(5);
    });

    it('registers all expected tool names', () => {
      const mockBridge = makeMockBridge({});
      const { server, handlers } = makeStubServer();
      registerSequencerTools(server, mockBridge);

      const expectedTools = [
        'ue_create_sequence',
        'ue_list_sequence_tracks',
        'ue_add_sequence_track',
        'ue_add_keyframe',
        'ue_sequence_playback',
      ];
      for (const name of expectedTools) {
        expect(handlers.has(name), `Tool "${name}" should be registered`).toBe(true);
      }
    });

    it('all playback actions accepted: play, pause, stop, scrub', async () => {
      const actions = ['play', 'pause', 'stop', 'scrub'];
      for (const action of actions) {
        const mockBridge = makeMockBridge({ responseData: { current_frame: 0 } });
        const { server, handlers } = makeStubServer();
        registerSequencerTools(server, mockBridge);

        const handler = handlers.get('ue_sequence_playback')!;
        const args = action === 'scrub'
          ? { asset_path: '/Game/Cinematics/MySeq', action, frame: 0 }
          : { asset_path: '/Game/Cinematics/MySeq', action };
        const result = await handler(args) as ToolResultShape;
        expect(result.isError).toBeFalsy();
      }
    });

    it('both track types accepted: transform, float', async () => {
      const trackTypes = ['transform', 'float'];
      for (const track_type of trackTypes) {
        const mockBridge = makeMockBridge({ responseData: { binding_guid: 'G', added: true } });
        const { server, handlers } = makeStubServer();
        registerSequencerTools(server, mockBridge);

        const handler = handlers.get('ue_add_sequence_track')!;
        const result = await handler({
          asset_path: '/Game/Cinematics/MySeq',
          actor_label: 'Actor',
          track_type,
        }) as ToolResultShape;
        expect(result.isError).toBeFalsy();
      }
    });
  });
});
