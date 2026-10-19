import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { SourceControlPublishRepositoryResult } from "./sourceControl.ts";

it("accepts only closed Git failure tags in a partial publish result", () => {
  const result = {
    repository: {
      provider: "github",
      nameWithOwner: "awtprod/sample",
      url: "https://github.com/awtprod/sample",
      sshUrl: "git@github.com:awtprod/sample.git",
    },
    remoteName: "origin",
    remoteUrl: "https://github.com/awtprod/sample.git",
    branch: "main",
    status: "push_failed",
  };
  const decode = Schema.decodeUnknownSync(SourceControlPublishRepositoryResult);
  assert.equal(
    decode({ ...result, failureReason: "authentication_failed" }).failureReason,
    "authentication_failed",
  );
  assert.throws(() => decode({ ...result, failureReason: "token=should-not-cross" }));
});
