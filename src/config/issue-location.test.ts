import JSON5 from "json5";
import { describe, expect, it } from "vitest";
import { renderConfigValidationIssueLines } from "./issue-location.js";
import type { ConfigFileSnapshot } from "./types.js";

type PathSegment = string | number;

function renderIssue(
  pathSegments: PathSegment[],
  options: { raw?: string | null; parsed?: unknown; effective?: unknown; message?: string } = {},
): string {
  const { raw = null, parsed = {}, effective = parsed, message = "Invalid input" } = options;
  return (
    renderConfigValidationIssueLines(
      {
        issues: [{ path: pathSegments.join("."), pathSegments, message }],
        raw,
        parsed,
        sourceConfig: effective as ConfigFileSnapshot["sourceConfig"],
        path: "/tmp/openclaw.json",
      },
      "",
    )[0] ?? ""
  );
}

function resolveConfigIssueLineInRaw(raw: string, pathSegments: PathSegment[]): number | undefined {
  let parsed: unknown = {};
  try {
    parsed = JSON5.parse(raw);
  } catch {
    // Malformed or empty text cannot own a source location.
  }
  const match = renderIssue(pathSegments, { raw, parsed }).match(/^openclaw\.json:(\d+) — /);
  return match?.[1] ? Number(match[1]) : undefined;
}

function receivedHint(value: unknown, pathValue = "some.path", message = "invalid input"): string {
  const pathSegments = pathValue.split(".");
  let root: unknown = value;
  for (const segment of pathSegments.toReversed()) {
    root = { [segment]: root };
  }
  const rendered = renderIssue(pathSegments, { message, raw: JSON5.stringify(root), parsed: root });
  const issueText = rendered.split(" — ").at(-1) ?? rendered;
  return issueText.slice(issueText.indexOf(": ") + 2);
}

describe("formatConfigIssuePath", () => {
  it.each<[PathSegment[], string]>([
    [["a", 0, "b", 1], "a[0].b[1]"],
    [[], "<root>"],
  ])("formats %j", (segments, expected) => {
    expect(renderIssue(segments)).toBe(`${expected}: Invalid input`);
  });
});

describe("resolveConfigIssueLineInRaw", () => {
  it("resolves line number for nested array object values", () => {
    const raw = [
      '{ "agents": { "list": [',
      '  { "id": "main" },',
      '  { "tools": {',
      '    "profile": "none"',
      "  } }",
      "] } }",
    ].join("\n");

    expect(resolveConfigIssueLineInRaw(raw, ["agents", "list", 1, "tools", "profile"])).toBe(4);
  });

  it.each<[string, PathSegment[], number | undefined]>([
    ['{\n  "a": "hello \\u0041",\n  "b": 1\n}', ["b"], 3],
    ['{\n  "a": { "b": { "c": [1, [2, [3]]] } } }\n}', ["a", "b", "c", 1, 0], 2],
    ['{\n  "a": 1\n}', ["nonexistent"], undefined],
    ['{\n  "a": 1\n}', ["a", "b"], undefined],
    ['{\n  "a": 1\n}', ["a", 0], undefined],
    ["", ["a"], undefined],
    ["  ", ["a"], undefined],
  ])("locates %j at %j", (raw, segments, expected) => {
    expect(resolveConfigIssueLineInRaw(raw, segments)).toBe(expected);
  });
});

describe("appendReceivedValueHint", () => {
  it.each([
    [
      "UTF-16 truncation",
      `${"x".repeat(155)}🎉tail`,
      "gateway.bind",
      `invalid input, got: "${"x".repeat(155)}...`,
    ],
    ["sensitive paths", "abc123", "channels.telegram.botToken", "invalid token", "invalid token"],
    ["object values", { nested: true }, "some.path", "invalid input"],
    ["NaN", Number.NaN, "some.path", "invalid input, got: NaN"],
    ["negative zero", -0, "some.path", "invalid input, got: -0"],
  ] as const)("handles %s", (_name, value, path, expected, message = "invalid input") => {
    expect(receivedHint(value, path, message)).toBe(expected);
  });
});

describe("renderConfigValidationIssueLines", () => {
  it.each([
    [
      "an object",
      [
        "  ignored: {",
        '    nested: [{ text: "}, ]", values: [1, {}, []] }],',
        "    // Closing delimiters in this comment: } ]",
        "  },",
      ],
    ],
    [
      "an array",
      [
        "  ignored: [",
        '    { nested: [[], { text: "}, ]" }] },',
        "    /* Keep scanning after nested containers. */ {},",
        "  ],",
      ],
    ],
  ] as const)("locates the value after skipping %s with mixed nesting", (_name, ignoredLines) => {
    const raw = ["{", ...ignoredLines, '  target: "bad",', "}"].join("\n");
    expect(renderIssue(["target"], { raw, parsed: JSON5.parse(raw) })).toBe(
      'openclaw.json:6 — target: Invalid input, got: "bad"',
    );
  });

  it.each([
    {
      name: "included config",
      path: ["models", "providers", "openai", "api"],
      raw: '{ "$include": "./models.json" }',
      parsed: { models: { providers: { openai: { api: "bad" } } } },
      message: 'Invalid input (allowed: "openai-chatgpt")',
      expected: 'models.providers.openai.api: Invalid input (allowed: "openai-chatgpt")',
    },
    {
      name: "environment substitution",
      path: ["gateway", "bind"],
      raw: '{ gateway: { bind: "${BIND}" } }',
      parsed: { gateway: { bind: "${BIND}" } },
      effective: { gateway: { bind: "lan" } },
      expected: "openclaw.json:1 — gateway.bind: Invalid input",
    },
    {
      name: "plugin-owned values",
      path: ["plugins", "entries", "vendor.plugin", "config", "accessCode"],
      raw: '{ plugins: { entries: { "vendor.plugin": { config: { accessCode: "private" } } } } }',
      expected:
        'openclaw.json:1 — plugins.entries["vendor.plugin"].config.accessCode: Invalid input',
    },
  ])("omits received values for $name", ({ path, expected, raw, ...options }) => {
    expect(renderIssue(path, { parsed: JSON5.parse(raw), ...options, raw })).toBe(expected);
  });
});
