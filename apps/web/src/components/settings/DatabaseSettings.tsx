"use client";

import {
  DatabaseZapIcon,
  ExternalLinkIcon,
  PencilIcon,
  PlusIcon,
  StarIcon,
  Trash2Icon,
} from "lucide-react";
import { useMemo, useState } from "react";
import {
  DatabaseConnectionId,
  ProjectId,
  databaseConnectionDisplayName,
  type EnvironmentId,
  type ServerSettings,
  type SupabaseDatabaseConnection,
} from "@t3tools/contracts";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { randomUUID } from "../../lib/utils";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import {
  buildProviderEnvironmentOptions,
  resolveSelectedProviderEnvironmentId,
} from "./ProviderSettingsPanel.logic";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

type DatabaseConnections = ServerSettings["databaseConnections"];

interface SupabaseConnectionDraft {
  readonly connectionId: DatabaseConnectionId;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly label: string;
  readonly isDefault: boolean;
  readonly projectRef: string;
  readonly accessToken: string;
  readonly readOnly: boolean;
}

export function newDatabaseConnectionId(): DatabaseConnectionId {
  return DatabaseConnectionId.make(randomUUID());
}

/** Connections for one project, default first, then by display name. */
export function connectionsForProject(
  connections: DatabaseConnections,
  projectId: ProjectId,
): ReadonlyArray<readonly [DatabaseConnectionId, SupabaseDatabaseConnection]> {
  return Object.entries(connections)
    .filter(([, connection]) => connection.projectId === projectId)
    .map(([id, connection]) => [DatabaseConnectionId.make(id), connection] as const)
    .toSorted(([, left], [, right]) => {
      if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1;
      return databaseConnectionDisplayName(left).localeCompare(
        databaseConnectionDisplayName(right),
      );
    });
}

/**
 * Add or replace a connection. A project keeps at most one default: marking a
 * connection default clears the flag on its siblings, and a project's first
 * connection is always its default so single-database projects need no label.
 */
export function upsertSupabaseConnection(
  connections: DatabaseConnections,
  draft: SupabaseConnectionDraft,
): DatabaseConnections {
  const existing = connections[draft.connectionId];
  const siblings = connectionsForProject(connections, draft.projectId).filter(
    ([id]) => id !== draft.connectionId,
  );
  const isDefault = draft.isDefault || siblings.length === 0;
  const next: Record<string, SupabaseDatabaseConnection> = { ...connections };
  if (isDefault) {
    for (const [id, sibling] of siblings) {
      if (sibling.isDefault) next[id] = { ...sibling, isDefault: false };
    }
  }
  next[draft.connectionId] = {
    provider: "supabase",
    projectId: draft.projectId,
    workspaceRoot: draft.workspaceRoot,
    label: draft.label,
    isDefault,
    projectRef: draft.projectRef,
    readOnly: draft.readOnly,
    accessToken: draft.accessToken,
    ...(draft.accessToken.length === 0 && existing?.accessTokenRedacted
      ? { accessTokenRedacted: true }
      : {}),
  };
  return next as DatabaseConnections;
}

export function setDefaultDatabaseConnection(
  connections: DatabaseConnections,
  connectionId: DatabaseConnectionId,
): DatabaseConnections {
  const target = connections[connectionId];
  if (target === undefined) return connections;
  const next: Record<string, SupabaseDatabaseConnection> = { ...connections };
  for (const [id, connection] of connectionsForProject(connections, target.projectId)) {
    next[id] = { ...connection, isDefault: id === connectionId };
  }
  return next as DatabaseConnections;
}

/**
 * Remove a connection. If it was the project's default and siblings remain,
 * the first remaining sibling becomes the default so tools keep resolving.
 */
export function removeDatabaseConnection(
  connections: DatabaseConnections,
  connectionId: DatabaseConnectionId,
): DatabaseConnections {
  const removed = connections[connectionId];
  const next: Record<string, SupabaseDatabaseConnection> = { ...connections };
  delete next[connectionId];
  if (removed?.isDefault) {
    const [successor] = connectionsForProject(next as DatabaseConnections, removed.projectId);
    if (successor !== undefined) next[successor[0]] = { ...successor[1], isDefault: true };
  }
  return next as DatabaseConnections;
}

