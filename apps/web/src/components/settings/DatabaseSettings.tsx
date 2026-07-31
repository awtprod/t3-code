"use client";

import { DatabaseZapIcon, ExternalLinkIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useMemo, useState } from "react";
import {
  ProjectId,
  type ServerSettings,
  type SupabaseDatabaseConnection,
} from "@t3tools/contracts";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { usePrimaryEnvironment } from "../../state/environments";
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
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

interface SupabaseConnectionDraft {
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly projectRef: string;
  readonly accessToken: string;
  readonly readOnly: boolean;
}

export function upsertSupabaseConnection(
  connections: ServerSettings["databaseConnections"],
  draft: SupabaseConnectionDraft,
): ServerSettings["databaseConnections"] {
  const existing = connections[draft.projectId];
  return {
    ...connections,
    [draft.projectId]: {
      provider: "supabase",
      workspaceRoot: draft.workspaceRoot,
      projectRef: draft.projectRef,
      readOnly: draft.readOnly,
      accessToken: draft.accessToken,
      ...(draft.accessToken.length === 0 && existing?.accessTokenRedacted
        ? { accessTokenRedacted: true }
        : {}),
    },
  };
}

export function removeDatabaseConnection(
  connections: ServerSettings["databaseConnections"],
  projectId: ProjectId,
): ServerSettings["databaseConnections"] {
  const next = { ...connections };
  delete next[projectId];
  return next;
}

