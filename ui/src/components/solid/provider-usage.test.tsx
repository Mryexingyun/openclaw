/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import type { ProviderUsageCostDaily } from "../../../../src/infra/provider-usage.types.js";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import {
  ProviderUsageChips,
  type ProviderUsageDetails,
  ProviderUsagePanel,
} from "./provider-usage.tsx";

function dailyUsage(
  date: string,
  amount: number,
  overrides: Partial<Omit<ProviderUsageCostDaily, "date" | "amount">> = {},
): ProviderUsageCostDaily {
  return {
    date,
    amount,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    ...overrides,
  };
}

const rowValues = (container: HTMLElement) =>
  Array.from(container.querySelectorAll(".provider-usage__row"), (row) => [
    row.querySelector(".oc-menu-panel-usage-label")?.textContent,
    row.querySelector(".oc-menu-panel-usage-value")?.textContent,
  ]);

function costHistory(
  daily: ProviderUsageCostDaily[],
  overrides: Partial<NonNullable<ProviderUsageDetails["costHistory"]>> = {},
): NonNullable<ProviderUsageDetails["costHistory"]> {
  return { unit: "USD", periodDays: 30, daily, models: [], categories: [], ...overrides };
}

function mountPanel(usage: ProviderUsageDetails) {
  const { container } = mountSolid(() => <ProviderUsagePanel usage={usage} />);
  return {
    container,
    query: (selector: string) => container.querySelector<HTMLElement>(selector),
    rows: () => rowValues(container),
  };
}

