// tests/import-export-tools.test.ts
// Integration tests for Phase 21 import/export tools. Uses mock PluginBridgeClient
// injected into registerImportExportTools.
//
// Port assignments (project-wide reference):
//   55557 — real UE Editor plugin (not running in tests)
//   55560 — plugin-bridge.test.ts mock server
//   55561 — blueprint-tools.test.ts mock server
//   55562 — bridge-cpp-tools.test.ts mock server
//   55563 — blueprint-write-tools.test.ts mock server
//   55564 — validation-tools.test.ts mock server
//   55565 — animation-tools.test.ts (reserved, not currently used)
//   55566 — reserved for this file (not currently used)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PluginBridgeClient, PluginNotConnectedError } from '../src/plugin-bridge/client.js';
import { registerImportExportTools } from '../src/tools/import-export/index.js';

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
// describe('import-export tools')
// ---------------------------------------------------------------------------

describe('import-export tools', () => {

  // -------------------------------------------------------------------------
  // ue_import_fbx
  // -------------------------------------------------------------------------
  describe('ue_import_fbx', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('sends import.fbx command with correct payload', async () => {
      const mockBridge = makeMockBridge({ responseData: { assets: ['/Game/Meshes/Chair'], count: 1 } });
      const { server, handlers } = makeStubServer();
      registerImportExportTools(server, mockBridge);

      const handler = handlers.get('ue_import_fbx')!;
      await handler({
        source_file: 'C:/Assets/Chair.fbx',
        dest_path: '/Game/Meshes',
        import_materials: true,
        combine_meshes: false,
        scale_factor: 1.0,
      });

      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'import.fbx',
          payload: expect.objectContaining({
            source_file: 'C:/Assets/Chair.fbx',
            dest_path: '/Game/Meshes',
            import_materials: true,
            combine_meshes: false,
            scale_factor: 1.0,
          }),
        })
      );
    });

    it('returns created asset paths on success', async () => {
      const mockBridge = makeMockBridge({ responseData: { assets: ['/Game/Meshes/Chair'], count: 1 } });
      const { server, handlers } = makeStubServer();
      registerImportExportTools(server, mockBridge);

      const handler = handlers.get('ue_import_fbx')!;
      const result = await handler({
        source_file: 'C:/Assets/Chair.fbx',
        dest_path: '/Game/Meshes',
      }) as ToolResultShape;

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(Array.isArray(parsed.assets)).toBe(true);
      expect(parsed.assets[0]).toBe('/Game/Meshes/Chair');
      expect(parsed.count).toBe(1);
    });

    it('passes default import_materials=true when omitted', async () => {
      // Zod applies defaults before the handler is called; simulate that here by
      // including the Zod default values that the real MCP server would inject.
      const mockBridge = makeMockBridge({ responseData: { assets: [], count: 0 } });
      const { server, handlers } = makeStubServer();
      registerImportExportTools(server, mockBridge);

      const handler = handlers.get('ue_import_fbx')!;
      await handler({
        source_file: 'C:/Assets/Table.fbx',
        dest_path: '/Game/Meshes',
        import_materials: true,  // Zod default
        combine_meshes: false,   // Zod default
        scale_factor: 1.0,       // Zod default
      });

      const callPayload = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0].payload;
      expect(callPayload.import_materials).toBe(true);
    });

    it('passes default scale_factor=1.0 when omitted', async () => {
      // Zod applies defaults before the handler is called; simulate that here.
      const mockBridge = makeMockBridge({ responseData: { assets: [], count: 0 } });
      const { server, handlers } = makeStubServer();
      registerImportExportTools(server, mockBridge);

      const handler = handlers.get('ue_import_fbx')!;
      await handler({
        source_file: 'C:/Assets/Table.fbx',
        dest_path: '/Game/Meshes',
        import_materials: true,  // Zod default
        combine_meshes: false,   // Zod default
        scale_factor: 1.0,       // Zod default
      });

      const callPayload = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0].payload;
      expect(callPayload.scale_factor).toBe(1);
    });

    it('returns isError on command failure', async () => {
      const mockBridge = makeMockBridge({ responseSuccess: false, responseError: 'file_not_found' });
      const { server, handlers } = makeStubServer();
      registerImportExportTools(server, mockBridge);

      const handler = handlers.get('ue_import_fbx')!;
      const result = await handler({
        source_file: 'C:/Assets/Missing.fbx',
        dest_path: '/Game/Meshes',
      }) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('file_not_found');
    });

    it('returns plugin_not_connected when bridge disconnected', async () => {
      const mockBridge = makeMockBridge({ throwDisconnect: true });
      const { server, handlers } = makeStubServer();
      registerImportExportTools(server, mockBridge);

      const handler = handlers.get('ue_import_fbx')!;
      const result = await handler({
        source_file: 'C:/Assets/Chair.fbx',
        dest_path: '/Game/Meshes',
      }) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('plugin_not_connected');
      expect(parsed.required_plugin).toBe(true);
    });

    it('passes combine_meshes=true when specified', async () => {
      const mockBridge = makeMockBridge({ responseData: { assets: ['/Game/Meshes/Combined'], count: 1 } });
      const { server, handlers } = makeStubServer();
      registerImportExportTools(server, mockBridge);

      const handler = handlers.get('ue_import_fbx')!;
      await handler({
        source_file: 'C:/Assets/Multi.fbx',
        dest_path: '/Game/Meshes',
        combine_meshes: true,
      });

      const callPayload = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0].payload;
      expect(callPayload.combine_meshes).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // ue_import_usd
  // -------------------------------------------------------------------------
  describe('ue_import_usd', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('sends import.usd command with source_file and dest_path', async () => {
      const mockBridge = makeMockBridge({ responseData: { assets: ['/Game/USD/Scene'], count: 1 } });
      const { server, handlers } = makeStubServer();
      registerImportExportTools(server, mockBridge);

      const handler = handlers.get('ue_import_usd')!;
      await handler({ source_file: 'C:/Assets/Scene.usd', dest_path: '/Game/USD' });

      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'import.usd',
          payload: expect.objectContaining({
            source_file: 'C:/Assets/Scene.usd',
            dest_path: '/Game/USD',
          }),
        })
      );
    });

    it('returns created asset paths on success', async () => {
      const mockBridge = makeMockBridge({ responseData: { assets: ['/Game/USD/Scene', '/Game/USD/Materials/M_Wood'], count: 2 } });
      const { server, handlers } = makeStubServer();
      registerImportExportTools(server, mockBridge);

      const handler = handlers.get('ue_import_usd')!;
      const result = await handler({ source_file: 'C:/Assets/Scene.usd', dest_path: '/Game/USD' }) as ToolResultShape;

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(Array.isArray(parsed.assets)).toBe(true);
      expect(parsed.count).toBe(2);
      expect(parsed.assets).toContain('/Game/USD/Scene');
    });

    it('returns isError on command failure', async () => {
      const mockBridge = makeMockBridge({ responseSuccess: false, responseError: 'interchange_unavailable' });
      const { server, handlers } = makeStubServer();
      registerImportExportTools(server, mockBridge);

      const handler = handlers.get('ue_import_usd')!;
      const result = await handler({ source_file: 'C:/Assets/Scene.usd', dest_path: '/Game/USD' }) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('interchange_unavailable');
    });

    it('returns plugin_not_connected when bridge disconnected', async () => {
      const mockBridge = makeMockBridge({ throwDisconnect: true });
      const { server, handlers } = makeStubServer();
      registerImportExportTools(server, mockBridge);

      const handler = handlers.get('ue_import_usd')!;
      const result = await handler({ source_file: 'C:/Assets/Scene.usd', dest_path: '/Game/USD' }) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('plugin_not_connected');
      expect(parsed.required_plugin).toBe(true);
    });

    it('handles .usda file extension', async () => {
      const mockBridge = makeMockBridge({ responseData: { assets: ['/Game/USD/SceneA'], count: 1 } });
      const { server, handlers } = makeStubServer();
      registerImportExportTools(server, mockBridge);

      const handler = handlers.get('ue_import_usd')!;
      await handler({ source_file: 'C:/Assets/SceneA.usda', dest_path: '/Game/USD' });

      const callPayload = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0].payload;
      expect(callPayload.source_file).toBe('C:/Assets/SceneA.usda');
    });
  });

  // -------------------------------------------------------------------------
  // ue_export_mesh
  // -------------------------------------------------------------------------
  describe('ue_export_mesh', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('sends export.mesh command with asset_path and output_file', async () => {
      const mockBridge = makeMockBridge({
        responseData: { output_file: 'C:/exports/mesh.fbx', exported: true, asset_class: 'StaticMesh' },
      });
      const { server, handlers } = makeStubServer();
      registerImportExportTools(server, mockBridge);

      const handler = handlers.get('ue_export_mesh')!;
      await handler({ asset_path: '/Game/Meshes/Chair', output_file: 'C:/exports/mesh.fbx' });

      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'export.mesh',
          payload: expect.objectContaining({
            asset_path: '/Game/Meshes/Chair',
            output_file: 'C:/exports/mesh.fbx',
          }),
        })
      );
    });

    it('returns exported file path on success', async () => {
      const mockBridge = makeMockBridge({
        responseData: { output_file: 'C:/exports/mesh.fbx', exported: true, asset_class: 'StaticMesh' },
      });
      const { server, handlers } = makeStubServer();
      registerImportExportTools(server, mockBridge);

      const handler = handlers.get('ue_export_mesh')!;
      const result = await handler({ asset_path: '/Game/Meshes/Chair', output_file: 'C:/exports/mesh.fbx' }) as ToolResultShape;

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.output_file).toBe('C:/exports/mesh.fbx');
      expect(parsed.exported).toBe(true);
      expect(parsed.asset_class).toBe('StaticMesh');
    });

    it('passes default export_collision=false', async () => {
      // Zod applies defaults before the handler is called; simulate that here.
      const mockBridge = makeMockBridge({
        responseData: { output_file: 'C:/exports/mesh.fbx', exported: true, asset_class: 'StaticMesh' },
      });
      const { server, handlers } = makeStubServer();
      registerImportExportTools(server, mockBridge);

      const handler = handlers.get('ue_export_mesh')!;
      await handler({
        asset_path: '/Game/Meshes/Chair',
        output_file: 'C:/exports/mesh.fbx',
        export_collision: false,  // Zod default
        level_of_detail: 0,       // Zod default
      });

      const callPayload = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0].payload;
      expect(callPayload.export_collision).toBe(false);
    });

    it('passes default level_of_detail=0', async () => {
      // Zod applies defaults before the handler is called; simulate that here.
      const mockBridge = makeMockBridge({
        responseData: { output_file: 'C:/exports/mesh.fbx', exported: true, asset_class: 'StaticMesh' },
      });
      const { server, handlers } = makeStubServer();
      registerImportExportTools(server, mockBridge);

      const handler = handlers.get('ue_export_mesh')!;
      await handler({
        asset_path: '/Game/Meshes/Chair',
        output_file: 'C:/exports/mesh.fbx',
        export_collision: false,  // Zod default
        level_of_detail: 0,       // Zod default
      });

      const callPayload = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0].payload;
      expect(callPayload.level_of_detail).toBe(0);
    });

    it('passes custom export_collision=true', async () => {
      const mockBridge = makeMockBridge({
        responseData: { output_file: 'C:/exports/mesh.fbx', exported: true, asset_class: 'StaticMesh' },
      });
      const { server, handlers } = makeStubServer();
      registerImportExportTools(server, mockBridge);

      const handler = handlers.get('ue_export_mesh')!;
      await handler({
        asset_path: '/Game/Meshes/Chair',
        output_file: 'C:/exports/mesh.fbx',
        export_collision: true,
      });

      const callPayload = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0].payload;
      expect(callPayload.export_collision).toBe(true);
    });

    it('returns isError on command failure', async () => {
      const mockBridge = makeMockBridge({ responseSuccess: false, responseError: 'asset_not_found' });
      const { server, handlers } = makeStubServer();
      registerImportExportTools(server, mockBridge);

      const handler = handlers.get('ue_export_mesh')!;
      const result = await handler({
        asset_path: '/Game/Meshes/Missing',
        output_file: 'C:/exports/missing.fbx',
      }) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('asset_not_found');
    });

    it('returns plugin_not_connected when bridge disconnected', async () => {
      const mockBridge = makeMockBridge({ throwDisconnect: true });
      const { server, handlers } = makeStubServer();
      registerImportExportTools(server, mockBridge);

      const handler = handlers.get('ue_export_mesh')!;
      const result = await handler({
        asset_path: '/Game/Meshes/Chair',
        output_file: 'C:/exports/mesh.fbx',
      }) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('plugin_not_connected');
      expect(parsed.required_plugin).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // ue_batch_import
  // -------------------------------------------------------------------------
  describe('ue_batch_import', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('sends import.batch command with directory, extensions, and dest_path', async () => {
      const mockBridge = makeMockBridge({
        responseData: { assets: ['/Game/Meshes/A', '/Game/Meshes/B', '/Game/Meshes/C'], count: 3, files_processed: 3, errors: [] },
      });
      const { server, handlers } = makeStubServer();
      registerImportExportTools(server, mockBridge);

      const handler = handlers.get('ue_batch_import')!;
      await handler({
        directory: 'C:/Assets/Batch',
        extensions: ['fbx', 'obj'],
        dest_path: '/Game/Meshes',
      });

      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'import.batch',
          payload: expect.objectContaining({
            directory: 'C:/Assets/Batch',
            extensions: ['fbx', 'obj'],
            dest_path: '/Game/Meshes',
          }),
        })
      );
    });

    it('returns batch import results on success', async () => {
      const mockBridge = makeMockBridge({
        responseData: { assets: ['/Game/Meshes/A', '/Game/Meshes/B', '/Game/Meshes/C'], count: 3, files_processed: 3, errors: [] },
      });
      const { server, handlers } = makeStubServer();
      registerImportExportTools(server, mockBridge);

      const handler = handlers.get('ue_batch_import')!;
      const result = await handler({
        directory: 'C:/Assets/Batch',
        dest_path: '/Game/Meshes',
      }) as ToolResultShape;

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(Array.isArray(parsed.assets)).toBe(true);
      expect(parsed.count).toBe(3);
      expect(parsed.files_processed).toBe(3);
      expect(Array.isArray(parsed.errors)).toBe(true);
      expect(parsed.errors).toHaveLength(0);
    });

    it("passes default extensions=['fbx'] when omitted", async () => {
      // Zod applies defaults before the handler is called; simulate that here.
      const mockBridge = makeMockBridge({ responseData: { assets: [], count: 0, files_processed: 0, errors: [] } });
      const { server, handlers } = makeStubServer();
      registerImportExportTools(server, mockBridge);

      const handler = handlers.get('ue_batch_import')!;
      await handler({
        directory: 'C:/Assets/Batch',
        dest_path: '/Game/Meshes',
        extensions: ['fbx'],         // Zod default
        import_materials: true,      // Zod default
        scale_factor: 1.0,           // Zod default
      });

      const callPayload = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0].payload;
      expect(Array.isArray(callPayload.extensions)).toBe(true);
      expect(callPayload.extensions).toEqual(['fbx']);
    });

    it('passes default import_materials=true', async () => {
      // Zod applies defaults before the handler is called; simulate that here.
      const mockBridge = makeMockBridge({ responseData: { assets: [], count: 0, files_processed: 0, errors: [] } });
      const { server, handlers } = makeStubServer();
      registerImportExportTools(server, mockBridge);

      const handler = handlers.get('ue_batch_import')!;
      await handler({
        directory: 'C:/Assets/Batch',
        dest_path: '/Game/Meshes',
        extensions: ['fbx'],         // Zod default
        import_materials: true,      // Zod default
        scale_factor: 1.0,           // Zod default
      });

      const callPayload = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0].payload;
      expect(callPayload.import_materials).toBe(true);
    });

    it('passes default scale_factor=1.0', async () => {
      // Zod applies defaults before the handler is called; simulate that here.
      const mockBridge = makeMockBridge({ responseData: { assets: [], count: 0, files_processed: 0, errors: [] } });
      const { server, handlers } = makeStubServer();
      registerImportExportTools(server, mockBridge);

      const handler = handlers.get('ue_batch_import')!;
      await handler({
        directory: 'C:/Assets/Batch',
        dest_path: '/Game/Meshes',
        extensions: ['fbx'],         // Zod default
        import_materials: true,      // Zod default
        scale_factor: 1.0,           // Zod default
      });

      const callPayload = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0].payload;
      expect(callPayload.scale_factor).toBe(1);
    });

    it('passes custom extensions array', async () => {
      const mockBridge = makeMockBridge({ responseData: { assets: [], count: 0, files_processed: 0, errors: [] } });
      const { server, handlers } = makeStubServer();
      registerImportExportTools(server, mockBridge);

      const handler = handlers.get('ue_batch_import')!;
      await handler({
        directory: 'C:/Assets/Multi',
        extensions: ['fbx', 'obj', 'usd'],
        dest_path: '/Game/Meshes',
      });

      const callPayload = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0].payload;
      expect(callPayload.extensions).toEqual(['fbx', 'obj', 'usd']);
    });

    it('returns isError on command failure', async () => {
      const mockBridge = makeMockBridge({ responseSuccess: false, responseError: 'directory_not_found' });
      const { server, handlers } = makeStubServer();
      registerImportExportTools(server, mockBridge);

      const handler = handlers.get('ue_batch_import')!;
      const result = await handler({
        directory: 'C:/Assets/Missing',
        dest_path: '/Game/Meshes',
      }) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('directory_not_found');
    });

    it('returns plugin_not_connected when bridge disconnected', async () => {
      const mockBridge = makeMockBridge({ throwDisconnect: true });
      const { server, handlers } = makeStubServer();
      registerImportExportTools(server, mockBridge);

      const handler = handlers.get('ue_batch_import')!;
      const result = await handler({
        directory: 'C:/Assets/Batch',
        dest_path: '/Game/Meshes',
      }) as ToolResultShape;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('plugin_not_connected');
      expect(parsed.required_plugin).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // tool registration
  // -------------------------------------------------------------------------
  describe('tool registration', () => {
    it('registers all four tools', () => {
      const mockBridge = makeMockBridge({});
      const { server, handlers } = makeStubServer();
      registerImportExportTools(server, mockBridge);

      expect(handlers.size).toBeGreaterThanOrEqual(4);
      expect(handlers.has('ue_import_fbx')).toBe(true);
      expect(handlers.has('ue_import_usd')).toBe(true);
      expect(handlers.has('ue_export_mesh')).toBe(true);
      expect(handlers.has('ue_batch_import')).toBe(true);
    });

    it('uses provided bridge instance', async () => {
      const mockBridge = makeMockBridge({ responseData: { assets: [], count: 0, files_processed: 0, errors: [] } });
      const { server, handlers } = makeStubServer();
      registerImportExportTools(server, mockBridge);

      const handler = handlers.get('ue_batch_import')!;
      await handler({ directory: 'C:/Assets/Batch', dest_path: '/Game/Meshes' });

      expect(mockBridge.sendCommand).toHaveBeenCalledTimes(1);
    });
  });

});
