import type {
  EnvironmentId,
  HostDiskConsumer,
  HostDiskScan,
  HostFilesystemUsage,
  HostUsageOwner,
  HostUsageProcess,
  HostUsageSnapshot,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangleIcon,
  CpuIcon,
  FolderSearchIcon,
  GaugeIcon,
  HardDriveIcon,
  InfoIcon,
  MemoryStickIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useRelativeTimeTick } from "../settings/settingsLayout";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { MiddleTruncate } from "../ui/middle-truncate";
import { RefreshIcon } from "../ui/refresh-icon";
import { ScrollArea } from "../ui/scroll-area";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  RESOURCES_POLL_INTERVAL_MS,
  consumerName,
  consumerPathParts,
  consumerReclaimState,
  diskFillSummary,
  diskLevelLabel,
  diskUsedFraction,
  estimateHostNow,
  filesystemRoleLabel,
  formatByteRate,
  formatBytes,
  formatCpuPercent,
  formatHostCpu,
  formatRelativeAge,
  formatRunningFor,
  hoardingReasonLabel,
  reclaimPolicySummary,
  scanStatusLabel,
  sortConsumersBySize,
  utilizationTone,
  type UtilizationTone,
} from "./resourcesPane.logic";

/** Enough rows to show where the space went without burying the page under a long tail. */
const CONSUMER_PREVIEW_COUNT = 25;

/**
 * Re-reads host usage while the pane is open. Skips a tick while a read is still in flight, since
 * a refresh replaces the request and a slow host would otherwise never finish one, and pauses while
 * the window is hidden.
 */
