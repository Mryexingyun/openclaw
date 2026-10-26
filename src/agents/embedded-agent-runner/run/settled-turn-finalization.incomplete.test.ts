import fs from "node:fs/promises";
import path from "node:path";
import type { Context } from "openclaw/plugin-sdk/llm";
import { expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  cleanupPluginLoaderFixturesForTest,
  resetPluginLoaderTestStateForTest,
} from "../../../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../../../plugins/plugin-metadata-lifecycle.js";
import { createColdPluginFixture } from "../../../plugins/test-helpers/cold-plugin-fixtures.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../../prepared-model-runtime.test-support.js";
import type { StreamFn } from "../../runtime/index.js";
import { completionModelDefinition } from "../../simple-completion.test-support.js";
import { makeAgentAssistantMessage } from "../../test-helpers/agent-message-fixtures.js";
import { createQueuedAssistantStream } from "../../test-helpers/assistant-event-stream.test-support.js";
import { ZERO_USAGE_FIXTURE } from "../../test-helpers/usage-fixtures.js";
import { runEmbeddedAgent } from "../run.js";
import { clearEmbeddedSessionPromptStates } from "../session-prompt-state.js";

const providerPluginId = "scripted-finalization-provider";
const modelId = "fixture-model";
const summary = "Both files are written: a.txt contains alpha and b.txt contains beta.";
const cutoffNotice =
  "The model was cut off at its output token limit, so the summary above was written afterwards without tools.";

// Adapted from @ablake4427's #178300 reproduction: real writes and finalization,
// with only provider I/O scripted. A summary cannot finish interrupted work.
it("preserves a length failure after recovering a summary", async () => {
  const sessionId = "interrupted-finalization";
  await withOpenClawTestState({ label: sessionId }, async (state) => {
    const bundled = state.path("bundled");
    await fs.mkdir(bundled);
    const requests: string[] = [];
    const stream: StreamFn = (model, context: Context) => {
      const hasTools = Boolean(context.tools?.length);
      const toolResults = context.messages.filter(
        (message) => message.role === "toolResult",
      ).length;
      const write = hasTools && toolResults === 0;
      const stopReason = !hasTools ? "stop" : write ? "toolUse" : "length";
      const message = makeAgentAssistantMessage({
        api: model.api,
        provider: model.provider,
        model: model.id,
        stopReason,
        ...(hasTools && !write
          ? { usage: { ...ZERO_USAGE_FIXTURE, output: 1, totalTokens: 1 } }
          : {}),
        content: !hasTools
          ? [{ type: "text", text: summary }]
          : write
            ? [
                {
                  type: "toolCall",
                  id: "write-a",
                  name: "write",
                  arguments: { path: "a.txt", content: "alpha\n" },
                },
              ]
            : [
                {
                  type: "thinking",
                  thinking: "Next I need to write b.txt",
                  thinkingSignature: "opaque-signature",
                },
              ],
      });
      requests.push(hasTools ? (write ? "write-a" : message.stopReason) : "summary");
      return createQueuedAssistantStream((push) => {
        push({ type: "done", reason: stopReason, message });
      });
    };
    const bridgeKey = `__finalization_fixture_${path.basename(state.root)}`;
    Object.defineProperty(globalThis, bridgeKey, { configurable: true, value: { stream } });
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("Scripted provider fixture must not perform network I/O");
    });
    try {
      const rootDir = path.join(bundled, providerPluginId);
      await fs.mkdir(rootDir);
      const fixture = createColdPluginFixture({
        rootDir,
        pluginId: providerPluginId,
        providerId: "anthropic",
        manifest: {
          channels: [],
          channelConfigs: {},
          providerAuthChoices: [],
          providers: ["anthropic"],
        },
      });
      await fs.writeFile(
        fixture.runtimeSource,
        `module.exports = { id: ${JSON.stringify(providerPluginId)}, register(api) {
  const bridge = globalThis[${JSON.stringify(bridgeKey)}];
  api.registerProvider({ id: "anthropic", label: "Scripted provider", auth: [], wrapStreamFn: () => bridge.stream });
} };`,
      );
      const config: OpenClawConfig = {
        agents: {
          entries: { main: { agentDir: state.agentDir(), workspace: state.workspaceDir } },
          defaults: { workspace: state.workspaceDir, model: `anthropic/${modelId}` },
        },
        models: {
          mode: "replace",
          providers: {
            anthropic: {
              api: "anthropic-messages",
              auth: "api-key",
              apiKey: "synthetic-finalization-key",
              baseUrl: "https://provider.invalid",
              models: [completionModelDefinition({ id: modelId, contextWindow: 200_000 })],
            },
          },
        },
        plugins: {
          allow: [providerPluginId],
          slots: { memory: "none" },
          entries: { [providerPluginId]: { enabled: true } },
        },
        skills: { load: { watch: false } },
      };
      await state.writeConfig(config);
      await withEnvAsync(
        { OPENCLAW_BUNDLED_PLUGINS_DIR: bundled, OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined },
        async () => {
          await resetPreparedModelRuntimeSnapshotsForTest();
          clearPluginMetadataLifecycleCaches();
          setRuntimeConfigSnapshot(config);
          const runId = `${sessionId}-run`;
          const admission = prepareSystemAgentRunAdmission(config, runId, "main", sessionId);
          const lifecycle: Array<Record<string, unknown>> = [];
          try {
            const result = await runEmbeddedAgent({
              preparedRunAdmission: admission,
              config,
              runId,
              sessionId,
              agentDir: state.agentDir(),
              workspaceDir: state.workspaceDir,
              sessionTarget: {
                agentId: "main",
                sessionId,
                sessionKey: `agent:main:${sessionId}`,
                storePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
              },
              provider: "anthropic",
              model: modelId,
              prompt:
                "Create a.txt containing alpha, then b.txt containing beta. Tell me when both are written.",
              toolsAllow: ["read", "write"],
              cleanupBundleMcpOnRunEnd: true,
              timeoutMs: 60_000,
              onAgentEvent: (event) => {
                if (event.stream === "lifecycle") {
                  lifecycle.push({ ...event.data });
                }
              },
            });
            expect(network).not.toHaveBeenCalled();
            expect(requests).toEqual(["write-a", "length", "summary"]);
            expect(await fs.readFile(path.join(state.workspaceDir, "a.txt"), "utf8")).toBe(
              "alpha\n",
            );
            await expect(fs.readFile(path.join(state.workspaceDir, "b.txt"))).rejects.toMatchObject(
              { code: "ENOENT" },
            );
            const deliveredText = result.payloads?.map((payload) => payload.text ?? "").join("\n");
            expect(deliveredText).toContain(summary);
            expect.soft(result.meta).toMatchObject({
              stopReason: "length",
              completion: { stopReason: "length", finishReason: "length" },
              error: { kind: "incomplete_turn", fallbackSafe: false },
            });
            expect(deliveredText).toContain(cutoffNotice);
            const phases = lifecycle.map((event) => event.phase);
            expect.soft(phases).toContain("error");
            expect.soft(phases).not.toContain("end");
          } finally {
            admission.close();
            await resetPreparedModelRuntimeSnapshotsForTest();
            resetPluginLoaderTestStateForTest();
            cleanupPluginLoaderFixturesForTest();
            clearPluginMetadataLifecycleCaches();
          }
        },
      );
    } finally {
      network.mockRestore();
      clearEmbeddedSessionPromptStates([sessionId]);
      Reflect.deleteProperty(globalThis, bridgeKey);
    }
  });
});
