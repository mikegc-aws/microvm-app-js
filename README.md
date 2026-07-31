# microvm-app (TypeScript / Node.js)

> ⚠️ **Alpha** — this port is in early development and has had very limited
> testing. Interfaces and behavior may change without notice; do not rely on
> it for production workloads yet. The reference implementation is
> [microvm-app-python](https://github.com/mikegc-aws/microvm-app-python).

A zero-dependency TypeScript/Node framework for **AWS Lambda MicroVMs**.

Lambda drives a MicroVM's lifecycle by calling HTTP hook endpoints your
application must expose — specific POST paths, specific ports, specific
status-code semantics. Getting that plumbing right means reading the hook
spec and standing up a web server before you write a line of business logic.

This library removes that work. Register a handler with `app.run(...)` and it
becomes your VM's startup hook; add `app.entrypoint(...)` for your application
traffic; call `app.serve()`. The library serves all the lifecycle hook
endpoints and your app on Node's built-in `http` server — correct paths,
ports, and status codes included, with sensible defaults for every hook you
don't implement.

## The 30-second version

```typescript
import { MicroVMApp } from "microvm-app";

const app = new MicroVMApp();

app.run((ctx) => {
  console.log(`MicroVM ${ctx.microvmId} started, payload: ${ctx.payload}`);
});

app.entrypoint((req) => ({ hello: "world" }));

app.serve();
```

## How Lambda MicroVMs work (what this library maps onto)

- Lambda calls **lifecycle hooks** as `POST` requests on
  `/aws/lambda-microvms/runtime/v1/<hook>` at a port you configure
  (default **9000**).
- External traffic arrives on the VM's dedicated HTTPS endpoint and is routed
  to port **8080** by default (`X-aws-proxy-port` header overrides).
- Traffic is only forwarded **after your `/run` hook returns 200**.
- Images are snapshots: a VM starts from pre-initialized memory+disk state, so
  anything unique (IDs, seeds, credentials) must be generated in the run hook.

| Method | Hook | When |
|---|---|---|
| `app.ready(fn)` | `/ready` | During image build — return `false` for 503 ("not ready, retry"), truthy/`undefined` when snapshot-ready |
| `app.validate(fn)` | `/validate` | After build, on a fresh VM. Exercise real code paths — Lambda prefetches the snapshot pages you touch |
| `app.run(fn)` | `/run` | VM started. Receives a `RunContext` with `microvmId` and the `--run-hook-payload` string (`ctx.payloadJson()` parses it) |
| `app.resume(fn)` | `/resume` | VM resumed from suspend — refresh credentials, reconnect |
| `app.suspend(fn)` | `/suspend` | Before suspend — flush writes, close connections |
| `app.terminate(fn)` | `/terminate` | Before terminate — final cleanup |

All hooks are optional; unregistered hooks return 200 immediately. Handlers
may be sync or async. Exceptions return 500 (which correctly blocks
traffic/build for run/ready/validate).

## Traffic handling

```typescript
app.entrypoint((req) => {          // catch-all handler
  // req.method/.path/.headers/.query/.json()/.text()
  return { any: "json" };          // object/array -> JSON
  // or "text", 204, Buffer, { status: 418, body: "teapot" }
});

app.get("/health", () => ({ status: "healthy" }));  // routes win over entrypoint
```

## Ports

`new MicroVMApp({ hookPort: 9000, appPort: 8080 })` — both listeners run from
one `serve()` call. Set them equal to serve everything on a single port.
Env overrides: `MICROVM_HOOK_PORT`, `MICROVM_APP_PORT`.

## Install

```bash
npm install microvm-app            # once published; until then:
npm install github:mikegc-aws/microvm-app-js
```

Zero runtime dependencies — it adds nothing to your MicroVM image beyond
your own code.

## Local development

```bash
node examples/hello/app.mjs &
curl -X POST localhost:9000/aws/lambda-microvms/runtime/v1/run \
     -d '{"microvmId":"local","runHookPayload":"{\"tenant\":\"dev\"}"}'
curl localhost:8080/
```

## Deploying

Use [mvm-cli](https://github.com/mikegc-aws/mvm-cli): MicroVM images are
built server-side from a zip (Dockerfile + code) uploaded to S3 — no local
docker or ECR. Add a `Dockerfile` with a Node base image
(`FROM public.ecr.aws/docker/library/node:22-slim`, `CMD ["node", "app.mjs"]`)
and `mvm deploy` handles the rest.

## Tests

```bash
npm install && npm test
```