function useHostUsagePolling(refresh: () => void, isPending: boolean) {
  const poll = useEffectEvent(() => {
    if (document.visibilityState !== "visible" || isPending) return;
    refresh();
  });
  useEffect(() => {
    if (typeof document === "undefined") return;
    const tick = () => poll();
    const timer = setInterval(tick, RESOURCES_POLL_INTERVAL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);
}

/** Truncated text that shows its full value on hover. */
function HoverText({ text, children }: { text: string; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipPopup side="top" className="max-w-[min(40rem,90vw)] break-all">
        {text}
      </TooltipPopup>
    </Tooltip>
  );
}

function commandErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

function Section({
  title,
  icon,
  action,
  children,
}: {
  title: string;
  icon: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2.5">
      <div className="flex min-h-7 flex-wrap items-center justify-between gap-x-4 gap-y-1 px-1">
        <h2 className="flex min-h-7 items-center gap-2 text-sm font-normal text-foreground/70">
          {icon}
          {title}
        </h2>
        {action ? <div className="flex min-w-0 items-center gap-2">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

const CARD_CLASS = "overflow-hidden rounded-2xl border border-border/70 bg-card shadow-xs/5";

function StatTile({
  icon,
  label,
  value,
  detail,
  tone = "default",
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail?: string | undefined;
  tone?: UtilizationTone;
}) {
  return (
    <div className="min-w-0 px-4 py-4 sm:px-5">
      <div className="flex items-center gap-2 text-3xs font-semibold uppercase tracking-widest text-muted-foreground/70">
        <span className="text-muted-foreground/55">{icon}</span>
        <span className="truncate">{label}</span>
      </div>
      <div
        className={cn(
          "mt-2.5 truncate font-mono text-2xl font-semibold tracking-tighter tabular-nums text-foreground",
          tone === "warning" && "text-warning-foreground",
          tone === "danger" && "text-destructive",
        )}
      >
        {value}
      </div>
      {detail ? (
        <div className="mt-1.5 truncate text-2xs text-muted-foreground/80">{detail}</div>
      ) : null}
    </div>
  );
}

function HostSummary({ snapshot }: { snapshot: HostUsageSnapshot }) {
  const { host } = snapshot;
  const usedMemory = Math.max(0, host.totalMemoryBytes - host.availableMemoryBytes);
  const memoryFraction = host.totalMemoryBytes > 0 ? usedMemory / host.totalMemoryBytes : null;
  const fullest = snapshot.filesystems.reduce<HostFilesystemUsage | null>(
    (current, filesystem) =>
      current === null || diskUsedFraction(filesystem) > diskUsedFraction(current)
        ? filesystem
        : current,
    null,
  );
  const fullestFraction = fullest === null ? null : diskUsedFraction(fullest);
  const flagged = snapshot.processes.filter((process) => process.reasons.length > 0).length;
  return (
    <div className={CARD_CLASS}>
      <div className="grid grid-cols-2 divide-x divide-y divide-border/55 md:grid-cols-4 md:divide-y-0">
        <StatTile
          icon={<CpuIcon className="size-3.5" />}
          label="CPU"
          value={formatHostCpu(host.cpuUtilization)}
          detail={`${host.cpuCount} ${host.cpuCount === 1 ? "core" : "cores"}`}
          tone={utilizationTone(host.cpuUtilization)}
        />
        <StatTile
          icon={<MemoryStickIcon className="size-3.5" />}
          label="Memory"
          value={formatBytes(usedMemory)}
          detail={`of ${formatBytes(host.totalMemoryBytes)}${
            memoryFraction === null ? "" : ` · ${Math.round(memoryFraction * 100)}% used`
          }`}
          tone={utilizationTone(memoryFraction)}
        />
        <StatTile
          icon={<HardDriveIcon className="size-3.5" />}
          label="Fullest disk"
          value={fullestFraction === null ? "—" : `${Math.round(fullestFraction * 100)}%`}
          detail={fullest?.mountPoint}
          tone={
            fullest === null
              ? "default"
              : fullest.level === "critical"
                ? "danger"
                : fullest.level === "warning"
                  ? "warning"
                  : "default"
          }
        />
        <StatTile
          icon={<GaugeIcon className="size-3.5" />}
          label="Resource hogs"
          value={snapshot.processesSupported ? String(flagged) : "—"}
          detail={
            snapshot.processesSupported
              ? `${flagged === 1 ? "process" : "processes"} flagged`
              : "Linux hosts only"
          }
          tone={flagged > 0 ? "warning" : "default"}
        />
      </div>
    </div>
  );
}

function DiskCard({ filesystem }: { filesystem: HostFilesystemUsage }) {
  const fraction = diskUsedFraction(filesystem);
  const percent = Math.round(fraction * 100);
  const fill = diskFillSummary(filesystem);
  return (
    <div
      className={cn(
        "min-w-0 rounded-2xl border bg-card px-4 py-4 shadow-xs/5 sm:px-5",
        filesystem.level === "critical" && "border-destructive/40",
        filesystem.level === "warning" && "border-warning/40",
        filesystem.level === "ok" && "border-border/70",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 font-mono text-sm font-semibold text-foreground">
            <MiddleTruncate value={filesystem.mountPoint} />
          </div>
          <div className="mt-0.5 flex min-w-0 text-2xs text-muted-foreground/70">
            <MiddleTruncate value={`${filesystem.device} · ${filesystem.fsType}`} />
          </div>
        </div>
        {filesystem.level === "ok" ? null : (
          <Badge variant={filesystem.level === "critical" ? "error" : "warning"}>
            <AlertTriangleIcon />
            {diskLevelLabel(filesystem.level)}
          </Badge>
        )}
      </div>
      {filesystem.roles.length > 0 ? (
        <div className="mt-2.5 flex flex-wrap gap-1">
          {filesystem.roles.map((role) => (
            <Badge key={role} variant="secondary">
              {filesystemRoleLabel(role)}
            </Badge>
          ))}
        </div>
      ) : null}
      <div
        className="mt-3.5 h-2 overflow-hidden rounded-full bg-muted"
        role="meter"
        aria-label={`${filesystem.mountPoint} used`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-500",
            filesystem.level === "critical" && "bg-destructive",
            filesystem.level === "warning" && "bg-warning",
            filesystem.level === "ok" && "bg-success/80",
          )}
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="mt-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-xs">
        <span className="text-muted-foreground">
          <span className="font-mono tabular-nums text-foreground/90">
            {formatBytes(filesystem.availableBytes)}
          </span>{" "}
          free of{" "}
          <span className="font-mono tabular-nums">{formatBytes(filesystem.totalBytes)}</span>
        </span>
        <span className="font-mono tabular-nums text-muted-foreground">{percent}% used</span>
      </div>
      {fill ? (
        <div
          className={cn(
            "mt-1.5 text-2xs",
            filesystem.level === "ok" ? "text-muted-foreground" : "text-warning-foreground",
          )}
        >
          {fill}
        </div>
      ) : null}
    </div>
  );
}

function OwnerCell({
  environmentId,
  owner,
}: {
  environmentId: EnvironmentId;
  owner: HostUsageOwner | null;
}) {
  if (owner === null) return <span className="text-muted-foreground/45">—</span>;
  if (owner.threadId !== null) {
    const title = owner.threadTitle ?? "Untitled thread";
    return (
      <div className="min-w-0">
        <HoverText text={title}>
          <Link
            to="/$environmentId/$threadId"
            params={{ environmentId, threadId: owner.threadId }}
            className="block truncate text-foreground underline-offset-2 hover:underline"
          >
            {title}
          </Link>
        </HoverText>
        <HoverText text={owner.projectTitle}>
          <div className="truncate text-2xs text-muted-foreground/80">{owner.projectTitle}</div>
        </HoverText>
      </div>
    );
  }
  return (
    <HoverText text={owner.projectTitle}>
      <span className="block truncate text-foreground/85">{owner.projectTitle}</span>
    </HoverText>
  );
}

function ProcessesTable({
  environmentId,
  snapshot,
  now,
}: {
  environmentId: EnvironmentId;
  snapshot: HostUsageSnapshot;
  now: number;
}) {
  if (!snapshot.processesSupported) {
    return (
      <div className={cn(CARD_CLASS, "px-4 py-5 text-xs text-muted-foreground sm:px-5")}>
        Per-process data is only available on Linux hosts.
      </div>
    );
  }
  return (
    <div className={CARD_CLASS}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[960px] table-fixed text-left text-xs">
          <colgroup>
            <col className="w-[24%]" />
            <col className="w-[8%]" />
            <col className="w-[16%]" />
            <col className="w-[7%]" />
            <col className="w-[9%]" />
            <col className="w-[9%]" />
            <col className="w-[9%]" />
            <col className="w-[18%]" />
          </colgroup>
          <thead className="border-b border-border/60 text-3xs uppercase tracking-widest text-muted-foreground/65">
            <tr>
              <th className="px-4 py-2 font-semibold sm:pl-5">Process</th>
              <th className="px-3 py-2 font-semibold">User</th>
              <th className="px-3 py-2 font-semibold">Owner</th>
              <th className="px-3 py-2 text-right font-semibold">CPU</th>
              <th className="px-3 py-2 text-right font-semibold">Memory</th>
              <th className="px-3 py-2 text-right font-semibold">Writes</th>
              <th className="px-3 py-2 text-right font-semibold">Running</th>
              <th className="px-3 py-2 font-semibold sm:pr-5">Flags</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {snapshot.processes.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-5 text-xs text-muted-foreground sm:px-5">
                  No processes sampled yet.
                </td>
              </tr>
            ) : null}
            {snapshot.processes.map((process) => (
              <ProcessRow
                key={`${process.pid}:${process.startedAt}`}
                environmentId={environmentId}
                process={process}
                now={now}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ProcessRow({
  environmentId,
  process,
  now,
}: {
  environmentId: EnvironmentId;
  process: HostUsageProcess;
  now: number;
}) {
  const flagged = process.reasons.length > 0;
  return (
    <tr className={cn(flagged ? "bg-warning/5 hover:bg-warning/10" : "hover:bg-muted/20")}>
      <td className="px-4 py-2 align-top sm:pl-5">
        <div className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate font-medium text-foreground">{process.name}</span>
          <span className="shrink-0 font-mono text-2xs tabular-nums text-muted-foreground/70">
            {process.pid}
          </span>
        </div>
        <Tooltip>
          <TooltipTrigger
            render={
              <div className="truncate font-mono text-2xs text-muted-foreground/80">
                {process.command || process.name}
              </div>
            }
          />
          <TooltipPopup side="top" variant="code" className="max-w-[min(48rem,90vw)] break-all">
            {process.command || process.name}
          </TooltipPopup>
        </Tooltip>
        {/* Narrow screens scroll the table sideways; keep the heavy numbers in view. */}
        <div className="mt-0.5 font-mono text-2xs tabular-nums text-muted-foreground sm:hidden">
          {formatCpuPercent(process.cpuPercent)} CPU · {formatBytes(process.residentBytes)}
        </div>
      </td>
      <td className="truncate px-3 py-2 align-top text-muted-foreground">{process.user}</td>
      <td className="px-3 py-2 align-top">
        <OwnerCell environmentId={environmentId} owner={process.owner} />
      </td>
      <td
        className={cn(
          "px-3 py-2 text-right align-top font-mono tabular-nums",
          process.reasons.includes("cpu") && "text-warning-foreground",
        )}
      >
        {formatCpuPercent(process.cpuPercent)}
      </td>
      <td
        className={cn(
          "px-3 py-2 text-right align-top font-mono tabular-nums",
          process.reasons.includes("memory") && "text-warning-foreground",
        )}
      >
        {formatBytes(process.residentBytes)}
      </td>
      <td
        className={cn(
          "px-3 py-2 text-right align-top font-mono tabular-nums",
          process.ioWriteBytesPerSecond === null && "text-muted-foreground/45",
          process.reasons.includes("disk-write") && "text-warning-foreground",
        )}
      >
        {formatByteRate(process.ioWriteBytesPerSecond)}
      </td>
      <td
        className={cn(
          "px-3 py-2 text-right align-top font-mono tabular-nums text-muted-foreground",
          process.reasons.includes("long-running") && "text-warning-foreground",
        )}
      >
        {formatRunningFor(process.startedAt, now)}
      </td>
      <td className="px-3 py-2 align-top sm:pr-5">
        {flagged ? (
          <div className="flex flex-wrap gap-1">
            {process.reasons.map((reason) => (
              <Badge key={reason} variant="warning">
                {hoardingReasonLabel(reason)}
              </Badge>
            ))}
          </div>
        ) : (
          <span className="text-muted-foreground/45">—</span>
        )}
      </td>
    </tr>
  );
}

function ConsumerPath({ consumer }: { consumer: HostDiskConsumer }) {
  const { prefix, relative } = consumerPathParts(consumer);
  return (
    <HoverText text={consumer.path}>
      {/* The root gives way first: the directory's own name is what tells rows apart. */}
      <div className="flex min-w-0 font-mono text-xs">
        {prefix ? (
          <span className="min-w-0 shrink-[999] truncate text-muted-foreground/55">{prefix}</span>
        ) : null}
        <span className="min-w-0 truncate font-medium text-foreground">{relative}</span>
      </div>
    </HoverText>
  );
}

function ReclaimCell({
  consumer,
  reclaiming,
  onReclaim,
}: {
  consumer: HostDiskConsumer;
  reclaiming: boolean;
  onReclaim: (consumer: HostDiskConsumer) => void;
}) {
  const state = consumerReclaimState(consumer);
  if (state.kind === "unavailable") return <span className="text-muted-foreground/45">—</span>;
  if (reclaiming) {
    return (
      <Button size="xs" variant="outline" disabled>
        <Spinner />
        Reclaiming…
      </Button>
    );
  }
  if (state.kind === "blocked") {
    return (
      <div className="flex flex-col items-end gap-0.5">
        <Button size="xs" variant="outline" disabled>
          Reclaim
        </Button>
        <span className="text-right text-2xs text-muted-foreground/80">{state.reason}</span>
      </div>
    );
  }
  return (
    <Button size="xs" variant="outline" onClick={() => onReclaim(consumer)}>
      Reclaim
    </Button>
  );
}

function ConsumersTable({
  environmentId,
  consumers,
  now,
  reclaimingPaths,
  onReclaim,
}: {
  environmentId: EnvironmentId;
  consumers: ReadonlyArray<HostDiskConsumer>;
  now: number;
  reclaimingPaths: ReadonlySet<string>;
  onReclaim: (consumer: HostDiskConsumer) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? consumers : consumers.slice(0, CONSUMER_PREVIEW_COUNT);
  return (
    <>
      <div className="overflow-x-auto border-t border-border/60">
        <table className="w-full min-w-[900px] table-fixed text-left text-xs">
          <colgroup>
            <col className="w-[36%]" />
            <col className="w-[10%]" />
            <col className="w-[11%]" />
            <col className="w-[11%]" />
            <col className="w-[18%]" />
            <col className="w-[14%]" />
          </colgroup>
          <thead className="border-b border-border/60 text-3xs uppercase tracking-widest text-muted-foreground/65">
            <tr>
              <th className="px-4 py-2 font-semibold sm:pl-5">Directory</th>
              <th className="px-3 py-2 text-right font-semibold">Size</th>
              <th className="px-3 py-2 text-right font-semibold">Build output</th>
              <th className="px-3 py-2 text-right font-semibold">Last activity</th>
              <th className="px-3 py-2 font-semibold">Owner</th>
              <th className="px-3 py-2 text-right font-semibold sm:pr-5">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {visible.map((consumer) => (
              <tr key={consumer.path} className="hover:bg-muted/20">
                <td className="px-4 py-2 align-top sm:pl-5">
                  <ConsumerPath consumer={consumer} />
                  {/* Narrow screens scroll the table sideways; keep the sizes in view. */}
                  <div className="mt-0.5 font-mono text-2xs tabular-nums text-muted-foreground sm:hidden">
                    {formatBytes(consumer.bytes)}
                    {consumer.artifactBytes > 0
                      ? ` · ${formatBytes(consumer.artifactBytes)} build output`
                      : ""}
                  </div>
                  {!consumer.isCheckout && consumer.largestChildren.length > 0 ? (
                    <HoverText
                      text={consumer.largestChildren
                        .map((child) => `${child.name} ${formatBytes(child.bytes)}`)
                        .join(" · ")}
                    >
                      <div className="mt-0.5 truncate text-2xs text-muted-foreground/80">
                        {consumer.largestChildren.map((child, index) => (
                          <span key={child.name}>
                            {index > 0 ? " · " : null}
                            <span className="font-mono">{child.name}</span>{" "}
                            <span className="tabular-nums">{formatBytes(child.bytes)}</span>
                          </span>
                        ))}
                      </div>
                    </HoverText>
                  ) : null}
                </td>
                <td className="px-3 py-2 text-right align-top font-mono font-medium tabular-nums">
                  {formatBytes(consumer.bytes)}
                </td>
                <td
                  className={cn(
                    "px-3 py-2 text-right align-top font-mono tabular-nums",
                    consumer.artifactBytes > 0 ? "text-foreground/85" : "text-muted-foreground/45",
                  )}
                >
                  {consumer.artifactBytes > 0 ? formatBytes(consumer.artifactBytes) : "—"}
                </td>
                <td className="px-3 py-2 text-right align-top text-muted-foreground">
                  {consumer.lastActivityAt === null
                    ? "—"
                    : formatRelativeAge(consumer.lastActivityAt, now)}
                </td>
                <td className="px-3 py-2 align-top">
                  <OwnerCell environmentId={environmentId} owner={consumer.owner} />
                </td>
                <td className="px-3 py-2 text-right align-top sm:pr-5">
                  <ReclaimCell
                    consumer={consumer}
                    reclaiming={reclaimingPaths.has(consumer.path)}
                    onReclaim={onReclaim}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {consumers.length > CONSUMER_PREVIEW_COUNT ? (
        <div className="border-t border-border/60 px-4 py-2 sm:px-5">
          <Button size="xs" variant="ghost" onClick={() => setShowAll((current) => !current)}>
            {showAll ? "Show fewer" : `Show all ${consumers.length} directories`}
          </Button>
        </div>
      ) : null}
    </>
  );
}

function DiskScanBody({
  environmentId,
  scan,
  now,
  reclaimingPaths,
  onReclaim,
}: {
  environmentId: EnvironmentId;
  scan: HostDiskScan;
  now: number;
  reclaimingPaths: ReadonlySet<string>;
  onReclaim: (consumer: HostDiskConsumer) => void;
}) {
  const consumers = useMemo(() => sortConsumersBySize(scan.consumers), [scan.consumers]);
  return (
    <div className={CARD_CLASS}>
      <div
        className={cn(
          "flex items-center gap-2 px-4 py-3 text-xs sm:px-5",
          scan.status === "failed" ? "text-destructive" : "text-muted-foreground",
        )}
        aria-live="polite"
      >
        {scan.status === "running" ? <Spinner size="sm" /> : null}
        {scan.status === "failed" ? <AlertTriangleIcon className="size-3.5 shrink-0" /> : null}
        <span>{scanStatusLabel(scan, now)}</span>
      </div>
      {scan.errors.length > 0 ? (
        <ul className="space-y-1 border-t border-destructive/20 bg-destructive/5 px-4 py-3 text-xs text-destructive sm:px-5">
          {scan.errors.map((error) => (
            <li key={`${error.root}:${error.message}`} className="flex min-w-0 gap-2">
              <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
              <span className="min-w-0 break-words">
                <span className="font-mono">{error.root}</span>: {error.message}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {scan.roots.length > 0 ? (
        <div className="grid gap-x-6 gap-y-1.5 border-t border-border/60 bg-muted/10 px-4 py-3 sm:grid-cols-2 sm:px-5">
          {scan.roots.map((root) => (
            <div key={root.path} className="flex min-w-0 items-baseline justify-between gap-3">
              <span className="flex min-w-0 font-mono text-xs text-foreground/85">
                <MiddleTruncate value={root.path} />
              </span>
              <span className="shrink-0 font-mono text-xs font-medium tabular-nums">
                {formatBytes(root.bytes)}
              </span>
            </div>
          ))}
        </div>
      ) : null}
      {consumers.length > 0 ? (
        <ConsumersTable
          environmentId={environmentId}
          consumers={consumers}
          now={now}
          reclaimingPaths={reclaimingPaths}
          onReclaim={onReclaim}
        />
      ) : scan.status === "never" ? (
        <div className="border-t border-border/60 px-4 py-5 text-xs text-muted-foreground sm:px-5">
          Scan to see which directories hold the most space and how much of it is build output.
        </div>
      ) : scan.status === "complete" ? (
        <div className="border-t border-border/60 px-4 py-5 text-xs text-muted-foreground sm:px-5">
          The last scan found no directories under the scan roots.
        </div>
      ) : null}
    </div>
  );
}

function ReclaimPolicyNote({ snapshot, now }: { snapshot: HostUsageSnapshot; now: number }) {
  const summary = reclaimPolicySummary(snapshot, now);
  return (
    <div className="flex items-start gap-2 px-1 text-2xs leading-relaxed text-muted-foreground">
      <InfoIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/70" />
      <div className="space-y-0.5">
        <p>{summary.policy}</p>
        {summary.lastRun ? <p>{summary.lastRun}</p> : null}
      </div>
    </div>
  );
}

function ReclaimDialog({
  consumer,
  open,
  onOpenChange,
  onClosed,
  onConfirm,
}: {
  consumer: HostDiskConsumer | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onClosed: () => void;
  onConfirm: (consumer: HostDiskConsumer) => void;
}) {
  return (
    <AlertDialog
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={(nextOpen) => {
        if (!nextOpen) onClosed();
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Reclaim build output from {consumer ? consumerName(consumer.path) : "this checkout"}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            This deletes regenerable build output (node_modules, target, .next, …) inside{" "}
            <span className="break-all font-mono text-foreground/85">{consumer?.path}</span>
            {consumer && consumer.artifactBytes > 0
              ? `, about ${formatBytes(consumer.artifactBytes)}`
              : ""}
            . Only build output is removed. The project must reinstall its dependencies or rebuild
            before its next use.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
          <Button
            variant="destructive"
            disabled={consumer === null}
            onClick={() => {
              if (consumer) onConfirm(consumer);
            }}
          >
            Reclaim
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

export interface ResourcesPaneViewProps {
  readonly environmentId: EnvironmentId;
  readonly environmentOptions: ReadonlyArray<{
    readonly id: EnvironmentId;
    readonly label: string;
  }>;
  readonly onEnvironmentChange: (environmentId: EnvironmentId) => void;
  readonly snapshot: HostUsageSnapshot | null;
  readonly error: string | null;
  readonly isRefreshing: boolean;
  readonly onRefresh: () => void;
  /** The host's clock, which every timestamp in the snapshot is measured against. */
  readonly now: number;
  readonly isStartingScan: boolean;
  readonly onScan: () => void;
  readonly reclaimingPaths: ReadonlySet<string>;
  /** Runs after the user confirms; the confirmation dialog is the view's own. */
  readonly onReclaim: (consumer: HostDiskConsumer) => void;
}

/** Everything the pane shows for one snapshot. Data and commands stay with the caller. */
export function ResourcesPaneView({
  environmentId,
  environmentOptions,
  onEnvironmentChange,
  snapshot,
  error,
  isRefreshing,
  onRefresh,
  now,
  isStartingScan,
  onScan,
  reclaimingPaths,
  onReclaim,
}: ResourcesPaneViewProps) {
  const [reclaimTarget, setReclaimTarget] = useState<HostDiskConsumer | null>(null);
  const [reclaimDialogOpen, setReclaimDialogOpen] = useState(false);
  const openReclaimDialog = useCallback((consumer: HostDiskConsumer) => {
    setReclaimTarget(consumer);
    setReclaimDialogOpen(true);
  }, []);
  const confirmReclaim = useCallback(
    (consumer: HostDiskConsumer) => {
      setReclaimDialogOpen(false);
      onReclaim(consumer);
    },
    [onReclaim],
  );
  const scanRunning = snapshot?.scan.status === "running";

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
      <WorkspacePageHeader
        electron={isElectron}
        className="border-b border-border/60 bg-background"
      >
        <div className="flex min-w-0 items-center gap-2">
          <HardDriveIcon className="size-4 shrink-0 text-primary" />
          <h1 className="truncate text-sm font-semibold">Resources</h1>
        </div>
        <div className="ml-auto flex min-w-0 items-center gap-2">
          {snapshot ? (
            <span className="hidden truncate text-2xs text-muted-foreground/60 sm:inline">
              Updated {formatRelativeAge(snapshot.sampledAt, now)}
            </span>
          ) : null}
          {environmentOptions.length > 1 ? (
            <>
              <label className="sr-only" htmlFor="resources-environment">
                Environment
              </label>
              <select
                className="h-8 min-w-0 max-w-44 rounded-md border border-input bg-background px-2 text-xs"
                id="resources-environment"
                onChange={(event) => onEnvironmentChange(event.target.value as EnvironmentId)}
                value={environmentId}
              >
                {environmentOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </>
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  disabled={isRefreshing}
                  onClick={onRefresh}
                  aria-label="Refresh resource usage"
                >
                  <RefreshIcon size="xs" refreshing={isRefreshing} />
                </Button>
              }
            />
            <TooltipPopup side="bottom">Refresh now</TooltipPopup>
          </Tooltip>
        </div>
      </WorkspacePageHeader>

      <ScrollArea className="min-h-0 flex-1">
        <WorkspacePageContainer width="expanded" className="gap-7">
          {error ? (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-xl border border-destructive/25 bg-destructive/5 px-4 py-3 text-xs text-destructive"
            >
              <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 break-words">
                {snapshot ? "Showing the last reading. " : "Could not read resource usage. "}
                {error}
              </span>
              {snapshot ? null : (
                <Button size="xs" variant="outline" onClick={onRefresh}>
                  Retry
                </Button>
              )}
            </div>
          ) : null}

          {snapshot === null ? (
            error ? null : (
              <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
                <Spinner size="md" />
                Reading resource usage…
              </div>
            )
          ) : (
            <>
              <HostSummary snapshot={snapshot} />

              <Section
                title="Disks"
                icon={<HardDriveIcon className="size-4 text-muted-foreground" />}
              >
                {snapshot.filesystems.length === 0 ? (
                  <div
                    className={cn(CARD_CLASS, "px-4 py-5 text-xs text-muted-foreground sm:px-5")}
                  >
                    No filesystems reported.
                  </div>
                ) : (
                  <div className="grid gap-3 md:grid-cols-2">
                    {snapshot.filesystems.map((filesystem) => (
                      <DiskCard key={filesystem.mountPoint} filesystem={filesystem} />
                    ))}
                  </div>
                )}
              </Section>

              <Section
                title="Resource hogs"
                icon={<GaugeIcon className="size-4 text-muted-foreground" />}
                action={
                  <span className="text-2xs text-muted-foreground/70">
                    Host-wide · flagged first
                  </span>
                }
              >
                <ProcessesTable environmentId={environmentId} snapshot={snapshot} now={now} />
              </Section>

              <Section
                title="Disk usage"
                icon={<FolderSearchIcon className="size-4 text-muted-foreground" />}
                action={
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={isStartingScan || scanRunning}
                    onClick={onScan}
                  >
                    <RefreshIcon size="xs" refreshing={isStartingScan || scanRunning} />
                    {scanRunning ? "Scanning…" : "Scan now"}
                  </Button>
                }
              >
                <DiskScanBody
                  environmentId={environmentId}
                  scan={snapshot.scan}
                  now={now}
                  reclaimingPaths={reclaimingPaths}
                  onReclaim={openReclaimDialog}
                />
              </Section>

              <ReclaimPolicyNote snapshot={snapshot} now={now} />
            </>
          )}
        </WorkspacePageContainer>
      </ScrollArea>

      <ReclaimDialog
        consumer={reclaimTarget}
        open={reclaimDialogOpen}
        onOpenChange={setReclaimDialogOpen}
        onClosed={() => setReclaimTarget(null)}
        onConfirm={confirmReclaim}
      />
    </div>
  );
}

export function ResourcesPane({
  environmentId,
  environmentOptions,
  onEnvironmentChange,
}: {
  environmentId: EnvironmentId;
  environmentOptions: ReadonlyArray<{ readonly id: EnvironmentId; readonly label: string }>;
  onEnvironmentChange: (environmentId: EnvironmentId) => void;
}) {
  const hostUsage = useEnvironmentQuery(serverEnvironment.hostUsage({ environmentId, input: {} }));
  const refreshHostUsage = hostUsage.refresh;
  useHostUsagePolling(refreshHostUsage, hostUsage.isPending);
  const localNow = useRelativeTimeTick(RESOURCES_POLL_INTERVAL_MS);
  const snapshot = hostUsage.data;
  const now =
    snapshot === null
      ? localNow
      : estimateHostNow({
          sampledAt: snapshot.sampledAt,
          receivedAt: hostUsage.dataUpdatedAt,
          localNow,
        });

  const scanCommand = useAtomCommand(serverEnvironment.scanHostDiskUsage, {
    reportFailure: false,
  });
  const reclaimCommand = useAtomCommand(serverEnvironment.reclaimHostDiskArtifacts, {
    reportFailure: false,
  });
  const [isStartingScan, setIsStartingScan] = useState(false);
  const [reclaimingPaths, setReclaimingPaths] = useState<ReadonlySet<string>>(() => new Set());

  const startScan = useCallback(() => {
    setIsStartingScan(true);
    void scanCommand({ environmentId, input: {} })
      .then((result) => {
        if (result._tag === "Failure") {
          if (isAtomCommandInterrupted(result)) return;
          throw squashAtomCommandFailure(result);
        }
      })
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Could not start disk scan",
          description: commandErrorMessage(error, "The disk scan request failed."),
        });
      })
      .finally(() => {
        setIsStartingScan(false);
        refreshHostUsage();
      });
  }, [environmentId, refreshHostUsage, scanCommand]);

  const reclaim = useCallback(
    (consumer: HostDiskConsumer) => {
      const name = consumerName(consumer.path);
      setReclaimingPaths((current) => new Set(current).add(consumer.path));
      void reclaimCommand({ environmentId, input: { path: consumer.path } })
        .then((result) => {
          if (result._tag === "Failure") {
            if (isAtomCommandInterrupted(result)) return;
            throw squashAtomCommandFailure(result);
          }
          if (result.value.status === "reclaimed") {
            toastManager.add({
              type: "success",
              title: `Freed ${formatBytes(result.value.freedBytes)} from ${name}`,
              description:
                result.value.removed.length > 0
                  ? `Removed ${result.value.removed.map(consumerName).join(", ")}.`
                  : undefined,
            });
            return;
          }
          toastManager.add({
            type: "warning",
            title: `Did not reclaim ${name}`,
            description: result.value.message,
          });
        })
        .catch((error: unknown) => {
          toastManager.add({
            type: "error",
            title: `Could not reclaim ${name}`,
            description: commandErrorMessage(error, "The reclaim request failed."),
          });
        })
        .finally(() => {
          setReclaimingPaths((current) => {
            const next = new Set(current);
            next.delete(consumer.path);
            return next;
          });
          refreshHostUsage();
        });
    },
    [environmentId, reclaimCommand, refreshHostUsage],
  );

  return (
    <ResourcesPaneView
      environmentId={environmentId}
      environmentOptions={environmentOptions}
      onEnvironmentChange={onEnvironmentChange}
      snapshot={snapshot}
      error={hostUsage.error}
      isRefreshing={hostUsage.isPending}
      onRefresh={refreshHostUsage}
      now={now}
      isStartingScan={isStartingScan}
      onScan={startScan}
      reclaimingPaths={reclaimingPaths}
      onReclaim={reclaim}
    />
  );
}
