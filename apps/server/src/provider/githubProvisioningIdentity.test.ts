import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";

import {
  GITHUB_IDENTITY_VARIABLE,
  GITHUB_PROVISIONING_IDENTITY_VARIABLE,
  withGitHubProvisioningIdentity,
} from "./githubProvisioningIdentity.ts";

const CLAUDE_AGENT_DRIVER = ProviderDriverKind.make("claudeAgent");
const CODEX_DRIVER = ProviderDriverKind.make("codex");

const provisioningValue = (
  environment: ReadonlyArray<{ readonly name: string; readonly value: string }>,
): string | undefined =>
  environment.find((variable) => variable.name === GITHUB_PROVISIONING_IDENTITY_VARIABLE)?.value;

it("pins the provisioning identity to the instance's own identity", () => {
  const environment = withGitHubProvisioningIdentity(ProviderInstanceId.make("claude-custom"), {
    driver: CLAUDE_AGENT_DRIVER,
    environment: [{ name: GITHUB_IDENTITY_VARIABLE, value: "primary", sensitive: false }],
  });
  expect(provisioningValue(environment)).toBe("primary");
  // The mismatch check reads the identity variable; leaving it untouched is
  // what keeps a session out of another identity's mapped directory.
  expect(environment.find((variable) => variable.name === GITHUB_IDENTITY_VARIABLE)?.value).toBe(
    "primary",
  );
});

it("derives the identity from the wrapper binary and the instance id", () => {
  expect(
    provisioningValue(
      withGitHubProvisioningIdentity(ProviderInstanceId.make("claude-custom"), {
        driver: CLAUDE_AGENT_DRIVER,
        config: { binaryPath: "/opt/command-center/bin/claude-fixture" },
      }),
    ),
  ).toBe("fixture");
  expect(
    provisioningValue(
      withGitHubProvisioningIdentity(ProviderInstanceId.make("codex-primary"), {
        driver: CODEX_DRIVER,
      }),
    ),
  ).toBe("primary");
});

it("leaves the environment alone when no identity can be resolved", () => {
  const environment = withGitHubProvisioningIdentity(ProviderInstanceId.make("codex"), {
    driver: CODEX_DRIVER,
  });
  expect(environment).toEqual([]);
});

it("never shadows an explicitly configured provisioning identity", () => {
  const explicit = withGitHubProvisioningIdentity(ProviderInstanceId.make("claude-primary"), {
    driver: CLAUDE_AGENT_DRIVER,
    environment: [
      { name: GITHUB_PROVISIONING_IDENTITY_VARIABLE, value: "secondary", sensitive: false },
    ],
  });
  expect(provisioningValue(explicit)).toBe("secondary");

  // A redacted value lives outside the config; deriving over it would swap
  // the identity out from under the operator.
  const redacted = withGitHubProvisioningIdentity(ProviderInstanceId.make("claude-primary"), {
    driver: CLAUDE_AGENT_DRIVER,
    environment: [
      {
        name: GITHUB_PROVISIONING_IDENTITY_VARIABLE,
        value: "",
        sensitive: true,
        valueRedacted: true,
      },
    ],
  });
  expect(redacted).toHaveLength(1);
  expect(provisioningValue(redacted)).toBe("");
});
