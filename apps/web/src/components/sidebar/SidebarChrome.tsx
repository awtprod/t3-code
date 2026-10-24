import {
  ArrowLeftIcon,
  CalendarDaysIcon,
  ChartNoAxesColumnIcon,
  CircleAlertIcon,
  CommandIcon,
  ContactRoundIcon,
  HardDriveIcon,
  InboxIcon,
  ListChecksIcon,
  ListFilterIcon,
  LightbulbIcon,
  SettingsIcon,
  SquarePenIcon,
  type LucideIcon,
  WorkflowIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { memo, useCallback } from "react";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";

import {
  useCommandCenterSidebarShortcuts,
  useEnvironmentIdentificationMode,
} from "../../hooks/useSettings";
import { APP_BASE_NAME } from "../../branding";
import { cn } from "../../lib/utils";
import { commandCenterEnvironment } from "../../state/commandCenter";
import { usePrimaryEnvironmentId, usePullRequestsSupported } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import {
  resolveEnvironmentIdentificationPillLabel,
  resolveSidebarStageBackdropVariant,
  SidebarStageBackdrop,
  useEnvironmentStageLabel,
} from "../SidebarStageBackdrop";
import { Badge } from "../ui/badge";
import {
  SidebarFooter,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import {
  type CommandCenterShortcut,
  isCommandCenterShortcutActive,
  visibleCommandCenterShortcuts,
} from "./commandCenterShortcuts";
import { isSidebarUtilityPage, useNavigateToMainApp } from "./mainAppLocation";
import { SidebarThreadUndoNotice } from "./SidebarThreadUndoNotice";
import { SidebarProviderUpdatePill } from "./SidebarProviderUpdatePill";
import { SidebarUpdateArchitectureWarning, SidebarUpdatePill } from "./SidebarUpdatePill";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { observeResize } from "~/lib/observeResize";

export const SidebarChromeHeader = memo(function SidebarChromeHeader({
  isElectron,
}: {
  isElectron: boolean;
}) {
  const stageLabel = useEnvironmentStageLabel();
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const backdropVariant = resolveSidebarStageBackdropVariant(
    stageLabel,
    environmentIdentificationMode === "artwork",
  );
  const pillLabel =
    environmentIdentificationMode === "pill"
      ? resolveEnvironmentIdentificationPillLabel(stageLabel)
      : null;

  return (
    // The titlebar row, not a padded SidebarHeader: it aligns to the window controls.
    <div
      className={cn(
        "relative flex h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center gap-2 pr-3",
        isElectron && "drag-region",
      )}
    >
      {backdropVariant ? <SidebarStageBackdrop variant={backdropVariant} /> : null}
      {/* Match the fixed control's inset and border compensation inside the sheet's safe area. */}
      <div className="relative top-[calc(var(--workspace-controls-top)-env(safe-area-inset-top))] z-10 ml-[calc(var(--workspace-controls-left)+1px-env(safe-area-inset-left))] flex shrink-0 items-center md:hidden">
        <SidebarTrigger
          // Over the stage artwork: the media viewer's control-on-imagery treatment.
          variant={backdropVariant ? "media-navigation" : "ghost"}
          className="relative top-auto translate-y-0"
          aria-label="Toggle main sidebar"
        />
      </div>
      {/* One visible line: the pill wraps onto the clipped second line once it no longer fits.
          The padding keeps the brand's focus ring inside the clip. */}
      <div className="relative z-10 flex h-8 min-w-0 flex-1 flex-wrap content-start items-center gap-x-2 overflow-hidden py-0.5">
        <SidebarBrand onBackdrop={backdropVariant !== null} />
        {pillLabel ? (
          <div className="ml-1 flex h-7 items-center">
            <Badge data-environment-identification="pill" size="sm" variant="secondary">
              {pillLabel}
            </Badge>
          </div>
        ) : null}
      </div>
    </div>
  );
});

// Measures the brand at its titlebar inset, plus the header's right padding and the
// sidebar border, so the sidebar minimum follows font size, zoom and macOS window controls.
export function SidebarBrandWidthProbe({
  onWidthChange,
}: {
  onWidthChange: (width: number) => void;
}) {
  const observeWidth = useCallback(
    (probe: HTMLDivElement) => {
      return observeResize(probe, ([entry]) => {
        if (entry) onWidthChange(entry.borderBoxSize[0]?.inlineSize ?? probe.offsetWidth);
      });
    },
    [onWidthChange],
  );

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none invisible fixed top-0 left-0 flex w-max border-r border-transparent pr-3"
      ref={observeWidth}
    >
      <div className="ml-[var(--workspace-titlebar-content-left)] flex">
        <SidebarBrandMark onBackdrop={false} />
      </div>
    </div>
  );
}

function SidebarBrand({ onBackdrop }: { onBackdrop: boolean }) {
  return (
    <Link
      aria-label="Go to Command Center"
      className={cn(
        "relative z-10 ml-[var(--workspace-titlebar-content-left)] hidden h-7 w-fit min-w-0 shrink-0 items-center overflow-hidden rounded-md outline-hidden ring-ring focus-visible:ring-2 focus-visible:ring-inset md:flex",
        onBackdrop ? "text-white" : "text-foreground",
      )}
      to="/"
    >
      <SidebarBrandMark onBackdrop={onBackdrop} />
    </Link>
  );
}

function SidebarBrandMark({ onBackdrop }: { onBackdrop: boolean }) {
  return (
    // Center the visible capitals, without the font's ascender/descender space.
    // Padding keeps ascenders and round-letter overshoot inside the truncation clip.
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5",
        onBackdrop ? "text-white" : "text-foreground",
      )}
    >
      <CommandIcon className="size-3.5 shrink-0" />
      <span className="truncate text-sm font-semibold tracking-tight [text-box:trim-both_cap_alphabetic] supports-[text-box:trim-both_cap_alphabetic]:py-1">
        {APP_BASE_NAME}
      </span>
    </span>
  );
}

