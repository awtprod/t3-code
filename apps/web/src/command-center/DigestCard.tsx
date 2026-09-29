"use client";

import { Link } from "@tanstack/react-router";
import { useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

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

  return (
    <section
      aria-labelledby="daily-digest-heading"
      className="rounded-xl border border-border bg-card/70 p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="daily-digest-heading" className="text-base font-semibold">
            Daily digest
          </h2>
          <p className="text-xs text-muted-foreground">
            {value
              ? `${value.period.localDate} · ${value.preferences.timezone} · for ${value.recipientSubject}`
              : "Actionable changes across your Spaces"}
          </p>
        </div>
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
    </section>
  );
}
