/**
 * microvm-app: a zero-dependency TypeScript/Node framework for AWS Lambda MicroVMs.
 *
 * Lambda drives a MicroVM's lifecycle by calling HTTP hook endpoints your
 * application must expose — specific POST paths, ports, and status-code
 * semantics. This library removes that plumbing:
 *
 *     import { MicroVMApp } from "microvm-app";
 *
 *     const app = new MicroVMApp();
 *
 *     app.run((ctx) => {
 *       console.log(`MicroVM ${ctx.microvmId} started`, ctx.payload);
 *     });
 *
 *     app.entrypoint((req) => ({ hello: "world" }));
 *
 *     app.serve();
 *
 * Hooks are served on port 9000 (`/aws/lambda-microvms/runtime/v1/<hook>`),
 * application traffic on port 8080. Traffic only flows after the run hook
 * returns 200.
 */

import * as http from "node:http";
import { URL } from "node:url";

export const HOOK_BASE_PATH = "/aws/lambda-microvms/runtime/v1";
export const LIFECYCLE_HOOKS = [
  "run",
  "resume",
  "suspend",
  "terminate",
  "ready",
  "validate",
] as const;

export type LifecycleHook = (typeof LIFECYCLE_HOOKS)[number];

/** Delivered to the run hook when Lambda starts a MicroVM. */
export interface RunContext {
  microvmId?: string;
  /** Raw string passed to `run-microvm --run-hook-payload` (max 16 KB). */
  payload?: string;
  raw: Record<string, unknown>;
  /** Parse the payload as JSON (undefined if empty). */
  payloadJson(): unknown;
}

/** An inbound HTTP request delivered to route/entrypoint handlers. */
export interface Request {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: Buffer;
  /** Parse the request body as JSON (undefined if empty). */
  json(): unknown;
  text(): string;
}

/** Explicit response handlers may return. */
export interface Response {
  status: number;
  body: string | Buffer | object;
  headers?: Record<string, string>;
  contentType?: string;
}

/**
 * What handlers may return: undefined (200), an object/array (JSON),
 * a string (text), a number (status code), a Buffer (octet-stream),
 * a Response, or `false` from ready/validate ("not ready yet" -> 503).
 */
export type HandlerResult =
  | void
  | boolean
  | number
  | string
  | Buffer
  | object
  | Response;

export type HookHandler = (
  arg: RunContext | Request
) => HandlerResult | Promise<HandlerResult>;
export type RequestHandler = (
  req: Request
) => HandlerResult | Promise<HandlerResult>;

export interface MicroVMAppOptions {
  hookPort?: number;
  appPort?: number;
  logger?: (message: string) => void;
}

interface NormalizedResponse {
  status: number;
  body: Buffer;
  contentType: string;
  headers: Record<string, string>;
}

function isResponse(value: unknown): value is Response {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    "body" in value &&
    typeof (value as Response).status === "number"
  );
}

function normalize(result: HandlerResult, hook: boolean): NormalizedResponse {
  if (result === undefined || result === null || result === true) {
    return { status: 200, body: Buffer.alloc(0), contentType: "application/json", headers: {} };
  }
  if (result === false) {
    // ready/validate semantics: "not ready yet" -> 503, Lambda retries.
    return { status: hook ? 503 : 500, body: Buffer.alloc(0), contentType: "text/plain", headers: {} };
  }
  if (typeof result === "number") {
    return { status: result, body: Buffer.alloc(0), contentType: "text/plain", headers: {} };
  }
  if (Buffer.isBuffer(result)) {
    return { status: 200, body: result, contentType: "application/octet-stream", headers: {} };
  }
  if (typeof result === "string") {
    return { status: 200, body: Buffer.from(result), contentType: "text/plain; charset=utf-8", headers: {} };
  }
  if (isResponse(result)) {
    const inner = normalize(result.body as HandlerResult, hook);
    return {
      status: result.status,
      body: inner.body,
      contentType: result.contentType ?? inner.contentType,
      headers: result.headers ?? {},
    };
  }
  return {
    status: 200,
    body: Buffer.from(JSON.stringify(result)),
    contentType: "application/json",
    headers: {},
  };
}

export class MicroVMApp {
  readonly hookPort: number;
  readonly appPort: number;
  /** RunContext captured by the run hook, if it has fired. */
  context?: RunContext;

  private hooks = new Map<LifecycleHook, HookHandler>();
  private routes: Array<{ method: string; path: string; handler: RequestHandler }> = [];
  private entrypointHandler?: RequestHandler;
  private servers: http.Server[] = [];
  private log: (message: string) => void;

  constructor(options: MicroVMAppOptions = {}) {
    this.hookPort =
      options.hookPort ?? Number(process.env.MICROVM_HOOK_PORT ?? 9000);
    this.appPort =
      options.appPort ?? Number(process.env.MICROVM_APP_PORT ?? 8080);
    this.log = options.logger ?? ((m) => console.log(`[microvm-app] ${m}`));
  }

  // ------------------------------------------------------------------
  // Lifecycle hooks
  // ------------------------------------------------------------------

  /** Hook invoked when a MicroVM starts. Traffic flows after it returns 200. */
  run(handler: (ctx: RunContext) => HandlerResult | Promise<HandlerResult>): this {
    this.hooks.set("run", handler as HookHandler);
    return this;
  }

  /** Hook invoked when a MicroVM resumes from the suspended state. */
  resume(handler: HookHandler): this {
    this.hooks.set("resume", handler);
    return this;
  }

  /** Hook invoked just before a MicroVM is suspended. */
  suspend(handler: HookHandler): this {
    this.hooks.set("suspend", handler);
    return this;
  }

