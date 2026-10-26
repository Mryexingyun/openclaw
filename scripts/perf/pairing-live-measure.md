# Pairing live traffic reproduction

This workload uses an isolated Gateway, the bundled iMessage plugin with the existing synthetic bridge, and a real foreground node host with its own synthetic state directory. It never opens a user profile. Output belongs in a task-owned directory on the internal disk; archive only aggregate counts and profiles.

## Acceptance rule (before measurements)

Attribute cold startup separately from a warm 130-second window after the first persisted host-stat sample with one paired node advertising its normal command surface (no command invocation) and eight rejected iMessage direct messages at 15-second intervals. The channel uses `allowlist` policy with a configured synthetic sender distinct from those messages. Count SQL statements, worker requests and runtime main-thread statements with the frozen observer. Count successive persisted node surfaces and pairing revisions as changed or unchanged; never report their contents.

A valid deletion removes one `pairing.allowFrom` request and its SELECT per direct message under open/allowlist policy, while pairing-policy DMs retain their current authorization read. The node heartbeat triplet is retained if its observation timestamp and pairing revision change each minute. Preserve immediate pairing revocation and external-writer visibility; no cache, schema or transaction changes.

The initial attribution is counts only, with per-thread CPU profiles; no latency claim. For a candidate, run three alternating baseline/candidate pairs when the campaign's load/disk gate allows, otherwise one pair with explicit attribution. Compare cold and warm separately: zero new runtime MAIN statements, zero added touched-owner work, identical denied-message outcomes and monotonic heartbeat freshness. Any user-facing latency comparison requires the campaign timing lock, load below 24 and at least five interleaved samples per arm; a 20% regression stops the change.

Run after building the current head with the repository's `qaRuntime` build:

```sh
node --import ./scripts/tsx.mjs scripts/perf/pairing-live-measure.mts \
  --out <internal-task-output> \
  --observer <frozen-harness>/observer.cjs
```

## Host telemetry checkpoint acceptance (preregistered)

The heartbeat checkpoint change uses this real Gateway and paired-node flow with
the frozen v3.1.5 observer, causality observer, and background roots. Reproduce the
current-main heartbeat writes before changing production code. Count cold startup,
the first accepted sample, a 15-minute steady phase, disconnect, and shutdown
separately. Keep all fixture state synthetic. The earlier requirement for at least
two persisted samples in 130 seconds describes the old cadence; the checkpoint
workload replaces it with the following contract.

Run five alternating baseline/candidate pairs on the same platform. For one node
reporting every minute, steady heartbeat work must fall from approximately 75 SQL
statements and 15 execute requests to at most 20 statements and four requests per
15 minutes. Runtime main-thread SQL must remain zero. Report per-operation counts
and rates, median, p95, and min–max separately for each phase. Count whole-process
and main-thread work, including final persistence, to expose relocated cost.

Record per-thread CPU profiles, CPU totals, RSS/heap, event-response and catalog
latency, and broadcast counts. Every accepted report must remain immediately
visible in the live catalog and broadcast stream. User-facing metrics must hold
or improve; an adverse 20% cell stops the change, and smaller adverse movement
needs explicit disposition. Wall-clock/CPU A/B runs require the campaign timing
lock and load below 24. After 60 minutes without timing admission, report only
counts/profile evidence and the unmeasured timing limitation.

Behavioral acceptance also requires durable-immediate revocation and identity
changes, a report arriving during an outstanding checkpoint, final-sample
disconnect persistence, shutdown drain before worker retirement, crash/reload
staleness bounded by the checkpoint interval, offline catalog parity, and passing
revision-consumer suites. Keep security and all other paired-state writes
immediate; only `lastHostStats` is coalesced in the existing NodeRegistry.

The approved tradeoffs are explicit: a crash can lose roughly five minutes of
host telemetry, and the offline catalog can briefly display the previous durable
sample while disconnect persistence settles. The five-minute deadline is anchored
to the last persisted sample's receipt time and assumes continuing reports and
successful scheduling/storage; completion delay and sensor silence remain visible
in the original `updatedAtMs`. First-sample persistence is immediate. No schema,
second pairing store, or memory-only authorization revision is introduced.