describe("ProviderUsagePanel", () => {
  it("orders accessible usage groups and retains rows across snapshot updates", () => {
    const initial: ProviderUsageDetails = {
      windows: [
        { label: "5h", groupLabel: "Account A", usedPercent: 25 },
        { label: "Weekly", groupLabel: "Account A", usedPercent: 92 },
        { label: "5h", groupLabel: "Account A", usedPercent: 30 },
        { label: "5h", groupLabel: "Account B", usedPercent: 40 },
        { label: "Monthly", groupLabel: "Account B", usedPercent: 80 },
      ],
      summary: "Provider summary",
      billing: [
        { type: "balance", amount: 12, unit: "credits" },
        { type: "balance", amount: 8, unit: "credits" },
      ],
      costHistory: costHistory([dailyUsage(new Date().toISOString().slice(0, 10), 2)]),
    };
    const [usage, setUsage] = createSignal(initial);
    const view = mountSolid(() => (
      <>
        <ProviderUsagePanel usage={usage()} />
        <ProviderUsageChips usage={usage()} />
      </>
    ));
    const meters = [
      ...view.container.querySelectorAll<HTMLElement>('.provider-usage [role="meter"]'),
    ];
    expect(
      meters.map((meter) => [
        meter.getAttribute("aria-label"),
        meter.getAttribute("aria-valuenow"),
        meter.closest(".provider-usage__window")?.getAttribute("data-tone"),
      ]),
    ).toEqual([
      ["5h", "75", null],
      ["5h", "70", null],
      ["Weekly", "8", "error"],
      ["5h", "60", null],
      ["Monthly", "20", "warning"],
    ]);
    expect(meters[0]?.querySelector<HTMLElement>("span")?.style.width).toBe("75%");
    const notes = view.container.querySelectorAll(".provider-usage__note");
    expect(Array.from(notes, (note) => note.textContent)).toEqual([
      "Account A",
      "Account B",
      "Provider summary",
    ]);
    const rows = () => [
      ...view.container.querySelectorAll(
        ".provider-usage__group, .provider-usage__window, .provider-usage__row, .provider-usage__chip",
      ),
    ];
    const before = rows();

    setUsage(structuredClone(initial));
    flush();
    expect(rows().filter((row) => !before.includes(row))).toHaveLength(0);

    const changed = structuredClone(initial);
    changed.windows[0]!.usedPercent = 90;
    changed.billing![0] = { type: "balance", amount: 14, unit: "credits" };
    changed.costHistory!.daily[0]!.amount = 4;
    setUsage(changed);
    flush();
    expect(rows()).toEqual(before);
    const query = (selector: string) => view.container.querySelector<HTMLElement>(selector);
    expect(query('[role="meter"]')?.getAttribute("aria-valuenow")).toBe("10");
    expect(query(".provider-usage__window")?.dataset.tone).toBe("error");
    expect(query(".provider-usage__chip-value")?.textContent).toBe("10% left");
    expect(rowValues(view.container)).toEqual([
      ["Balance", "14 credits"],
      ["Balance", "8 credits"],
      ["Today", "$4.00"],
      ["7 days", "$4.00"],
      ["30 days", "$4.00"],
    ]);
  });

  it("names a used-up window and when it comes back", () => {
    const resetAt = Date.now() + 3 * 3_600_000;
    const view = mountPanel({
      windows: [
        { label: "Premium", usedPercent: 100, resetAt },
        { label: "Chat", usedPercent: 0 },
      ],
    });
    const alert = view.query('.provider-usage__alert[role="status"]');
    expect(alert?.textContent).toMatch(/^Premium is used up until .+\.$/u);
    const reset = view.query(".provider-usage__window .provider-usage__reset");
    expect(reset?.textContent).toMatch(/^Resets .+ · in 3h$/u);
    expect(view.container.querySelectorAll(".provider-usage__reset")).toHaveLength(1);
  });

  it.each([
    { unit: " usd ", amount: "$12.50" },
    { unit: "jPy", amount: "¥13" },
    { unit: " Credits ", amount: "12.5  Credits " },
  ])("renders provider-billed cost windows and attribution in $unit", ({ unit, amount }) => {
    const today = new Date().toISOString().slice(0, 10);
    const tokens = {
      requests: 42,
      inputTokens: 1_000,
      cacheReadTokens: 400,
      cacheWriteTokens: 0,
      outputTokens: 250,
      totalTokens: 1_250,
    };
    const view = mountPanel({
      windows: [],
      billing: [{ type: "budget", used: 2.5, limit: 10, unit: "USD" }],
      costHistory: costHistory(
        [
          dailyUsage(today, 12.5, tokens),
          dailyUsage("2026-01-01", 0, { requests: 1, inputTokens: 50, outputTokens: 10 }),
        ],
        {
          unit,
          models: [{ name: "gpt-5.5", ...tokens }],
          categories: [{ name: "Responses", amount: 12.5 }],
        },
      ),
    });
    expect(view.rows()).toEqual([
      ["Budget", "$2.50 / $10.00"],
      ["Today", amount],
      ["7 days", amount],
      ["30 days", amount],
      ["Top models", "gpt-5.5 1.3k"],
      ["Cost categories", `Responses ${amount}`],
    ]);
    const trend = view.query(".provider-usage__trend")!;
    expect(trend.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
      "Daily provider cost",
    );
    expect(trend.textContent).toBe("43 requests · 1.1k input · 400 cache · 260 output");
  });

  it("draws non-finite and signed amounts as zero without mutating the snapshot", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-09-07T12:00:00Z"));
      const today = "2026-09-07";
      const usage = {
        windows: [],
        costHistory: costHistory(
          [
            dailyUsage(today, 2, { cacheReadTokens: 2 ** 53 }),
            dailyUsage(today, Number.NaN, { cacheReadTokens: 1, cacheWriteTokens: -(2 ** 53) }),
            dailyUsage(today, -0),
          ],
          { unit: "credits" },
        ),
      };
      const before = structuredClone(usage);
      const view = mountPanel(usage);
      const path = view.query(".oc-sparkline-line")?.getAttribute("d");
      expect(path).toBe("M0 3.0 H40.0 V27.0 H80.0 V27.0 H120.0");
      expect(view.rows().map(([, value]) => value)).toEqual([
        "NaN credits",
        "NaN credits",
        "NaN credits",
      ]);
      expect(view.query(".provider-usage__trend")?.textContent).toContain("0 cache");
      expect(usage).toEqual(before);
    } finally {
      vi.useRealTimers();
    }
  });
});
