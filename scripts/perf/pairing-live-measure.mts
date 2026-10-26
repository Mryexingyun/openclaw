/** Real Gateway/node host and synthetic iMessage transport; aggregate pairing evidence only. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { loadavg } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.js";
import { stopChild, stopGatewayGracefully } from "../lib/gateway-bench-child.ts";
import { getFreePort } from "../lib/gateway-bench-probes.ts";
import {
  measureGatewayCpuUsage,
  readGatewayResources,
  startGatewayDiagnostics,
} from "../lib/gateway-bench-profile.ts";
import {
  BASE_GATEWAY_BENCH_CONFIG,
  buildGatewayBenchChildArgs,
  createGatewayBenchEnv,
  gatewayBenchCpuProfileArgs,
  summarizeNumbers,
  waitForInitialProbe,
  writeGatewayBenchConfig,
} from "../lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    observer: { type: "string" },
    "heartbeat-mode": { type: "string" },
    "steady-seconds": { type: "string" },
  },
});
assert(values.out && values.observer, "--out and --observer required");
const heartbeatMode = values["heartbeat-mode"];
assert(
  heartbeatMode === undefined || heartbeatMode === "baseline" || heartbeatMode === "checkpoint",
  "--heartbeat-mode must be baseline or checkpoint",
);
const steadySeconds = Number(values["steady-seconds"] ?? (heartbeatMode ? 900 : 130));
assert(
  Number.isSafeInteger(steadySeconds) && steadySeconds >= 130,
  "steady duration must be >=130s",
);
const observer = path.resolve(values.observer);
for (const name of ["observer.cjs", "causality.cjs", "background-roots.json"]) {
  assert(existsSync(path.join(path.dirname(observer), name)), `missing frozen harness ${name}`);
}
const output = path.resolve(values.out);
const fixture = path.join(output, "fixture");
assert(!existsSync(fixture), "output must not contain a prior fixture");
mkdirSync(path.join(fixture, "workspace"), { recursive: true });
const abort = new AbortController();
const interrupt = () => abort.abort(new Error("workload interrupted"));
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const children: ChildProcess[] = [];
const events: object[] = [];
let watches = 0;
let sends = 0;
let delivered = 0;
let phase = "boot";
let phaseStart = Date.now();
const evidence = {
  harnessVersion: "3.1.5",
  heartbeatMode: heartbeatMode ?? "attribution",
  steadySeconds,
  load: [{ phase: "boot", values: loadavg() }],
  gatewayReadyMs: null as number | null,
  firstSamplePersisted: false,
  hostStatsBroadcasts: 0,
  broadcastsByPhase: {} as Record<string, number>,
  liveCatalogMatches: 0,
  offlineCatalogMatches: false,
  finalSamplePersisted: false,
  maxDurableSampleLagMs: 0,
  broadcastReceiptLagMs: [] as number[],
  catalogResponseMs: [] as number[],
  resources: [] as object[],
  steadyCpu: null as ReturnType<typeof measureGatewayCpuUsage> | null,
  steadyDiagnostics: null as Awaited<
    ReturnType<Awaited<ReturnType<typeof startGatewayDiagnostics>>>
  > | null,
  shutdownMs: null as number | null,
  turns: [],
  children: [] as { name: string; pid: number }[],
  phases: [] as { phase: string; start: number; end: number }[],
  hostSurfaceChanges: 0,
  heartbeatRevisionChanges: 0,
  ok: false,
};
function setPhase(next: string) {
  evidence.phases.push({ phase, start: phaseStart, end: Date.now() });
  phase = next;
  evidence.load.push({ phase, values: loadavg() });
  phaseStart = Date.now();
  writeFileSync(path.join(output, "phase"), phase);
}
writeFileSync(path.join(output, "phase"), phase);
const server = createServer((req, res) => {
  if (req.url === "/watch") {
    watches++;
  }
  if (req.url === "/sent") {
    sends++;
  }
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/next") {
    delivered += events.length;
    res.end(JSON.stringify(events.splice(0)));
  } else {
    res.end("{}");
  }
});
await new Promise<void>((resolve) => {
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
assert(address && typeof address !== "string");
const bridgeUrl = `http://127.0.0.1:${address.port}`;
function launch(args: string[], env: NodeJS.ProcessEnv, name: string) {
  const log = createWriteStream(path.join(output, `${name}.log`));
  const child = spawn(process.execPath, args, {
    env,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    detached: true,
  });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  children.push(child);
  assert(child.pid, `${name} failed to spawn`);
  evidence.children.push({ name, pid: child.pid });
  return child;
}
async function until(predicate: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 180_000;
  while (!(await predicate())) {
    abort.signal.throwIfAborted();
    assert(Date.now() < deadline, `${label} timeout`);
    await delay(250);
  }
}
type HostStats = { updatedAtMs: number; [key: string]: unknown };
type CatalogNode = { nodeId: string; connected: boolean; hostStats?: HostStats };
const broadcasts: { nodeId: string; stats: HostStats; phase: string }[] = [];
let latestBroadcast: (typeof broadcasts)[number] | undefined;
let client: ReturnType<typeof createGatewayWsClient> | undefined;
try {
  const port = await getFreePort();
  const bridge = path.join(fixture, "synthetic-imsg");
  const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  writeFileSync(
    bridge,
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.resolve("scripts/perf/bench-ingress-bridge.mjs"))} "$@"\n`,
    { mode: 0o755 },
  );
  const cfg = {
    ...structuredClone(BASE_GATEWAY_BENCH_CONFIG),
    agents: {
      defaults: { skipBootstrap: true },
      entries: { main: { workspace: path.join(fixture, "workspace") } },
    },
    channels: {
      imessage: {
        enabled: true,
        cliPath: bridge,
        dbPath: path.join(fixture, "synthetic-chat.db"),
        dmPolicy: "allowlist" as const,
        allowFrom: ["+15555550100"],
      },
    },
    plugins: {
      entries: {
        imessage: { enabled: true },
        "memory-core": { config: { dreaming: { enabled: false } } },
      },
    },
  };
  const configPath = writeGatewayBenchConfig(fixture, cfg, {
    agentList: [{ id: "main", workspace: path.join(fixture, "workspace") }],
  });
  const stopPreload = new URL("../lib/gateway-bench-stop-preload.mjs", import.meta.url);
  stopPreload.searchParams.set("parentPid", String(process.pid));
  stopPreload.searchParams.set("entry", path.resolve("dist/entry.js"));
  const gateway = launch(
    buildGatewayBenchChildArgs("dist/entry.js", port, [
      ...gatewayBenchCpuProfileArgs(output),
      "--import",
      stopPreload.href,
      ...(heartbeatMode
        ? [
            "--import",
            "./scripts/tsx.mjs",
            "--import",
            "./scripts/lib/gateway-bench-profile-preload.ts",
          ]
        : []),
    ]),
    {
      ...createGatewayBenchEnv(fixture, configPath, { caseEnv: {} }),
      INGRESS_BENCH_URL: bridgeUrl,
      SQLMEASURE_OUT: output,
      NODE_OPTIONS: `--require=${JSON.stringify(observer)} --enable-source-maps`,
    },
    "gateway",
  );
  const ready = await waitForInitialProbe({
    port,
    path: "/readyz",
    startAt: performance.now(),
    deadlineAt: performance.now() + 300_000,
    isDone: () => gateway.exitCode !== null || gateway.signalCode !== null,
  });
  assert.equal(ready.status, 200, "Gateway unavailable");
  evidence.gatewayReadyMs = ready.ms;
  await until(() => watches > 0, "iMessage watch");
  client = createGatewayWsClient({
    url: `ws://127.0.0.1:${port}`,
    onEvent: (event) => {
      if (event.event !== "node.hostStats") {
        return;
      }
      const payload = event.payload as { nodeId: string; hostStats: HostStats };
      latestBroadcast = {
        nodeId: payload.nodeId,
        stats: payload.hostStats,
        phase,
      };
      broadcasts.push(latestBroadcast);
      evidence.hostStatsBroadcasts++;
      evidence.broadcastsByPhase[phase] = (evidence.broadcastsByPhase[phase] ?? 0) + 1;
      if (phase === "steady" || phase === "warm") {
        evidence.broadcastReceiptLagMs.push(Date.now() - payload.hostStats.updatedAtMs);
      }
    },
  });
  await client.waitOpen();
  const call = async (method: string, params = {}) => {
    const result = await client!.request(method, params);
    assert.equal(result.ok, true, `${method} failed: ${JSON.stringify(result.error)}`);
    return result.payload;
  };
  await call("connect", {
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client: { id: "gateway-client", version: "1.0.0", platform: process.platform, mode: "backend" },
    role: "operator",
    scopes: ["operator.admin", "operator.read", "operator.write", "operator.pairing"],
    caps: [],
  });
  const nodeRoot = path.join(output, "node-fixture");
  mkdirSync(nodeRoot, { recursive: true });
  const nodeConfig = writeGatewayBenchConfig(nodeRoot, BASE_GATEWAY_BENCH_CONFIG, {});
  setPhase("first-sample");
  const node = launch(
    [
      ...gatewayBenchCpuProfileArgs(output),
      "dist/entry.js",
      "node",
      "run",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--display-name",
      "synthetic-livepair-node",
      "--all-commands",
      "--no-share-installed-apps",
      "--no-desktop-sharing",
    ],
    createGatewayBenchEnv(nodeRoot, nodeConfig, { caseEnv: {} }),
    "node",
  );
  await until(async () => {
    assert(node.exitCode === null && node.signalCode === null, "node host exited");
    // Fresh direct-loopback nodes inherit the connection owner's silent device/surface approval.
    const list = (await call("node.list")) as { nodes: { connected: boolean }[] };
    return list.nodes.some((entry) => entry.connected);
  }, "paired node connection");
  const db = new DatabaseSync(path.join(fixture, "state", "state", "openclaw.sqlite"), {
    readOnly: true,
  });
  try {
    const read = () => {
      const row = db
        .prepare(
          "SELECT node_surface_json FROM device_pairing_paired WHERE node_surface_json IS NOT NULL",
        )
        .get() as { node_surface_json: string };
      const revision = db
        .prepare(
          "SELECT value_json FROM config_machine_state WHERE state_key = 'devicePairing.revision'",
        )
        .get() as { value_json: string };
      const surface = JSON.parse(row.node_surface_json) as { lastHostStats?: HostStats };
      return { stats: surface.lastHostStats, revision: revision.value_json };
    };
    const checkLiveBroadcasts = async () => {
      for (const broadcast of broadcasts.splice(0)) {
        const started = performance.now();
        const list = (await call("node.list")) as { nodes: CatalogNode[] };
        const entry = list.nodes.find((candidate) => candidate.nodeId === broadcast.nodeId);
        assert(entry?.connected, "broadcast must have a live catalog entry");
        assert(
          JSON.stringify(entry.hostStats) === JSON.stringify(broadcast.stats),
          "live catalog must expose the broadcast sample immediately",
        );
        evidence.liveCatalogMatches++;
        if (broadcast.phase === "steady" || broadcast.phase === "warm") {
          evidence.catalogResponseMs.push(performance.now() - started);
        }
      }
    };
    await until(() => read().stats !== undefined, "initial persisted host stats");
    evidence.firstSamplePersisted = true;
    await checkLiveBroadcasts();
    let previous = read();
    const resourcesBefore = heartbeatMode ? await readGatewayResources(gateway) : undefined;
    const stopDiagnostics = heartbeatMode
      ? await startGatewayDiagnostics(gateway, "steady")
      : undefined;
    setPhase(heartbeatMode ? "steady" : "warm");
    const started = Date.now();
    let nextMessage = 0;
    let nextResourceSample = 60_000;
    while (Date.now() - started < steadySeconds * 1_000) {
      abort.signal.throwIfAborted();
      assert(
        node.exitCode === null && node.signalCode === null,
        "node host exited during steady phase",
      );
      const elapsed = Date.now() - started;
      if (nextMessage < 8 && elapsed >= nextMessage * 15_000) {
        events.push({
          id: nextMessage + 1,
          guid: `synthetic-${nextMessage}`,
          chat_id: 1,
          sender: "+15555550123",
          text: "Synthetic denied message.",
          is_from_me: false,
          is_group: false,
          created_at: new Date().toISOString(),
        });
        nextMessage++;
      }
      const current = read();
      if (JSON.stringify(current.stats) !== JSON.stringify(previous.stats)) {
        evidence.hostSurfaceChanges++;
      }
      if (current.revision !== previous.revision) {
        evidence.heartbeatRevisionChanges++;
      }
      if (latestBroadcast && current.stats) {
        evidence.maxDurableSampleLagMs = Math.max(
          evidence.maxDurableSampleLagMs,
          latestBroadcast.stats.updatedAtMs - current.stats.updatedAtMs,
        );
      }
      previous = current;
      await checkLiveBroadcasts();
      if (heartbeatMode && elapsed >= nextResourceSample) {
        const sample = await readGatewayResources(gateway);
        evidence.resources.push({ elapsedMs: elapsed, memory: sample.memory });
        nextResourceSample += 60_000;
      }
      await delay(250, undefined, { signal: abort.signal });
    }
    await checkLiveBroadcasts();
    if (resourcesBefore && stopDiagnostics) {
      const after = await readGatewayResources(gateway);
      evidence.resources.unshift({ elapsedMs: 0, memory: resourcesBefore.memory });
      evidence.resources.push({ elapsedMs: Date.now() - started, memory: after.memory });
      evidence.steadyCpu = measureGatewayCpuUsage(resourcesBefore, after);
      evidence.steadyDiagnostics = await stopDiagnostics();
      assert.equal(evidence.steadyDiagnostics.collectionErrors, 0);
      assert.equal(evidence.steadyDiagnostics.droppedEvents, 0);
    }
    assert.equal(delivered, 8);
    assert.equal(sends, 0, "allowlist denial must not send");
    assert.equal(evidence.liveCatalogMatches, evidence.hostStatsBroadcasts);
    assert(
      evidence.hostStatsBroadcasts >= 1 + Math.floor(steadySeconds / 60),
      "normal reports required",
    );
    if (heartbeatMode === "checkpoint") {
      assert(
        evidence.hostSurfaceChanges >= Math.floor(steadySeconds / 300) &&
          evidence.hostSurfaceChanges <= Math.ceil(steadySeconds / 240),
        "checkpoint writes must follow the five-minute sample-age deadline",
      );
    } else {
      assert(
        evidence.hostSurfaceChanges >= Math.floor(steadySeconds / 60),
        "per-report writes required",
      );
    }
    assert.equal(
      evidence.heartbeatRevisionChanges,
      evidence.hostSurfaceChanges,
      "each actual telemetry write must advance the durable revision",
    );
    setPhase("disconnect");
    await stopChild(node, { teardownGraceMs: 10_000, killGraceMs: 2_000 });
    assert(latestBroadcast, "at least one host-stat broadcast required");
    await until(() => {
      evidence.finalSamplePersisted =
        JSON.stringify(read().stats) === JSON.stringify(latestBroadcast!.stats);
      return evidence.finalSamplePersisted;
    }, "final sample persistence");
    await until(async () => {
      const list = (await call("node.list")) as { nodes: CatalogNode[] };
      const entry = list.nodes.find((candidate) => candidate.nodeId === latestBroadcast!.nodeId);
      evidence.offlineCatalogMatches =
        entry?.connected === false &&
        JSON.stringify(entry.hostStats) === JSON.stringify(latestBroadcast!.stats);
      return evidence.offlineCatalogMatches;
    }, "offline catalog final-sample parity");
  } finally {
    db.close();
  }
  setPhase("shutdown");
  client.close();
  evidence.shutdownMs = (await stopGatewayGracefully(gateway, 30_000)).ms;
  evidence.ok = true;
} finally {
  if (phase !== "shutdown") {
    setPhase("shutdown");
  }
  client?.close();
  for (const child of children.toReversed()) {
    await stopChild(child, { teardownGraceMs: 10_000, killGraceMs: 2_000 });
  }
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  setPhase("done");
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
  writeFileSync(
    path.join(output, "evidence.json"),
    JSON.stringify(
      {
        ...evidence,
        broadcastReceiptLagMs: summarizeNumbers(evidence.broadcastReceiptLagMs),
        catalogResponseMs: summarizeNumbers(evidence.catalogResponseMs),
        delivered,
        sends,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      ok: evidence.ok,
      heartbeatMode: evidence.heartbeatMode,
      hostSurfaceChanges: evidence.hostSurfaceChanges,
      heartbeatRevisionChanges: evidence.heartbeatRevisionChanges,
      broadcasts: evidence.hostStatsBroadcasts,
      liveCatalogMatches: evidence.liveCatalogMatches,
      offlineCatalogMatches: evidence.offlineCatalogMatches,
      delivered,
      sends,
    }),
  );
}