function SidebarUtilityItem({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <SidebarMenuItem className="shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton aria-label={label} onClick={onClick} size="icon">
              {icon}
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}

export const SidebarUtilityMenu = memo(function SidebarUtilityMenu() {
  const navigate = useNavigate();
  const navigateToMainApp = useNavigateToMainApp();
  const { isMobile, setOpenMobile } = useSidebar();
  const isOnUtilityPage = useLocation({
    select: (location) => isSidebarUtilityPage(location.pathname),
  });
  const pullRequestsSupported = usePullRequestsSupported();
  const closeMobileSidebar = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
  }, [isMobile, setOpenMobile]);
  const handlePullRequestsClick = useCallback(() => {
    closeMobileSidebar();
    void navigate({
      to: "/pull-requests",
      search: readPullRequestListPreferences(),
    });
  }, [closeMobileSidebar, navigate]);
  const handleSettingsClick = useCallback(() => {
    closeMobileSidebar();
    void navigate({ to: "/settings" });
  }, [closeMobileSidebar, navigate]);

  const handleUsageClick = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
    void navigate({ to: "/usage" });
  }, [isMobile, navigate, setOpenMobile]);

  const handleBackClick = useCallback(() => {
    closeMobileSidebar();
    void navigateToMainApp();
  }, [closeMobileSidebar, navigateToMainApp]);

  return (
    <SidebarMenu className="flex-row items-center">
      {isOnUtilityPage ? (
        <SidebarMenuItem className="min-w-0 flex-1">
          <SidebarMenuButton onClick={handleBackClick}>
            <ArrowLeftIcon />
            <span>Back</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ) : (
        <>
          <SidebarUtilityItem
            icon={<SettingsIcon />}
            label="Settings"
            onClick={handleSettingsClick}
          />
          {pullRequestsSupported ? (
            <SidebarUtilityItem
              icon={<PullRequestGlyph.pullRequest />}
              label="Pull Requests"
              onClick={handlePullRequestsClick}
            />
          ) : null}
          <SidebarUtilityItem
            icon={<ChartNoAxesColumnIcon />}
            label="Usage"
            onClick={handleUsageClick}
          />
        </>
      )}
      <SidebarUpdatePill />
    </SidebarMenu>
  );
});

