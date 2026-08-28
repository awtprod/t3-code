import { describe, expect, it } from "@effect/vitest";
import {
  asSandboxGitRemoteUrl,
  DEFAULT_SANDBOX_GIT_IDENTITY,
  resolveSandboxGitIdentity,
} from "./SandboxGitIdentity.ts";

describe("SandboxGitIdentity", () => {
  it("uses a complete override or the stable fallback", () => {
    expect(
      resolveSandboxGitIdentity({
        T3_SANDBOX_GIT_USER_NAME: "Andrew",
        T3_SANDBOX_GIT_USER_EMAIL: "andrew@example.test",
      }),
    ).toEqual({ name: "Andrew", email: "andrew@example.test" });
    expect(resolveSandboxGitIdentity({ T3_SANDBOX_GIT_USER_NAME: "partial" })).toEqual(
      DEFAULT_SANDBOX_GIT_IDENTITY,
    );
  });

  it("keeps credential-free network remotes and omits host-local or credentialed remotes", () => {
    expect(asSandboxGitRemoteUrl("https://github.com/contributor/repo.git")).toBe(
      "https://github.com/contributor/repo.git",
    );
    expect(asSandboxGitRemoteUrl("git@github.com:contributor/repo.git")).toBe(
      "git@github.com:contributor/repo.git",
    );
    expect(asSandboxGitRemoteUrl("/srv/git/repo.git")).toBeUndefined();
    expect(asSandboxGitRemoteUrl("file:///srv/git/repo.git")).toBeUndefined();
  });
});
