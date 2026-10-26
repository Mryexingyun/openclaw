import { beforeEach, expect, it, vi } from "vitest";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createPluginManifestRecordFixture as plugin } from "../plugins/plugin-metadata.test-support.js";
import {
  validateConfigObjectRawWithPlugins,
  validateConfigObjectWithPlugins,
} from "./validation.js";
import { validatedConfig, validationIssues } from "./validation.test-helpers.js";

const metadata = (...plugins: Parameters<typeof plugin>[0][]) => ({
  pluginMetadataSnapshot: { manifestRegistry: { diagnostics: [], plugins: plugins.map(plugin) } },
});
const objectSchema = (
  properties: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) => ({ type: "object", properties, additionalProperties: false, ...extra });
const feishu = (id: string, properties: Record<string, unknown> = {}) => ({
  id,
  origin: "global" as const,
  channels: ["feishu"],
  channelConfigs: { feishu: { schema: objectSchema(properties) } },
});

// Synthetic channels isolate metadata validation from bundled channel schema admission.
vi.mock("./zod-schema.js", () => ({
  OpenClawSchema: { safeParse: (raw: unknown) => ({ success: true, data: raw }) },
}));
beforeEach(clearPluginMetadataLifecycleCaches);

it("loads catalog defaults before materialization when plugin validation is skipped", () => {
  const source = {
    models: {
      providers: {
        fixture: {
          baseUrl: "https://models.example/v1",
          models: [{ id: "vision-model", name: "Authored model" }],
        },
      },
    },
  };
  const original = structuredClone(source);
  const options = metadata({
    id: "fixture",
    providers: ["fixture"],
    modelCatalog: {
      providers: {
        fixture: {
          models: [{ id: "vision-model", name: "Catalog model", reasoning: true }],
        },
      },
    },
  });
  const result = validateConfigObjectWithPlugins(source, {
    loadPluginMetadataSnapshot: () => options.pluginMetadataSnapshot,
    pluginValidation: "skip",
  });
  expect(validatedConfig(result).models?.providers?.fixture?.models).toMatchObject([
    { id: "vision-model", name: "Authored model", reasoning: true },
  ]);
  expect(source).toEqual(original);
});

it("applies channel schema defaults even in raw mode", () => {
  const result = validateConfigObjectRawWithPlugins(
    { channels: { telegram: {} } },
    metadata({
      id: "telegram",
      channels: ["telegram"],
      channelConfigs: {
        telegram: {
          schema: objectSchema(
            {
              dmPolicy: { type: "string", enum: ["pairing", "allowlist"], default: "pairing" },
            },
            { additionalProperties: true },
          ),
        },
      },
    }),
  );
  expect(validatedConfig(result).channels?.telegram?.dmPolicy).toBe("pairing");
});

it("keeps schema ownership when closer root metadata shadows a later schema", () => {
  const issues = validationIssues(
    validateConfigObjectRawWithPlugins(
      { channels: { feishu: { unsupportedField: true } } },
      metadata(
        feishu("openclaw" + String.fromCharCode(10, 27) + "[31m-lark"),
        { id: "workspace-channel-labels", origin: "workspace", channels: ["feishu"] },
        feishu("other-global-feishu", { otherField: { type: "string" } }),
      ),
    ),
  );
  expect(issues).toContainEqual(
    expect.objectContaining({
      path: "channels.feishu",
      message:
        'invalid config for plugin openclaw-lark: must not have additional properties: "unsupportedField"',
    }),
  );
  expect(issues.map((issue) => issue.message)).not.toContain(
    'invalid config for plugin other-global-feishu: must not have additional properties: "unsupportedField"',
  );
});

it.each([false, true])("materializes absent plugin config only in normal mode=%s", (normal) => {
  const validate = normal ? validateConfigObjectWithPlugins : validateConfigObjectRawWithPlugins;
  const result = validate(
    { plugins: { allow: ["opik"], entries: { opik: { enabled: true } } } },
    metadata({
      id: "opik",
      configSchema: objectSchema(
        { workspace: { type: "string", default: "default-workspace" } },
        { required: ["workspace"], additionalProperties: true },
      ),
    }),
  );
  expect(validatedConfig(result).plugins?.entries?.opik?.config).toEqual(
    normal ? { workspace: "default-workspace" } : undefined,
  );
});

