/**
 * MISSION A21.07 — local runtime fixtures (QA test infrastructure only; never used by the product).
 *
 * Two real HTTP servers on 127.0.0.1 that speak the documented runtime contracts, so the production
 * probes run unmodified over real sockets:
 * - Hermes: `GET /health` (unauthenticated), `GET /v1/models` and `GET /v1/toolsets` (bearer key),
 *   and a chat-completions answer for any POST (NousResearch/hermes-agent api_server contract).
 * - Hatchet: `GET /api/ready`, `GET /api/v1/version`, `GET /api/v1/tenants/{id}` (bearer token), plus
 *   a TCP listener standing in for the engine gRPC address (@hatchet-dev/typescript-sdk 1.46.1 REST).
 *
 * Each fixture can be switched into a failure mode, taken down and brought back on the SAME port
 * (a runtime restart), and records every request it served (path + whether credentials were sent).
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { apiRuntimeMonitor, restartApiRuntimeMonitor } from '../src/operations/runtime-readiness';

export type HermesMode = 'ok' | 'hang' | 'auth' | 'tools-enabled' | 'not-hermes' | 'unhealthy' | 'model-missing' | 'echo-key-401';
export type HatchetMode = 'ok' | 'hang' | 'auth' | 'unready' | 'wrong-tenant' | 'unknown-tenant';

export interface ServedRequest { readonly method: string; readonly path: string; readonly authorization: string | undefined }

interface Listening { server: Server; port: number; sockets: Set<Socket> }

async function listenHttp(handler: (request: IncomingMessage, response: ServerResponse) => void, port = 0): Promise<Listening> {
  const sockets = new Set<Socket>();
  const server = createServer(handler);
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => resolve()); });
  return { server, port: (server.address() as AddressInfo).port, sockets };
}

async function closeHttp(listening: Listening | null): Promise<void> {
  if (!listening) return;
  for (const socket of listening.sockets) socket.destroy();
  await new Promise<void>(resolve => listening.server.close(() => resolve()));
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(body));
}

export class HermesFixture {
  mode: HermesMode = 'ok';
  version = '0.20.0-qa';
  readonly key = 'qa-hermes-key-' + randomUUID();
  readonly model = 'qa-hermes-model';
  readonly served: ServedRequest[] = [];
  private listening: Listening | null = null;
  private port = 0;

  get origin(): string { return 'http://127.0.0.1:' + this.port; }
  get baseUrl(): string { return this.origin; }
  count(path: string): number { return this.served.filter(entry => entry.path === path).length; }
  chatCalls(): number { return this.served.filter(entry => entry.method === 'POST').length; }

  async up(): Promise<void> {
    this.listening = await listenHttp((request, response) => this.handle(request, response), this.port);
    this.port = this.listening.port;
  }

  /** Stop accepting connections (ECONNREFUSED) while keeping the port for a restart. */
  async down(): Promise<void> { await closeHttp(this.listening); this.listening = null; }

  /** A restart of the runtime: down, optionally a new version, then up on the same port. */
  async restart(version?: string): Promise<void> {
    await this.down();
    if (version) this.version = version;
    await this.up();
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    const path = (request.url ?? '/').split('?')[0]!;
    this.served.push({ method: request.method ?? 'GET', path, authorization: request.headers.authorization });
    if (this.mode === 'hang') return; // never answers; the probe deadline must cut it off
    const authorized = request.headers.authorization === 'Bearer ' + this.key;
    if (request.method === 'GET' && path === '/health') {
      json(response, 200, { status: this.mode === 'unhealthy' ? 'degraded' : 'ok', platform: this.mode === 'not-hermes' ? 'some-other-gateway' : 'hermes-agent', version: this.version });
      return;
    }
    if (request.method === 'GET' && (path === '/v1/models' || path === '/v1/toolsets')) {
      if (this.mode === 'echo-key-401') { json(response, 401, { error: { code: 'gateway_auth_failed', message: 'bad key ' + String(request.headers.authorization) } }); return; }
      if (!authorized || this.mode === 'auth') { json(response, 401, { error: { code: 'gateway_auth_failed', message: 'invalid API key' } }); return; }
      if (path === '/v1/models') {
        json(response, 200, { object: 'list', data: [{ id: 'hermes-agent' }, ...(this.mode === 'model-missing' ? [] : [{ id: this.model }])] });
      } else {
        json(response, 200, { object: 'list', data: [{ name: 'web', enabled: this.mode === 'tools-enabled', configured: true, tools: ['web_search'] }, { name: 'terminal', enabled: false, configured: false, tools: [] }] });
      }
      return;
    }
    if (request.method === 'POST') {
      let raw = '';
      request.on('data', chunk => { raw += String(chunk); });
      request.on('end', () => {
        if (!authorized) { json(response, 401, { error: { code: 'gateway_auth_failed' } }); return; }
        json(response, 200, { id: 'qa-runtime-completion-' + this.chatCalls(), choices: [{ message: { content: 'QA RUNTIME FIXTURE ANSWER (' + raw.length + ' bytes of request)' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } });
      });
      return;
    }
    json(response, 404, { error: { code: 'not_found' } });
  }
}

export class HatchetFixture {
  mode: HatchetMode = 'ok';
  version = 'v0.70.1-qa';
  readonly tenantId = randomUUID();
  readonly served: ServedRequest[] = [];
  private api: Listening | null = null;
  private apiPort = 0;
  private grpc: TcpServer | null = null;
  private grpcPort = 0;
  private grpcSockets = new Set<Socket>();
  /** A structurally valid Hatchet JWT naming this tenant and these addresses (signature is a fixture value). */
  token = '';

  get apiOrigin(): string { return 'http://127.0.0.1:' + this.apiPort; }
  get grpcAddress(): string { return '127.0.0.1:' + this.grpcPort; }
  count(path: string): number { return this.served.filter(entry => entry.path === path).length; }

  async up(): Promise<void> {
    this.api = await listenHttp((request, response) => this.handle(request, response), this.apiPort);
    this.apiPort = this.api.port;
    await this.grpcUp();
    if (!this.token) {
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
      this.token = [
        encode({ alg: 'ES256', typ: 'JWT' }),
        encode({ sub: this.tenantId, server_url: this.apiOrigin, grpc_broadcast_address: this.grpcAddress, iss: 'qa-fixture', aud: 'qa-fixture' }),
        'qa' + randomUUID().replace(/-/g, '') + 'signature',
      ].join('.');
    }
  }

  async down(): Promise<void> { await closeHttp(this.api); this.api = null; await this.grpcDown(); }

  async restart(version?: string): Promise<void> { await this.down(); if (version) this.version = version; await this.up(); }

  async grpcUp(): Promise<void> {
    const server = createTcpServer(socket => { this.grpcSockets.add(socket); socket.on('close', () => this.grpcSockets.delete(socket)); socket.end(); });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(this.grpcPort, '127.0.0.1', () => resolve()); });
    this.grpcPort = (server.address() as AddressInfo).port;
    this.grpc = server;
  }

  async grpcDown(): Promise<void> {
    const server = this.grpc;
    this.grpc = null;
    if (!server) return;
    for (const socket of this.grpcSockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    const path = (request.url ?? '/').split('?')[0]!;
    this.served.push({ method: request.method ?? 'GET', path, authorization: request.headers.authorization });
    if (this.mode === 'hang') return;
    if (path === '/api/ready') { if (this.mode === 'unready') json(response, 503, { error: 'not ready' }); else { response.statusCode = 200; response.end(); } return; }
    if (path === '/api/v1/version') { json(response, 200, { version: this.version }); return; }
    const tenant = /^\/api\/v1\/tenants\/([^/]+)$/.exec(path);
    if (tenant) {
      if (request.headers.authorization !== 'Bearer ' + this.token || this.mode === 'auth') { json(response, 403, { errors: [{ description: 'forbidden' }] }); return; }
      if (this.mode === 'unknown-tenant' || decodeURIComponent(tenant[1]!) !== this.tenantId) { json(response, 404, { errors: [{ description: 'not found' }] }); return; }
      json(response, 200, { metadata: { id: this.mode === 'wrong-tenant' ? randomUUID() : this.tenantId, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' }, name: 'QA tenant', slug: 'qa-tenant', version: 'V1' });
      return;
    }
    json(response, 404, { errors: [{ description: 'not found' }] });
  }
}

/** Environment that points the production probes at the fixtures (no API URL override: claims are used). */
export function runtimeEnvironment(hermes: HermesFixture, hatchet: HatchetFixture): Record<string, string> {
  return {
    HERMES_API_BASE_URL: hermes.baseUrl,
    HERMES_API_KEY: hermes.key,
    HERMES_MODEL: hermes.model,
    HERMES_NATIVE_TOOLS_ISOLATED: 'true',
    QEYNOX_NETWORK_POLICY_ATTESTED: 'true',
    HATCHET_CLIENT_TOKEN: hatchet.token,
  };
}

export const RUNTIME_ENV_KEYS = [
  'HERMES_API_BASE_URL', 'HERMES_API_KEY', 'HERMES_MODEL', 'HERMES_PRIVATE_ORIGIN', 'HERMES_NATIVE_TOOLS_ISOLATED', 'QEYNOX_NETWORK_POLICY_ATTESTED',
  'HATCHET_CLIENT_TOKEN', 'HATCHET_CLIENT_API_URL', 'HATCHET_CLIENT_HOST_PORT', 'QEYNOX_RUNTIME_VERIFIED_LIVE', 'QEYNOX_RUNTIME_VERIFICATION_EVIDENCE',
] as const;

/**
 * For API suites that launch missions over HTTP: bring up both fixtures, point the process environment
 * at them, and obtain REAL probe evidence through the API's own runtime monitor (restarted, so nothing
 * is inherited). No flag is set and no evidence is fabricated: if a probe fails, this throws.
 * Background probing is started so evidence stays fresh for long suites; `stop()` restores everything.
 */
export interface VerifiedRuntime {
  readonly hermes: HermesFixture;
  readonly hatchet: HatchetFixture;
  /** Re-point the environment at the fixtures (e.g. after a suite cleared it) and probe again. */
  ensure(): Promise<void>;
  /** Remove the runtime configuration from the environment (readiness becomes NOT_CONFIGURED). */
  unset(): void;
  stop(): Promise<void>;
}

export async function startVerifiedRuntime(): Promise<VerifiedRuntime> {
  const saved = Object.fromEntries(RUNTIME_ENV_KEYS.map(key => [key, process.env[key]]));
  const hermes = new HermesFixture();
  const hatchet = new HatchetFixture();
  await hermes.up();
  await hatchet.up();
  const unset = () => { for (const key of RUNTIME_ENV_KEYS) delete process.env[key]; };
  const ensure = async () => {
    unset();
    Object.assign(process.env, runtimeEnvironment(hermes, hatchet));
    const monitor = apiRuntimeMonitor();
    monitor.start();
    await monitor.probeAll();
    const readiness = monitor.readiness();
    if (!readiness.canExecute) {
      throw new Error('QA runtime fixtures could not be verified: hermes=' + readiness.engine.verification.status + '/' + String(readiness.engine.verification.failure) + ' hatchet=' + readiness.orchestrator.verification.status + '/' + String(readiness.orchestrator.verification.failure));
    }
  };
  unset();
  Object.assign(process.env, runtimeEnvironment(hermes, hatchet));
  restartApiRuntimeMonitor();
  await ensure();
  return {
    hermes, hatchet, ensure, unset,
    async stop() {
      apiRuntimeMonitor().stop();
      await hermes.down();
      await hatchet.down();
      for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    },
  };
}
