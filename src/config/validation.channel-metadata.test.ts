import { assert, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginManifestRecord, PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createPluginManifestRecordFixture as plugin } from "../plugins/plugin-metadata.test-support.js";
import {
  validateConfigObjectRawWithPlugins,
  validateConfigObjectWithPlugins,
} from "./validation.js";
import { validatedConfig } from "./validation.test-helpers.js";

let manifestRegistry: PluginManifestRegistry;
const metadata = () => ({ manifestRegistry });

function registry(...plugins: PluginManifestRecord[]): PluginManifestRegistry {
  return { diagnostics: [], plugins };
}

function install(...plugins: Parameters<typeof plugin>[0][]) {
  manifestRegistry = registry(...plugins.map(plugin));
}

const objectSchema = (
  properties: Record<string, unknown>,
  options: Record<string, unknown> = {},
) => ({ type: "object", properties, additionalProperties: false, ...options });

function feishuPlugin(schema: Record<string, unknown> = objectSchema({}), id = "openclaw-lark") {
  return plugin({
    id,
    origin: "global",
    channels: ["feishu"],
    channelConfigs: { feishu: { schema, uiHints: {} } },
  });
}

function validateFeishu(config: Record<string, unknown>) {
  return validateConfigObjectRawWithPlugins(
    { channels: { feishu: config } },
    { pluginMetadataSnapshot: metadata() },
  );
}

function pluginDefaultsRegistry() {
  return registry(
    plugin({
      id: "opik",
      configSchema: objectSchema(
        { workspace: { type: "string", default: "default-workspace" } },
        { required: ["workspace"], additionalProperties: true },
      ),
    }),
  );
}

const enabledOpik = { plugins: { allow: ["opik"], entries: { opik: { enabled: true } } } };

vi.mock("./zod-schema.js", () => ({
  OpenClawSchema: { safeParse: (raw: unknown) => ({ success: true, data: raw }) },
}));

beforeEach(() => {
  clearPluginMetadataLifecycleCaches();
  manifestRegistry = registry();
});

describe("config validation metadata", () => {
  it("loads catalog defaults before materialization when plugin validation is skipped", () => {
    const source = {
      plugins: { enabled: true },
      models: {
        providers: {
          fixture: {
            baseUrl: "https://models.example/v1",
            models: [{ id: "vision-model", name: "Authored model", contextWindow: 64_000 }],
          },
        },
      },
    };
    const original = structuredClone(source);
    const cost = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 };
    const catalogModel = {
      id: "vision-model",
      name: "Catalog model",
      reasoning: true,
      input: ["text" as const, "image" as const],
      cost,
      contextWindow: 128_000,
      maxTokens: 16_000,
    };
    const expectedModel = {
      ...structuredClone(catalogModel),
      name: "Authored model",
      contextWindow: 64_000,
    };
    install({
      id: "fixture",
      providers: ["fixture"],
      modelCatalog: {
        providers: { fixture: { models: [catalogModel] } },
      },
    });
    const loadPluginMetadataSnapshot = vi.fn(metadata);
    const result = validateConfigObjectWithPlugins(source, {
      pluginValidation: "skip",
      loadPluginMetadataSnapshot,
    });
    expect(validatedConfig(result).models?.providers?.fixture?.models).toMatchObject([
      expectedModel,
    ]);
    expect(source).toEqual(original);
    expect(loadPluginMetadataSnapshot).toHaveBeenCalledOnce();
  });

  it("applies channel schema defaults even in raw mode", () => {
    install({
      id: "telegram",
      channels: ["telegram"],
      channelCatalogMeta: { id: "telegram", label: "Telegram", blurb: "Telegram channel" },
      channelConfigs: {
        telegram: {
          schema: objectSchema(
            { dmPolicy: { type: "string", enum: ["pairing", "allowlist"], default: "pairing" } },
            { additionalProperties: true },
          ),
          uiHints: {},
        },
      },
    });
    expect(
      validatedConfig(
        validateConfigObjectRawWithPlugins(
          { channels: { telegram: {} } },
          { pluginMetadataSnapshot: metadata() },
        ),
      ).channels?.telegram?.dmPolicy,
    ).toBe("pairing");
  });

  it("keeps schema ownership when closer root metadata shadows a later schema", () => {
    install(
      feishuPlugin(objectSchema({}), "openclaw" + String.fromCharCode(10, 27) + "[31m-lark"),
      plugin({ id: "workspace-channel-labels", origin: "workspace", channels: ["feishu"] }),
      feishuPlugin(objectSchema({ otherField: { type: "string" } }), "other-global-feishu"),
    );
    const result = validateFeishu({ unsupportedField: true });
    assert(!result.ok);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        path: "channels.feishu",
        message:
          'invalid config for plugin openclaw-lark: must not have additional properties: "unsupportedField"',
      }),
    );
    expect(result.issues.map((issue) => issue.message)).not.toContain(
      'invalid config for plugin other-global-feishu: must not have additional properties: "unsupportedField"',
    );
  });

  it.each([false, true])("materializes plugin defaults only in normal mode=%s", (materialized) => {
    const loadPluginMetadataSnapshot = vi.fn(() => ({
      manifestRegistry: pluginDefaultsRegistry(),
    }));
    const result = materialized
      ? validateConfigObjectWithPlugins(enabledOpik, { loadPluginMetadataSnapshot })
      : validateConfigObjectRawWithPlugins(
          { plugins: { entries: { opik: { enabled: true } } } },
          { pluginMetadataSnapshot: { manifestRegistry: pluginDefaultsRegistry() } },
        );
    expect(loadPluginMetadataSnapshot).toHaveBeenCalledTimes(Number(materialized));
    expect(validatedConfig(result).plugins?.entries?.opik?.config).toEqual(
      materialized ? { workspace: "default-workspace" } : undefined,
    );
  });
});
