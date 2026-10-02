/**
 * Settings > Connections > Publishing accounts. One row per publishing provider (YouTube,
 * Instagram) for the primary environment: connect, see which account is connected and when its
 * token expires, and disconnect. Credentials are pasted once and stay on the environment; this
 * component only ever sees the browser-safe `CommandCenterPublishConnection` summary.
 *
 * @module PublishingConnectionsSection
 */
import type {
  CommandCenterPublishConnection,
  CommandCenterPublishConnectionSetupBeginResult,
  CommandCenterPublishProvider,
  EnvironmentId,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { ExternalLinkIcon, InstagramIcon, YoutubeIcon } from "lucide-react";
import { useState } from "react";

import { commandCenterEnvironment } from "../../state/commandCenter";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatExpiresInLabel } from "../../timestampFormat";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const PROVIDER_COPY: Readonly<
  Record<
    CommandCenterPublishProvider,
    {
      readonly title: string;
      readonly description: string;
      readonly credentialLabel: string;
      readonly credentialPlaceholder: string;
      readonly icon: typeof YoutubeIcon;
    }
  >
> = {
  youtube: {
    title: "YouTube",
    description:
      "Upload finished clips and, with separate read permission, inspect YouTube Analytics.",
    credentialLabel: "Paste the final browser address",
    credentialPlaceholder: "http://127.0.0.1/oauth2/callback?code=…&state=…",
    icon: YoutubeIcon,
  },
  instagram: {
    title: "Instagram",
    description: "Publish finished clips as Reels to an Instagram professional account.",
    credentialLabel: "Long-lived access token",
    credentialPlaceholder: "IGAA…",
    icon: InstagramIcon,
  },
};

function commandErrorMessage(cause: unknown, fallback: string): string {
  if (typeof cause === "object" && cause !== null && "message" in cause) {
    const message = cause.message;
    if (typeof message === "string" && message.trim().length > 0) return message;
  }
  return fallback;
}

function connectionStatus(connection: CommandCenterPublishConnection): string {
  if (connection.state === "unavailable") return connection.detail ?? "Not available yet.";
  if (connection.state === "disconnected") return "Not connected.";
  const parts = [`Connected as ${connection.accountLabel ?? connection.accountId ?? "account"}`];
  if (connection.expiresAt !== undefined) {
    parts.push(`token ${formatExpiresInLabel(connection.expiresAt)}`);
  }
  return parts.join(" · ");
}

