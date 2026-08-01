import type { UsageBreakdown, UsageSummary, UsageTokenTotals } from "@t3tools/contracts";
import { CommonActions, useNavigation } from "@react-navigation/native";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { usageEnvironment } from "../../state/usage";

const RANGES = [7, 30, 90] as const;

function total(tokens: UsageTokenTotals): number | null {
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

function Metric({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <View className="w-[48%] rounded-2xl bg-card p-4">
      <Text className="text-sm text-foreground-muted">{label}</Text>
      <Text className="mt-1 font-t3-semibold text-xl text-foreground">{value}</Text>
      {note ? <Text className="mt-1 text-xs text-foreground-muted">{note}</Text> : null}
    </View>
  );
}

function cost(summary: UsageSummary | undefined): string {
  return summary?.cost.microUsd === null || summary?.cost.microUsd === undefined
    ? "Unavailable"
    : `$${(summary.cost.microUsd / 1_000_000).toFixed(2)}`;
}

function Breakdown({ title, rows }: { title: string; rows: ReadonlyArray<UsageBreakdown> }) {
  return (
    <View className="rounded-2xl bg-card p-4">
      <Text className="mb-3 font-t3-semibold text-lg text-foreground">{title}</Text>
      {rows.length ? (
        rows.slice(0, 8).map((row) => (
          <View key={row.key} className="flex-row justify-between gap-4 py-2">
            <Text className="flex-1 text-foreground-muted" numberOfLines={1}>
              {row.label}
            </Text>
            <Text className="font-t3-medium text-foreground">
              {number(total(row.summary.tokens))}
            </Text>
          </View>
        ))
      ) : (
        <Text className="text-foreground-muted">No usage in this range.</Text>
      )}
    </View>
  );
}

export function SettingsUsageRouteScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { environments } = useEnvironments();
  const [environmentId, setEnvironmentId] = useState<string | null>(null);
  const environment =
    environments.find((candidate) => candidate.environmentId === environmentId) ??
    environments[0] ??
    null;
  const [days, setDays] = useState<(typeof RANGES)[number] | "custom">(30);
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const input = useMemo(() => {
    const parsedFrom = Date.parse(`${customFrom}T00:00:00.000Z`);
    const parsedTo = Date.parse(`${customTo}T23:59:59.999Z`);
    const hasCustomRange =
      days === "custom" && Number.isFinite(parsedFrom) && Number.isFinite(parsedTo);
    const to = hasCustomRange ? new Date(`${customTo}T23:59:59.999Z`) : new Date();
    const from = hasCustomRange
      ? new Date(`${customFrom}T00:00:00.000Z`)
      : new Date(to.getTime() - (days === "custom" ? 30 : days) * 86_400_000);
    return { from: from.toISOString(), to: to.toISOString(), bucket: "day" as const, limit: 30 };
  }, [customFrom, customTo, days]);
  const query = useEnvironmentQuery(
    environment ? usageEnvironment({ environmentId: environment.environmentId, input }) : null,
  );
  const summary = query.data?.summary;
  const coverage = summary?.componentCount
    ? summary.completeComponentCount / summary.componentCount
    : null;
  const maxBucket = Math.max(
    1,
    ...(query.data?.timeSeries.map((bucket) => total(bucket.summary.tokens) ?? 0) ?? []),
  );

  return (
    <View className="flex-1 bg-sheet">
      <ScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        contentContainerClassName="gap-5 px-5 pt-5"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <View>
          <Text className="text-base text-foreground-muted">
            {environment?.label ?? "No environment selected"}
          </Text>
          <Text className="mt-1 text-sm text-foreground-muted">
            Missing provider metrics are shown as unavailable, not zero.
          </Text>
        </View>
        {environments.length > 1 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerClassName="gap-2"
          >
            {environments.map((candidate) => (
              <Pressable
                key={candidate.environmentId}
                onPress={() => setEnvironmentId(candidate.environmentId)}
                className={
                  candidate.environmentId === environment?.environmentId
                    ? "rounded-full bg-primary px-4 py-2"
                    : "rounded-full bg-card px-4 py-2"
                }
              >
                <Text
                  className={
                    candidate.environmentId === environment?.environmentId
                      ? "font-t3-medium text-primary-foreground"
                      : "text-foreground-muted"
                  }
                >
                  {candidate.label}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        ) : null}
        <View className="flex-row rounded-xl bg-card p-1">
          {RANGES.map((range) => (
            <Pressable
              key={range}
              onPress={() => setDays(range)}
              className={days === range ? "flex-1 rounded-lg bg-primary py-2" : "flex-1 py-2"}
            >
              <Text
                className={
                  days === range
                    ? "text-center font-t3-medium text-primary-foreground"
                    : "text-center text-foreground-muted"
                }
              >
                {range}d
              </Text>
            </Pressable>
          ))}
          <Pressable
            onPress={() => setDays("custom")}
            className={days === "custom" ? "flex-1 rounded-lg bg-primary py-2" : "flex-1 py-2"}
          >
            <Text
              className={
                days === "custom"
                  ? "text-center font-t3-medium text-primary-foreground"
                  : "text-center text-foreground-muted"
              }
            >
              Custom
            </Text>
          </Pressable>
        </View>
        {days === "custom" ? (
          <View className="flex-row gap-2">
            <TextInput
              value={customFrom}
              onChangeText={setCustomFrom}
              placeholder="From YYYY-MM-DD"
              placeholderTextColor="#777"
              className="flex-1 rounded-xl bg-card px-3 py-3 text-foreground"
              autoCapitalize="none"
            />
            <TextInput
              value={customTo}
              onChangeText={setCustomTo}
              placeholder="To YYYY-MM-DD"
              placeholderTextColor="#777"
              className="flex-1 rounded-xl bg-card px-3 py-3 text-foreground"
              autoCapitalize="none"
            />
          </View>
        ) : null}
        {query.error ? <Text className="text-sm text-destructive">{query.error}</Text> : null}
        <View className="flex-row flex-wrap justify-between gap-y-3">
          <Metric label="Total tokens" value={number(summary ? total(summary.tokens) : null)} />
          <Metric label="Cost" value={cost(summary)} note={summary?.cost.kind} />
          <Metric
            label="Uncached input"
            value={number(summary?.tokens.uncachedInputTokens ?? null)}
          />
          <Metric label="Output" value={number(summary?.tokens.outputTokens ?? null)} />
          <Metric
            label="Cache reads"
            value={number(summary?.tokens.cacheReadInputTokens ?? null)}
          />
          <Metric
            label="Cache writes"
            value={number(summary?.tokens.cacheWriteInputTokens ?? null)}
          />
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
                : `$${(summary.cost.cacheSavingsMicroUsd / 1_000_000).toFixed(2)} savings`
            }
          />
          <Metric
            label="Data coverage"
            value={coverage === null ? "No data" : `${(coverage * 100).toFixed(0)}%`}
          />
        </View>
        <View className="rounded-2xl bg-card p-4">
          <Text className="mb-4 font-t3-semibold text-lg text-foreground">Usage over time</Text>
          <View className="h-32 flex-row items-end gap-1">
            {query.data?.timeSeries.length ? (
              query.data.timeSeries.map((bucket) => {
                const bucketTotal = total(bucket.summary.tokens) ?? 0;
                return (
                  <View
                    key={bucket.from}
                    className="min-w-1 flex-1 rounded-t bg-primary"
                    style={{ height: `${Math.max(2, (bucketTotal / maxBucket) * 100)}%` }}
                    accessibilityLabel={`${bucket.from.slice(0, 10)}, ${number(bucketTotal)} tokens`}
                  />
                );
              })
            ) : (
              <Text className="m-auto text-foreground-muted">No usage in this range.</Text>
            )}
          </View>
        </View>
        <Breakdown title="Providers" rows={query.data?.byProvider ?? []} />
        <Breakdown title="Models" rows={query.data?.byModel ?? []} />
        <Breakdown title="Projects" rows={query.data?.byProject ?? []} />
        <Breakdown title="Workload" rows={query.data?.byWorkload ?? []} />
        <Breakdown title="Main vs. subagents" rows={query.data?.byComponent ?? []} />
        <View className="rounded-2xl bg-card p-4">
          <Text className="mb-3 font-t3-semibold text-lg text-foreground">Recent turns</Text>
          {query.data?.turns.length ? (
            query.data.turns.map((row) => (
              <Pressable
                key={`${row.threadId}:${row.turnId}`}
                onPress={() =>
                  navigation.getParent()?.dispatch(
                    CommonActions.navigate({
                      name: "Thread",
                      params: { environmentId: environment?.environmentId, threadId: row.threadId },
                    }),
                  )
                }
                className="flex-row items-center justify-between gap-3 border-b border-border py-3"
              >
                <View className="flex-1">
                  <Text className="font-t3-medium text-foreground" numberOfLines={1}>
                    {row.model ?? row.provider}
                  </Text>
                  <Text className="text-xs text-foreground-muted">{row.workload}</Text>
                </View>
                <Text className="text-foreground">{number(total(row.summary.tokens))}</Text>
              </Pressable>
            ))
          ) : (
            <Text className="text-foreground-muted">No turns recorded.</Text>
          )}
        </View>
        <View className="rounded-2xl bg-card p-4">
          <Text className="mb-3 font-t3-semibold text-lg text-foreground">Price provenance</Text>
          {query.data?.pricingProvenance.length ? (
            query.data.pricingProvenance.map((entry) => (
              <View key={entry.key} className="flex-row justify-between py-2">
                <Text className="text-foreground-muted">{entry.key}</Text>
                <Text className="font-t3-medium text-foreground">{entry.componentCount}</Text>
              </View>
            ))
          ) : (
            <Text className="text-foreground-muted">No priced usage in this range.</Text>
          )}
        </View>
      </ScrollView>
    </View>
  );
}
