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
  WorkflowIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { memo, useCallback } from "react";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";

import { useEnvironmentIdentificationMode } from "../../hooks/useSettings";
import { APP_BASE_NAME } from "../../branding";
import { cn } from "../../lib/utils";
import { commandCenterEnvironment } from "../../state/commandCenter";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironments } from "../../state/environments";
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
import { isSidebarUtilityPage, useNavigateToMainApp } from "./mainAppLocation";
import { SidebarThreadUndoNotice } from "./SidebarThreadUndoNotice";
import { SidebarProviderUpdatePill } from "./SidebarProviderUpdatePill";
import { SidebarUpdateArchitectureWarning, SidebarUpdatePill } from "./SidebarUpdatePill";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";

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
        "@container/sidebar-header relative flex h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center gap-2 px-3 md:px-0",
        isElectron && "drag-region",
      )}
    >
      {backdropVariant ? <SidebarStageBackdrop variant={backdropVariant} /> : null}
      <SidebarTrigger
        // Over the stage artwork: the media viewer's control-on-imagery treatment.
        variant={backdropVariant ? "media-navigation" : "ghost"}
        className="relative top-auto z-10 translate-y-0 md:hidden"
      />
      <SidebarBrand onBackdrop={backdropVariant !== null} />
      {pillLabel ? (
        <Badge
          className="relative z-10 ml-1 hidden @[15rem]/sidebar-header:inline-flex"
          data-environment-identification="pill"
          size="sm"
          variant="secondary"
        >
          {pillLabel}
        </Badge>
      ) : null}
    </div>
  );
});

function SidebarBrand({ onBackdrop }: { onBackdrop: boolean }) {
  return (
    <Link
      aria-label="Go to Command Center"
      className={cn(
        "relative z-10 ml-[var(--workspace-titlebar-content-left)] hidden h-7 w-fit min-w-0 shrink-0 items-center overflow-hidden rounded-md outline-hidden ring-ring focus-visible:ring-2 md:flex",
        onBackdrop ? "text-white" : "text-foreground",
      )}
      to="/"
    >
      <CommandIcon className="size-3.5 shrink-0" />
      <span className="truncate text-sm font-semibold tracking-tight">{APP_BASE_NAME}</span>
    </Link>
  );
}

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
  const entries = [
    {
      to: "/inbox" as const,
      label: "Needs You",
      icon: InboxIcon,
      active: pathname === "/" || pathname.startsWith("/inbox"),
    },
    { to: "/new" as const, label: "New thread", icon: SquarePenIcon, active: pathname === "/new" },
    {
      to: "/command" as const,
      label: "Command",
      icon: CommandIcon,
      active: pathname.startsWith("/command"),
    },
    {
      to: "/automations" as const,
      label: "Automations",
      icon: WorkflowIcon,
      active: pathname.startsWith("/automations"),
    },
    {
      to: "/responsibilities" as const,
      label: "Responsibilities",
      icon: ListChecksIcon,
      active: pathname.startsWith("/responsibilities"),
    },
    {
      to: "/prospects" as const,
      label: "Prospects",
      icon: ContactRoundIcon,
      active: pathname.startsWith("/prospects"),
    },
    {
      to: "/sprint-plan" as const,
      label: "Sprint plan",
      icon: CalendarDaysIcon,
      active: pathname.startsWith("/sprint-plan"),
    },
    {
      to: "/observations" as const,
      label: "Observations",
      icon: ListFilterIcon,
      active: pathname.startsWith("/observations"),
    },
    {
      to: "/lessons" as const,
      label: "Lessons",
      icon: LightbulbIcon,
      active: pathname.startsWith("/lessons"),
    },
    {
      to: "/resources" as const,
      label: "Resources",
      icon: HardDriveIcon,
      active: pathname.startsWith("/resources"),
    },
  ];

  return (
    <SidebarGroup>
      <SidebarMenu>
        {entries.map((entry) => {
          const Icon = entry.icon;
          return (
            <SidebarMenuItem key={entry.label}>
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
        {bootstrapQuery.error !== null && environmentId !== null ? (
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
  const { environments } = useEnvironments();
  // The page reads every connected server, so one of them offering pull requests is enough for
  // the link to lead somewhere.
  const pullRequestsSupported = environments.some(
    (environment) => environment.serverConfig?.environment.capabilities.pullRequests === true,
  );
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
