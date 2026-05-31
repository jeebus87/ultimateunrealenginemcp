// Tests for INF-01: Tool registry auto-discovery via domain module pattern
// Implementation: src/tools/*/index.ts

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerKnownIssuesTools } from '../src/tools/known-issues/index.js';
import { registerCppTools } from '../src/tools/cpp/index.js';
import { registerConfigTools } from '../src/tools/config/index.js';
import { registerDocsTools } from '../src/tools/docs/index.js';
import { registerBuildTools } from '../src/tools/build/index.js';
import { registerBlueprintTools } from '../src/tools/blueprint/index.js';
import { registerEditorTools } from '../src/tools/editor/index.js';

describe('Tool registry auto-discovery', () => {
  it('registerKnownIssuesTools is a function', () => {
    expect(typeof registerKnownIssuesTools).toBe('function');
  });

  it('registerCppTools is a function', () => {
    expect(typeof registerCppTools).toBe('function');
  });

  it('registerConfigTools is a function', () => {
    expect(typeof registerConfigTools).toBe('function');
  });

  it('registerDocsTools is a function', () => {
    expect(typeof registerDocsTools).toBe('function');
  });

  it('registerBuildTools is a function', () => {
    expect(typeof registerBuildTools).toBe('function');
  });

  it('registerBlueprintTools is a function', () => {
    expect(typeof registerBlueprintTools).toBe('function');
  });

  it('registerEditorTools is a function', () => {
    expect(typeof registerEditorTools).toBe('function');
  });
});

describe('Tool registration', () => {
  it('known-issues tools register on server without error', () => {
    const server = new McpServer({ name: 'test', version: '0.1.0' });
    expect(() => registerKnownIssuesTools(server)).not.toThrow();
  });

  it('cpp stub tools register on server without error', () => {
    const server = new McpServer({ name: 'test', version: '0.1.0' });
    expect(() => registerCppTools(server)).not.toThrow();
  });

  it('config stub tools register on server without error', () => {
    const server = new McpServer({ name: 'test', version: '0.1.0' });
    expect(() => registerConfigTools(server)).not.toThrow();
  });

  it('docs stub tools register on server without error', () => {
    const server = new McpServer({ name: 'test', version: '0.1.0' });
    expect(() => registerDocsTools(server)).not.toThrow();
  });

  it('build stub tools register on server without error', () => {
    const server = new McpServer({ name: 'test', version: '0.1.0' });
    expect(() => registerBuildTools(server)).not.toThrow();
  });

  it('blueprint stub tools register on server without error', () => {
    const server = new McpServer({ name: 'test', version: '0.1.0' });
    expect(() => registerBlueprintTools(server)).not.toThrow();
  });

  it('editor stub tools register on server without error', () => {
    const server = new McpServer({ name: 'test', version: '0.1.0' });
    expect(() => registerEditorTools(server)).not.toThrow();
  });

  it('all 7 domain modules register together on a single server without conflict', () => {
    const server = new McpServer({ name: 'test', version: '0.1.0' });
    expect(() => {
      registerKnownIssuesTools(server);
      registerCppTools(server);
      registerConfigTools(server);
      registerDocsTools(server);
      registerBuildTools(server);
      registerBlueprintTools(server);
      registerEditorTools(server);
    }).not.toThrow();
  });
});