export function DatabaseSettingsPanel() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const primaryEnvironment = usePrimaryEnvironment();
  const allProjects = useProjects();
  const projects = useMemo(
    () =>
      primaryEnvironment === null
        ? []
        : allProjects
            .filter((project) => project.environmentId === primaryEnvironment.environmentId)
            .sort((left, right) => left.title.localeCompare(right.title)),
    [allProjects, primaryEnvironment],
  );
  const projectsById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );
  const connections = Object.entries(settings.databaseConnections);
  const unconnectedProjects = projects.filter(
    (project) => settings.databaseConnections[project.id] === undefined,
  );

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingProjectId, setEditingProjectId] = useState<ProjectId | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<ProjectId | null>(null);
  const [projectRef, setProjectRef] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [readOnly, setReadOnly] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [removeProjectId, setRemoveProjectId] = useState<ProjectId | null>(null);

  const openAddDialog = () => {
    setEditingProjectId(null);
    setSelectedProjectId(unconnectedProjects[0]?.id ?? null);
    setProjectRef("");
    setAccessToken("");
    setReadOnly(true);
    setDialogOpen(true);
  };

  const openEditDialog = (projectId: ProjectId, connection: SupabaseDatabaseConnection) => {
    setEditingProjectId(projectId);
    setSelectedProjectId(projectId);
    setProjectRef(connection.projectRef);
    setAccessToken("");
    setReadOnly(connection.readOnly);
    setDialogOpen(true);
  };

  const selectedProject =
    selectedProjectId === null ? undefined : projectsById.get(selectedProjectId);
  const existingConnection =
    selectedProjectId === null ? undefined : settings.databaseConnections[selectedProjectId];
  const credentialConfigured =
    accessToken.trim().length > 0 || existingConnection?.accessTokenRedacted === true;
  const formValid =
    selectedProject !== undefined && projectRef.trim().length > 0 && credentialConfigured;

  const saveConnection = async () => {
    if (!formValid || selectedProject === undefined || selectedProjectId === null) return;
    setIsSaving(true);
    const persisted = await updateSettings({
      databaseConnections: upsertSupabaseConnection(settings.databaseConnections, {
        projectId: selectedProjectId,
        workspaceRoot: selectedProject.workspaceRoot,
        projectRef: projectRef.trim(),
        accessToken: accessToken.trim(),
        readOnly,
      }),
    });
    setIsSaving(false);
    if (!persisted) {
      toastManager.add({
        type: "error",
        title: "Could not save Supabase connection",
        description: "The primary environment did not accept the settings update.",
      });
      return;
    }
    toastManager.add({
      type: "success",
      title: editingProjectId === null ? "Supabase connected" : "Supabase connection updated",
      description: `${selectedProject.title} can now use project-scoped Supabase tools.`,
    });
    setDialogOpen(false);
  };

  const removeConnection = async () => {
    if (removeProjectId === null) return;
    const project = projectsById.get(removeProjectId);
    const persisted = await updateSettings({
      databaseConnections: removeDatabaseConnection(settings.databaseConnections, removeProjectId),
    });
    if (!persisted) {
      toastManager.add({
        type: "error",
        title: "Could not remove Supabase connection",
        description: "The primary environment did not accept the settings update.",
      });
      return;
    }
    toastManager.add({
      type: "success",
      title: "Supabase disconnected",
      description: `${project?.title ?? "The project"} no longer exposes Supabase tools to threads.`,
    });
    setRemoveProjectId(null);
  };

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Database Providers"
        headerAction={
          <Button
            size="xs"
            variant="outline"
            onClick={openAddDialog}
            disabled={unconnectedProjects.length === 0}
          >
            <PlusIcon aria-hidden />
            Connect
          </Button>
        }
      >
        {connections.length === 0 ? (
          <div className="flex flex-col gap-4 px-5 py-6 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-[#3ecf8e]/10">
                <DatabaseZapIcon className="size-5 text-[#3ecf8e]" aria-hidden />
              </span>
              <div className="space-y-1">
                <div className="text-sm font-semibold text-foreground">Connect Supabase</div>
                <p className="max-w-xl text-xs leading-relaxed text-muted-foreground">
                  Bind a local project to a Supabase project. Threads in that project receive scoped
                  database, advisor, and type-generation tools without exposing your personal access
                  token to the provider process.
                </p>
              </div>
            </div>
            <Button size="sm" onClick={openAddDialog} disabled={unconnectedProjects.length === 0}>
              Connect project
            </Button>
          </div>
        ) : (
          connections.map(([rawProjectId, connection]) => {
            const projectId = ProjectId.make(rawProjectId);
            const project = projectsById.get(projectId);
            return (
              <div
                key={projectId}
                className="border-t border-border/60 px-4 py-4 first:border-t-0 sm:px-5"
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 items-start gap-3">
                    <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-[#3ecf8e]/10">
                      <DatabaseZapIcon className="size-4.5 text-[#3ecf8e]" aria-hidden />
                    </span>
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-[13px] font-semibold text-foreground">
                          {project?.title ?? rawProjectId}
                        </span>
                        <Badge variant="success" size="sm">
                          Connected
                        </Badge>
                        <Badge variant={connection.readOnly ? "secondary" : "warning"} size="sm">
                          {connection.readOnly ? "Read only" : "Write access"}
                        </Badge>
                      </div>
                      <p className="truncate font-mono text-[11px] text-muted-foreground">
                        {connection.projectRef}
                      </p>
                      <p className="truncate text-[11px] text-muted-foreground/70">
                        {connection.workspaceRoot}
                      </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => openEditDialog(projectId, connection)}
                    >
                      <PencilIcon aria-hidden />
                      Edit
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="destructive-outline"
                      aria-label={`Disconnect Supabase from ${project?.title ?? rawProjectId}`}
                      onClick={() => setRemoveProjectId(projectId)}
                    >
                      <Trash2Icon aria-hidden />
                    </Button>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </SettingsSection>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editingProjectId === null ? "Connect Supabase" : "Edit Supabase connection"}
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
                disabled={editingProjectId !== null}
              >
                <SelectTrigger aria-label="Local project">
                  <SelectValue placeholder="Choose a project">{selectedProject?.title}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {(editingProjectId === null ? unconnectedProjects : projects).map((project) => (
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
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void saveConnection()} disabled={!formValid || isSaving}>
              {isSaving
                ? "Saving…"
                : editingProjectId === null
                  ? "Connect project"
                  : "Save changes"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog
        open={removeProjectId !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveProjectId(null);
        }}
      >
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>Disconnect Supabase?</DialogTitle>
            <DialogDescription>
              Threads in this project will immediately lose access to Supabase tools. The stored
              personal access token will be removed from the server.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveProjectId(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void removeConnection()}>
              Disconnect
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </SettingsPageContainer>
  );
}
