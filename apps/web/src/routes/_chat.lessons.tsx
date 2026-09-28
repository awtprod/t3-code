import { MemoryId, ObservationId, RepositoryId, SpaceId, type Memory } from "@command-center/core";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { Button } from "../components/ui/button";
import { SidebarInset } from "../components/ui/sidebar";
import { Textarea } from "../components/ui/textarea";
import { randomUUID } from "../lib/utils";
import { commandCenterEnvironment } from "../state/commandCenter";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";

type Search = {
  environment?: string | undefined;
  space?: string | undefined;
  observation?: string | undefined;
  revision?: string | undefined;
  version?: number | undefined;
};

function correctionSource(sourceRef: string | undefined) {
  const match = /^observation\/([^/]+)\/version\/([1-9]\d*)\/revision\/([^/]+)$/u.exec(
    sourceRef ?? "",
  );
  if (match === null) return null;
  try {
    return {
      observation: decodeURIComponent(match[1] ?? ""),
      version: Number(match[2]),
      revision: decodeURIComponent(match[3] ?? ""),
    };
  } catch {
    return null;
  }
}

function LessonsRouteView() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/lessons" });
  const primary = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const environmentId =
    environments.find((entry) => entry.environmentId === search.environment)?.environmentId ??
    primary ??
    environments.find((entry) => entry.connection.phase === "connected")?.environmentId ??
    null;
  const bootstrap = useEnvironmentQuery(
    environmentId === null
      ? null
      : commandCenterEnvironment.bootstrap({ environmentId, input: {} }),
  );
  const spaces = bootstrap.data?.spaces ?? [];
  const space = spaces.find((entry) => entry.id === search.space) ?? spaces[0];
  const memories = useEnvironmentQuery(
    environmentId === null || space === undefined
      ? null
      : commandCenterEnvironment.memories({
          environmentId,
          input: {
            spaceId: SpaceId.make(space.id),
            statuses: ["candidate", "approved", "rejected", "expired"],
            limit: 100,
          },
        }),
  );
  const evidence = useEnvironmentQuery(
    environmentId === null || space === undefined || !search.observation || !search.revision
      ? null
      : commandCenterEnvironment.observationsHistory({
          environmentId,
          input: {
            spaceId: SpaceId.make(space.id),
            observationId: ObservationId.make(search.observation),
            limit: 25,
            ...(search.version === undefined ? {} : { beforeVersion: search.version + 1 }),
          },
        }),
  );
  const correction = evidence.data?.find((item) => item.revisionId === search.revision);
  const [rule, setRule] = useState("");
  const [confidence, setConfidence] = useState("0.8");
  const [expires, setExpires] = useState("");
  const [repositoryId, setRepositoryId] = useState("");
  const [contradictionOf, setContradictionOf] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const propose = useAtomCommand(commandCenterEnvironment.proposeMemory, { reportFailure: false });
  const review = useAtomCommand(commandCenterEnvironment.reviewMemory, { reportFailure: false });
  const rows = memories.data?.memories ?? [];
  const approved = rows.filter((item) => item.status === "approved");

  useEffect(() => {
    setRule("");
    setExpires("");
    setRepositoryId("");
    setContradictionOf("");
    setError(null);
  }, [environmentId, space?.id, search.revision]);

  const setSearch = (next: Partial<Search>) =>
    void navigate({
      to: "/lessons",
      search: { environment: environmentId ?? undefined, space: space?.id, ...next },
      replace: true,
    });
  const submit = async () => {
    if (environmentId === null || space === undefined || correction === undefined || busy) return;
    setBusy(true);
    setError(null);
    try {
      const numericConfidence = Number(confidence);
      if (
        !confidence.trim() ||
        !Number.isFinite(numericConfidence) ||
        numericConfidence < 0 ||
        numericConfidence > 1
      )
        throw new Error("Confidence must be between 0 and 1.");
      const result = await propose({
        environmentId,
        input: {
          requestId: randomUUID(),
          spaceId: SpaceId.make(space.id),
          ...(repositoryId ? { repositoryId: RepositoryId.make(repositoryId) } : {}),
          kind: "procedure",
          content: rule.trim(),
          confidence: numericConfidence,
          evidence: {
            kind: "observation-correction",
            observationId: correction.observation.id,
            revisionId: correction.revisionId,
          },
          ...(expires ? { expiresAt: new Date(`${expires}T23:59:59.000Z`).toISOString() } : {}),
          ...(contradictionOf ? { contradictionOf: MemoryId.make(contradictionOf) } : {}),
        },
      });
      if (result._tag !== "Success") throw squashAtomCommandFailure(result);
      setRule("");
      setContradictionOf("");
      memories.refresh();
      bootstrap.refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  const decide = async (memory: Memory, decision: "approve" | "reject" | "expire") => {
    if (environmentId === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await review({
        environmentId,
        input: {
          memoryId: memory.id,
          spaceId: memory.spaceId,
          ...(memory.repositoryId === undefined ? {} : { repositoryId: memory.repositoryId }),
          decision,
        },
      });
      if (result._tag !== "Success") throw squashAtomCommandFailure(result);
      memories.refresh();
      bootstrap.refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SidebarInset className="h-full min-h-0 overflow-auto bg-background text-foreground">
      <main className="mx-auto w-full max-w-5xl space-y-5 p-4 pb-10 sm:p-6">
        <header>
          <h1 className="text-2xl font-semibold sm:text-3xl">Reviewed lessons</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Rules from explicit corrections stay candidates until you approve them. They do not
            change Space policy or automation thresholds.
          </p>
        </header>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            Environment
            <select
              className="mt-1 block h-10 w-full rounded-md border bg-background px-3"
              value={environmentId ?? ""}
              onChange={(event) => setSearch({ environment: event.target.value, space: undefined })}
            >
              {environments.map((entry) => (
                <option key={entry.environmentId} value={entry.environmentId}>
                  {entry.environmentId}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            Space
            <select
              className="mt-1 block h-10 w-full rounded-md border bg-background px-3"
              value={space?.id ?? ""}
              onChange={(event) =>
                setSearch({
                  space: event.target.value,
                  observation: undefined,
                  revision: undefined,
                })
              }
            >
              {spaces.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.displayName}
                </option>
              ))}
            </select>
          </label>
        </div>
        {bootstrap.error || memories.error || evidence.error || error ? (
          <p role="alert" className="rounded-lg border border-destructive p-3 text-sm">
            {bootstrap.error ?? memories.error ?? evidence.error ?? error}
          </p>
        ) : null}
        {search.revision ? (
          <section className="space-y-3 rounded-xl border p-4">
            <h2 className="font-semibold">Propose from correction</h2>
            {correction?.revisionKind === "corrected" && correction.actor.kind === "user" ? (
              <>
                <p className="text-sm">
                  Revision {correction.version}: {correction.revisionReason}
                </p>
                <Link
                  className="text-sm underline"
                  to="/observations"
                  search={{
                    environment: environmentId ?? undefined,
                    space: space?.id,
                    observation: search.observation,
                    revision: search.revision,
                    version: correction.version,
                  }}
                >
                  View exact evidence
                </Link>
                <label className="block text-sm">
                  Proposed rule
                  <Textarea
                    className="mt-1"
                    value={rule}
                    maxLength={1000}
                    onChange={(event) => setRule(event.target.value)}
                    placeholder="When this condition occurs, do this…"
                  />
                </label>
                <div className="grid gap-3 sm:grid-cols-3">
                  <label className="text-sm">
                    Scope
                    <select
                      className="mt-1 block h-10 w-full rounded-md border bg-background px-3"
                      value={repositoryId}
                      onChange={(event) => {
                        setRepositoryId(event.target.value);
                        setContradictionOf("");
                      }}
                    >
                      <option value="">Entire Space</option>
                      {space?.repositories.map((repo) => (
                        <option key={repo.id} value={repo.id}>
                          {repo.displayName}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-sm">
                    Confidence (0–1)
                    <input
                      className="mt-1 block h-10 w-full rounded-md border bg-background px-3"
                      type="number"
                      min="0"
                      max="1"
                      step="0.1"
                      value={confidence}
                      onChange={(event) => setConfidence(event.target.value)}
                    />
                  </label>
                  <label className="text-sm">
                    Expires (optional)
                    <input
                      className="mt-1 block h-10 w-full rounded-md border bg-background px-3"
                      type="date"
                      value={expires}
                      onChange={(event) => setExpires(event.target.value)}
                    />
                  </label>
                </div>
                {approved.length > 0 ? (
                  <label className="block text-sm">
                    Conflicts with approved rule (optional)
                    <select
                      className="mt-1 block h-10 w-full rounded-md border bg-background px-3"
                      value={contradictionOf}
                      onChange={(event) => setContradictionOf(event.target.value)}
                    >
                      <option value="">None</option>
                      {approved
                        .filter((item) => item.repositoryId === (repositoryId || undefined))
                        .map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.content.slice(0, 100)}
                          </option>
                        ))}
                    </select>
                  </label>
                ) : null}
                <Button disabled={busy || !rule.trim()} onClick={() => void submit()}>
                  Propose for review
                </Button>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                Loading correction, or this revision is not a user correction.
              </p>
            )}
          </section>
        ) : (
          <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
            Open a corrected revision in Observations to propose a lesson.
          </p>
        )}
        <section className="space-y-3">
          <h2 className="font-semibold">Lessons in this Space</h2>
          {memories.isPending && rows.length === 0 ? (
            <p className="text-sm">Loading lessons…</p>
          ) : null}
          {!memories.isPending && rows.length === 0 ? (
            <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
              No lessons yet. Zero approved lessons is a valid state.
            </p>
          ) : null}
          {rows.length === 100 ? (
            <p className="text-sm text-muted-foreground">Showing the latest 100 records.</p>
          ) : null}
          {rows.map((memory) => {
            const source = correctionSource(memory.provenance.sourceRef);
            const pastExpiry =
              memory.expiresAt !== undefined && memory.expiresAt <= new Date().toISOString();
            return (
              <article key={memory.id} className="space-y-2 rounded-xl border p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <strong className="text-sm capitalize">
                    {pastExpiry && memory.status === "approved" ? "Expired by date" : memory.status}
                  </strong>
                  <span className="text-xs text-muted-foreground">
                    {memory.repositoryId ?? "Space-wide"} · confidence {memory.confidence}
                  </span>
                </div>
                <p className="whitespace-pre-wrap text-sm">{memory.content}</p>
                {source !== null ? (
                  <Link
                    className="text-sm underline"
                    to="/observations"
                    search={{
                      environment: environmentId ?? undefined,
                      space: memory.spaceId,
                      ...source,
                    }}
                  >
                    View evidence revision
                  </Link>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Source: {memory.provenance.sourceRef ?? "unspecified"}
                  </p>
                )}
                {memory.contradictionOf ? (
                  <p className="text-xs text-muted-foreground">
                    Conflicts with {memory.contradictionOf}
                  </p>
                ) : null}
                {memory.expiresAt ? (
                  <p className="text-xs text-muted-foreground">
                    Expires {new Date(memory.expiresAt).toLocaleDateString()}
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  {memory.status === "candidate" ? (
                    <>
                      <Button
                        disabled={busy || pastExpiry}
                        onClick={() => void decide(memory, "approve")}
                      >
                        Approve
                      </Button>
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() => void decide(memory, "reject")}
                      >
                        Reject
                      </Button>
                    </>
                  ) : null}
                  {memory.status === "approved" || memory.status === "candidate" ? (
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => void decide(memory, "expire")}
                    >
                      Expire
                    </Button>
                  ) : null}
                </div>
              </article>
            );
          })}
        </section>
      </main>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/lessons")({
  validateSearch: (search): Search => ({
    environment: typeof search.environment === "string" ? search.environment : undefined,
    space: typeof search.space === "string" ? search.space : undefined,
    observation: typeof search.observation === "string" ? search.observation : undefined,
    revision: typeof search.revision === "string" ? search.revision : undefined,
    version:
      typeof search.version === "number" &&
      Number.isSafeInteger(search.version) &&
      search.version > 0
        ? search.version
        : undefined,
  }),
  component: LessonsRouteView,
});
