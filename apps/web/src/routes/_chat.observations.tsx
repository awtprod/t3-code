import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  ObservationId,
  ObservationMutationId,
  SpaceId,
  type ObservationSnapshot,
} from "@command-center/core";
import {
  CommandCenterObservationCorrectionRequest,
  CommandCenterObservationImportInput,
  CommandCenterObservationManualCreateRequest,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Schema from "effect/Schema";
import { RefreshCwIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { SidebarInset } from "../components/ui/sidebar";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import { randomUUID } from "../lib/utils";
import { metricValue, starterDraft } from "../command-center/observations/ObservationDisplay.logic";
import { commandCenterEnvironment } from "../state/commandCenter";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";

const PAGE_SIZE = 25;
const HISTORY_SIZE = 25;
const decodeManual = Schema.decodeUnknownSync(CommandCenterObservationManualCreateRequest);
const decodeImport = Schema.decodeUnknownSync(CommandCenterObservationImportInput);
const decodeCorrection = Schema.decodeUnknownSync(CommandCenterObservationCorrectionRequest);

type Search = {
  environment?: string | undefined;
  space?: string | undefined;
  observation?: string | undefined;
};

function message(failure: unknown): string {
  const value = failure instanceof Error ? failure.message : String(failure);
  return value.trim() || "The observation request failed.";
}

function ObservationCard({
  snapshot,
  selected,
  onSelect,
}: {
  snapshot: ObservationSnapshot;
  selected: boolean;
  onSelect: () => void;
}) {
  const observation = snapshot.observation;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      className={`w-full rounded-xl border p-4 text-left focus-visible:ring-2 focus-visible:ring-ring ${selected ? "border-primary bg-primary/5" : "border-border hover:bg-accent/30"}`}
    >
      <span className="flex flex-wrap items-center justify-between gap-2">
        <strong className="text-sm">{observation.metric.definition}</strong>
        <span className="rounded-full border px-2 py-0.5 text-xs capitalize">
          {observation.collectionMethod}
        </span>
      </span>
      <span className="mt-2 block text-lg font-semibold">{metricValue(snapshot)}</span>
      <span className="mt-1 block text-sm text-muted-foreground">
        {observation.subjectId} · {observation.data.period.start}–{observation.data.period.end}
      </span>
      <span className="mt-1 block text-xs text-muted-foreground">
        {snapshot.retired ? "Retired" : `Revision ${snapshot.version}`} · Collected{" "}
        {new Date(observation.data.collectedAt).toLocaleString()}
      </span>
    </button>
  );
}

function ObservationsRouteView() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/observations" });
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const selectedEnvironment = environments.find(
    (environment) => environment.environmentId === search.environment,
  );
  const environmentId =
    selectedEnvironment?.environmentId ??
    primaryEnvironmentId ??
    environments.find((environment) => environment.connection.phase === "connected")
      ?.environmentId ??
    null;
  const bootstrap = useEnvironmentQuery(
    environmentId === null
      ? null
      : commandCenterEnvironment.bootstrap({ environmentId, input: {} }),
  );
  const spaces = bootstrap.data?.spaces ?? [];
  const space = spaces.find((entry) => entry.id === search.space) ?? spaces[0];
  const [cursor, setCursor] =
    useState<Parameters<typeof commandCenterEnvironment.observationsList>[0]["input"]["cursor"]>();
  const [earlier, setEarlier] = useState<ReadonlyArray<ObservationSnapshot>>([]);
  const [historyBefore, setHistoryBefore] = useState<number>();
  const [olderHistory, setOlderHistory] = useState<ReadonlyArray<ObservationSnapshot>>([]);
  const lastListQueryRef = useRef<string | undefined>(undefined);
  const lastHistoryQueryRef = useRef<string | undefined>(undefined);
  const [editorMode, setEditorMode] = useState<"manual" | "import" | null>(null);
  const [editorText, setEditorText] = useState("");
  const [correctionText, setCorrectionText] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRetire, setConfirmRetire] = useState(false);
  const [analyticsStartDate, setAnalyticsStartDate] = useState(() =>
    new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10),
  );
  const [analyticsEndDate, setAnalyticsEndDate] = useState(() =>
    new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10),
  );
  const [analyticsBusy, setAnalyticsBusy] = useState(false);
  const [analyticsError, setAnalyticsError] = useState<string | null>(null);
  const [analyticsReceipt, setAnalyticsReceipt] = useState<string | null>(null);
  const list = useEnvironmentQuery(
    environmentId === null || space === undefined
      ? null
      : commandCenterEnvironment.observationsList({
          environmentId,
          input: {
            spaceId: SpaceId.make(space.id),
            limit: PAGE_SIZE,
            ...(cursor === undefined ? {} : { cursor }),
          },
        }),
  );
  const rows = useMemo(() => {
    const byId = new Map<string, ObservationSnapshot>();
    for (const item of [...earlier, ...(list.data?.observations ?? [])])
      byId.set(item.observation.id, item);
    return [...byId.values()];
  }, [earlier, list.data?.observations]);
  const selectedId = search.observation ?? rows[0]?.observation.id;
  const detail = useEnvironmentQuery(
    environmentId === null || space === undefined || selectedId === undefined
      ? null
      : commandCenterEnvironment.observationsGet({
          environmentId,
          input: { spaceId: SpaceId.make(space.id), observationId: ObservationId.make(selectedId) },
        }),
  );
  const history = useEnvironmentQuery(
    environmentId === null || space === undefined || selectedId === undefined
      ? null
      : commandCenterEnvironment.observationsHistory({
          environmentId,
          input: {
            spaceId: SpaceId.make(space.id),
            observationId: ObservationId.make(selectedId),
            limit: HISTORY_SIZE,
            ...(historyBefore === undefined ? {} : { beforeVersion: historyBefore }),
          },
        }),
  );
  const historyRows = useMemo(() => {
    const byRevision = new Map<string, ObservationSnapshot>();
    for (const revision of [...olderHistory, ...(history.data ?? [])])
      byRevision.set(revision.revisionId, revision);
    return [...byRevision.values()].sort((left, right) => right.version - left.version);
  }, [history.data, olderHistory]);
  const publishingConnections = useEnvironmentQuery(
    environmentId === null
      ? null
      : commandCenterEnvironment.publishConnections({ environmentId, input: {} }),
  );
  const youtube = publishingConnections.data?.connections.find(
    (connection) => connection.provider === "youtube",
  );
  const analyticsPermission =
    youtube?.analytics?.state === "verified" || youtube?.analytics?.state === "permission-granted";
  const create = useAtomCommand(commandCenterEnvironment.createManualObservation, {
    reportFailure: false,
  });
  const importBatch = useAtomCommand(commandCenterEnvironment.importObservations, {
    reportFailure: false,
  });
  const correct = useAtomCommand(commandCenterEnvironment.correctObservation, {
    reportFailure: false,
  });
  const retire = useAtomCommand(commandCenterEnvironment.retireObservation, {
    reportFailure: false,
  });
  const fetchYouTubeAnalytics = useAtomCommand(commandCenterEnvironment.fetchYouTubeAnalytics, {
    reportFailure: false,
  });

  useEffect(() => {
    setCursor(undefined);
    setEarlier([]);
  }, [environmentId, space?.id]);
  useEffect(() => {
    setHistoryBefore(undefined);
    setOlderHistory([]);
  }, [environmentId, space?.id, selectedId]);
  useEffect(() => {
    if (detail.data !== null)
      setCorrectionText(JSON.stringify(detail.data.observation.data, null, 2));
    setReason("");
    setConfirmRetire(false);
  }, [detail.data?.revisionId, selectedId]);
  useEffect(() => {
    setAnalyticsError(null);
    setAnalyticsReceipt(null);
  }, [environmentId, space?.id, selectedId]);

  const setSearch = (next: Partial<Search>) =>
    void navigate({
      to: "/observations",
      search: {
        environment: environmentId ?? undefined,
        space: space?.id,
        observation: search.observation,
        ...next,
      },
      replace: true,
    });
  const refresh = () => {
    if (cursor === undefined) list.refresh();
    else setCursor(undefined);
    setEarlier([]);
    setHistoryBefore(undefined);
    setOlderHistory([]);
    bootstrap.refresh();
    publishingConnections.refresh();
    detail.refresh();
    history.refresh();
  };
  const fetchAnalytics = async () => {
    const selected = detail.data;
    if (
      environmentId === null ||
      selected === null ||
      selected.retired ||
      analyticsBusy ||
      !analyticsPermission ||
      selected.observation.channelId === undefined ||
      selected.observation.contentId === undefined
    )
      return;
    setAnalyticsBusy(true);
    setAnalyticsError(null);
    setAnalyticsReceipt(null);
    try {
      const result = await fetchYouTubeAnalytics({
        environmentId,
        input: {
          spaceId: selected.observation.spaceId,
          sourceObservationId: selected.observation.id,
          expectedSourceRevisionId: selected.revisionId,
          channelId: selected.observation.channelId,
          videoId: selected.observation.contentId,
          startDate: analyticsStartDate,
          endDate: analyticsEndDate,
        },
      });
      if (result._tag !== "Success") throw squashAtomCommandFailure(result);
      const receipt = result.value;
      setAnalyticsReceipt(
        `Stored ${receipt.observationIds.length} Analytics observations (${receipt.status}). ` +
          `Views: ${receipt.views ?? "unavailable"}. Reported through: ${receipt.freshThroughDate ?? "unknown"}.` +
          (receipt.deduplicated ? " Existing source data was reused." : ""),
      );
      list.refresh();
      publishingConnections.refresh();
    } catch (failure) {
      setAnalyticsError(message(failure));
      publishingConnections.refresh();
    } finally {
      setAnalyticsBusy(false);
    }
  };
  const listKey = `${environmentId}:${space?.id}:${cursor?.createdAt ?? "first"}:${cursor?.observationId ?? ""}`;
  useEffect(() => {
    if (lastListQueryRef.current === listKey) return;
    lastListQueryRef.current = listKey;
    list.refresh();
  }, [listKey, list.refresh]);
  const historyKey = `${environmentId}:${space?.id}:${selectedId}:${historyBefore ?? "latest"}`;
  useEffect(() => {
    if (lastHistoryQueryRef.current === historyKey) return;
    lastHistoryQueryRef.current = historyKey;
    history.refresh();
  }, [historyKey, history.refresh]);
  const submit = async () => {
    if (environmentId === null || space === undefined || busy) return;
    setBusy(true);
    setError(null);
    try {
      const parsed: unknown = JSON.parse(editorText);
      if (editorMode === "manual") {
        const input = decodeManual({
          mutationId: ObservationMutationId.make(randomUUID()),
          expectedVersion: 0,
          observation: parsed,
        });
        if (input.observation.spaceId !== space.id)
          throw new Error("The manual observation must belong to the selected Space.");
        const result = await create({
          environmentId,
          input,
        });
        if (result._tag !== "Success") throw squashAtomCommandFailure(result);
        setSearch({ observation: result.value.observationId });
      } else {
        if (!Array.isArray(parsed)) throw new Error("Import must be a JSON array of observations.");
        const result = await importBatch({
          environmentId,
          input: decodeImport({
            spaceId: SpaceId.make(space.id),
            request: {
              mutationId: ObservationMutationId.make(randomUUID()),
              observations: parsed,
            },
          }),
        });
        if (result._tag !== "Success") throw squashAtomCommandFailure(result);
        setSearch({ observation: result.value.observations[0]?.observationId });
      }
      setEditorMode(null);
      setEditorText("");
      refresh();
    } catch (failure) {
      setError(message(failure));
    } finally {
      setBusy(false);
    }
  };
  const revise = async (retiring: boolean) => {
    if (environmentId === null || space === undefined || detail.data === null || busy) return;
    if (!reason.trim()) {
      setError("Enter a reason for this revision.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const input = {
        mutationId: ObservationMutationId.make(randomUUID()),
        spaceId: SpaceId.make(space.id),
        observationId: detail.data.observation.id,
        expectedVersion: detail.data.version,
        reason: reason.trim(),
      };
      const result = retiring
        ? await retire({ environmentId, input })
        : await correct({
            environmentId,
            input: decodeCorrection({ ...input, data: JSON.parse(correctionText) }),
          });
      if (result._tag !== "Success") throw squashAtomCommandFailure(result);
      setConfirmRetire(false);
      refresh();
    } catch (failure) {
      setError(message(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SidebarInset className="h-full min-h-0 overflow-auto bg-background text-foreground">
      <main className="mx-auto w-full max-w-7xl space-y-5 p-4 pb-10 pt-14 sm:p-6">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold sm:text-3xl">Observations</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Source-backed measurements and their revision history.
            </p>
          </div>
          <Button variant="outline" onClick={refresh} aria-label="Refresh observations">
            <RefreshCwIcon className="size-4" /> Refresh
          </Button>
        </header>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-sm font-medium">
            Environment
            <select
              className="block h-10 w-full rounded-md border bg-background px-3"
              value={environmentId ?? ""}
              onChange={(event) =>
                setSearch({
                  environment: event.target.value,
                  space: undefined,
                  observation: undefined,
                })
              }
            >
              {environments.map((entry) => (
                <option key={entry.environmentId} value={entry.environmentId}>
                  {entry.environmentId}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-sm font-medium">
            Space
            <select
              className="block h-10 w-full rounded-md border bg-background px-3"
              value={space?.id ?? ""}
              onChange={(event) => setSearch({ space: event.target.value, observation: undefined })}
            >
              {spaces.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.displayName}
                </option>
              ))}
            </select>
          </label>
        </div>
        {environmentId === null ? (
          <p className="rounded-lg border p-4">Connect an environment to view observations.</p>
        ) : null}
        {bootstrap.error ? (
          <p role="alert" className="rounded-lg border border-destructive p-4 text-sm">
            {bootstrap.error}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="rounded-lg border border-destructive p-4 text-sm">
            {error}
          </p>
        ) : null}
        {space !== undefined ? (
          <div className="grid gap-5 lg:grid-cols-[minmax(18rem,23rem)_minmax(0,1fr)]">
            <section className="space-y-3" aria-label="Observation list">
              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={() => {
                    setEditorMode("manual");
                    setEditorText(starterDraft(space.id));
                  }}
                >
                  Add manual
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setEditorMode("import");
                    setEditorText("[]");
                  }}
                >
                  Import JSON
                </Button>
              </div>
              {list.error ? (
                <p role="alert" className="rounded-lg border p-3 text-sm">
                  {list.error}
                </p>
              ) : null}
              {list.isPending && rows.length === 0 ? (
                <p className="text-sm text-muted-foreground">Loading observations…</p>
              ) : null}
              {!list.isPending && list.error === null && rows.length === 0 ? (
                <p className="rounded-xl border border-dashed p-5 text-sm text-muted-foreground">
                  No observations in this Space yet.
                </p>
              ) : null}
              {rows.map((row) => (
                <ObservationCard
                  key={row.observation.id}
                  snapshot={row}
                  selected={selectedId === row.observation.id}
                  onSelect={() => setSearch({ observation: row.observation.id })}
                />
              ))}
              {list.data?.nextCursor ? (
                <Button
                  variant="outline"
                  disabled={list.isPending}
                  onClick={() => {
                    setEarlier(rows);
                    setCursor(list.data?.nextCursor ?? undefined);
                  }}
                >
                  Load more
                </Button>
              ) : null}
            </section>
            <section className="min-w-0 space-y-4" aria-label="Observation detail">
              {editorMode !== null ? (
                <div className="space-y-3 rounded-xl border p-4">
                  <div>
                    <h2 className="font-semibold">
                      {editorMode === "manual" ? "Manual observation" : "Import observations"}
                    </h2>
                    <p className="text-sm text-muted-foreground">
                      {editorMode === "manual"
                        ? "Edit the measurement, source identity, period, and completeness. Missing values need a reason."
                        : "Paste an array of imported observations for this Space, up to 100 and 256 KiB. Each entry must have collectionMethod imported."}
                    </p>
                  </div>
                  <Textarea
                    aria-label="Observation JSON"
                    className="min-h-64 font-mono text-xs"
                    value={editorText}
                    onChange={(event) => setEditorText(event.target.value)}
                  />
                  <div className="flex gap-2">
                    <Button disabled={busy} onClick={submit}>
                      {busy ? "Saving…" : "Save"}
                    </Button>
                    <Button variant="ghost" onClick={() => setEditorMode(null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : null}
              {detail.error ? (
                <p role="alert" className="rounded-lg border p-4 text-sm">
                  {detail.error}
                </p>
              ) : null}
              {detail.data ? (
                <div className="space-y-5 rounded-xl border p-4 sm:p-6">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h2 className="text-xl font-semibold">
                        {detail.data.observation.metric.definition}
                      </h2>
                      <p className="text-sm text-muted-foreground">
                        {detail.data.observation.subjectId} · {detail.data.observation.contentKind}
                      </p>
                    </div>
                    <span className="rounded-full border px-3 py-1 text-xs capitalize">
                      {detail.data.observation.collectionMethod}
                      {detail.data.retired ? " · retired" : ""}
                    </span>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-lg bg-muted/40 p-3">
                      <p className="text-xs text-muted-foreground">Measured value</p>
                      <p className="text-lg font-semibold">{metricValue(detail.data)}</p>
                    </div>
                    <div className="rounded-lg bg-muted/40 p-3">
                      <p className="text-xs text-muted-foreground">Completeness</p>
                      <p className="font-medium capitalize">
                        {detail.data.observation.data.completeness.status}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {detail.data.observation.data.completeness.reason ?? "No gap reported"}
                      </p>
                    </div>
                  </div>
                  <dl className="grid gap-2 text-sm sm:grid-cols-2">
                    <div>
                      <dt className="text-muted-foreground">Source identity / revision</dt>
                      <dd className="break-all">
                        {detail.data.observation.source.identity} /{" "}
                        {detail.data.observation.source.revision}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Observation period</dt>
                      <dd>
                        {detail.data.observation.data.period.start}–
                        {detail.data.observation.data.period.end} (
                        {detail.data.observation.data.period.timeZone})
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Content / cohort</dt>
                      <dd className="break-all">
                        {detail.data.observation.contentId ?? "No content ID"} /{" "}
                        {detail.data.observation.cohortId ?? "No cohort ID"}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Channel</dt>
                      <dd className="break-all">
                        {detail.data.observation.channelId ?? "No channel ID"}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Observed</dt>
                      <dd>{new Date(detail.data.observation.data.observedAt).toLocaleString()}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Collected</dt>
                      <dd>{new Date(detail.data.observation.data.collectedAt).toLocaleString()}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Fresh through</dt>
                      <dd>
                        {detail.data.observation.data.freshThrough
                          ? new Date(detail.data.observation.data.freshThrough).toLocaleString()
                          : "Unknown"}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Sample / denominator</dt>
                      <dd>
                        {detail.data.observation.data.sampleCount ?? "Unknown"} /{" "}
                        {detail.data.observation.data.denominator.value ?? "Unknown"}{" "}
                        {detail.data.observation.data.denominator.kind}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Reporting lag</dt>
                      <dd>
                        {detail.data.observation.data.reportingLagMs === null
                          ? "Unknown"
                          : `${detail.data.observation.data.reportingLagMs} ms`}
                      </dd>
                    </div>
                  </dl>
                  {detail.data.observation.channelId !== undefined &&
                  detail.data.observation.contentId !== undefined &&
                  (detail.data.observation.contentKind === "short-form" ||
                    detail.data.observation.contentKind === "long-form") ? (
                    <section
                      className="space-y-3 rounded-lg border p-4"
                      aria-label="YouTube Analytics"
                    >
                      <div>
                        <h3 className="font-semibold">YouTube Analytics</h3>
                        <p className="text-sm text-muted-foreground">
                          Fetch a closed period for this mapped channel and video. Views support the
                          average view percentage and duration observations. Thumbnail CTR remains
                          manual because this API does not report it.
                        </p>
                      </div>
                      <p className="text-sm">
                        {detail.data.retired
                          ? "This source observation is retired. Select an active video observation."
                          : (youtube?.analytics?.detail ??
                            "Connect YouTube with Analytics read permission in Settings first.")}
                      </p>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <label className="text-sm">
                          Start date
                          <input
                            className="mt-1 block h-10 w-full rounded-md border bg-background px-3"
                            type="date"
                            value={analyticsStartDate}
                            onChange={(event) => setAnalyticsStartDate(event.target.value)}
                          />
                        </label>
                        <label className="text-sm">
                          End date
                          <input
                            className="mt-1 block h-10 w-full rounded-md border bg-background px-3"
                            type="date"
                            value={analyticsEndDate}
                            onChange={(event) => setAnalyticsEndDate(event.target.value)}
                          />
                        </label>
                      </div>
                      <Button
                        disabled={
                          detail.data.retired ||
                          !analyticsPermission ||
                          analyticsBusy ||
                          !analyticsStartDate ||
                          !analyticsEndDate
                        }
                        onClick={() => void fetchAnalytics()}
                      >
                        {analyticsBusy ? "Fetching…" : "Fetch Analytics"}
                      </Button>
                      {analyticsError ? (
                        <p role="alert" className="text-sm text-destructive">
                          {analyticsError}
                        </p>
                      ) : null}
                      {analyticsReceipt ? (
                        <p role="status" className="text-sm">
                          {analyticsReceipt}
                        </p>
                      ) : null}
                    </section>
                  ) : null}
                  {detail.data.hasCollectionConflict ? (
                    <p
                      role="status"
                      className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
                    >
                      Another collection method reports this metric for the same subject and period.
                      Reconcile before comparing.
                    </p>
                  ) : null}
                  <p className="rounded-lg border bg-muted/20 p-3 text-sm">
                    Eligibility has not been evaluated against a server-owned policy. This
                    measurement is evidence, not approval to change a plan.
                  </p>
                  {!detail.data.retired ? (
                    <div className="space-y-3 border-t pt-4">
                      <h3 className="font-semibold">Correct or retire</h3>
                      <p className="text-sm text-muted-foreground">
                        Corrections create a new revision; the source identity and earlier values
                        remain in history.
                      </p>
                      <Textarea
                        aria-label="Corrected data JSON"
                        className="min-h-48 font-mono text-xs"
                        value={correctionText}
                        onChange={(event) => setCorrectionText(event.target.value)}
                      />
                      <label className="block space-y-1 text-sm">
                        Reason
                        <input
                          className="block h-10 w-full rounded-md border bg-background px-3"
                          value={reason}
                          onChange={(event) => setReason(event.target.value)}
                        />
                      </label>
                      <div className="flex flex-wrap gap-2">
                        <Button disabled={busy} onClick={() => void revise(false)}>
                          Save correction
                        </Button>
                        {confirmRetire ? (
                          <>
                            <Button
                              variant="destructive"
                              disabled={busy}
                              onClick={() => void revise(true)}
                            >
                              Confirm retirement
                            </Button>
                            <Button variant="ghost" onClick={() => setConfirmRetire(false)}>
                              Cancel
                            </Button>
                          </>
                        ) : (
                          <Button variant="outline" onClick={() => setConfirmRetire(true)}>
                            Retire observation
                          </Button>
                        )}
                      </div>
                    </div>
                  ) : null}
                  <div className="space-y-2 border-t pt-4">
                    <h3 className="font-semibold">Revision history</h3>
                    {history.error ? (
                      <p role="alert" className="text-sm">
                        {history.error}
                      </p>
                    ) : null}
                    {historyRows.map((revision) => (
                      <div key={revision.revisionId} className="rounded-lg border p-3 text-sm">
                        <p className="font-medium capitalize">
                          Revision {revision.version} · {revision.revisionKind}
                        </p>
                        <p>{metricValue(revision)}</p>
                        <p className="text-muted-foreground">
                          {new Date(revision.revisedAt).toLocaleString()} · {revision.actor.kind} ·{" "}
                          {revision.revisionReason ?? "Initial record"}
                        </p>
                      </div>
                    ))}
                    {history.data?.length === HISTORY_SIZE &&
                    (history.data.at(-1)?.version ?? 0) > 1 ? (
                      <Button
                        variant="outline"
                        disabled={history.isPending}
                        onClick={() => {
                          setOlderHistory(historyRows);
                          setHistoryBefore(history.data?.at(-1)?.version);
                        }}
                      >
                        Load older revisions
                      </Button>
                    ) : null}
                  </div>
                </div>
              ) : !list.isPending && rows.length > 0 ? (
                <p className="rounded-xl border p-5 text-sm text-muted-foreground">
                  Choose an observation to inspect its source and history.
                </p>
              ) : null}
            </section>
          </div>
        ) : null}
      </main>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/observations")({
  validateSearch: (search): Search => ({
    environment: typeof search.environment === "string" ? search.environment : undefined,
    space: typeof search.space === "string" ? search.space : undefined,
    observation: typeof search.observation === "string" ? search.observation : undefined,
  }),
  component: ObservationsRouteView,
});
