"use client";

import { Link } from "@tanstack/react-router";
import { useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { ChevronRightIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { commandCenterEnvironment } from "~/state/commandCenter";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

export function DigestCard({ environmentId }: { readonly environmentId: EnvironmentId | null }) {
  const digest = useEnvironmentQuery(
    environmentId === null ? null : commandCenterEnvironment.digest({ environmentId, input: {} }),
  );
  const bootstrap = useEnvironmentQuery(
    environmentId === null
      ? null
      : commandCenterEnvironment.bootstrap({ environmentId, input: {} }),
  );
  const updatePreferences = useAtomCommand(commandCenterEnvironment.updateDigestPreferences, {
    reportFailure: false,
  });
  const markViewed = useAtomCommand(commandCenterEnvironment.markDigestViewed, {
    reportFailure: false,
  });
  const [editing, setEditing] = useState(false);
  const [timezone, setTimezone] = useState("");
  const [quietStart, setQuietStart] = useState("");
  const [quietEnd, setQuietEnd] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const value = digest.data;
  const summary = digest.error
    ? "Unavailable"
    : digest.isPending && !value
      ? "Loading…"
      : value?.notification === "quiet-hours"
        ? "Quiet hours"
        : value?.notification === "empty"
          ? "No actionable changes"
          : value?.snapshot
            ? `${value.snapshot.items.length}${value.truncated ? "+" : ""} actionable`
            : "Actionable changes across your Spaces";

  return (
    <details
      aria-labelledby="daily-digest-heading"
      className="group max-h-[min(24rem,40vh)] overflow-y-auto rounded-lg border border-border/70 bg-card/45"
    >
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        <span id="daily-digest-heading" className="font-medium">
          Daily digest
        </span>
        <span className="min-w-0 truncate text-xs text-muted-foreground">{summary}</span>
        <ChevronRightIcon
          aria-hidden="true"
          className="ml-auto size-4 shrink-0 text-muted-foreground group-open:rotate-90"
        />
      </summary>
      <div className="border-t border-border/60 px-3 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            {value
              ? `${value.period.localDate} · ${value.preferences.timezone}`
              : "Actionable changes across your Spaces"}
          </p>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={digest.refresh}>
              Refresh
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                if (!value) return;
                setTimezone(value.preferences.timezone);
                setQuietStart(value.preferences.quietStart ?? "");
                setQuietEnd(value.preferences.quietEnd ?? "");
                setError(null);
                setEditing((wasEditing) => !wasEditing);
              }}
              disabled={!value}
            >
              Preferences
            </Button>
          </div>
        </div>
        {digest.error ? (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {digest.error}
          </p>
        ) : null}
        {environmentId === null ? (
          <p className="mt-3 text-sm text-muted-foreground">
            Connect an environment to see your digest.
          </p>
        ) : null}
        {digest.isPending && !value ? (
          <p className="mt-3 text-sm text-muted-foreground">Loading digest…</p>
        ) : null}
        {value?.notification === "quiet-hours" ? (
          <p className="mt-3 text-sm text-muted-foreground">
            Quiet hours are active. New changes will appear after they end.
          </p>
        ) : null}
        {value?.notification === "empty" ? (
          <p className="mt-3 text-sm text-muted-foreground">
            No actionable Inbox changes in this local day.
          </p>
        ) : null}
        {value?.snapshot ? (
          <>
            {value.truncated ? (
              <p className="mt-3 text-sm text-muted-foreground">
                Showing {value.snapshot.items.length} of {value.totalCount} actionable changes. Open
                Inbox to see the rest.
              </p>
            ) : null}
            <ul className="mt-3 space-y-2">
              {value.snapshot.items.map((item) => (
                <li
                  key={`${item.spaceId}:${item.itemId}`}
                  className="rounded-lg border border-border/70 px-3 py-2"
                >
                  <Link
                    className="block min-w-0 hover:underline"
                    to="/inbox"
                    search={{
                      tab: "actionable",
                      environment: environmentId ?? undefined,
                      space: item.spaceId,
                      item: item.itemId,
                    }}
                  >
                    <span className="block truncate text-sm font-medium">{item.title}</span>
                    <span className="text-xs text-muted-foreground">
                      {bootstrap.data?.spaces.find((space) => space.id === item.spaceId)
                        ?.displayName ?? item.spaceId}{" "}
                      · {item.kind} · {item.status}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <span>
                {value.snapshot.viewedAt
                  ? `Viewed ${new Date(value.snapshot.viewedAt).toLocaleString(undefined, { timeZone: value.preferences.timezone })}`
                  : "New digest"}
              </span>
              {value.snapshot.supersedesId ? <span>Updated since your previous digest</span> : null}
              {!value.snapshot.viewedAt && environmentId ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    void markViewed({
                      environmentId,
                      input: { snapshotId: value.snapshot!.id },
                    }).then((result) => {
                      if (result._tag !== "Success")
                        setError(String(squashAtomCommandFailure(result)));
                      else digest.refresh();
                    });
                  }}
                >
                  Mark viewed
                </Button>
              ) : null}
            </div>
          </>
        ) : null}
        {editing && value && environmentId ? (
          <form
            className="mt-4 grid gap-3 border-t border-border pt-4 sm:grid-cols-3"
            onSubmit={(event) => {
              event.preventDefault();
              if ((quietStart === "") !== (quietEnd === "")) {
                setError("Set both quiet-hour times, or leave both blank.");
                return;
              }
              setSaving(true);
              setError(null);
              void updatePreferences({
                environmentId,
                input: {
                  expectedVersion: value.preferences.version,
                  timezone,
                  quietStart: quietStart || null,
                  quietEnd: quietEnd || null,
                },
              }).then((result) => {
                setSaving(false);
                if (result._tag !== "Success") setError(String(squashAtomCommandFailure(result)));
                else {
                  setEditing(false);
                  digest.refresh();
                }
              });
            }}
          >
            <label className="grid gap-1 text-sm">
              Time zone
              <Input
                required
                value={timezone}
                onChange={(event) => setTimezone(event.target.value)}
                placeholder="America/New_York"
              />
            </label>
            <label className="grid gap-1 text-sm">
              Quiet from
              <Input
                type="time"
                value={quietStart}
                onChange={(event) => setQuietStart(event.target.value)}
              />
            </label>
            <label className="grid gap-1 text-sm">
              Quiet until
              <Input
                type="time"
                value={quietEnd}
                onChange={(event) => setQuietEnd(event.target.value)}
              />
            </label>
            <p className="text-sm text-muted-foreground sm:col-span-3">
              Times use the time zone above. Leave both quiet-hour fields blank to turn quiet hours
              off.
            </p>
            <div className="sm:col-span-3">
              <Button size="sm" type="submit" disabled={saving}>
                {saving ? "Saving…" : "Save preferences"}
              </Button>
            </div>
          </form>
        ) : null}
        {error ? (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </details>
  );
}
