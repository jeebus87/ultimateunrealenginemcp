// Tests for INF-01: MCP server startup and tool registration via stdio transport
// Implementation: src/index.ts

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerKnownIssuesTools } from '../src/tools/known-issues/index.js';
import { registerCppTools } from '../src/tools/cpp/index.js';
import { registerConfigTools } from '../src/tools/config/index.js';
import { registerDocsTools } from '../src/tools/docs/index.js';
import { registerBuildTools } from '../src/tools/build/index.js';
import { registerBlueprintTools } from '../src/tools/blueprint/index.js';
import { registerEditorTools } from '../src/tools/editor/index.js';

describe('MCP Server startup', () => {
  it('McpServer can be instantiated with name and version', () => {
    const server = new McpServer({
      name: 'ultimate-unreal-engine-mcp',
      version: '0.1.0',
    });
    expect(server).toBeDefined();
  });

  it('all 7 registerXxxTools functions can be called without throwing', () => {
    const server = new McpServer({ name: 'test-server', version: '0.1.0' });
    expect(() => registerKnownIssuesTools(server)).not.toThrow();
    expect(() => registerCppTools(server)).not.toThrow();
    expect(() => registerConfigTools(server)).not.toThrow();
    expect(() => registerDocsTools(server)).not.toThrow();
    expect(() => registerBuildTools(server)).not.toThrow();
    expect(() => registerBlueprintTools(server)).not.toThrow();
    expect(() => registerEditorTools(server)).not.toThrow();
  });
});

describe('MCP Server tool listing', () => {
  it('server is defined after all domain registrations', () => {
    const server = new McpServer({ name: 'test-server', version: '0.1.0' });
    registerKnownIssuesTools(server);
    registerCppTools(server);
    registerConfigTools(server);
    registerDocsTools(server);
    registerBuildTools(server);
    registerBlueprintTools(server);
    registerEditorTools(server);
    // Server object exists and is not null after full registration
    expect(server).toBeDefined();
    expect(server).not.toBeNull();
  });
});
