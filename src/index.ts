// src/index.ts
// MCP server entry point for the Ultimate Unreal Engine MCP.
// Registers all domain tool modules and connects the StdioServerTransport.
//
// Logging: ALL output goes to stderr via logger.ts — never console.log.
// Reason: stdout is the MCP JSON-RPC channel; any non-JSON stdout output
// corrupts the protocol stream and disconnects the client (PITFALLS.md Pitfall 8).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { SERVER_VERSION, PLUGIN_PORT } from './config.js';
import { log } from './utils/logger.js';

import { registerKnownIssuesTools } from './tools/known-issues/index.js';
import { registerCppTools } from './tools/cpp/index.js';
import { registerConfigTools } from './tools/config/index.js';
import { registerDocsTools } from './tools/docs/index.js';
import { registerBuildTools } from './tools/build/index.js';
import { registerBlueprintTools } from './tools/blueprint/index.js';
import { registerEditorTools } from './tools/editor/index.js';
import { registerViewportTools } from './tools/viewport/index.js';
import { registerSequencerTools } from './tools/sequencer/index.js';
import { registerInputTools } from './tools/input/index.js';
import { registerMaterialTools } from './tools/material/index.js';
import { registerValidationTools } from './tools/validation/index.js';
import { registerAnimationTools } from './tools/animation/index.js';
import { registerWorldPartitionTools } from './tools/worldpartition/index.js';
import { registerSelectionTools } from './tools/selection/index.js';
import { registerCollisionPhysicsTools } from './tools/collision-physics/index.js';
import { registerImportExportTools } from './tools/import-export/index.js';
import { registerAISystemsTools } from './tools/ai-systems/index.js';
import { registerLiveLinkTools } from './tools/livelink/index.js';
import { registerAudioTools } from './tools/audio/index.js';
import { registerPCGTools } from './tools/pcg/index.js';
import { registerGASTools } from './tools/gas/index.js';
import { registerChaosTools } from './tools/chaos/index.js';
import { registerMotionDesignTools } from './tools/motion-design/index.js';
import { registerMovieRenderTools } from './tools/movie-render/index.js';
import { registerNetworkingTools } from './tools/networking/index.js';

// ---------------------------------------------------------------------------
// Main async IIFE — wraps the full startup sequence.
// Any unhandled error triggers a clean process.exit(1) with a stderr message.
// ---------------------------------------------------------------------------

(async () => {
  log('Starting ultimate-unreal-engine-mcp v' + SERVER_VERSION);
  log('Plugin connection will be attempted on port ' + PLUGIN_PORT);

  const server = new McpServer({
    name: 'ultimate-unreal-engine-mcp',
    version: SERVER_VERSION,
  });

  // Register all domain tool modules in dependency order:
  // 1. KNOWN_ISSUES tools (infrastructure — must come first so other tools can surface issues)
  // 2. File-system tool domains (no plugin dependency)
  // 3. Plugin-dependent tool domains (return structured errors when plugin is absent)
  registerKnownIssuesTools(server);
  registerCppTools(server);
  registerConfigTools(server);
  registerDocsTools(server);
  registerBuildTools(server);
  registerBlueprintTools(server);
  registerEditorTools(server);
  registerViewportTools(server);
  registerSequencerTools(server);
  registerInputTools(server);
  registerMaterialTools(server); // Material & Shader tools (Phase 15)
  // Validation tools (VAL-01..04)
  registerValidationTools(server);
  registerAnimationTools(server); // Animation tools (ANIM-01..05)
  registerWorldPartitionTools(server); // World Partition tools (WP-01..04)
  registerSelectionTools(server); // Selection tools (SEL-01..04)
  registerCollisionPhysicsTools(server); // Collision & Physics tools (PHY-01..04)
  registerImportExportTools(server); // Import/Export tools (IMP-01..04)
  registerAISystemsTools(server); // AI system tools (AI-01..05)
  registerLiveLinkTools(server); // Live Link tools (LL-01..04)
  registerAudioTools(server); // Audio tools (AUD-01..04)
  registerPCGTools(server); // PCG Framework tools (PCG-01..04)
  registerGASTools(server); // GAS tools (GAS-01..04)
  registerChaosTools(server); // Chaos physics tools (CHAOS-01..04)
  registerMotionDesignTools(server); // Motion Design tools (MD-01..04)
  registerMovieRenderTools(server); // Movie Render Pipeline tools (MRP-01..04)
  registerNetworkingTools(server); // Networking & Replication tools (NET-01..04)

  const transport = new StdioServerTransport();
  await server.connect(transport);

  log('Server ready — connected via stdio');
})().catch((err: unknown) => {
  // Fatal startup error — log to stderr and exit with non-zero code.
  // Do NOT rethrow: unhandled rejection leaves the process in limbo,
  // which can cause the MCP host to wait indefinitely for a response.
  console.error('[UE MCP] Fatal startup error:', err);
  process.exit(1);
});