  /** Hook invoked just before a MicroVM is terminated. */
  terminate(handler: HookHandler): this {
    this.hooks.set("terminate", handler);
    return this;
  }

  /** Image-build hook: return false for 503 ("not ready, retry"). */
  ready(handler: HookHandler): this {
    this.hooks.set("ready", handler);
    return this;
  }

  /** Image-build hook: exercise real code paths; false -> 503 (retry). */
  validate(handler: HookHandler): this {
    this.hooks.set("validate", handler);
    return this;
  }

  // ------------------------------------------------------------------
  // Traffic
  // ------------------------------------------------------------------

  /** Catch-all handler for inbound traffic. */
  entrypoint(handler: RequestHandler): this {
    this.entrypointHandler = handler;
    return this;
  }

  /** Register a handler for an exact path. */
  route(path: string, handler: RequestHandler, methods: string[] = ["GET", "POST"]): this {
    for (const method of methods) {
      this.routes.push({ method: method.toUpperCase(), path, handler });
    }
    return this;
  }

  get(path: string, handler: RequestHandler): this {
    return this.route(path, handler, ["GET"]);
  }

  post(path: string, handler: RequestHandler): this {
    return this.route(path, handler, ["POST"]);
  }

  // ------------------------------------------------------------------
  // Dispatch (exported for tests)
  // ------------------------------------------------------------------

  async handle(request: Request): Promise<NormalizedResponse> {
    if (request.path.startsWith(HOOK_BASE_PATH + "/")) {
      const name = request.path
        .slice(HOOK_BASE_PATH.length + 1)
        .replace(/\/+$/, "") as LifecycleHook;
      if ((LIFECYCLE_HOOKS as readonly string[]).includes(name)) {
        if (request.method !== "POST") {
          return normalize({ status: 405, body: "hooks accept POST only" } as Response, true);
        }
        return this.dispatchHook(name, request);
      }
      return normalize({ status: 404, body: "unknown hook" } as Response, true);
    }
    return this.dispatchApp(request);
  }

  private async dispatchHook(
    name: LifecycleHook,
    request: Request
  ): Promise<NormalizedResponse> {
    const handler = this.hooks.get(name);
    this.log(`lifecycle hook: ${name}${handler ? "" : " (no handler, 200)"}`);
    let arg: RunContext | Request = request;
    if (name === "run") {
      let body: Record<string, unknown> = {};
      try {
        body = (request.json() as Record<string, unknown>) ?? {};
      } catch {
        this.log("run hook body was not valid JSON");
      }
      const payload = body["runHookPayload"] as string | undefined;
      this.context = {
        microvmId: body["microvmId"] as string | undefined,
        payload,
        raw: body,
        payloadJson: () => (payload ? JSON.parse(payload) : undefined),
      };
      arg = this.context;
    }
    if (!handler) {
      return normalize(undefined, true);
    }
    try {
      return normalize(await handler(arg), true);
    } catch (err) {
      // Fail loudly: a non-2xx from run/ready/validate blocks traffic /
      // the build, which is what you want on a broken init.
      this.log(`error in ${name} hook handler: ${err}`);
      return normalize({ status: 500, body: "hook handler raised an exception" } as Response, true);
    }
  }

  private async dispatchApp(request: Request): Promise<NormalizedResponse> {
    const route = this.routes.find(
      (r) => r.method === request.method && r.path === request.path
    );
    const handler = route?.handler ?? this.entrypointHandler;
    if (!handler) {
      return normalize({ status: 404, body: "not found" } as Response, false);
    }
    try {
      return normalize(await handler(request), false);
    } catch (err) {
      this.log(`error in request handler: ${err}`);
      return normalize({ status: 500, body: "internal error" } as Response, false);
    }
  }

  // ------------------------------------------------------------------
  // Serving
  // ------------------------------------------------------------------

  private makeServer(): http.Server {
    return http.createServer((incoming, outgoing) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk) => chunks.push(chunk));
      incoming.on("end", async () => {
        const url = new URL(incoming.url ?? "/", "http://localhost");
        const body = Buffer.concat(chunks);
        const request: Request = {
          method: incoming.method ?? "GET",
          path: url.pathname,
          query: Object.fromEntries(url.searchParams),
          headers: Object.fromEntries(
            Object.entries(incoming.headers).map(([k, v]): [string, string] => [
              k.toLowerCase(),
              (Array.isArray(v) ? v[0] : v) ?? "",
            ])
          ),
          body,
          json: () => (body.length ? JSON.parse(body.toString()) : undefined),
          text: () => body.toString("utf-8"),
        };
        const response = await this.handle(request);
        outgoing.writeHead(response.status, {
          "content-type": response.contentType,
          "content-length": response.body.length,
          ...response.headers,
        });
        outgoing.end(response.body);
      });
    });
  }

  /**
   * Start the hook listener and the app listener. Returns once both are
   * accepting connections; the process stays alive while they run.
   * If hookPort === appPort a single listener serves everything.
   */
  async serve(): Promise<void> {
    const ports = [...new Set([this.hookPort, this.appPort])].sort();
    for (const port of ports) {
      const server = this.makeServer();
      this.servers.push(server);
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "0.0.0.0", () => resolve());
      });
      const role =
        ports.length === 1 ? "hooks + app" : port === this.hookPort ? "hooks" : "app";
      this.log(`listening on 0.0.0.0:${port} (${role})`);
    }
  }

  /** Alias for serve(). */
  start(): Promise<void> {
    return this.serve();
  }

  async shutdown(): Promise<void> {
    await Promise.all(
      this.servers.map(
        (server) => new Promise<void>((resolve) => server.close(() => resolve()))
      )
    );
    this.servers = [];
  }
}
