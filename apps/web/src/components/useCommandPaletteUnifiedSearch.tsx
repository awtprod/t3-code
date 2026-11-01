import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { ProjectId } from "@t3tools/contracts";
import { BrainIcon, FileSearchIcon, FileTextIcon } from "lucide-react";

import { projectEnvironmentProjects } from "../command-center/CommandCenterHome.logic";
import { useActiveProjectTarget } from "../hooks/useActiveProjectTarget";
import { useRightPanelStore } from "../rightPanelStore";
import { commandCenterEnvironment } from "../state/commandCenter";
import { useProjectContentSearch, useProjectPathSearch } from "../state/queries";
import { useEnvironmentQuery } from "../state/query";
import {
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
  ITEM_ICON_CLASS,
} from "./CommandPalette.logic";

const UNIFIED_SEARCH_MIN_QUERY_LENGTH = 2;
const UNIFIED_SEARCH_GROUP_LIMIT = 12;

/**
 * Command Center's root palette search: files and content in the active project, plus
 * governed memory for its space. Results are server-ranked, so the groups are `preFiltered`.
 */
export function useCommandPaletteUnifiedSearch(input: {
  readonly query: string;
  readonly enabled: boolean;
  readonly currentProjectId: ProjectId | null;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly onOpenMemory: () => Promise<void>;
}): CommandPaletteGroup[] {
  const activeProjectTarget = useActiveProjectTarget();
  const trimmedQuery = input.query.trim();
  const query =
    input.enabled && trimmedQuery.length >= UNIFIED_SEARCH_MIN_QUERY_LENGTH ? trimmedQuery : "";
  const workspaceFileSearch = useProjectPathSearch(
    {
      environmentId: activeProjectTarget?.environmentId ?? null,
      cwd: activeProjectTarget?.cwd ?? null,
      query,
      kind: "file",
    },
    20,
  );
  const projectContentSearch = useProjectContentSearch({
    environmentId: activeProjectTarget?.environmentId ?? null,
    cwd: activeProjectTarget?.cwd ?? null,
    query,
    caseSensitive: false,
    wholeWord: false,
    useRegex: false,
  });
  const commandCenterBootstrap = useEnvironmentQuery(
    activeProjectTarget === null
      ? null
      : commandCenterEnvironment.bootstrap({
          environmentId: activeProjectTarget.environmentId,
          input: {},
        }),
  );
  const activeScope = (() => {
    if (activeProjectTarget === null || input.currentProjectId === null) return null;
    const linkedProject = projectEnvironmentProjects(
      input.projects.filter(
        (project) => project.environmentId === activeProjectTarget.environmentId,
      ),
      commandCenterBootstrap.data,
    ).find((project) => project.id === input.currentProjectId);
    if (linkedProject?.spaceId === undefined) return null;
    const space = commandCenterBootstrap.data?.spaces.find(
      (candidate) => String(candidate.id) === String(linkedProject.spaceId),
    );
    if (!space) return null;
    const repository = space.repositories.find(
      (candidate) => String(candidate.id) === String(linkedProject.repositoryId),
    );
    return { spaceId: space.id, repositoryId: repository?.id };
  })();
  const memorySearch = useEnvironmentQuery(
    activeProjectTarget !== null && activeScope !== null && query.length > 0
      ? commandCenterEnvironment.memorySearch({
          environmentId: activeProjectTarget.environmentId,
          input: {
            query,
            spaceId: activeScope.spaceId,
            ...(activeScope.repositoryId === undefined
              ? {}
              : { repositoryId: activeScope.repositoryId }),
            includeArchives: true,
            limit: UNIFIED_SEARCH_GROUP_LIMIT,
          },
        })
      : null,
  );

  if (query.length === 0 || activeProjectTarget === null) return [];

  const fileItems: CommandPaletteActionItem[] = workspaceFileSearch.entries
    .slice(0, UNIFIED_SEARCH_GROUP_LIMIT)
    .map((entry) => ({
      kind: "action",
      value: `workspace-file:${entry.path}`,
      searchTerms: [entry.path],
      title: entry.path.split(/[\\/]/u).at(-1) ?? entry.path,
      description: entry.path,
      icon: <FileSearchIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        useRightPanelStore.getState().openFile(activeProjectTarget.threadRef, entry.path);
      },
    }));
  const contentItems: CommandPaletteActionItem[] = projectContentSearch.matches
    .slice(0, UNIFIED_SEARCH_GROUP_LIMIT)
    .map((match) => ({
      kind: "action",
      value: `project-content:${match.path}:${match.lineNumber}`,
      searchTerms: [match.path, match.lineContent],
      title: `${match.path}:${match.lineNumber}`,
      description: match.lineContent.trim(),
      icon: <FileTextIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        useRightPanelStore
          .getState()
          .openFile(activeProjectTarget.threadRef, match.path, match.lineNumber);
      },
    }));
  const memoryItems: CommandPaletteActionItem[] = (memorySearch.data?.results ?? []).map(
    (result) => {
      const provenance =
        typeof result.provenance === "object" &&
        result.provenance !== null &&
        "kind" in result.provenance &&
        typeof result.provenance.kind === "string"
          ? result.provenance.kind
          : "recorded";
      const labels = [
        result.trust === "trusted" ? "trusted" : "archive · untrusted",
        `${Math.round(result.confidence * 100)}% confidence`,
        provenance,
        result.scope,
      ];
      return {
        kind: "action",
        value: `governed-memory:${result.memoryId}`,
        searchTerms: [result.content, result.kind, ...labels],
        title: result.content,
        description: labels.join(" · "),
        icon: <BrainIcon className={ITEM_ICON_CLASS} />,
        run: input.onOpenMemory,
      };
    },
  );

  return [
    ...(fileItems.length > 0
      ? [{ value: "workspace-files-search", label: "Files", items: fileItems, preFiltered: true }]
      : []),
    ...(contentItems.length > 0
      ? [
          {
            value: "project-content-search",
            label: "Project Content",
            items: contentItems,
            preFiltered: true,
          },
        ]
      : []),
    ...(activeScope !== null && memoryItems.length > 0
      ? [
          {
            value: "governed-memory-search",
            label: "Governed Memory",
            items: memoryItems,
            preFiltered: true,
          },
        ]
      : []),
  ];
}
