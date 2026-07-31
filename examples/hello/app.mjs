// Example MicroVM app: full lifecycle hooks + a tiny JSON API.
import { randomUUID } from "node:crypto";
import { MicroVMApp } from "microvm-app";

const app = new MicroVMApp();

const state = {
  instanceId: null, // regenerated per-VM in the run hook (snapshot uniqueness!)
  tenant: null,
  startedAt: null,
  resumes: 0,
  requests: 0,
};

app.ready(() => {
  // Called during image build, before Lambda snapshots the VM.
  console.log("ready hook: warm caches / preload here");
  return true;
});

app.validate(() => {
  // Called on a fresh VM from the new image. Exercise real code paths so
  // Lambda can prefetch the snapshot pages your app actually touches.
  console.log("validate hook: running smoke checks");
  return true;
});

app.run((ctx) => {
  // Values baked into the snapshot are shared by every VM from this image,
  // so anything unique is generated here.
  state.instanceId = randomUUID();
  state.startedAt = Date.now();
  state.tenant = (ctx.payloadJson() ?? {}).tenant ?? "anonymous";
  console.log(`run hook: microvm=${ctx.microvmId} tenant=${state.tenant}`);
});

app.resume(() => {
  state.resumes += 1;
  console.log(`resume hook: resume #${state.resumes}`);
});

app.suspend(() => console.log("suspend hook: flushing state"));
app.terminate(() => console.log("terminate hook: goodbye"));

app.get("/health", () => ({ status: "healthy" }));

app.entrypoint((req) => {
  state.requests += 1;
  return {
    message: "Hello from a Lambda MicroVM! (Node.js)",
    instanceId: state.instanceId,
    tenant: state.tenant,
    uptimeSeconds: state.startedAt ? (Date.now() - state.startedAt) / 1000 : null,
    resumes: state.resumes,
    requestsServed: state.requests,
    path: req.path,
    node: process.version,
  };
});

app.serve();
