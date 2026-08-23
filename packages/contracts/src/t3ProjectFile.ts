import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { ThreadEnvMode } from "./environment.ts";
import { ProjectScriptIcon } from "./orchestration.ts";
import { SandboxResourceLimits } from "./sandbox.ts";

/** File name of the checked-in T3 project file, resolved at the workspace root. */
export const T3_PROJECT_FILE_NAME = "t3.json";

/** Public URL of the published JSON Schema for {@link T3ProjectFile}. */
export const T3_PROJECT_FILE_SCHEMA_URL = "https://t3.codes/schema/t3.json";

const T3_PROJECT_FILE_PATH_MAX_LENGTH = 512;
const T3_PROJECT_FILE_MAX_SCRIPTS = 50;
const T3_PROJECT_FILE_MAX_SANDBOX_ITEMS = 32;

// Annotations go on the encoded (string) side so they survive into the
// published JSON Schema; decoding still trims and re-validates non-emptiness.
const trimmedNonEmpty = (annotations: { readonly description: string }, maxLength?: number) => {
  const annotated = Schema.String.annotate(annotations);
  const encoded =
    maxLength === undefined
      ? annotated.check(Schema.isNonEmpty())
      : annotated.check(Schema.isNonEmpty(), Schema.isMaxLength(maxLength));
  return encoded.pipe(Schema.decodeTo(encoded, SchemaTransformation.trim()));
};

export const T3ProjectFileScript = Schema.Struct({
  name: trimmedNonEmpty({
    description: "Display name for the script, shown in the T3 Code scripts menu.",
  }),
  command: trimmedNonEmpty({
    description: "Shell command executed in a T3 Code terminal at the project root.",
  }),
  icon: Schema.optionalKey(
    ProjectScriptIcon.annotate({
      description: 'Icon shown next to the script in the scripts menu. Defaults to "play".',
    }),
  ),
  runOnWorktreeCreate: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "When true, the script runs automatically after a worktree is created for a new thread.",
    }),
  ),
  previewUrl: Schema.optionalKey(
    trimmedNonEmpty({
      description:
        "URL opened in the in-app browser preview when this script runs. Only honored on the desktop build.",
    }),
  ),
  autoOpenPreview: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "When true, automatically open the preview panel at `previewUrl` the moment the script starts.",
    }),
  ),
}).annotate({
  description: "A project script that team members can import into T3 Code.",
});
export type T3ProjectFileScript = typeof T3ProjectFileScript.Type;

const digestPinnedImage = trimmedNonEmpty(
  { description: "OCI image pinned by an immutable sha256 digest." },
  256,
).check(Schema.isPattern(/^[a-z0-9][a-z0-9._/-]{0,200}@sha256:[a-f0-9]{64}$/i));
const sandboxPath = trimmedNonEmpty(
  { description: "Absolute path inside the sandbox." },
  512,
).check(Schema.isPattern(/^\/(?!.*(?:^|\/)\.\.(?:\/|$))[^\0]*$/));
const sandboxCommand = Schema.Struct({
  executable: trimmedNonEmpty({ description: "Executable name or absolute sandbox path." }, 256),
  args: Schema.optionalKey(
    Schema.Array(Schema.String.check(Schema.isMaxLength(16_384))).check(Schema.isMaxLength(256)),
  ),
});
const sandboxService = Schema.Struct({
  name: trimmedNonEmpty({ description: "Thread-local service hostname." }, 63).check(
    Schema.isPattern(/^[a-z][a-z0-9-]*$/),
  ),
  image: digestPinnedImage,
  internalPorts: Schema.optionalKey(
    Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 }))).check(
      Schema.isMaxLength(32),
    ),
  ),
  volumes: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        name: trimmedNonEmpty({ description: "Thread-local volume name." }, 63).check(
          Schema.isPattern(/^[a-z][a-z0-9-]*$/),
        ),
        target: sandboxPath,
      }),
    ).check(Schema.isMaxLength(32)),
  ),
  healthCheck: Schema.optionalKey(
    Schema.Struct({
      executable: trimmedNonEmpty(
        { description: "Health-check executable inside the service container." },
        256,
      ),
      args: Schema.optionalKey(
        Schema.Array(Schema.String.check(Schema.isMaxLength(4096))).check(Schema.isMaxLength(64)),
      ),
      intervalSeconds: Schema.optionalKey(
        Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 300 })),
      ),
      timeoutSeconds: Schema.optionalKey(
        Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60 })),
      ),
      retries: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 30 }))),
    }),
  ),
  generatedEnvironment: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        key: Schema.String.check(Schema.isPattern(/^[A-Z_][A-Z0-9_]{0,127}$/)),
        kind: Schema.Literals(["database-name", "username", "password"]),
      }),
    ).check(Schema.isMaxLength(32)),
  ),
});
export const T3ProjectFileSandbox = Schema.Struct({
  image: digestPinnedImage,
  limits: Schema.optionalKey(SandboxResourceLimits),
  services: Schema.optionalKey(
    Schema.Array(sandboxService).check(Schema.isMaxLength(T3_PROJECT_FILE_MAX_SANDBOX_ITEMS)),
  ),
  setup: Schema.optionalKey(
    Schema.Array(sandboxCommand).check(Schema.isMaxLength(T3_PROJECT_FILE_MAX_SANDBOX_ITEMS)),
  ),
  teardown: Schema.optionalKey(
    Schema.Array(sandboxCommand).check(Schema.isMaxLength(T3_PROJECT_FILE_MAX_SANDBOX_ITEMS)),
  ),
  caches: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/i)),
        target: sandboxPath,
      }),
    ).check(Schema.isMaxLength(T3_PROJECT_FILE_MAX_SANDBOX_ITEMS)),
  ),
  previewPorts: Schema.optionalKey(
    Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 }))).check(
      Schema.isMaxLength(32),
    ),
  ),
});
export type T3ProjectFileSandbox = typeof T3ProjectFileSandbox.Type;

export const T3ProjectFile = Schema.Struct({
  $schema: Schema.optionalKey(
    Schema.String.annotate({
      description: `URL of the JSON Schema for this file, typically "${T3_PROJECT_FILE_SCHEMA_URL}".`,
    }),
  ),
  iconPath: Schema.optionalKey(
    trimmedNonEmpty(
      {
        description:
          'Workspace-relative path to the project icon (e.g. "assets/logo.svg"). Checked before T3 Code\'s built-in icon locations.',
      },
      T3_PROJECT_FILE_PATH_MAX_LENGTH,
    ),
  ),
  defaultThreadEnvMode: Schema.optionalKey(
    ThreadEnvMode.annotate({
      description:
        'Where new threads start for this repository: "worktree" for a fresh git worktree, "local" for the current checkout. A per-project setting in T3 Code overrides this; when neither is set, the global default applies.',
    }),
  ),
  scripts: Schema.optionalKey(
    Schema.Array(T3ProjectFileScript)
      .annotate({
        description: "Project scripts shared with everyone who opens this repository in T3 Code.",
      })
      .check(Schema.isMaxLength(T3_PROJECT_FILE_MAX_SCRIPTS)),
  ),
  sandbox: Schema.optionalKey(T3ProjectFileSandbox),
}).annotate({
  title: "T3 project file",
  description:
    "Checked-in project configuration for T3 Code (t3.json at the repository root). See https://t3.codes for documentation.",
});
export type T3ProjectFile = typeof T3ProjectFile.Type;
