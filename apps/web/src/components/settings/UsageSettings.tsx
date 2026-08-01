import { Link } from "@tanstack/react-router";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type UsageBreakdown,
  type UsagePricingOverride,
  type UsageSummary,
  type UsageTokenTotals,
} from "@t3tools/contracts";
import { BarChart3Icon, RefreshCwIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { usageEnvironment } from "../../state/usage";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";

const RANGES = [7, 30, 90] as const;

function tokenTotal(tokens: UsageTokenTotals): number | null {
  const values = [
    tokens.uncachedInputTokens,
    tokens.cacheReadInputTokens,
    tokens.cacheWriteInputTokens,
    tokens.outputTokens,
  ].filter((value): value is number => value !== null);
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0);
}

function number(value: number | null): string {
  return value === null ? "Unavailable" : new Intl.NumberFormat().format(value);
}

function cost(summary: UsageSummary): string {
  return summary.cost.microUsd === null
    ? "Unavailable"
    : `$${(summary.cost.microUsd / 1_000_000).toFixed(2)}`;
}

function Metric({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string | undefined;
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-card/45 p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums tracking-tight">{value}</div>
      {note ? <div className="mt-1 text-[11px] text-muted-foreground/70">{note}</div> : null}
    </div>
  );
}

function Breakdown({ title, rows }: { title: string; rows: ReadonlyArray<UsageBreakdown> }) {
  return (
    <div className="rounded-xl border border-border/60 bg-card/35 p-4">
      <h3 className="mb-3 text-sm font-medium">{title}</h3>
      {rows.length === 0 ? (
        <div className="text-xs text-muted-foreground">No data in this range.</div>
      ) : (
        <div className="space-y-2">
          {rows.slice(0, 8).map((row) => (
            <div key={row.key} className="flex items-center justify-between gap-4 text-xs">
              <span className="truncate text-muted-foreground">{row.label}</span>
              <span className="shrink-0 font-medium tabular-nums">
                {number(tokenTotal(row.summary.tokens))}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function UsageSettingsPanel() {
  const environment = usePrimaryEnvironment();
  const pricingOverrides = usePrimarySettings((settings) => settings.usagePricingOverrides);
  const updateSettings = useUpdatePrimarySettings();
  const [days, setDays] = useState<(typeof RANGES)[number] | "custom">(30);
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [priceDraft, setPriceDraft] = useState({
    driver: "kimi",
    instanceId: "",
    model: "kimi-code/k3",
    uncached: "3.00",
    cached: "0.30",
    cacheWrite: "3.00",
    output: "15.00",
  });
  const input = useMemo(() => {
    const custom = days === "custom" && customFrom && customTo;
    const to = custom ? new Date(`${customTo}T23:59:59.999Z`) : new Date();
    const from = custom
      ? new Date(`${customFrom}T00:00:00.000Z`)
      : new Date(to.getTime() - (days === "custom" ? 30 : days) * 86_400_000);
    return { from: from.toISOString(), to: to.toISOString(), bucket: "day" as const, limit: 50 };
  }, [customFrom, customTo, days]);
  const query = useEnvironmentQuery(
    environment ? usageEnvironment({ environmentId: environment.environmentId, input }) : null,
  );
  const result = query.data;
  const summary = result?.summary;
  const coverage = summary
    ? summary.componentCount === 0
      ? null
      : summary.completeComponentCount / summary.componentCount
    : null;
  const maxBucket = Math.max(
    1,
    ...(result?.timeSeries.map((bucket) => tokenTotal(bucket.summary.tokens) ?? 0) ?? []),
  );

  return (
    <SettingsPageContainer className="max-w-6xl">
      <SettingsSection
        title="Usage"
        icon={<BarChart3Icon className="size-5" />}
        headerAction={
          <Button size="xs" variant="ghost" onClick={query.refresh} disabled={query.isPending}>
            <RefreshCwIcon className={query.isPending ? "size-3.5 animate-spin" : "size-3.5"} />
            Refresh
          </Button>
        }
      >
        <div className="space-y-5 rounded-xl px-3 py-2 sm:px-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="max-w-2xl text-sm text-muted-foreground">
              Provider-reported and API-equivalent usage for{" "}
              {environment?.label ?? "this environment"}. Missing upstream metrics stay unavailable
              rather than being treated as zero.
            </p>
            <div className="flex rounded-lg bg-muted/60 p-1">
              {RANGES.map((range) => (
                <Button
                  key={range}
                  size="xs"
                  variant={days === range ? "secondary" : "ghost"}
                  onClick={() => setDays(range)}
                >
                  {range}d
                </Button>
              ))}
              <Button
                size="xs"
                variant={days === "custom" ? "secondary" : "ghost"}
                onClick={() => setDays("custom")}
              >
                Custom
              </Button>
            </div>
          </div>
          {days === "custom" ? (
            <div className="flex flex-wrap items-center gap-2 rounded-xl bg-muted/25 p-3">
              <label className="text-xs text-muted-foreground" htmlFor="usage-from">
                From
              </label>
              <Input
                id="usage-from"
                type="date"
                value={customFrom}
                onChange={(event) => setCustomFrom(event.target.value)}
                className="w-auto"
              />
              <label className="text-xs text-muted-foreground" htmlFor="usage-to">
                To
              </label>
              <Input
                id="usage-to"
                type="date"
                value={customTo}
                onChange={(event) => setCustomTo(event.target.value)}
                className="w-auto"
              />
            </div>
          ) : null}
          {query.error ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              {query.error}
            </div>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Metric
              label="Total tokens"
              value={number(summary ? tokenTotal(summary.tokens) : null)}
            />
            <Metric
              label="Cache reads"
              value={number(summary?.tokens.cacheReadInputTokens ?? null)}
            />
            <Metric
              label="Cache writes"
              value={number(summary?.tokens.cacheWriteInputTokens ?? null)}
            />
            <Metric
              label="Cost"
              value={summary ? cost(summary) : "Unavailable"}
              note={
                summary?.cost.kind === "api-equivalent-estimate"
                  ? "API-equivalent estimate"
                  : summary?.cost.kind
              }
            />
            <Metric
              label="Uncached input"
              value={number(summary?.tokens.uncachedInputTokens ?? null)}
            />
            <Metric label="Output" value={number(summary?.tokens.outputTokens ?? null)} />
            <Metric
              label="Cache utilization"
              value={
                summary?.cacheUtilization === null || summary?.cacheUtilization === undefined
                  ? "Unavailable"
                  : `${(summary.cacheUtilization * 100).toFixed(1)}%`
              }
              note={
                summary?.cost.cacheSavingsMicroUsd === null ||
                summary?.cost.cacheSavingsMicroUsd === undefined
                  ? "Savings unavailable"
                  : `$${(summary.cost.cacheSavingsMicroUsd / 1_000_000).toFixed(2)} estimated savings`
              }
            />
            <Metric
              label="Data coverage"
              value={coverage === null ? "No data" : `${(coverage * 100).toFixed(0)}%`}
              note={
                summary
                  ? `${summary.turnCount} turns · ${summary.componentCount} components`
                  : undefined
              }
            />
          </div>

          <div className="rounded-xl border border-border/60 bg-card/35 p-4">
            <h3 className="mb-4 text-sm font-medium">Daily usage</h3>
            <div className="flex h-36 items-end gap-1" aria-label="Token usage over time">
              {result?.timeSeries.length ? (
                result.timeSeries.map((bucket) => {
                  const total = tokenTotal(bucket.summary.tokens) ?? 0;
                  return (
                    <div
                      key={bucket.from}
                      className="min-w-1 flex-1 rounded-t bg-primary/65"
                      style={{ height: `${Math.max(2, (total / maxBucket) * 100)}%` }}
                      title={`${bucket.from.slice(0, 10)}: ${number(total)} tokens`}
                    />
                  );
                })
              ) : (
                <div className="m-auto text-xs text-muted-foreground">No usage in this range.</div>
              )}
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <Breakdown title="Providers" rows={result?.byProvider ?? []} />
            <Breakdown title="Models" rows={result?.byModel ?? []} />
            <Breakdown title="Projects" rows={result?.byProject ?? []} />
            <Breakdown title="Workload" rows={result?.byWorkload ?? []} />
            <Breakdown title="Main vs. subagents" rows={result?.byComponent ?? []} />
          </div>

          <div className="rounded-xl border border-border/60 bg-card/35 p-4">
            <h3 className="mb-3 text-sm font-medium">Price provenance</h3>
            {result?.pricingProvenance.length ? (
              <div className="flex flex-wrap gap-2">
                {result.pricingProvenance.map((entry) => (
                  <span
                    key={entry.key}
                    className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground"
                  >
                    {entry.key} · {entry.componentCount}
                  </span>
                ))}
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">No priced usage in this range.</div>
            )}
          </div>

          <div className="overflow-hidden rounded-xl border border-border/60">
            <div className="border-b border-border/60 bg-muted/25 px-4 py-3 text-sm font-medium">
              Recent turns
            </div>
            {result?.turns.length ? (
              <div className="divide-y divide-border/50">
                {result.turns.map((row) => (
                  <Link
                    key={`${row.threadId}:${row.turnId}`}
                    to="/$environmentId/$threadId"
                    params={{ environmentId: environment!.environmentId, threadId: row.threadId }}
                    className="grid gap-1 px-4 py-3 text-xs hover:bg-muted/35 sm:grid-cols-[1fr_auto_auto] sm:items-center sm:gap-4"
                  >
                    <span className="truncate font-medium">{row.model ?? row.provider}</span>
                    <span className="text-muted-foreground">{row.workload}</span>
                    <span className="tabular-nums">{number(tokenTotal(row.summary.tokens))}</span>
                  </Link>
                ))}
              </div>
            ) : (
              <div className="px-4 py-8 text-center text-xs text-muted-foreground">
                No turns recorded.
              </div>
            )}
          </div>

          <div className="rounded-xl border border-border/60 bg-card/35 p-4">
            <h3 className="text-sm font-medium">Price overrides</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Rates are USD per million tokens. Instance + model overrides take precedence over
              driver + model and built-in prices.
            </p>
            <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              <Input
                value={priceDraft.driver}
                onChange={(event) =>
                  setPriceDraft((value) => ({ ...value, driver: event.target.value }))
                }
                placeholder="Provider driver"
              />
              <Input
                value={priceDraft.instanceId}
                onChange={(event) =>
                  setPriceDraft((value) => ({ ...value, instanceId: event.target.value }))
                }
                placeholder="Instance (optional)"
              />
              <Input
                value={priceDraft.model}
                onChange={(event) =>
                  setPriceDraft((value) => ({ ...value, model: event.target.value }))
                }
                placeholder="Model"
              />
              <Input
                value={priceDraft.uncached}
                onChange={(event) =>
                  setPriceDraft((value) => ({ ...value, uncached: event.target.value }))
                }
                inputMode="decimal"
                placeholder="Uncached input"
              />
              <Input
                value={priceDraft.cached}
                onChange={(event) =>
                  setPriceDraft((value) => ({ ...value, cached: event.target.value }))
                }
                inputMode="decimal"
                placeholder="Cache read"
              />
              <Input
                value={priceDraft.cacheWrite}
                onChange={(event) =>
                  setPriceDraft((value) => ({ ...value, cacheWrite: event.target.value }))
                }
                inputMode="decimal"
                placeholder="Cache write"
              />
              <Input
                value={priceDraft.output}
                onChange={(event) =>
                  setPriceDraft((value) => ({ ...value, output: event.target.value }))
                }
                inputMode="decimal"
                placeholder="Output"
              />
              <Button
                onClick={() => {
                  const micro = (value: string) =>
                    Math.max(0, Math.round(Number(value) * 1_000_000));
                  if (
                    !priceDraft.model.trim() ||
                    (!priceDraft.instanceId.trim() && !priceDraft.driver.trim()) ||
                    !Number.isFinite(Number(priceDraft.uncached)) ||
                    !Number.isFinite(Number(priceDraft.output))
                  )
                    return;
                  const override: UsagePricingOverride = {
                    ...(priceDraft.instanceId.trim()
                      ? {
                          providerInstanceId: ProviderInstanceId.make(priceDraft.instanceId.trim()),
                        }
                      : { driver: ProviderDriverKind.make(priceDraft.driver.trim()) }),
                    model: priceDraft.model.trim(),
                    effectiveAt: new Date().toISOString(),
                    uncachedInputMicroUsdPerMillion: micro(priceDraft.uncached),
                    ...(priceDraft.cached.trim()
                      ? { cacheReadInputMicroUsdPerMillion: micro(priceDraft.cached) }
                      : {}),
                    ...(priceDraft.cacheWrite.trim()
                      ? { cacheWriteInputMicroUsdPerMillion: micro(priceDraft.cacheWrite) }
                      : {}),
                    outputMicroUsdPerMillion: micro(priceDraft.output),
                  };
                  void updateSettings({ usagePricingOverrides: [...pricingOverrides, override] });
                }}
              >
                Add override
              </Button>
            </div>
            <div className="mt-4 divide-y divide-border/50">
              {pricingOverrides.map((override, index) => (
                <div
                  key={`${override.providerInstanceId ?? override.driver}:${override.model}:${override.effectiveAt}`}
                  className="flex items-center justify-between gap-3 py-2 text-xs"
                >
                  <span className="truncate text-muted-foreground">
                    {override.providerInstanceId ?? override.driver ?? "Unknown provider"} ·{" "}
                    {override.model} · $
                    {(override.uncachedInputMicroUsdPerMillion / 1_000_000).toFixed(2)} input / $
                    {(override.outputMicroUsdPerMillion / 1_000_000).toFixed(2)} output
                  </span>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() =>
                      void updateSettings({
                        usagePricingOverrides: pricingOverrides.filter(
                          (_, itemIndex) => itemIndex !== index,
                        ),
                      })
                    }
                  >
                    Remove
                  </Button>
                </div>
              ))}
            </div>
          </div>
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
