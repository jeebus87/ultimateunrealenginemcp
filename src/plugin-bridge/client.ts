// TCP client connecting to the UE Editor plugin on PLUGIN_PORT.
// Returns structured plugin_not_connected errors when the editor is not running.
// Reconnects automatically with ExponentialBackoff — never floods logs (Pitfall 3).
// JSON-newline framing with correlationId-based request/response matching (Phase 7).

import * as net from 'net';
import { ExponentialBackoff } from './retry.js';
import type { MCPCommand, MCPResponse } from './protocol.js';
import { PLUGIN_PORT } from '../config.js';

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/**
 * Structured error returned when the UE Editor plugin is not connected.
 * Shape is locked per CONTEXT.md: error, message, required_plugin: true.
 */
export interface MCPBridgeError {
  error: 'plugin_not_connected';
  message: string;
  required_plugin: true;
}

/**
 * Thrown by sendCommand() when no connection to the UE Editor plugin exists.
 * Catch this to surface a structured error to the MCP client instead of crashing.
 */
export class PluginNotConnectedError extends Error {
  readonly bridgeError: MCPBridgeError;

  constructor(bridgeError: MCPBridgeError) {
    super(bridgeError.message);
    this.name = 'PluginNotConnectedError';
    this.bridgeError = bridgeError;
  }
}

// ---------------------------------------------------------------------------
// PluginBridgeClient
// ---------------------------------------------------------------------------

/**
 * TCP client that connects to the UE Editor MCPBridge plugin (port 55557 by default).
 *
 * Connection lifecycle:
 *  - Constructor starts scheduleReconnect() immediately (first attempt after 1s).
 *  - On connect: socket is set, backoff is reset.
 *  - On error/close: socket is cleared, next reconnect is scheduled.
 *  - Only logs on first failure and on state changes (never on every retry).
 *
 * Graceful degradation:
 *  - isConnected() returns false when no socket is active — never throws.
 *  - getDisconnectedError() returns the exact MCPBridgeError shape.
 *  - sendCommand() throws PluginNotConnectedError when disconnected.
 *
 * Protocol (JSON-newline framing with correlationId):
 *  - sendCommand() generates a UUID correlationId, writes JSON+\n to the socket.
 *  - The socket 'data' listener accumulates receiveBuffer, splits on \n, and
 *    resolves the matching pending promise by correlationId.
 *  - 10-second timeout rejects the promise if no response arrives.
 *  - destroy() rejects all pending commands to prevent leaks.
 */
export class PluginBridgeClient {
  private socket: net.Socket | null = null;
  private readonly port: number;
  private readonly backoff: ExponentialBackoff;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Log first failure only; suppress subsequent retries until state changes. */
  private hasLoggedFirstFailure = false;

  /** Accumulates partial data received from the TCP socket between newlines. */
  private receiveBuffer: string = '';

  /**
   * Maps correlationId to resolve/reject callbacks for in-flight sendCommand() calls.
   * Entries are added before socket.write() and removed on response or timeout.
   */
  private readonly pendingCommands = new Map<string, {
    resolve: (r: MCPResponse) => void;
    reject:  (e: Error) => void;
  }>();

  constructor(port: number = PLUGIN_PORT) {
    this.port = port;
    this.backoff = new ExponentialBackoff();
    this.scheduleReconnect();
  }

  /** Returns true only when a live (non-destroyed) socket exists. */
  isConnected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  /**
   * Returns the exact error object shape required by CONTEXT.md locked decision.
   * Callers should include this object in their MCP tool response (isError: true).
   */
  getDisconnectedError(): MCPBridgeError {
    return {
      error: 'plugin_not_connected',
      message:
        'This tool requires the UE Editor plugin. Start the editor with the MCPBridge plugin enabled.',
      required_plugin: true,
    };
  }