function PublishConnectionSetupDialog({
  session,
  busy,
  error,
  onSubmit,
  onOpenChange,
}: {
  readonly session: CommandCenterPublishConnectionSetupBeginResult | null;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onSubmit: (credential: string) => void;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const [credential, setCredential] = useState("");
  const copy = session === null ? null : PROVIDER_COPY[session.provider];
  return (
    <Dialog
      open={session !== null}
      onOpenChange={(open) => {
        if (busy) return;
        if (!open) setCredential("");
        onOpenChange(open);
      }}
    >
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Connect {copy?.title}</DialogTitle>
          <DialogDescription>
            {session?.authUrl === undefined
              ? "The token is validated with the provider and stored only on this environment. It is never shown again."
              : "Approve access in the provider tab, then paste the address the browser lands on. A page-not-found message there is expected."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-3">
            {session?.authUrl === undefined ? null : (
              <Button
                className="w-full"
                render={<a href={session.authUrl} rel="noreferrer" target="_blank" />}
                variant="outline"
              >
                <ExternalLinkIcon />
                Open {copy?.title} authorization
              </Button>
            )}
            <label className="block space-y-1.5 text-sm font-medium">
              <span>{copy?.credentialLabel}</span>
              <Textarea
                autoComplete="off"
                spellCheck={false}
                placeholder={copy?.credentialPlaceholder}
                value={credential}
                readOnly={busy}
                onChange={(event) => setCredential(event.currentTarget.value)}
              />
            </label>
            {error === null ? null : (
              <p
                className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive"
                role="alert"
              >
                {error}
              </p>
            )}
          </div>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={busy} />}>Cancel</DialogClose>
          <Button
            disabled={busy || credential.trim().length === 0}
            onClick={() => onSubmit(credential.trim())}
          >
            {busy ? <Spinner className="size-3.5" /> : null}
            {busy ? "Connecting…" : "Connect"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function PublishingConnectionsSection({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const query = useEnvironmentQuery(
    commandCenterEnvironment.publishConnections({ environmentId, input: {} }),
  );
  const begin = useAtomCommand(commandCenterEnvironment.beginPublishConnectionSetup, {
    reportFailure: false,
  });
  const complete = useAtomCommand(commandCenterEnvironment.completePublishConnectionSetup, {
    reportFailure: false,
  });
  const remove = useAtomCommand(commandCenterEnvironment.removePublishConnection, {
    reportFailure: false,
  });
  const [pendingProvider, setPendingProvider] = useState<CommandCenterPublishProvider | null>(null);
  const [session, setSession] = useState<CommandCenterPublishConnectionSetupBeginResult | null>(
    null,
  );
  const [setupError, setSetupError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{
    readonly provider: CommandCenterPublishProvider;
    readonly message: string;
  } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<CommandCenterPublishConnection | null>(null);

  const startSetup = async (provider: CommandCenterPublishProvider) => {
    setPendingProvider(provider);
    setRowError(null);
    setSetupError(null);
    const result = await begin({ environmentId, input: { provider } });
    setPendingProvider(null);
    if (result._tag === "Success") {
      setSession(result.value);
      return;
    }
    setRowError({
      provider,
      message: commandErrorMessage(
        squashAtomCommandFailure(result),
        "The connection could not be started.",
      ),
    });
  };

  const finishSetup = async (credential: string) => {
    if (session === null) return;
    setPendingProvider(session.provider);
    setSetupError(null);
    const result = await complete({
      environmentId,
      input: { sessionId: session.sessionId, credential },
    });
    setPendingProvider(null);
    if (result._tag === "Success") {
      setSession(null);
      query.refresh();
      return;
    }
    setSetupError(
      commandErrorMessage(squashAtomCommandFailure(result), "The account could not be connected."),
    );
  };

  const disconnect = async (provider: CommandCenterPublishProvider) => {
    setPendingProvider(provider);
    setRowError(null);
    const result = await remove({ environmentId, input: { provider } });
    setPendingProvider(null);
    setConfirmRemove(null);
    if (result._tag === "Success") {
      query.refresh();
      return;
    }
    setRowError({
      provider,
      message: commandErrorMessage(
        squashAtomCommandFailure(result),
        "The account could not be disconnected.",
      ),
    });
  };

  const connections = query.data?.connections ?? [];

  return (
    <SettingsSection {...searchableSetting("publishing-accounts")}>
      {query.error !== null && connections.length === 0 ? (
        <SettingsRow title="Publishing accounts" description={query.error} />
      ) : null}
      {query.isPending && connections.length === 0 ? (
        <SettingsRow title="Publishing accounts" status={<Spinner className="size-3.5" />} />
      ) : null}
      {connections.map((connection) => {
        const copy = PROVIDER_COPY[connection.provider];
        const Icon = copy.icon;
        const busy = pendingProvider === connection.provider;
        const error = rowError?.provider === connection.provider ? rowError.message : undefined;
        const warning =
          connection.state === "connected" && connection.detail !== undefined
            ? connection.detail
            : undefined;
        return (
          <SettingsRow
            key={connection.provider}
            title={
              <span className="inline-flex items-center gap-1.5">
                <Icon aria-hidden className="size-3.5" />
                {copy.title}
              </span>
            }
            description={copy.description}
            status={
              <span className="space-y-0.5">
                <span className="block">{connectionStatus(connection)}</span>
                {connection.provider === "youtube" && connection.state === "connected" ? (
                  <span className="block">
                    Analytics: {connection.analytics?.detail ?? "Permission status unavailable."}
                  </span>
                ) : null}
                {warning === undefined ? null : (
                  <span className="block text-warning-foreground">{warning}</span>
                )}
                {error === undefined ? null : (
                  <span className="block text-destructive" role="alert">
                    {error}
                  </span>
                )}
              </span>
            }
            control={
              connection.state === "connected" ? (
                <>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void startSetup(connection.provider)}
                  >
                    Reconnect
                  </Button>
                  <Button
                    size="xs"
                    variant="destructive-outline"
                    disabled={busy}
                    onClick={() => setConfirmRemove(connection)}
                  >
                    Disconnect
                  </Button>
                </>
              ) : (
                <Button
                  size="xs"
                  disabled={busy || connection.state === "unavailable"}
                  onClick={() => void startSetup(connection.provider)}
                >
                  {busy ? <Spinner className="size-3" /> : null}
                  Connect
                </Button>
              )
            }
          />
        );
      })}
      <PublishConnectionSetupDialog
        key={session?.sessionId ?? "closed"}
        session={session}
        busy={session !== null && pendingProvider === session.provider}
        error={setupError}
        onSubmit={(credential) => void finishSetup(credential)}
        onOpenChange={(open) => {
          if (!open) {
            setSession(null);
            setSetupError(null);
          }
        }}
      />
      <AlertDialog
        open={confirmRemove !== null}
        onOpenChange={(open) => {
          if (!open && pendingProvider === null) setConfirmRemove(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Disconnect {confirmRemove === null ? "" : PROVIDER_COPY[confirmRemove.provider].title}
              ?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The stored token is deleted from this environment. Clips can no longer be published to{" "}
              {confirmRemove?.accountLabel ?? "this account"} until you connect again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose
              disabled={pendingProvider !== null}
              render={<Button variant="outline" disabled={pendingProvider !== null} />}
            >
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={pendingProvider !== null}
              onClick={() => {
                if (confirmRemove !== null) void disconnect(confirmRemove.provider);
              }}
            >
              Disconnect
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsSection>
  );
}