/**
 * A label is required once a project has more than one connection, and must
 * be unique within the project, so the agent's `database` selector is
 * unambiguous.
 */
export function validateConnectionLabel(
  connections: DatabaseConnections,
  draft: Pick<SupabaseConnectionDraft, "connectionId" | "projectId" | "label">,
): string | null {
  const siblings = connectionsForProject(connections, draft.projectId).filter(
    ([id]) => id !== draft.connectionId,
  );
  const label = draft.label.trim().toLowerCase();
  if (siblings.length > 0 && label.length === 0) {
    return "Give this database a name so agents can tell it apart from the others.";
  }
  if (
    label.length > 0 &&
    siblings.some(([, sibling]) => databaseConnectionDisplayName(sibling).toLowerCase() === label)
  ) {
    return "Another database in this project already uses that name.";
  }
  return null;
}

export function DatabaseSettingsPanel() {
  const { environments, isReady } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const options = useMemo(
    () => buildProviderEnvironmentOptions(environments, primaryEnvironmentId),
    [environments, primaryEnvironmentId],
  );
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(
    primaryEnvironmentId,
  );
  const effectiveEnvironmentId = resolveSelectedProviderEnvironmentId(
    options,
    selectedEnvironmentId,
    primaryEnvironmentId,
  );

  if (effectiveEnvironmentId === null) {
    return (
      <SettingsPageContainer>
        <SettingsSection title="Database Providers">
          <SettingsRow
            title={isReady ? "No connected environments" : "Loading environments"}
            description={
              isReady
                ? "Connect an execution environment before binding Supabase projects."
                : "Reading connected execution environments."
            }
          />
        </SettingsSection>
      </SettingsPageContainer>
    );
  }

  return (
    <SettingsPageContainer>
      {options.length > 1 ? (
        <SettingsSection title="Environment">
          <SettingsRow
            title="Manage databases on"
            description="Database connections and their access tokens live on the server that runs the threads."
            control={
              <Select
                value={effectiveEnvironmentId}
                onValueChange={(value) =>
                  setSelectedEnvironmentId(value === null ? null : (value as EnvironmentId))
                }
              >
                <SelectTrigger aria-label="Environment" className="w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {options.map((environment) => (
                    <SelectItem key={environment.environmentId} value={environment.environmentId}>
                      {environment.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
        </SettingsSection>
      ) : null}
      <EnvironmentDatabaseSettings
        key={effectiveEnvironmentId}
        environmentId={effectiveEnvironmentId}
      />
    </SettingsPageContainer>
  );
}

function EnvironmentDatabaseSettings({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const settings = useEnvironmentSettings(environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const allProjects = useProjects();
  const projects = useMemo(
    () =>
      allProjects
        .filter((project) => project.environmentId === environmentId)
        .sort((left, right) => left.title.localeCompare(right.title)),
    [allProjects, environmentId],
  );
  const projectsById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );
  const connections = settings.databaseConnections;
  const connectionCount = Object.keys(connections).length;
  const projectSections = useMemo(
    () =>
      projects
        .map((project) => ({
          project,
          connections: connectionsForProject(connections, project.id),
        }))
        .filter((section) => section.connections.length > 0),
    [projects, connections],
  );
  const orphanedConnections = useMemo(
    () =>
      Object.entries(connections)
        .filter(([, connection]) => !projectsById.has(connection.projectId))
        .map(([id, connection]) => [DatabaseConnectionId.make(id), connection] as const),
    [connections, projectsById],
  );

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingConnectionId, setEditingConnectionId] = useState<DatabaseConnectionId | null>(null);
  const [draftConnectionId, setDraftConnectionId] = useState<DatabaseConnectionId | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<ProjectId | null>(null);
  const [label, setLabel] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const [projectRef, setProjectRef] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [readOnly, setReadOnly] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [removeConnectionId, setRemoveConnectionId] = useState<DatabaseConnectionId | null>(null);

  const openAddDialog = (projectId?: ProjectId) => {
    setEditingConnectionId(null);
    setDraftConnectionId(newDatabaseConnectionId());
    setSelectedProjectId(projectId ?? projects[0]?.id ?? null);
    setLabel("");
    setIsDefault(false);
    setProjectRef("");
    setAccessToken("");
    setReadOnly(true);
    setDialogOpen(true);
  };

  const openEditDialog = (
    connectionId: DatabaseConnectionId,
    connection: SupabaseDatabaseConnection,
  ) => {
    setEditingConnectionId(connectionId);
    setDraftConnectionId(connectionId);
    setSelectedProjectId(connection.projectId);
    setLabel(connection.label);
    setIsDefault(connection.isDefault);
    setProjectRef(connection.projectRef);
    setAccessToken("");
    setReadOnly(connection.readOnly);
    setDialogOpen(true);
  };

  const selectedProject =
    selectedProjectId === null ? undefined : projectsById.get(selectedProjectId);
  const existingConnection =
    editingConnectionId === null ? undefined : connections[editingConnectionId];
  const siblingCount =
    selectedProjectId === null
      ? 0
      : connectionsForProject(connections, selectedProjectId).filter(
          ([id]) => id !== draftConnectionId,
        ).length;
  const labelError =
    draftConnectionId === null || selectedProjectId === null
      ? null
      : validateConnectionLabel(connections, {
          connectionId: draftConnectionId,
          projectId: selectedProjectId,
          label,
        });
  const credentialConfigured =
    accessToken.trim().length > 0 || existingConnection?.accessTokenRedacted === true;
  const formValid =
    selectedProject !== undefined &&
    projectRef.trim().length > 0 &&
    credentialConfigured &&
    labelError === null;

  const persist = async (next: DatabaseConnections, failureTitle: string): Promise<boolean> => {
    const persisted = await updateSettings({ databaseConnections: next });
    if (!persisted) {
      toastManager.add({
        type: "error",
        title: failureTitle,
        description: "The environment did not accept the settings update.",
      });
    }
    return persisted;
  };

  const saveConnection = async () => {
    if (
      !formValid ||
      selectedProject === undefined ||
      selectedProjectId === null ||
      draftConnectionId === null
    ) {
      return;
    }
    setIsSaving(true);
    const persisted = await persist(
      upsertSupabaseConnection(connections, {
        connectionId: draftConnectionId,
        projectId: selectedProjectId,
        workspaceRoot: selectedProject.workspaceRoot,
        label: label.trim(),
        isDefault,
        projectRef: projectRef.trim(),
        accessToken: accessToken.trim(),
        readOnly,
      }),
      "Could not save Supabase connection",
    );
    setIsSaving(false);
    if (!persisted) return;
    toastManager.add({
      type: "success",
      title: editingConnectionId === null ? "Supabase connected" : "Supabase connection updated",
      description: `${selectedProject.title} can now use project-scoped Supabase tools.`,
    });
    setDialogOpen(false);
  };

  const makeDefault = async (connectionId: DatabaseConnectionId) => {
    const persisted = await persist(
      setDefaultDatabaseConnection(connections, connectionId),
      "Could not change the default database",
    );
    if (!persisted) return;
    const connection = connections[connectionId];
    toastManager.add({
      type: "success",
      title: "Default database updated",
      description:
        connection === undefined
          ? undefined
          : `Threads that do not name a database now use ${databaseConnectionDisplayName(connection)}.`,
    });
  };

  const removeConnection = async () => {
    if (removeConnectionId === null) return;
    const connection = connections[removeConnectionId];
    const project = connection === undefined ? undefined : projectsById.get(connection.projectId);
    const persisted = await persist(
      removeDatabaseConnection(connections, removeConnectionId),
      "Could not remove Supabase connection",
    );
    if (!persisted) return;
    toastManager.add({
      type: "success",
      title: "Supabase disconnected",
      description: `${project?.title ?? "The project"} no longer exposes ${
        connection === undefined ? "this database" : databaseConnectionDisplayName(connection)
      } to threads.`,
    });
    setRemoveConnectionId(null);
  };

  const renderConnection = (
    connectionId: DatabaseConnectionId,
    connection: SupabaseDatabaseConnection,
    options: { readonly showProject: boolean; readonly siblingCount: number },
  ) => {
    const project = projectsById.get(connection.projectId);
    const name = databaseConnectionDisplayName(connection);
    return (
      <div
        key={connectionId}
        className="flex flex-col gap-3 border-t border-border/60 px-4 py-3 first:border-t-0 sm:flex-row sm:items-center sm:justify-between sm:px-5"
      >
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-[#3ecf8e]/10">
            <DatabaseZapIcon className="size-4.5 text-[#3ecf8e]" aria-hidden />
          </span>
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate text-[13px] font-semibold text-foreground">
                {options.showProject ? (project?.title ?? connection.projectId) : name}
              </span>
              {connection.isDefault && options.siblingCount > 0 ? (
                <Badge variant="info" size="sm">
                  Default
                </Badge>
              ) : null}
              <Badge variant="success" size="sm">
                Connected
              </Badge>
              <Badge variant={connection.readOnly ? "secondary" : "warning"} size="sm">
                {connection.readOnly ? "Read only" : "Write access"}
              </Badge>
            </div>
            <p className="truncate font-mono text-[11px] text-muted-foreground">
              {connection.label.length > 0 || options.showProject
                ? `${options.showProject ? `${name} · ` : ""}${connection.projectRef}`
                : connection.projectRef}
            </p>
            <p className="truncate text-[11px] text-muted-foreground/70">
              {connection.workspaceRoot}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {!connection.isDefault && options.siblingCount > 0 ? (
            <Button
              size="xs"
              variant="ghost"
              aria-label={`Make ${name} the default database`}
              onClick={() => void makeDefault(connectionId)}
            >
              <StarIcon aria-hidden />
              Make default
            </Button>
          ) : null}
          <Button
            size="xs"
            variant="outline"
            onClick={() => openEditDialog(connectionId, connection)}
          >
            <PencilIcon aria-hidden />
            Edit
          </Button>
          <Button
            size="icon-xs"
            variant="destructive-outline"
            aria-label={`Disconnect ${name} from ${project?.title ?? connection.projectId}`}
            onClick={() => setRemoveConnectionId(connectionId)}
          >
            <Trash2Icon aria-hidden />
          </Button>
        </div>
      </div>
    );
  };

  return (
    <>
      <SettingsSection
        title="Database Providers"
        headerAction={
          <Button
            size="xs"
            variant="outline"
            onClick={() => openAddDialog()}
            disabled={projects.length === 0}
          >
            <PlusIcon aria-hidden />
            Connect
          </Button>
        }
      >
        {connectionCount === 0 ? (
          <div className="flex flex-col gap-4 px-5 py-6 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-[#3ecf8e]/10">
                <DatabaseZapIcon className="size-5 text-[#3ecf8e]" aria-hidden />
              </span>
              <div className="space-y-1">
                <div className="text-sm font-semibold text-foreground">Connect Supabase</div>
                <p className="max-w-xl text-xs leading-relaxed text-muted-foreground">
                  Bind a local project to one or more Supabase projects, such as staging and
                  production. Threads in that project receive scoped database, advisor, and
                  type-generation tools without exposing your personal access token to the provider
                  process.
                </p>
              </div>
            </div>
            <Button size="sm" onClick={() => openAddDialog()} disabled={projects.length === 0}>
              Connect project
            </Button>
          </div>
        ) : (
          <>
            {projectSections.map(({ project, connections: projectConnections }) => (
              <div key={project.id} className="border-t border-border/60 first:border-t-0">
                <div className="flex items-center justify-between gap-3 bg-muted/20 px-4 py-2 sm:px-5">
                  <div className="min-w-0">
                    <div className="truncate text-xs font-semibold text-foreground">
                      {project.title}
                    </div>
                    <div className="truncate text-[11px] text-muted-foreground/70">
                      {projectConnections.length === 1
                        ? "1 database"
                        : `${projectConnections.length} databases`}
                    </div>
                  </div>
                  <Button size="xs" variant="ghost" onClick={() => openAddDialog(project.id)}>
                    <PlusIcon aria-hidden />
                    Add database
                  </Button>
                </div>
                {projectConnections.map(([connectionId, connection]) =>
                  renderConnection(connectionId, connection, {
                    showProject: false,
                    siblingCount: projectConnections.length - 1,
                  }),
                )}
              </div>
            ))}
            {orphanedConnections.length > 0 ? (
              <div className="border-t border-border/60">
                <div className="bg-muted/20 px-4 py-2 text-xs font-semibold text-foreground sm:px-5">
                  Projects no longer in this environment
                </div>
                {orphanedConnections.map(([connectionId, connection]) =>
                  renderConnection(connectionId, connection, {
                    showProject: true,
                    siblingCount: 0,
                  }),
                )}
              </div>
            ) : null}
          </>
        )}
      </SettingsSection>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editingConnectionId === null ? "Connect Supabase" : "Edit Supabase connection"}
            </DialogTitle>
            <DialogDescription>
              The access token is stored separately with restricted permissions and is never sent to
              agent provider processes.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">Local project</span>
              <Select
                value={selectedProjectId}
                onValueChange={(value) =>
                  setSelectedProjectId(value === null ? null : ProjectId.make(value))
                }
                disabled={editingConnectionId !== null}
              >
                <SelectTrigger aria-label="Local project">
                  <SelectValue placeholder="Choose a project">{selectedProject?.title}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.title}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              {projects.length === 0 ? (
                <span className="text-[11px] text-muted-foreground">
                  Add a local project to this environment first.
                </span>
              ) : null}
            </label>

            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">
                Database name{siblingCount > 0 ? "" : " (optional)"}
              </span>
              <Input
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder={siblingCount > 0 ? "staging" : "prod"}
                spellCheck={false}
                aria-invalid={labelError !== null}
              />
              <span
                className={
                  labelError === null
                    ? "text-[11px] text-muted-foreground"
                    : "text-[11px] text-destructive"
                }
              >
                {labelError ??
                  'Agents pick a database by this name, for example database="staging".'}
              </span>
            </label>

            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">Supabase project ref</span>
              <Input
                value={projectRef}
                onChange={(event) => setProjectRef(event.target.value)}
                placeholder="abcdefghijklmnopqrst"
                spellCheck={false}
              />
              <span className="text-[11px] text-muted-foreground">
                Found in the Supabase dashboard URL or Project Settings.
              </span>
            </label>

            <label className="grid gap-1.5">
              <span className="flex items-center justify-between gap-2 text-xs font-medium text-foreground">
                Personal access token
                <a
                  href="https://supabase.com/dashboard/account/tokens"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 font-normal text-primary hover:underline"
                >
                  Create token <ExternalLinkIcon className="size-3" aria-hidden />
                </a>
              </span>
              <Input
                type="password"
                value={accessToken}
                onChange={(event) => setAccessToken(event.target.value)}
                placeholder={
                  existingConnection?.accessTokenRedacted
                    ? "Stored securely — enter a new token to replace it"
                    : "sbp_..."
                }
                autoComplete="off"
                spellCheck={false}
              />
              <span className="text-[11px] text-muted-foreground">
                {existingConnection?.accessTokenRedacted
                  ? "Leave blank to keep the stored token."
                  : "Stored only by the Command Center server."}
              </span>
            </label>

            <div className="flex items-center justify-between gap-4 rounded-xl border bg-muted/30 px-3 py-3">
              <div className="space-y-0.5">
                <div className="text-xs font-medium text-foreground">Read-only mode</div>
                <p className="text-[11px] text-muted-foreground">
                  Recommended. Disables migrations and restricts SQL to read-only operations.
                </p>
              </div>
              <Switch
                checked={readOnly}
                onCheckedChange={setReadOnly}
                aria-label="Read-only Supabase access"
              />
            </div>

            {siblingCount > 0 ? (
              <div className="flex items-center justify-between gap-4 rounded-xl border bg-muted/30 px-3 py-3">
                <div className="space-y-0.5">
                  <div className="text-xs font-medium text-foreground">Use as default</div>
                  <p className="text-[11px] text-muted-foreground">
                    Threads that do not name a database use the default. Prefer a read-only database
                    here.
                  </p>
                </div>
                <Switch
                  checked={isDefault}
                  onCheckedChange={setIsDefault}
                  aria-label="Use as the project's default database"
                />
              </div>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void saveConnection()} disabled={!formValid || isSaving}>
              {isSaving
                ? "Saving…"
                : editingConnectionId === null
                  ? "Connect database"
                  : "Save changes"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog
        open={removeConnectionId !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveConnectionId(null);
        }}
      >
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>Disconnect Supabase?</DialogTitle>
            <DialogDescription>
              Threads in this project will immediately lose access to this database. The stored
              personal access token will be removed from the server.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveConnectionId(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void removeConnection()}>
              Disconnect
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