function warnings(raw: unknown, plugins: PluginManifestRecord[]) {
  const result = validateConfigObjectWithPlugins(raw, {
    pluginMetadataSnapshot: { manifestRegistry: { diagnostics: [], plugins } },
  });
  expect(result.ok).toBe(true);
  return result.warnings;
}
function dmWarnings(
  channels: Record<string, unknown>,
  doctorCapabilities?: { dmAllowFromMode: "nestedOnly" },
) {
  return warnings(
    { channels },
    Object.keys(channels).map((id) =>
      plugin({
        id,
        channels: [id],
        packageChannel: { id, doctorCapabilities },
      }),
    ),
  );
}
const forChannel = (issues: ReturnType<typeof warnings>, channel: string) =>
  issues.filter((issue) => issue.path.startsWith(`channels.${channel}`));

// Eligibility and ordering permutations belong to runtime-schema.test.ts; this
// boundary proves that the chosen owner's capability drives root/account warnings.
it.each([false, true])("uses the selected owner's wildcard requirement=%s", (requiresWildcard) => {
  const issues = warnings(
    {
      plugins: { entries: { plus: { enabled: true } } },
      channels: {
        proofchat: {
          plus: "selected schema",
          dmPolicy: "open",
          allowFrom: ["123"],
          accounts: {
            ops: { dmPolicy: "open", allowFrom: ["456"] },
            empty: { dmPolicy: "allowlist", allowFrom: [] },
          },
        },
      },
    },
    ["core", "plus"].map((id) =>
      plugin({
        id,
        origin: "global",
        channels: ["proofchat"],
        packageChannel: {
          id: "proofchat",
          doctorCapabilities: {
            openDmRequiresAllowFromWildcard: id === "plus" ? requiresWildcard : !requiresWildcard,
          },
        },
        channelConfigs: {
          proofchat: {
            ...(id === "plus" ? { preferOver: ["core"] } : {}),
            schema: { type: "object", required: [id] },
          },
        },
      }),
    ),
  );
  const suffixes = requiresWildcard
    ? ["allowFrom", "accounts.ops.allowFrom", "accounts.empty.allowFrom"]
    : ["accounts.empty.allowFrom"];
  expect(forChannel(issues, "proofchat").map((issue) => issue.path)).toEqual(
    suffixes.map((suffix) => `channels.proofchat.${suffix}`),
  );
});

it("does not warn for disabled channels/accounts", () => {
  const channels = {
    mattermost: { enabled: false, dmPolicy: "open", accounts: { team: { dmPolicy: "open" } } },
    slack: { accounts: { work: { enabled: false, dmPolicy: "open" } } },
  };
  expect(dmWarnings(channels).filter((issue) => issue.path.startsWith("channels."))).toEqual([]);
});

const openDm = { policy: "open" };
const wildcardDm = { ...openDm, allowFrom: ["*"] };
const nested = (dm: unknown, team: unknown, disabled?: unknown) => ({
  ...(dm === undefined ? {} : { dm }),
  accounts: { team, ...(disabled === undefined ? {} : { disabled }) },
});
it.each([
  ["inherited missing wildcard", nested(openDm, { dm: {} }), ["", "team"]],
  ["empty account override", nested(wildcardDm, { dm: { allowFrom: [] } }), ["team"]],
  [
    "account enablement",
    nested({ ...openDm, enabled: false }, { dm: { enabled: true } }, { dm: {} }),
    ["team"],
  ],
  [
    "ignored wildcard alias",
    nested({ policy: "allowlist", allowFrom: [] }, { allowFrom: ["*"] }),
    ["", "team"],
  ],
  ["ignored empty alias", nested(wildcardDm, { allowFrom: [] }), []],
  ["ignored policy alias", nested(undefined, { dmPolicy: "open", dm: { allowFrom: [] } }), []],
] as const)("uses canonical nested DM fields: %s", (_name, matrix, scopes) => {
  const issues = forChannel(dmWarnings({ matrix }, { dmAllowFromMode: "nestedOnly" }), "matrix");
  expect(issues.map((issue) => issue.path)).toEqual(
    scopes.map((scope) => `channels.matrix.${scope ? `accounts.${scope}.` : ""}dm.allowFrom`),
  );
  for (const issue of issues) {
    expect(issue.message).toContain(".dm.policy=");
    expect(issue.message).not.toContain(".dmPolicy");
    expect(issue.message).not.toContain("channels.matrix.allowFrom");
  }
});

it("does not suggest channel allowFrom as sufficient when account allowFrom overrides it", () => {
  const issues = dmWarnings({
    mattermost: { allowFrom: ["*"], accounts: { team: { dmPolicy: "open", allowFrom: [] } } },
  });
  const path = "channels.mattermost.accounts.team.allowFrom";
  const warning = issues.find((entry) => entry.path === path);
  expect(warning?.message).toContain(`remove ${path} to inherit channels.mattermost.allowFrom`);
  expect(warning?.message).not.toContain("(or channels.mattermost.allowFrom)");
});
