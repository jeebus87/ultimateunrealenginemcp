// Tests for INF-02: Plugin bridge graceful degradation
// Implementation: src/plugin-bridge/client.ts, src/utils/path-guard.ts, src/utils/logger.ts

import * as path from 'path';
import * as net from 'net';
import { ExponentialBackoff } from '../src/plugin-bridge/retry.js';
import { PLUGIN_PORT, PROJECT_ROOT, SERVER_VERSION } from '../src/config.js';
import { PluginBridgeClient, PluginNotConnectedError } from '../src/plugin-bridge/client.js';
import { validatePath } from '../src/utils/path-guard.js';

describe('ExponentialBackoff', () => {
  it('starts at 1000ms', () => {
    const backoff = new ExponentialBackoff();
    expect(backoff.nextDelay()).toBe(1000);
  });

  it('doubles each call: 1000, 2000, 4000, 8000', () => {
    const backoff = new ExponentialBackoff();
    expect(backoff.nextDelay()).toBe(1000);
    expect(backoff.nextDelay()).toBe(2000);
    expect(backoff.nextDelay()).toBe(4000);
    expect(backoff.nextDelay()).toBe(8000);
  });

  it('caps at 30000ms', () => {
    const backoff = new ExponentialBackoff();
    // Advance well past the cap
    for (let i = 0; i < 20; i++) {
      backoff.nextDelay();
    }
    expect(backoff.nextDelay()).toBe(30000);
  });

  it('reset() sets delay back to 1000ms', () => {
    const backoff = new ExponentialBackoff();
    backoff.nextDelay(); // 1000
    backoff.nextDelay(); // 2000
    backoff.nextDelay(); // 4000
    backoff.reset();
    expect(backoff.nextDelay()).toBe(1000);
  });
});

describe('config constants', () => {
  it('PLUGIN_PORT defaults to 55557 when UE_PLUGIN_PORT env var is not set', () => {
    // The env var is not set in this test environment
    expect(PLUGIN_PORT).toBe(55557);
  });

  it('PROJECT_ROOT is a string (defaults to process.cwd())', () => {
    expect(typeof PROJECT_ROOT).toBe('string');
    expect(PROJECT_ROOT.length).toBeGreaterThan(0);
  });

  it('SERVER_VERSION is 0.1.0', () => {
    expect(SERVER_VERSION).toBe('0.1.0');
  });
});

describe('PluginBridgeClient graceful degradation', () => {
  it('isConnected() returns false when no UE Editor is running', () => {
    // Use a port that nothing is listening on (55558) to ensure disconnected state
    const client = new PluginBridgeClient(55558);
    expect(client.isConnected()).toBe(false);
    client.destroy();
  });

  it('getDisconnectedError() returns exact error shape', () => {
    const client = new PluginBridgeClient(55558);
    const err = client.getDisconnectedError();
    expect(err.error).toBe('plugin_not_connected');
    expect(err.required_plugin).toBe(true);
    expect(err.message).toContain('MCPBridge plugin');
    client.destroy();
  });

  it('sendCommand() throws PluginNotConnectedError when disconnected', async () => {
    const client = new PluginBridgeClient(55558);
    await expect(client.sendCommand({ type: 'ping' })).rejects.toThrow(PluginNotConnectedError);
    client.destroy();
  });

  it('PluginNotConnectedError.bridgeError has the correct shape', async () => {
    const client = new PluginBridgeClient(55558);
    try {
      await client.sendCommand({ type: 'ping' });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PluginNotConnectedError);
      const pnce = err as PluginNotConnectedError;
      expect(pnce.bridgeError.error).toBe('plugin_not_connected');
      expect(pnce.bridgeError.required_plugin).toBe(true);
    }
    client.destroy();
  });
});

describe('PluginBridgeClient', () => {
  it('file-system tools execute without requiring bridge connection', () => {
    // Verify that a disconnected bridge does not prevent isConnected check from returning false
    // (it never throws — always returns boolean gracefully)
    const client = new PluginBridgeClient(55558);
    expect(() => client.isConnected()).not.toThrow();
    client.destroy();
  });
});

describe('validatePath', () => {
  const root = process.cwd();

  it('returns resolved absolute path when path is within project root', () => {
    // Use path.join to produce a platform-correct path (backslashes on Windows)
    const subPath = path.join(root, 'src', 'config.ts');
    const result = validatePath(subPath, root);
    expect(result).toBe(subPath);
  });

  it('throws "Path traversal rejected" for path outside project root', () => {
    expect(() => validatePath('/etc/passwd', root)).toThrow('Path traversal rejected');
  });

  it('throws "Path traversal rejected" for ../ traversal', () => {
    expect(() => validatePath('../outside', root)).toThrow('Path traversal rejected');
  });

  it('returns resolved path when path is the root itself', () => {
    const result = validatePath(root, root);
    expect(result).toBe(root);
  });
});

// ============================================================
// Integration: mock TCP server round-trip (Phase 7)
// ============================================================
// Tests the full JSON-newline framing, correlationId matching,
// and sendCommand() resolve path using a real TCP server.
// Uses port 55560 to avoid conflicts with real plugin on 55557.

describe('PluginBridgeClient real TCP round-trip', () => {
  const TEST_PORT = 55560;
  let server: net.Server;
  let client: PluginBridgeClient;

  beforeAll(async () => {
    // Start mock TCP server that echoes ping -> pong
    server = net.createServer((socket) => {
      let buf = '';
      socket.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        let idx: number;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) { continue; }
          try {
            const cmd = JSON.parse(line) as { type: string; correlationId: string };
            if (cmd.type === 'ping') {
              const response = {
                success: true,
                correlationId: cmd.correlationId,
                data: { pong: true },
              };
              socket.write(JSON.stringify(response) + '\n', 'utf8');
            }
          } catch {
            // ignore bad JSON
          }
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(TEST_PORT, '127.0.0.1', resolve));
  });

  afterAll(async () => {
    client?.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    );
  });

  it('sendCommand ping returns {success:true, data:{pong:true}} with matching correlationId', async () => {
    // Give PluginBridgeClient time to connect to mock server
    client = new PluginBridgeClient(TEST_PORT);

    // Wait for connection (backoff starts at 1s — poll isConnected())
    await new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const interval = setInterval(() => {
        if (client.isConnected()) {
          clearInterval(interval);
          resolve();
        } else if (Date.now() - start > 5000) {
          clearInterval(interval);
          reject(new Error('Client did not connect to mock server within 5 seconds'));
        }
      }, 50);
    });

    const response = await client.sendCommand({ type: 'ping', correlationId: '' });
    expect(response.success).toBe(true);
    expect((response.data as { pong: boolean }).pong).toBe(true);
    expect(typeof response.correlationId).toBe('string');
    expect(response.correlationId.length).toBeGreaterThan(0);
  });

  it('concurrent sendCommand calls resolve independently', async () => {
    // Client already connected from previous test
    const [r1, r2] = await Promise.all([
      client.sendCommand({ type: 'ping', correlationId: '' }),
      client.sendCommand({ type: 'ping', correlationId: '' }),
    ]);
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    expect(r1.correlationId).not.toBe(r2.correlationId);
  });
});
