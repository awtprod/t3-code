import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_SERVER_SETTINGS, ProjectId } from "@t3tools/contracts";

import { removeDatabaseConnection, upsertSupabaseConnection } from "./DatabaseSettings";

describe("Supabase database settings helpers", () => {
  it("preserves a redacted token when editing other connection fields", () => {
    const projectId = ProjectId.make("project-a");
    const current = {
      [projectId]: {
        provider: "supabase" as const,
        workspaceRoot: "/work/project-a",
        projectRef: "old-ref",
        readOnly: true,
        accessToken: "",
        accessTokenRedacted: true,
      },
    };

    expect(
      upsertSupabaseConnection(current, {
        projectId,
        workspaceRoot: "/work/project-a",
        projectRef: "new-ref",
        readOnly: false,
        accessToken: "",
      })[projectId],
    ).toEqual({
      provider: "supabase",
      workspaceRoot: "/work/project-a",
      projectRef: "new-ref",
      readOnly: false,
      accessToken: "",
      accessTokenRedacted: true,
    });
  });

  it("replaces a token and removes only the selected project", () => {
    const projectId = ProjectId.make("project-a");
    const next = upsertSupabaseConnection(DEFAULT_SERVER_SETTINGS.databaseConnections, {
      projectId,
      workspaceRoot: "/work/project-a",
      projectRef: "new-ref",
      readOnly: true,
      accessToken: "sbp-new",
    });

    expect(next[projectId]?.accessToken).toBe("sbp-new");
    expect(next[projectId]?.accessTokenRedacted).toBeUndefined();
    expect(removeDatabaseConnection(next, projectId)).toEqual({});
  });
});
