// Structured logger for the UE MCP server.
// All output goes to console.error (stderr) — NEVER console.log or console.info.
// Reason: console.log writes to stdout, which is the MCP JSON-RPC channel.
// Any stdout output corrupts the protocol stream and disconnects the client.
// See: PITFALLS.md Pitfall 8, CONTEXT.md locked decision.

/**
 * Logs an informational message to stderr with the [UE MCP] prefix.
 * Use for normal operational messages (startup, connection status, etc.).
 */
export function log(message: string, ...args: unknown[]): void {
  console.error(`[UE MCP] ${message}`, ...args);
}

/**
 * Logs a warning message to stderr with the [UE MCP WARN] prefix.
 * Use for non-fatal issues that operators should be aware of.
 */
export function warn(message: string, ...args: unknown[]): void {
  console.error(`[UE MCP WARN] ${message}`, ...args);
}

/**
 * Logs an error message to stderr with the [UE MCP ERROR] prefix.
 * Use for caught exceptions and error conditions. The err argument is
 * logged inline — pass an Error object or any useful context.
 */
export function error(message: string, err?: unknown): void {
  console.error(`[UE MCP ERROR] ${message}`, err ?? '');
}
