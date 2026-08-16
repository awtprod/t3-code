import { Button } from "../ui/button";
import { type ContextWindowSnapshot, formatContextWindowTokens } from "~/lib/contextWindow";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { formatContextWindowCompactionMessage } from "./ContextWindowMeter.logic";

function formatPercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  if (value < 10) {
    return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(value)}%`;
}

export function ContextWindowMeter(props: {
  usage: ContextWindowSnapshot;
  modelDisplayName?: string | null;
  adviceThresholdPercent?: number | null;
  toolWarningThreshold?: number | null;
}) {
  const { usage, modelDisplayName, adviceThresholdPercent, toolWarningThreshold } = props;
  const usedPercentage = formatPercentage(usage.usedPercentage);
  const normalizedPercentage = Math.max(0, Math.min(100, usage.usedPercentage ?? 0));
  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - normalizedPercentage / 100);
  const totalProcessedTokens = usage.totalProcessedTokens ?? null;
  const showTotalProcessed = totalProcessedTokens !== null && totalProcessedTokens > 0;
  const latestInput = usage.lastInputTokens ?? usage.inputTokens ?? null;
  const latestCacheRead = usage.lastCachedInputTokens ?? usage.cachedInputTokens ?? null;
  const latestCacheWrite = usage.lastCacheWriteInputTokens ?? usage.cacheWriteInputTokens ?? null;
  const latestOutput = usage.lastOutputTokens ?? usage.outputTokens ?? null;
  const cacheInputTotal =
    latestInput === null
      ? null
      : Math.max(latestInput, (latestCacheRead ?? 0) + (latestCacheWrite ?? 0));
  const cacheUtilization =
    cacheInputTotal && latestCacheRead !== null ? (latestCacheRead / cacheInputTotal) * 100 : null;
  const isOverloaded =
    normalizedPercentage >= (adviceThresholdPercent ?? 90) ||
    (toolWarningThreshold !== null &&
      toolWarningThreshold !== undefined &&
      usage.toolUses != null &&
      usage.toolUses >= toolWarningThreshold);
  const usageColor = isOverloaded
    ? "var(--color-error)"
    : "color-mix(in oklab, var(--color-muted-foreground) 72%, transparent)";

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={0}
        render={
          <Button
            size="icon-sm"
            variant="ghost-muted"
            className="size-7 rounded-full hover:text-muted-foreground data-pressed:text-muted-foreground"
            aria-label={
              usage.maxTokens !== null && usedPercentage
                ? `Context window ${usedPercentage} used`
                : `Context window ${formatContextWindowTokens(usage.usedTokens)} tokens used`
            }
          >
            <span className="relative flex size-5 items-center justify-center">
              <svg
                viewBox="0 0 24 24"
                className="-rotate-90 absolute inset-0 size-full transform-gpu"
                aria-hidden="true"
              >
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke="color-mix(in oklab, var(--color-muted-foreground) 24%, transparent)"
                  strokeWidth="3"
                />
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke={usageColor}
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={dashOffset}
                  className="transition-[stroke-dashoffset,stroke] duration-500 ease-out motion-reduce:transition-none"
                />
              </svg>
            </span>
          </Button>
        }
      />
      <PopoverPopup
        tooltipStyle
        side="top"
        align="end"
        viewportClassName="p-0"
        className="w-64 max-w-none text-left whitespace-normal"
      >
        <div className="flex flex-col gap-2 p-[var(--floating-content-inset)]">
          <div className="flex items-center justify-between gap-3">
            <div className="font-medium text-muted-foreground text-xs">Context Window</div>
            {usage.maxTokens !== null && usedPercentage ? (
              <div className="text-secondary-label text-[11px] tabular-nums">
                <span>{usedPercentage}</span>
                <span className="mx-1">·</span>
                <span>
                  {formatContextWindowTokens(usage.usedTokens)}/
                  {formatContextWindowTokens(usage.maxTokens ?? null)}
                </span>
              </div>
            ) : (
              <div className="text-secondary-label text-[11px] tabular-nums">
                {formatContextWindowTokens(usage.usedTokens)}
              </div>
            )}
          </div>
          {usage.maxTokens !== null ? (
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(normalizedPercentage)}
              aria-label="Context window usage"
            >
              <div
                className="h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none"
                style={{ width: `${normalizedPercentage}%`, backgroundColor: usageColor }}
              />
            </div>
          ) : null}
          {showTotalProcessed ? (
            <div className="flex items-center justify-between gap-3 text-[11px] leading-4">
              <span className="text-secondary-label">Total processed</span>
              <span className="font-medium tabular-nums text-secondary-label">
                {formatContextWindowTokens(totalProcessedTokens)}
              </span>
            </div>
          ) : null}
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] leading-4">
            <span className="text-muted-foreground/60">Uncached input</span>
            <span className="text-right tabular-nums text-muted-foreground/80">
              {latestInput === null
                ? "Unavailable"
                : formatContextWindowTokens(
                    Math.max(0, latestInput - (latestCacheRead ?? 0) - (latestCacheWrite ?? 0)),
                  )}
            </span>
            <span className="text-muted-foreground/60">Cache read</span>
            <span className="text-right tabular-nums text-muted-foreground/80">
              {latestCacheRead === null
                ? "Unavailable"
                : formatContextWindowTokens(latestCacheRead)}
            </span>
            <span className="text-muted-foreground/60">Cache write</span>
            <span className="text-right tabular-nums text-muted-foreground/80">
              {latestCacheWrite === null
                ? "Unavailable"
                : formatContextWindowTokens(latestCacheWrite)}
            </span>
            <span className="text-muted-foreground/60">Output</span>
            <span className="text-right tabular-nums text-muted-foreground/80">
              {latestOutput === null ? "Unavailable" : formatContextWindowTokens(latestOutput)}
            </span>
            <span className="text-muted-foreground/60">Cache utilization</span>
            <span className="text-right tabular-nums text-muted-foreground/80">
              {formatPercentage(cacheUtilization) ?? "Unavailable"}
            </span>
            <span className="text-muted-foreground/60">Cost</span>
            <span className="text-right tabular-nums text-muted-foreground/80">
              {usage.costUsd == null
                ? "Unavailable"
                : `$${usage.costUsd.toFixed(4)}${usage.costKind === "reported" ? " reported" : " est."}`}
            </span>
          </div>
          {usage.compactsAutomatically ? (
            <div className="mt-1 text-pretty text-secondary-label text-[11px] font-medium">
              {formatContextWindowCompactionMessage(modelDisplayName)}
            </div>
          ) : null}
          {adviceThresholdPercent !== null &&
          adviceThresholdPercent !== undefined &&
          normalizedPercentage >= adviceThresholdPercent ? (
            <div className="mt-1 text-pretty text-[11px] font-medium text-amber-600 dark:text-amber-400">
              This task has reached its {adviceThresholdPercent}% context guide. Compact it if the
              provider supports that, or start a new task to keep token use predictable.
            </div>
          ) : null}
          {toolWarningThreshold !== null &&
          toolWarningThreshold !== undefined &&
          usage.toolUses != null &&
          usage.toolUses >= toolWarningThreshold ? (
            <div className="text-pretty text-[11px] font-medium text-amber-600 dark:text-amber-400">
              This turn has used {usage.toolUses} tools. Consider narrowing the next request or
              starting a focused task.
            </div>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
