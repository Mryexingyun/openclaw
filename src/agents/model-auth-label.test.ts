// Verifies safe, user-facing auth labels without exposing credential values.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createApiKeyCredential,
  createAuthProfileStoreFixture,
  createOAuthRefreshCredential,
} from "./auth-profiles/credential-fixtures.test-support.js";
import { resolveModelAuthLabelAsync } from "./model-auth-label.js";

const mocks = vi.hoisted(() => ({
  ensureAuthProfileStoreAsync: vi.fn(),
  externalCliDiscoveryForProviderAuth: vi.fn(() => undefined),
  ensureAuthProfileStoreWithoutExternalProfilesAsync: vi.fn(),
  resolveAuthProfileOrder: vi.fn(),
  resolveAuthProfileDisplayLabel: vi.fn(),
  resolveProviderEntryApiKeyProfileReference: vi.fn<() => unknown>(() => ({ kind: "none" })),
  resolveUsableCustomProviderApiKey: vi.fn<() => { apiKey: string; source: string } | null>(
    () => null,
  ),
  resolveEnvApiKey: vi.fn<() => { apiKey: string; source: string } | null>(() => null),
  readCodexCliCredentialsCached: vi.fn<(options?: unknown) => unknown>(() => null),
}));

// mock-isolation: Label privacy cases use synthetic credentials without loading host auth profiles.
vi.mock("./auth-profiles.js", () => ({
  ensureAuthProfileStoreAsync: mocks.ensureAuthProfileStoreAsync,
  externalCliDiscoveryForProviderAuth: mocks.externalCliDiscoveryForProviderAuth,
  ensureAuthProfileStoreWithoutExternalProfilesAsync:
    mocks.ensureAuthProfileStoreWithoutExternalProfilesAsync,
  resolveAuthProfileOrder: mocks.resolveAuthProfileOrder,
  resolveAuthProfileDisplayLabel: mocks.resolveAuthProfileDisplayLabel,
}));

vi.mock("./model-auth.js", () => ({
  resolveProviderEntryApiKeyProfileReference: mocks.resolveProviderEntryApiKeyProfileReference,
  resolveUsableCustomProviderApiKey: mocks.resolveUsableCustomProviderApiKey,
  resolveEnvApiKey: mocks.resolveEnvApiKey,
}));

vi.mock("./cli-credentials.js", () => ({
  readCodexCliCredentialsCached: mocks.readCodexCliCredentialsCached,
}));

function profileLabel(profileId: string, profile: unknown) {
  mocks.ensureAuthProfileStoreAsync.mockReturnValue(
    createAuthProfileStoreFixture({ [profileId]: profile }),
  );
  mocks.resolveAuthProfileOrder.mockReturnValue([profileId]);
  mocks.resolveAuthProfileDisplayLabel.mockReturnValue(profileId);
}

function labelFor(
  provider: string,
  options: Parameters<typeof resolveModelAuthLabelAsync>[0] = {},
) {
  return resolveModelAuthLabelAsync({ cfg: {}, provider, ...options });
}

