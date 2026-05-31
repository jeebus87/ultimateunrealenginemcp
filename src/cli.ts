#!/usr/bin/env node
// cli.ts — Entry point for `npx ultimate-unreal-engine-mcp`.
// Routes to setup (interactive installer) or starts the MCP server.

const command = process.argv[2];

if (command === 'setup') {
  // Dynamic import keeps the server code out of the setup path
  await import('./setup.js');
} else {
  // No subcommand or unknown — start the MCP server
  await import('./index.js');
}
