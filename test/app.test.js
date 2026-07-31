import { test } from "node:test";
import assert from "node:assert/strict";

import { MicroVMApp, HOOK_BASE_PATH } from "../dist/index.js";

function makeRequest({ method = "POST", path = "/", body = "" } = {}) {
  const buf = Buffer.from(body);
  return {
    method,
    path,
    query: {},
    headers: {},
    body: buf,
    json: () => (buf.length ? JSON.parse(buf.toString()) : undefined),
    text: () => buf.toString("utf-8"),
  };
}

const hookPath = (name) => `${HOOK_BASE_PATH}/${name}`;

test("run hook receives context", async () => {
  const app = new MicroVMApp({ logger: () => {} });
  let seen;
  app.run((ctx) => {
    seen = { id: ctx.microvmId, payload: ctx.payload };
  });
  const body = JSON.stringify({ microvmId: "mvm-1", runHookPayload: "t-42" });
  const res = await app.handle(makeRequest({ path: hookPath("run"), body }));
  assert.equal(res.status, 200);
  assert.deepEqual(seen, { id: "mvm-1", payload: "t-42" });
  assert.equal(app.context.microvmId, "mvm-1");
});

test("payloadJson parses", async () => {
  const app = new MicroVMApp({ logger: () => {} });
  let parsed;
  app.run((ctx) => {
    parsed = ctx.payloadJson();
  });
  const body = JSON.stringify({
    microvmId: "m",
    runHookPayload: JSON.stringify({ tenant: "acme" }),
  });
  await app.handle(makeRequest({ path: hookPath("run"), body }));
  assert.deepEqual(parsed, { tenant: "acme" });
});

test("unregistered hooks return 200", async () => {
  const app = new MicroVMApp({ logger: () => {} });
  for (const name of ["run", "resume", "suspend", "terminate", "ready", "validate"]) {
    const res = await app.handle(makeRequest({ path: hookPath(name), body: "{}" }));
    assert.equal(res.status, 200, name);
  }
});

test("ready returning false -> 503", async () => {
  const app = new MicroVMApp({ logger: () => {} });
  let isReady = false;
  app.ready(() => isReady);
  assert.equal((await app.handle(makeRequest({ path: hookPath("ready") }))).status, 503);
  isReady = true;
  assert.equal((await app.handle(makeRequest({ path: hookPath("ready") }))).status, 200);
});

test("hook handler exception -> 500", async () => {
  const app = new MicroVMApp({ logger: () => {} });
  app.run(() => {
    throw new Error("boom");
  });
  const res = await app.handle(makeRequest({ path: hookPath("run"), body: "{}" }));
  assert.equal(res.status, 500);
});

test("hooks reject GET", async () => {
  const app = new MicroVMApp({ logger: () => {} });
  const res = await app.handle(makeRequest({ method: "GET", path: hookPath("run") }));
  assert.equal(res.status, 405);
});

test("unknown hook -> 404", async () => {
  const app = new MicroVMApp({ logger: () => {} });
  const res = await app.handle(makeRequest({ path: hookPath("bogus") }));
  assert.equal(res.status, 404);
});

test("async handlers work", async () => {
  const app = new MicroVMApp({ logger: () => {} });
  app.terminate(async () => ({ flushed: true }));
  const res = await app.handle(makeRequest({ path: hookPath("terminate") }));
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body.toString()), { flushed: true });
});

test("entrypoint catch-all", async () => {
  const app = new MicroVMApp({ logger: () => {} });
  app.entrypoint((req) => ({ path: req.path }));
  const res = await app.handle(makeRequest({ method: "GET", path: "/anything" }));
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body.toString()), { path: "/anything" });
});

test("route beats entrypoint", async () => {
  const app = new MicroVMApp({ logger: () => {} });
  app.entrypoint(() => "fallback");
  app.get("/health", () => ({ ok: true }));
  const health = await app.handle(makeRequest({ method: "GET", path: "/health" }));
  assert.deepEqual(JSON.parse(health.body.toString()), { ok: true });
  const other = await app.handle(makeRequest({ method: "GET", path: "/x" }));
  assert.equal(other.body.toString(), "fallback");
});

test("return type mapping", async () => {
  const app = new MicroVMApp({ logger: () => {} });
  app.get("/str", () => "hello");
  app.get("/num", () => 204);
  app.get("/resp", () => ({ status: 418, body: "teapot" }));
  assert.equal((await app.handle(makeRequest({ method: "GET", path: "/str" }))).body.toString(), "hello");
  assert.equal((await app.handle(makeRequest({ method: "GET", path: "/num" }))).status, 204);
  assert.equal((await app.handle(makeRequest({ method: "GET", path: "/resp" }))).status, 418);
});

test("no handler -> 404", async () => {
  const app = new MicroVMApp({ logger: () => {} });
  const res = await app.handle(makeRequest({ method: "GET", path: "/" }));
  assert.equal(res.status, 404);
});

test("handler exception -> 500", async () => {
  const app = new MicroVMApp({ logger: () => {} });
  app.entrypoint(() => {
    throw new Error("nope");
  });
  const res = await app.handle(makeRequest({ method: "GET", path: "/" }));
  assert.equal(res.status, 500);
});

test("live server: full lifecycle over HTTP", async () => {
  const app = new MicroVMApp({ hookPort: 19100, appPort: 18180, logger: () => {} });
  let tenant;
  app.run((ctx) => {
    tenant = (ctx.payloadJson() ?? {}).tenant;
  });
  app.entrypoint(() => ({ tenant }));
  await app.serve();
  try {
    const hookRes = await fetch(`http://127.0.0.1:19100${hookPath("run")}`, {
      method: "POST",
      body: JSON.stringify({
        microvmId: "mvm-live",
        runHookPayload: JSON.stringify({ tenant: "acme" }),
      }),
    });
    assert.equal(hookRes.status, 200);
    const appRes = await fetch("http://127.0.0.1:18180/whoami");
    assert.deepEqual(await appRes.json(), { tenant: "acme" });
  } finally {
    await app.shutdown();
  }
});

test("single-port mode collapses to one listener", async () => {
  const app = new MicroVMApp({ hookPort: 17170, appPort: 17170, logger: () => {} });
  app.entrypoint(() => "app");
  await app.serve();
  try {
    const hook = await fetch(`http://127.0.0.1:17170${hookPath("run")}`, {
      method: "POST",
      body: "{}",
    });
    assert.equal(hook.status, 200);
    const traffic = await fetch("http://127.0.0.1:17170/");
    assert.equal(await traffic.text(), "app");
  } finally {
    await app.shutdown();
  }
});
