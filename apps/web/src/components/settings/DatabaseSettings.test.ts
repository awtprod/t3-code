import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_SERVER_SETTINGS, DatabaseConnectionId, ProjectId } from "@t3tools/contracts";

import {
  connectionsForProject,
  newDatabaseConnectionId,
  removeDatabaseConnection,
  setDefaultDatabaseConnection,
  upsertSupabaseConnection,
  validateConnectionLabel,
} from "./DatabaseSettings";

const projectId = ProjectId.make("project-a");
const otherProjectId = ProjectId.make("project-b");
const stagingId = DatabaseConnectionId.make("conn-staging");
const prodId = DatabaseConnectionId.make("conn-prod");
const otherId = DatabaseConnectionId.make("conn-other");

const draft = (
  connectionId: DatabaseConnectionId,
  overrides: Partial<Parameters<typeof upsertSupabaseConnection>[1]> = {},
) => ({
  connectionId,
  projectId,
  workspaceRoot: "/work/project-a",
  label: "",
  isDefault: false,
  projectRef: `ref-${connectionId}`,
  accessToken: "sbp-token",
  readOnly: true,
  ...overrides,
});

describe("Supabase database settings helpers", () => {
  it("makes a project's first connection its default and keeps at most one default", () => {
    const one = upsertSupabaseConnection(
      DEFAULT_SERVER_SETTINGS.databaseConnections,
      draft(stagingId, { label: "staging" }),
    );
    expect(one[stagingId]?.isDefault).toBe(true);

    const two = upsertSupabaseConnection(one, draft(prodId, { label: "prod", readOnly: false }));
    expect(two[stagingId]?.isDefault).toBe(true);
    expect(two[prodId]?.isDefault).toBe(false);

    const promoted = upsertSupabaseConnection(
      two,
      draft(prodId, { label: "prod", readOnly: false, isDefault: true }),
    );
    expect(promoted[stagingId]?.isDefault).toBe(false);
    expect(promoted[prodId]?.isDefault).toBe(true);

    // Another project's connections are untouched by default changes.
    const withOther = upsertSupabaseConnection(
      promoted,
      draft(otherId, { projectId: otherProjectId, workspaceRoot: "/work/project-b" }),
    );
    expect(withOther[otherId]?.isDefault).toBe(true);
    expect(setDefaultDatabaseConnection(withOther, stagingId)[otherId]?.isDefault).toBe(true);
    expect(setDefaultDatabaseConnection(withOther, stagingId)[prodId]?.isDefault).toBe(false);
  });

  it("preserves a redacted token when editing other connection fields", () => {
    const current = {
      [stagingId]: {
        provider: "supabase" as const,
        projectId,
        workspaceRoot: "/work/project-a",
        label: "staging",
        isDefault: true,
        projectRef: "old-ref",
        readOnly: true,
        accessToken: "",
        accessTokenRedacted: true,
      },
    };

    expect(
      upsertSupabaseConnection(
        current,
        draft(stagingId, {
          label: "staging",
          projectRef: "new-ref",
          readOnly: false,
          accessToken: "",
        }),
      )[stagingId],
    ).toEqual({
      provider: "supabase",
      projectId,
      workspaceRoot: "/work/project-a",
      label: "staging",
      isDefault: true,
      projectRef: "new-ref",
      readOnly: false,
      accessToken: "",
      accessTokenRedacted: true,
    });
  });

  it("replaces a token and hands the default to a sibling when the default is removed", () => {
    const two = upsertSupabaseConnection(
      upsertSupabaseConnection(
        DEFAULT_SERVER_SETTINGS.databaseConnections,
        draft(stagingId, { label: "staging" }),
      ),
      draft(prodId, { label: "prod", accessToken: "sbp-new" }),
    );
    expect(two[prodId]?.accessToken).toBe("sbp-new");
    expect(two[prodId]?.accessTokenRedacted).toBeUndefined();

    const afterRemove = removeDatabaseConnection(two, stagingId);
    expect(Object.keys(afterRemove)).toEqual([prodId]);
    expect(afterRemove[prodId]?.isDefault).toBe(true);
    expect(removeDatabaseConnection(afterRemove, prodId)).toEqual({});
  });

  it("lists a project's connections default-first and requires unique labels once there are several", () => {
    const two = upsertSupabaseConnection(
      upsertSupabaseConnection(
        DEFAULT_SERVER_SETTINGS.databaseConnections,
        draft(prodId, { label: "prod" }),
      ),
      draft(stagingId, { label: "alpha", isDefault: true }),
    );
    expect(connectionsForProject(two, projectId).map(([id]) => id)).toEqual([stagingId, prodId]);
    expect(connectionsForProject(two, otherProjectId)).toEqual([]);

    expect(
      validateConnectionLabel(two, { connectionId: prodId, projectId, label: "prod" }),
    ).toBeNull();
    expect(
      validateConnectionLabel(two, {
        connectionId: newDatabaseConnectionId(),
        projectId,
        label: "",
      }),
    ).toMatch(/name/i);
    expect(
      validateConnectionLabel(two, {
        connectionId: newDatabaseConnectionId(),
        projectId,
        label: "PROD",
      }),
    ).toMatch(/already/i);
    // A lone connection may stay unlabeled; its project ref is the name.
    expect(
      validateConnectionLabel(DEFAULT_SERVER_SETTINGS.databaseConnections, {
        connectionId: stagingId,
        projectId,
        label: "",
      }),
    ).toBeNull();
    // Unlabeled legacy siblings are matched by project ref.
    const legacy = {
      [prodId]: { ...two[prodId]!, label: "" },
    };
    expect(
      validateConnectionLabel(legacy, {
        connectionId: stagingId,
        projectId,
        label: `ref-${prodId}`,
      }),
    ).toMatch(/already/i);
  });
});
