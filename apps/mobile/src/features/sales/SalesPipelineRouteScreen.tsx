import type { CommandCenterSalesProspectsQueryResult, EnvironmentId } from "@t3tools/contracts";
import { useMemo, useState } from "react";
import { Linking, Modal, Pressable, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { commandCenterEnvironment } from "../../state/commandCenter";

type Prospect = CommandCenterSalesProspectsQueryResult["prospects"][number];
type Stage = Prospect["stage"];

const STAGES: ReadonlyArray<Stage> = [
  "researched",
  "qualified",
  "drafted",
  "contacted",
  "replied",
  "call_booked",
  "proposal_sent",
  "won",
  "nurture",
  "lost",
];
const LABEL: Readonly<Record<Stage, string>> = {
  researched: "Researched",
  qualified: "Qualified",
  drafted: "Drafted",
  contacted: "Contacted",
  replied: "Replied",
  call_booked: "Call booked",
  proposal_sent: "Proposal sent",
  won: "Won",
  nurture: "Nurture",
  lost: "Lost",
};
const NEXT: Partial<Record<Stage, Stage>> = {
  researched: "qualified",
  drafted: "contacted",
  contacted: "replied",
  replied: "call_booked",
  call_booked: "proposal_sent",
  proposal_sent: "won",
  nurture: "qualified",
};

function ProspectRow({
  prospect,
  onPress,
}: {
  readonly prospect: Prospect;
  readonly onPress: () => void;
}) {
  return (
    <Pressable className="rounded-2xl bg-card p-4 active:opacity-70" onPress={onPress}>
      <View className="flex-row items-start justify-between gap-3">
        <View className="flex-1">
          <Text className="font-t3-semibold text-base text-foreground">{prospect.channelName}</Text>
          <Text className="mt-1 text-sm text-foreground-muted" numberOfLines={1}>
            {prospect.niche}
          </Text>
        </View>
        <View className="rounded-full bg-subtle px-2.5 py-1">
          <Text className="font-t3-semibold text-xs text-foreground">{prospect.fit.score}</Text>
        </View>
      </View>
      <View className="mt-3 flex-row justify-between">
        <Text className="text-xs text-foreground-muted">
          {prospect.subscriberCount?.toLocaleString() ?? "—"} subscribers
        </Text>
        <Text className="font-t3-medium text-xs text-foreground">$300</Text>
      </View>
    </Pressable>
  );
}

export function SalesPipelineRouteScreen() {
  const insets = useSafeAreaInsets();
  const { environments } = useEnvironments();
  const [environmentId, setEnvironmentId] = useState<EnvironmentId | null>(null);
  const environment =
    environments.find((item) => item.environmentId === environmentId) ?? environments[0] ?? null;
  const bootstrap = useEnvironmentQuery(
    environment === null
      ? null
      : commandCenterEnvironment.bootstrap({ environmentId: environment.environmentId, input: {} }),
  );
  const salesSpaces =
    bootstrap.data?.spaces.filter((space) => space.features?.salesPipeline === true) ?? [];
  const [spaceSelection, setSpaceSelection] = useState<string>();
  const space = salesSpaces.find((item) => item.id === spaceSelection) ?? salesSpaces[0];
  const prospects = useEnvironmentQuery(
    environment === null || space === undefined
      ? null
      : commandCenterEnvironment.salesProspects({
          environmentId: environment.environmentId,
          input: { spaceId: space.id },
        }),
  );
  const update = useAtomCommand(commandCenterEnvironment.updateSalesProspect, {
    reportFailure: false,
  });
  const [selected, setSelected] = useState<Prospect>();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const grouped = useMemo(
    () =>
      new Map(
        STAGES.map((stage) => [
          stage,
          prospects.data?.prospects.filter((item) => item.stage === stage) ?? [],
        ]),
      ),
    [prospects.data?.prospects],
  );

  const move = async (prospect: Prospect, stage: Stage) => {
    if (environment === null || busy) return;
    setBusy(true);
    setActionError(undefined);
    const result = await update({
      environmentId: environment.environmentId,
      input: {
        prospectId: prospect.id,
        spaceId: prospect.spaceId,
        expectedUpdatedAt: prospect.updatedAt,
        stage,
      },
    });
    if (result._tag === "Success") {
      setSelected(result.value.prospect);
      prospects.refresh();
    } else {
      setActionError(
        "The prospect changed or this stage move is not allowed. Refresh and try again.",
      );
    }
    setBusy(false);
  };

  return (
    <View className="flex-1 bg-screen">
      <ScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-5 px-4 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        refreshControl={
          <RefreshControl refreshing={prospects.isPending} onRefresh={prospects.refresh} />
        }
      >
        {environments.length > 1 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerClassName="gap-2"
          >
            {environments.map((item) => (
              <Pressable
                className={
                  item.environmentId === environment?.environmentId
                    ? "rounded-full bg-primary px-4 py-2"
                    : "rounded-full bg-card px-4 py-2"
                }
                key={item.environmentId}
                onPress={() => setEnvironmentId(item.environmentId)}
              >
                <Text
                  className={
                    item.environmentId === environment?.environmentId
                      ? "text-primary-foreground"
                      : "text-foreground-muted"
                  }
                >
                  {item.label}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        ) : null}
        {salesSpaces.length > 1 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerClassName="gap-2"
          >
            {salesSpaces.map((item) => (
              <Pressable
                className={
                  item.id === space?.id
                    ? "rounded-full bg-foreground px-4 py-2"
                    : "rounded-full bg-card px-4 py-2"
                }
                key={item.id}
                onPress={() => setSpaceSelection(item.id)}
              >
                <Text
                  className={item.id === space?.id ? "text-background" : "text-foreground-muted"}
                >
                  {item.displayName}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        ) : null}
        {actionError || prospects.error ? (
          <Text className="rounded-xl bg-danger/10 p-3 text-sm text-danger">
            {actionError ?? prospects.error}
          </Text>
        ) : null}
        {space === undefined && !bootstrap.isPending ? (
          <EmptyState
            title="No sales pipeline"
            detail="Enable the salesPipeline feature for a Space to use this view."
          />
        ) : null}
        {STAGES.map((stage) => {
          const rows = grouped.get(stage) ?? [];
          if (rows.length === 0) return null;
          return (
            <View className="gap-2" key={stage}>
              <View className="flex-row items-center justify-between px-1">
                <Text className="font-t3-semibold text-sm text-foreground">{LABEL[stage]}</Text>
                <Text className="text-xs text-foreground-muted">{rows.length}</Text>
              </View>
              {rows.map((prospect) => (
                <ProspectRow
                  key={prospect.id}
                  prospect={prospect}
                  onPress={() => setSelected(prospect)}
                />
              ))}
            </View>
          );
        })}
      </ScrollView>

      <Modal
        animationType="slide"
        onRequestClose={() => setSelected(undefined)}
        presentationStyle="pageSheet"
        visible={selected !== undefined}
      >
        {selected ? (
          <ScrollView
            className="flex-1 bg-sheet"
            contentInsetAdjustmentBehavior="automatic"
            contentContainerClassName="gap-5 p-5"
          >
            <View className="flex-row items-start justify-between gap-4">
              <View className="flex-1">
                <Text className="font-t3-bold text-2xl text-foreground">
                  {selected.channelName}
                </Text>
                <Text className="mt-1 text-foreground-muted">
                  {LABEL[selected.stage]} · {selected.niche}
                </Text>
              </View>
              <Pressable
                className="rounded-full bg-card px-3 py-2"
                onPress={() => setSelected(undefined)}
              >
                <Text className="text-foreground">Close</Text>
              </Pressable>
            </View>
            <View className="rounded-2xl bg-card p-4">
              <Text className="font-t3-semibold text-foreground">Thumbnail audit</Text>
              <Text className="mt-2 leading-6 text-foreground-muted">
                {selected.fit.thumbnailAudit}
              </Text>
            </View>
            <View className="rounded-2xl bg-card p-4">
              <Text className="font-t3-semibold text-foreground">Fit evidence</Text>
              {selected.fit.reasons.map((reason) => (
                <Text className="mt-2 text-foreground-muted" key={reason}>
                  • {reason}
                </Text>
              ))}
            </View>
            <Pressable
              className="rounded-2xl bg-card p-4"
              onPress={() => void Linking.openURL(selected.contactProvenance.sourceUrl)}
            >
              <Text className="font-t3-semibold text-foreground">Public business contact</Text>
              <Text className="mt-1 text-foreground-muted">
                {selected.contactEmail ?? "No email recorded"}
              </Text>
              <Text className="mt-2 text-info">Review provenance</Text>
            </Pressable>
            {selected.stage === "qualified" ? (
              <View className="rounded-2xl bg-warning/10 p-4">
                <Text className="font-t3-semibold text-foreground">Outreach review required</Text>
                <Text className="mt-1 text-foreground-muted">
                  Open Command Center on web or desktop to review the full recipient, subject, and
                  body before creating a Gmail draft.
                </Text>
              </View>
            ) : null}
            {NEXT[selected.stage] ? (
              <Pressable
                className="rounded-2xl bg-primary p-4"
                disabled={busy}
                onPress={() => void move(selected, NEXT[selected.stage]!)}
              >
                <Text className="text-center font-t3-semibold text-primary-foreground">
                  Move to {LABEL[NEXT[selected.stage]!]}
                </Text>
              </Pressable>
            ) : null}
            {selected.stage !== "won" && selected.stage !== "lost" ? (
              <Pressable
                className="rounded-2xl border border-input-border p-4"
                disabled={busy}
                onPress={() => void move(selected, "lost")}
              >
                <Text className="text-center font-t3-semibold text-foreground">Mark lost</Text>
              </Pressable>
            ) : null}
          </ScrollView>
        ) : null}
      </Modal>
    </View>
  );
}
