// Configuration constants for the Ultimate Unreal Engine MCP server.
// All values are read from environment variables with sensible defaults.
// Uses console.error for any startup logging (never console.log — stdout safety).

export const PLUGIN_PORT: number = process.env['UE_PLUGIN_PORT']
  ? parseInt(process.env['UE_PLUGIN_PORT'], 10)
  : 55557;

export const PROJECT_ROOT: string = process.env['UE_PROJECT_ROOT'] ?? process.cwd();

export const SERVER_VERSION: string = '0.1.0';