  /**
   * Sends a command to the UE Editor plugin and waits for a correlated response.
   *
   * - Throws PluginNotConnectedError immediately if not connected.
   * - Generates a crypto.randomUUID() correlationId (overwrites any caller-supplied value).
   * - Writes JSON-newline framed message: JSON.stringify(cmd) + '\n'.
   * - Resolves when the matching correlationId response arrives from the plugin.
   * - Rejects with a timeout Error after 10 seconds if no response arrives.
   * - Rejects immediately on socket write error.
   *
   * Threat T-07-11 mitigation: 10-second timeout clears Map entry on expiry;
   * destroy() clears all remaining entries.
   */
  async sendCommand(cmd: MCPCommand): Promise<MCPResponse> {
    if (!this.isConnected()) {
      throw new PluginNotConnectedError(this.getDisconnectedError());
    }

    // Generate a unique correlationId for this request — overwrites any caller value.
    // crypto.randomUUID() is available globally in Node 19+ (Node 22 used here).
    const correlationId = crypto.randomUUID();
    const cmdWithId: MCPCommand = { ...cmd, correlationId };

    return new Promise<MCPResponse>((resolve, reject) => {
      this.pendingCommands.set(correlationId, { resolve, reject });

      // 10-second timeout — T-07-11 mitigation
      const timeoutHandle = setTimeout(() => {
        if (this.pendingCommands.has(correlationId)) {
          this.pendingCommands.delete(correlationId);
          reject(new Error(`MCP command '${cmd.type}' timed out after 10 seconds`));
        }
      }, 10_000);

      // Write JSON-newline framed message to the socket.
      // The write callback fires on flush; reject immediately on error.
      this.socket!.write(JSON.stringify(cmdWithId) + '\n', 'utf8', (err) => {
        if (err) {
          clearTimeout(timeoutHandle);
          this.pendingCommands.delete(correlationId);
          reject(err);
        }
      });
    });
  }

  /**
   * Cancel the pending reconnect timer, reject all in-flight commands, and close the socket.
   * Call this in tests or during graceful shutdown.
   */
  destroy(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket !== null) {
      this.socket.destroy();
      this.socket = null;
    }
    // Reject all pending commands to prevent leaks (T-07-11 mitigation).
    for (const [, pending] of this.pendingCommands) {
      pending.reject(new Error('PluginBridgeClient destroyed'));
    }
    this.pendingCommands.clear();
    this.receiveBuffer = '';
  }

  // ---------------------------------------------------------------------------
  // Private: reconnect loop
  // ---------------------------------------------------------------------------

  private scheduleReconnect(): void {
    const delay = this.backoff.nextDelay();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.isConnected()) {
        // Already connected — reset backoff and continue monitoring
        this.backoff.reset();
        this.scheduleReconnect();
        return;
      }
      this.connect().then(() => {
        // Connection succeeded
        this.backoff.reset();
        this.hasLoggedFirstFailure = false;
        console.error('[UE MCP] Connected to UE Editor plugin on port', this.port);
        this.scheduleReconnect();
      }).catch(() => {
        // Connection failed — log only on first failure or after reconnection
        if (!this.hasLoggedFirstFailure) {
          console.error(
            `[UE MCP] Cannot reach UE Editor plugin on port ${this.port}. Retrying with backoff...`
          );
          this.hasLoggedFirstFailure = true;
        }
        this.scheduleReconnect();
      });
    }, delay);
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ port: this.port, host: '127.0.0.1' });

      // JSON-newline response parser — accumulates partial chunks, splits on \n,
      // and resolves the correlated pending promise.
      // Threat T-07-09 mitigation: try/catch around JSON.parse; unknown correlationId
      // is silently dropped — no state corruption.
      socket.on('data', (chunk: Buffer) => {
        this.receiveBuffer += chunk.toString('utf8');
        let newlineIdx: number;
        while ((newlineIdx = this.receiveBuffer.indexOf('\n')) !== -1) {
          const line = this.receiveBuffer.slice(0, newlineIdx).trim();
          this.receiveBuffer = this.receiveBuffer.slice(newlineIdx + 1);
          if (line.length === 0) { continue; }
          try {
            const response = JSON.parse(line) as MCPResponse;
            const pending = this.pendingCommands.get(response.correlationId);
            if (pending) {
              this.pendingCommands.delete(response.correlationId);
              pending.resolve(response);
            }
            // Unknown correlationId — silently drop (T-07-09 mitigation)
          } catch {
            // Non-JSON line — ignore (T-07-09 mitigation)
          }
        }
      });

      socket.once('connect', () => {
        this.socket = socket;
        resolve();
      });
      socket.once('error', (err) => {
        socket.destroy();
        reject(err);
      });
      socket.once('close', () => {
        if (this.socket === socket) {
          this.socket = null;
          // Log disconnection only if we were previously connected
          console.error('[UE MCP] Lost connection to UE Editor plugin. Reconnecting...');
          this.hasLoggedFirstFailure = false;
          this.scheduleReconnect();
        }
      });
    });
  }
}
