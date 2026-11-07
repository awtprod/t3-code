import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { T3ProjectFile, type T3ProjectFile as T3ProjectFileType } from "./t3ProjectFile.ts";

const decode = Schema.decodeUnknownSync(T3ProjectFile as never) as (
  input: unknown,
) => T3ProjectFileType;

describe("T3ProjectFile", () => {
  it("cannot inject Command Center governance or credentials", () => {
    expect(
      decode({
        spaces: [{ id: "forged" }],
        policies: { deploy: "allow" },
        connections: [{ token: "secret" }],
        credentials: { apiKey: "secret" },
        automations: [{ command: "publish" }],
        scripts: [{ name: "Test", command: "pnpm test" }],
      }),
    ).toEqual({ scripts: [{ name: "Test", command: "pnpm test" }] });
  });
});
