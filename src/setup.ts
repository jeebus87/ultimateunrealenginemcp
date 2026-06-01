#!/usr/bin/env node
// setup.ts — One-command installer for Ultimate Unreal Engine MCP.
// Automatically configures Claude Desktop, Claude Code, or Cursor to use this server.
//
// Usage:
//   npx ultimate-unreal-engine-mcp setup
//   npx ultimate-unreal-engine-mcp setup --project "C:/MyGame"
//   npx ultimate-unreal-engine-mcp setup --client claude-code
//   npx ultimate-unreal-engine-mcp setup --port 55557

import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { platform, env } from 'node:process';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg: string): void {
  console.error(msg);
}

function getConfigPath(client: string): string {
  const home = env['USERPROFILE'] || env['HOME'] || '';

  switch (client) {
    case 'claude-desktop':
      if (platform === 'win32') {
        return join(env['APPDATA'] || join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
      }
      return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');

    case 'claude-code':
      return join(home, '.claude.json');

    case 'cursor':
      if (platform === 'win32') {
        return join(env['APPDATA'] || join(home, 'AppData', 'Roaming'), 'Cursor', 'User', 'globalStorage', 'cursor.mcp', 'config.json');
      }
      return join(home, '.config', 'cursor', 'mcp.json');

    default:
      return '';
  }
}

function parseArgs(argv: string[]): { project: string; client: string; port: number; pluginOnly: boolean } {
  let project = '';
  let client = 'claude-desktop';
  let port = 55557;
  let pluginOnly = false;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--project' && argv[i + 1]) {
      project = argv[++i];
    } else if (argv[i] === '--client' && argv[i + 1]) {
      client = argv[++i];
    } else if (argv[i] === '--port' && argv[i + 1]) {
      port = parseInt(argv[++i], 10);
    } else if (argv[i] === '--plugin-only') {
      pluginOnly = true;
    }
  }

  return { project, client, port, pluginOnly };
}

// ---------------------------------------------------------------------------
// Plugin installer
// ---------------------------------------------------------------------------

function installPlugin(projectRoot: string): boolean {
  const pluginSrc = join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), '..', 'unreal-plugin', 'MCPBridge');
  const pluginDest = join(projectRoot, 'Plugins', 'MCPBridge');

  if (!existsSync(pluginSrc)) {
    log(`  Plugin source not found at ${pluginSrc}`);
    log('  You may need to copy unreal-plugin/MCPBridge/ manually.');
    return false;
  }

  if (existsSync(pluginDest)) {
    log(`  Plugin already exists at ${pluginDest} — skipping copy.`);
    return true;
  }

  try {
    mkdirSync(dirname(pluginDest), { recursive: true });
    cpSync(pluginSrc, pluginDest, { recursive: true });
    log(`  Copied MCPBridge plugin to ${pluginDest}`);
    return true;
  } catch (err) {
    log(`  Failed to copy plugin: ${err}`);
    log(`  Copy manually: cp -r "${pluginSrc}" "${pluginDest}"`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Config writer
// ---------------------------------------------------------------------------

function configureClient(client: string, port: number, projectRoot: string): void {
  const configPath = getConfigPath(client);
  if (!configPath) {
    log(`  Unknown client: ${client}`);
    log('  Supported: claude-desktop, claude-code, cursor');
    return;
  }

  // For claude-code, we use the mcpServers format in settings.json
  // For claude-desktop and cursor, we use the standard MCP config format

  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {
      log(`  Warning: Could not parse existing ${configPath}, creating fresh config.`);
    }
  }

  const serverEntry: Record<string, unknown> = {
    command: 'npx',
    args: ['-y', 'ultimate-unreal-engine-mcp'],
  };

  // All clients need "type": "stdio" for proper MCP server detection
  serverEntry['type'] = 'stdio';

  // Only add env if project root is specified or port is non-default
  const envBlock: Record<string, string> = {};
  if (projectRoot) {
    envBlock['UE_PROJECT_ROOT'] = projectRoot;
  }
  if (port !== 55557) {
    envBlock['UE_PLUGIN_PORT'] = String(port);
  }
  if (Object.keys(envBlock).length > 0) {
    serverEntry['env'] = envBlock;
  }

  // All clients use mcpServers at top level
  if (!config['mcpServers'] || typeof config['mcpServers'] !== 'object') {
    config['mcpServers'] = {};
  }
  (config['mcpServers'] as Record<string, unknown>)['unreal-engine'] = serverEntry;

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  log(`  Configured ${client} at ${configPath}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  // Check if this is a "setup" invocation or just running the server
  const command = process.argv[2];
  if (command !== 'setup') {
    // Not setup — just import and run the server
    // This is handled by the bin entry pointing to dist/index.js
    console.error('Usage: npx ultimate-unreal-engine-mcp setup [--project <path>] [--client <name>] [--port <num>]');
    console.error('');
    console.error('Options:');
    console.error('  --project <path>     Path to your UE project (optional, can set later via UE_PROJECT_ROOT)');
    console.error('  --client <name>      claude-desktop (default), claude-code, or cursor');
    console.error('  --port <num>         Plugin TCP port (default: 55557)');
    console.error('  --plugin-only        Only install the UE plugin, skip MCP config');
    console.error('');
    console.error('Examples:');
    console.error('  npx ultimate-unreal-engine-mcp setup');
    console.error('  npx ultimate-unreal-engine-mcp setup --project "C:/MyGame" --client claude-code');
    process.exit(1);
  }

  log('');
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log(' Ultimate Unreal Engine MCP — Setup');
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log('');

  // Step 1: Configure MCP client
  if (!args.pluginOnly) {
    log('Step 1: Configuring MCP client...');
    configureClient(args.client, args.port, args.project);
    log('');
  }

  // Step 2: Install UE plugin (if project path provided)
  if (args.project) {
    const projectRoot = resolve(args.project);
    if (!existsSync(projectRoot)) {
      log(`Step 2: Project path not found: ${projectRoot}`);
      log('  Skipping plugin install. You can copy it manually later.');
    } else {
      log('Step 2: Installing UE plugin...');
      installPlugin(projectRoot);
      log('');
      log('  After installing, regenerate project files and compile.');
      log('  The plugin starts a TCP server on port ' + args.port + ' when the editor launches.');
    }
  } else {
    log('Step 2: No --project path specified.');
    log('  To install the UE plugin later, copy unreal-plugin/MCPBridge/');
    log('  into your UE project\'s Plugins/ folder.');
  }

  log('');
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log(' Setup complete!');
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log('');
  log('Next steps:');
  log('  1. Restart ' + args.client);
  log('  2. Ask Claude: "List all Blueprint assets in my project"');
  log('');
  if (!args.project) {
    log('Optional: Set your UE project path:');
    log('  npx ultimate-unreal-engine-mcp setup --project "C:/path/to/MyGame"');
    log('');
  }
}

main();