export const SidebarChromeFooter = memo(function SidebarChromeFooter() {
  return (
    <SidebarFooter>
      <SidebarThreadUndoNotice />
      <SidebarProviderUpdatePill />
      <SidebarUpdateArchitectureWarning />
      <SidebarUtilityMenu />
    </SidebarFooter>
  );
});

const SHORTCUT_ICONS: Record<CommandCenterShortcut["key"], LucideIcon> = {
  inbox: InboxIcon,
  new: SquarePenIcon,
  command: CommandIcon,
  automations: WorkflowIcon,
  responsibilities: ListChecksIcon,
  prospects: ContactRoundIcon,
  "sprint-plan": CalendarDaysIcon,
  observations: ListFilterIcon,
  lessons: LightbulbIcon,
  resources: HardDriveIcon,
};

/** Command Center-owned navigation shared by both sidebar generations. */
export const SidebarCommandCenterNavigation = memo(function SidebarCommandCenterNavigation() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const environmentId = usePrimaryEnvironmentId();
  const bootstrapQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : commandCenterEnvironment.bootstrap({ environmentId, input: {} }),
  );
  const { isMobile, setOpenMobile } = useSidebar();
  const closeMobileSidebar = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);
  const shortcuts = useCommandCenterSidebarShortcuts();
  const entries = visibleCommandCenterShortcuts(shortcuts).map((shortcut) => ({
    ...shortcut,
    icon: SHORTCUT_ICONS[shortcut.key],
    active: isCommandCenterShortcutActive(shortcut, pathname),
  }));
  const inboxUnavailable =
    bootstrapQuery.error !== null &&
    environmentId !== null &&
    entries.some((entry) => entry.key === "inbox");
  // Every shortcut can be hidden; an empty group would still take up its padding.
  if (entries.length === 0) return null;

  if (isMobile) {
    // The phone drawer is mostly for switching threads. Wrapping chips keep
    // every destination one tap away in about a third of the rows' height.
    return (
      <SidebarGroup>
        <nav aria-label="Command Center" className="flex flex-wrap gap-1">
          {entries.map((entry) => {
            const Icon = entry.icon;
            return (
              <Link
                key={entry.key}
                aria-current={entry.active ? "page" : undefined}
                className="inline-flex h-8 items-center gap-1.5 rounded-full bg-sidebar-control-surface px-2 text-xs font-medium text-sidebar-muted-foreground ring-1 ring-sidebar-border outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:bg-sidebar-row-active data-[active=true]:bg-sidebar-row-selected data-[active=true]:text-sidebar-foreground [&>svg]:size-3.5 [&>svg]:shrink-0"
                data-active={entry.active}
                onClick={closeMobileSidebar}
                to={entry.to}
              >
                <Icon />
                <span>{entry.label}</span>
              </Link>
            );
          })}
        </nav>
        {inboxUnavailable ? (
          <div className="px-2 pt-2 text-xs text-muted-foreground">
            <CircleAlertIcon className="mr-2 inline size-3.5" /> Inbox unavailable
          </div>
        ) : null}
      </SidebarGroup>
    );
  }

  return (
    <SidebarGroup>
      <SidebarMenu>
        {entries.map((entry) => {
          const Icon = entry.icon;
          return (
            <SidebarMenuItem key={entry.key}>
              <SidebarMenuButton
                isActive={entry.active}
                render={<Link to={entry.to} onClick={closeMobileSidebar} />}
                size="sm"
              >
                <Icon />
                <span>{entry.label}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          );
        })}
        {inboxUnavailable ? (
          <SidebarMenuItem>
            <div className="px-2 py-1 text-xs text-muted-foreground">
              <CircleAlertIcon className="mr-2 inline size-3.5" /> Inbox unavailable
            </div>
          </SidebarMenuItem>
        ) : null}
      </SidebarMenu>
    </SidebarGroup>
  );
});