describe("resolveModelAuthLabelAsync", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }
    mocks.ensureAuthProfileStoreAsync.mockReturnValue(createAuthProfileStoreFixture({}));
    mocks.resolveAuthProfileOrder.mockReturnValue([]);
    mocks.resolveProviderEntryApiKeyProfileReference.mockReturnValue({ kind: "none" });
    mocks.resolveUsableCustomProviderApiKey.mockReturnValue(null);
    mocks.resolveEnvApiKey.mockReturnValue(null);
    mocks.readCodexCliCredentialsCached.mockReturnValue(null);
  });

  it.each([
    [
      "github-copilot",
      "token",
      {
        type: "token",
        provider: "github-copilot",
        token: "synthetic-token",
        tokenRef: { source: "env", provider: "default", id: "GITHUB_TOKEN" },
      },
    ],
    ["openai", "api-key", createApiKeyCredential("openai", "abc123")],
  ] as const)("keeps %s credential values out of labels", async (provider, mode, profile) => {
    const profileId = `${provider}:default`;
    profileLabel(profileId, profile);
    expect(await labelFor(provider, { sessionEntry: { authProfileOverride: profileId } })).toBe(
      `${mode} (${profileId})`,
    );
  });

  it.each(["codex", "openai"])(
    "labels %s Codex CLI auth without leaking credentials",
    async (provider) => {
      const codexHome = provider === "openai" ? "/tmp/openclaw-agent/codex-home" : undefined;
      mocks.readCodexCliCredentialsCached.mockReturnValue(createOAuthRefreshCredential());
      if (codexHome) {
        mocks.resolveEnvApiKey.mockReturnValue({
          apiKey: "env-key-placeholder",
          source: "env: OPENAI_API_KEY",
        });
      }
      expect(await labelFor(provider, { codexCliCredentialsHome: codexHome })).toBe(
        "oauth (codex-cli)",
      );
      expect(mocks.readCodexCliCredentialsCached).toHaveBeenCalledWith({
        ...(codexHome ? { codexHome } : {}),
        ttlMs: 5_000,
        allowKeychainPrompt: false,
      });
      if (codexHome) {
        expect(mocks.resolveEnvApiKey).not.toHaveBeenCalled();
      }
    },
  );

  it("shows native Claude CLI auth without reading credential storage", async () => {
    expect(await labelFor("claude-cli")).toBe("native (claude-cli)");
  });

  it("can skip external auth profile overlays for status labels", async () => {
    mocks.ensureAuthProfileStoreWithoutExternalProfilesAsync.mockReturnValue(
      createAuthProfileStoreFixture({
        "anthropic:oauth": { type: "oauth", provider: "anthropic" },
      }),
    );
    mocks.resolveAuthProfileOrder.mockReturnValue(["anthropic:oauth"]);
    mocks.resolveAuthProfileDisplayLabel.mockReturnValue("anthropic:oauth");

    expect(await labelFor("anthropic", { includeExternalProfiles: false })).toBe(
      "oauth (anthropic:oauth)",
    );
    expect(mocks.ensureAuthProfileStoreWithoutExternalProfilesAsync).toHaveBeenCalledOnce();
    expect(mocks.ensureAuthProfileStoreAsync).not.toHaveBeenCalled();
  });

  it("resolves env labels with config and workspace scope", async () => {
    mocks.resolveEnvApiKey.mockReturnValue({
      apiKey: "workspace-cloud-local-credentials",
      source: "workspace cloud credentials",
    });

    const cfg = { plugins: { allow: ["workspace-cloud"] } };
    expect(
      await labelFor("workspace-cloud", {
        cfg,
        workspaceDir: "/tmp/workspace",
      }),
    ).toBe("api-key (workspace cloud credentials)");
    expect(mocks.resolveEnvApiKey).toHaveBeenCalledWith("workspace-cloud", process.env, {
      config: cfg,
      workspaceDir: "/tmp/workspace",
    });
  });

  it.each([false, true])(
    "handles per-entry profile references (incompatible=%s)",
    async (incompatible) => {
      mocks.resolveAuthProfileDisplayLabel.mockReturnValue("openrouter:key-b");
      mocks.resolveProviderEntryApiKeyProfileReference.mockReturnValue(
        incompatible
          ? {
              kind: "profile-incompatible",
              profileId: "google:oauth-a",
              credentialProvider: "google",
              credentialType: "oauth",
              reason: "credential-class",
            }
          : {
              kind: "profile",
              profileId: "openrouter:key-b",
              credential: createApiKeyCredential("openrouter", "sk-or-actual-key-b"),
              mode: "api-key",
            },
      );
      mocks.resolveUsableCustomProviderApiKey.mockReturnValue({
        apiKey: incompatible ? "google:oauth-a" : "openrouter:key-b",
        source: "models.json",
      });

      expect(await labelFor("openrouter-minimax")).toBe(
        incompatible ? "unknown" : "api-key (openrouter:key-b)",
      );
      expect(mocks.resolveUsableCustomProviderApiKey).not.toHaveBeenCalled();
    },
  );
});
