import type { Space } from "@command-center/core";
import type {
  CommandCenterResponsibilityDetail,
  CommandCenterResponsibilityStatus,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import {
  ArrowRightIcon,
  CircleAlertIcon,
  Clock3Icon,
  PauseIcon,
  PlayIcon,
  RefreshCwIcon,
  WorkflowIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

const healthLabel: Record<CommandCenterResponsibilityStatus["health"], string> = {
  paused: "Paused",
  blocked: "Blocked",
  "temporarily-failing": "Retrying",
  healthy: "Healthy",
  unknown: "Unknown",
};

function time(value: string | null): string {
  if (value === null) return "Not yet";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function HealthPill({ health }: { readonly health: CommandCenterResponsibilityStatus["health"] }) {
  return (
    <span
      className={cn(
        "inline-flex min-h-7 items-center rounded-full border px-2.5 text-xs font-medium",
        health === "healthy" &&
          "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
        health === "paused" && "border-muted-foreground/25 bg-muted text-muted-foreground",
        health === "blocked" && "border-destructive/30 bg-destructive/10 text-destructive",
        health === "temporarily-failing" &&
          "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
        health === "unknown" && "border-border bg-muted/50 text-muted-foreground",
      )}
    >
      {healthLabel[health]}
    </span>
  );
}

function Fact({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-1 break-words text-sm">{children}</dd>
    </div>
  );
}

export interface ResponsibilitiesScreenProps {
  readonly spaces: readonly Space[];
  readonly spaceId: string;
  readonly onSpaceChange: (spaceId: string) => void;
  readonly responsibilities: readonly CommandCenterResponsibilityStatus[];
  readonly detail: CommandCenterResponsibilityDetail | null;
  readonly selectedId: string | null;
  readonly onSelect: (automationId: string) => void;
  readonly loading: boolean;
  readonly detailLoading: boolean;
  readonly error: string | null;
  readonly detailError: string | null;
  readonly actionError: string | null;
  readonly actionPending: boolean;
  readonly onPauseChange: (paused: boolean, reason: string) => void;
  readonly onRefresh: () => void;
}

export function ResponsibilitiesScreen({
  spaces,
  spaceId,
  onSpaceChange,
  responsibilities,
  detail,
  selectedId,
  onSelect,
  loading,
  detailLoading,
  error,
  detailError,
  actionError,
  actionPending,
  onPauseChange,
  onRefresh,
}: ResponsibilitiesScreenProps) {
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    setReason("");
    setConfirming(false);
  }, [selectedId, detail?.paused]);

  const selected =
    detail ?? responsibilities.find((item) => item.automationId === selectedId) ?? null;
  const unavailable = error !== null;
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 pt-14 pb-12 sm:px-6 sm:pt-5">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-sm font-medium text-muted-foreground">Command Center</p>
          <h1 className="text-2xl font-semibold tracking-tight">Responsibilities</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            See what each Automation checks, when it last produced a useful result, and what needs
            attention.
          </p>
        </div>
        <Button className="self-start" disabled={loading} onClick={onRefresh} variant="outline">
          <RefreshCwIcon /> Refresh
        </Button>
      </header>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <label className="flex min-w-48 max-w-sm flex-col gap-1.5 text-sm font-medium">
          Space
          <select
            aria-label="Responsibilities Space"
            className="min-h-11 rounded-[var(--control-radius)] border border-input bg-background px-3 text-base shadow-xs/5 sm:min-h-9 sm:text-sm"
            onChange={(event) => onSpaceChange(event.target.value)}
            value={spaceId}
          >
            <option value="">All Spaces</option>
            {spaces.map((space) => (
              <option key={space.id} value={space.id}>
                {space.displayName}
              </option>
            ))}
          </select>
        </label>
        {responsibilities.length === 100 ? (
          <p className="text-xs text-muted-foreground">
            Showing the first 100. Select a Space to narrow the list.
          </p>
        ) : null}
      </div>

      {unavailable ? (
        <div
          className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm"
          role="alert"
        >
          <p>{error}</p>
          <Button className="mt-3" onClick={onRefresh} variant="outline">
            Try again
          </Button>
        </div>
      ) : loading && responsibilities.length === 0 ? (
        <div className="rounded-xl border bg-card p-6 text-sm text-muted-foreground">
          Loading Responsibilities…
        </div>
      ) : responsibilities.length === 0 ? (
        <div className="rounded-xl border bg-card p-6 text-sm text-muted-foreground">
          No Responsibilities are configured{spaceId ? " in this Space" : ""}. Create an Automation
          to start tracking one.
          <div className="mt-4">
            <Button render={<Link to="/automations" />} variant="outline">
              Open Automations <ArrowRightIcon />
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid min-h-0 gap-4 lg:grid-cols-[minmax(15rem,20rem)_minmax(0,1fr)]">
          <nav aria-label="Responsibilities" className="min-w-0 space-y-2">
            {responsibilities.map((item) => (
              <button
                aria-current={selected?.automationId === item.automationId ? "true" : undefined}
                className={cn(
                  "flex min-h-20 w-full flex-col items-start gap-2 rounded-xl border bg-card p-3 text-left transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  selected?.automationId === item.automationId && "border-primary/50 bg-accent/60",
                )}
                key={`${item.spaceId}:${item.automationId}`}
                onClick={() => onSelect(item.automationId)}
                type="button"
              >
                <span className="flex w-full items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-sm font-semibold">{item.name}</span>
                  <HealthPill health={item.health} />
                </span>
                <span className="text-xs text-muted-foreground">
                  {spaces.find((space) => space.id === item.spaceId)?.displayName ?? item.spaceId}
                  {item.lastCheckedAt
                    ? ` · Checked ${time(item.lastCheckedAt)}`
                    : " · Never checked"}
                </span>
              </button>
            ))}
          </nav>

          <section
            aria-label="Responsibility detail"
            className="min-w-0 rounded-xl border bg-card p-4 sm:p-5"
          >
            {detailError ? (
              <div
                className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm"
                role="alert"
              >
                {detailError}
              </div>
            ) : detailLoading && detail === null ? (
              <p className="text-sm text-muted-foreground">Loading detail…</p>
            ) : selected === null ? (
              <p className="text-sm text-muted-foreground">
                Select a Responsibility to see its history.
              </p>
            ) : (
              <>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <WorkflowIcon className="size-5 text-muted-foreground" />
                      <h2 className="text-lg font-semibold">{selected.name}</h2>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Owned by {selected.owner} ·{" "}
                      {selected.enabled ? "Enabled" : "Disabled in config"}
                    </p>
                  </div>
                  <HealthPill health={selected.health} />
                </div>

                <dl className="mt-5 grid gap-x-5 gap-y-4 border-t pt-5 sm:grid-cols-2">
                  <Fact label="Watched source">
                    {selected.watchedSources.length > 0
                      ? selected.watchedSources.join(", ")
                      : "Manual trigger; no watched source"}
                  </Fact>
                  <Fact label="Next scheduled check">{time(selected.nextScheduledAt)}</Fact>
                  <Fact label="Last check">
                    {time(selected.lastCheckedAt)}
                    {selected.lastCheckStatus
                      ? ` · ${selected.lastCheckStatus.replaceAll("-", " ")}`
                      : ""}
                  </Fact>
                  <Fact label="Last useful result">{time(selected.lastUsefulResultAt)}</Fact>
                  <Fact label="Source freshness">
                    Not reported. Last check time does not prove source freshness.
                  </Fact>
                  <Fact label="Current run">{selected.currentExecutionId ?? "None"}</Fact>
                  <Fact label="Authority">
                    {selected.authority ?? selected.authorityExplanation}
                  </Fact>
                  <Fact label="Limits">{selected.limits ?? selected.limitsExplanation}</Fact>
                </dl>

                {selected.lastUsefulResultRef ? (
                  <div className="mt-5 rounded-lg border bg-background p-3 text-sm">
                    <p className="font-medium">Useful result reference</p>
                    <p className="mt-1 break-all text-muted-foreground">
                      Artifact {selected.lastUsefulResultRef.artifactId} · Run{" "}
                      {selected.lastUsefulResultRef.runId}
                    </p>
                  </div>
                ) : (
                  <p className="mt-5 rounded-lg border bg-background p-3 text-sm text-muted-foreground">
                    No inspectable useful result has been recorded yet. A successful empty check is
                    shown only under Last check.
                  </p>
                )}

                {selected.incident ? (
                  <div className="mt-5 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-sm">
                    <div className="flex items-center gap-2 font-semibold">
                      <CircleAlertIcon className="size-4" />{" "}
                      {selected.incident.state === "blocked"
                        ? "Needs intervention"
                        : "Temporary failure"}
                    </div>
                    <p className="mt-2">{selected.incident.displayError}</p>
                    <p className="mt-2 text-muted-foreground">
                      Cause: {selected.incident.canonicalCode} · {selected.incident.resource} ·{" "}
                      {selected.incident.subject}
                    </p>
                    <p className="mt-1 text-muted-foreground">
                      Seen {selected.incident.occurrenceCount} time
                      {selected.incident.occurrenceCount === 1 ? "" : "s"}; last seen{" "}
                      {time(selected.incident.lastSeenAt)}
                    </p>
                    {selected.incident.retryAt ? (
                      <p className="mt-1 text-muted-foreground">
                        Retry at {time(selected.incident.retryAt)}
                      </p>
                    ) : null}
                    <p className="mt-3">{selected.incident.recoveryInstruction}</p>
                  </div>
                ) : null}

                <div className="mt-5 border-t pt-5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-semibold">Control</h3>
                      <p className="text-xs text-muted-foreground">
                        Pause prevents new admissions; a current run can finish.
                      </p>
                    </div>
                    <Button
                      disabled={actionPending}
                      onClick={() => setConfirming((value) => !value)}
                      variant={selected.paused ? "default" : "outline"}
                    >
                      {selected.paused ? <PlayIcon /> : <PauseIcon />}
                      {selected.paused ? "Resume" : "Pause"}
                    </Button>
                  </div>
                  {confirming ? (
                    <form
                      className="mt-4 flex flex-col gap-3 rounded-lg border bg-background p-3"
                      onSubmit={(event) => {
                        event.preventDefault();
                        onPauseChange(!selected.paused, reason.trim());
                      }}
                    >
                      <label className="flex flex-col gap-1.5 text-sm font-medium">
                        Reason <span className="font-normal text-muted-foreground">(optional)</span>
                        <textarea
                          className="min-h-20 rounded-md border border-input bg-background p-2 text-sm"
                          maxLength={500}
                          onChange={(event) => setReason(event.target.value)}
                          placeholder={
                            selected.paused
                              ? "Why is this ready to resume?"
                              : "Why are you pausing it?"
                          }
                          value={reason}
                        />
                      </label>
                      <div className="flex flex-wrap gap-2">
                        <Button disabled={actionPending} type="submit">
                          {actionPending
                            ? "Saving…"
                            : selected.paused
                              ? "Resume Responsibility"
                              : "Pause Responsibility"}
                        </Button>
                        <Button
                          disabled={actionPending}
                          onClick={() => setConfirming(false)}
                          type="button"
                          variant="ghost"
                        >
                          Cancel
                        </Button>
                      </div>
                    </form>
                  ) : null}
                  {actionError ? (
                    <p className="mt-3 text-sm text-destructive" role="alert">
                      {actionError}
                    </p>
                  ) : null}
                  {selected.paused ? (
                    <p className="mt-3 text-xs text-muted-foreground">
                      Paused by {selected.pauseActor ?? "unknown"}
                      {selected.pauseReason ? ` · ${selected.pauseReason}` : ""}
                    </p>
                  ) : null}
                </div>

                <div className="mt-5 border-t pt-5">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold">Recent checks</h3>
                    <Clock3Icon className="size-4 text-muted-foreground" />
                  </div>
                  {detail === null || detail.history.length === 0 ? (
                    <p className="mt-3 text-sm text-muted-foreground">No checks yet.</p>
                  ) : (
                    <ol className="mt-3 space-y-2">
                      {detail.history.map((entry) => (
                        <li
                          className="rounded-lg border bg-background p-3 text-sm"
                          key={entry.executionId}
                        >
                          <div className="flex flex-wrap justify-between gap-2">
                            <span className="font-medium capitalize">
                              {entry.state.replaceAll("-", " ")}
                            </span>
                            <time className="text-xs text-muted-foreground">
                              {time(entry.startedAt)}
                            </time>
                          </div>
                          {entry.error ? (
                            <p className="mt-1 text-destructive">{entry.error}</p>
                          ) : null}
                          {entry.usefulResultRef ? (
                            <p className="mt-1 break-all text-xs text-muted-foreground">
                              Artifact {entry.usefulResultRef.artifactId}
                            </p>
                          ) : null}
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
                <Button className="mt-5" render={<Link to="/automations" />} variant="ghost">
                  Edit Automation <ArrowRightIcon />
                </Button>
              </>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
