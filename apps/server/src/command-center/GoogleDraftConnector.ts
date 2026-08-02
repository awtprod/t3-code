import type { SalesDraftRequest as SalesDraftRequestType } from "@command-center/core";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import { ProcessRunner, type ProcessRunError } from "../processRunner.ts";
import { ServerConfig } from "../config.ts";
import { CommandCenterConfig } from "./Config.ts";
import { ConnectionHealth } from "./ConnectionHealth.ts";
import { hasPinnedGogVersion, PINNED_GOG_VERSION } from "./GoogleReadConnector.ts";

export const GOOGLE_DRAFT_COMMAND_ALLOWLIST = [
  "gmail.drafts.create",
  "gmail.drafts.list",
  "gmail.drafts.get",
] as const;

export type GoogleDraftSelection = Pick<SalesDraftRequestType, "spaceId" | "connectionId">;

export class GoogleDraftConnectorError extends Schema.TaggedErrorClass<GoogleDraftConnectorError>()(
  "GoogleDraftConnectorError",
  {
    reason: Schema.Literals(["configuration", "version", "process", "output"]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const baseArgs = (account: string): ReadonlyArray<string> => [
  "--account",
  account,
  "--gmail-no-send",
  "--no-input",
  "--json",
  "--enable-commands-exact",
  GOOGLE_DRAFT_COMMAND_ALLOWLIST.join(","),
];

export const buildGoogleDraftCreateInvocation = (
  account: string,
  request: Pick<SalesDraftRequestType, "recipient" | "subject">,
): ReadonlyArray<string> => [
  ...baseArgs(account),
  "gmail",
  "drafts",
  "create",
  "--to",
  request.recipient,
  "--subject",
  request.subject,
  "--body-file",
  "-",
];

export const buildGoogleDraftListInvocation = (account: string): ReadonlyArray<string> => [
  ...baseArgs(account),
  "gmail",
  "drafts",
  "list",
  "--max",
  "100",
];

export const buildGoogleDraftGetInvocation = (
  account: string,
  draftId: string,
): ReadonlyArray<string> => [...baseArgs(account), "gmail", "drafts", "get", "--", draftId];

const decodeUnknownJsonString = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);

const collectIds = (value: unknown, ids: Set<string>): void => {
  if (Array.isArray(value)) {
    for (const entry of value) collectIds(entry, ids);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if ((key === "id" || key === "draftId" || key === "draft_id") && typeof entry === "string") {
      ids.add(entry);
    }
    collectIds(entry, ids);
  }
};

const collectStrings = (value: unknown, strings: string[]): void => {
  if (typeof value === "string") {
    strings.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, strings);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const entry of Object.values(value)) collectStrings(entry, strings);
};

const normalizeText = (value: string): string => value.replace(/\r\n/gu, "\n").trim();

export const googleDraftMatches = (
  data: unknown,
  request: Pick<SalesDraftRequestType, "recipient" | "subject" | "body">,
): boolean => {
  const strings: string[] = [];
  collectStrings(data, strings);
  const normalized = new Set(strings.map(normalizeText));
  return (
    normalized.has(normalizeText(request.recipient)) &&
    normalized.has(normalizeText(request.subject)) &&
    normalized.has(normalizeText(request.body))
  );
};

const extractCreatedDraftId = (data: unknown): string | undefined => {
  if (data !== null && typeof data === "object") {
    const record = data as Readonly<Record<string, unknown>>;
    if (typeof record.draftId === "string") return record.draftId;
    if (typeof record.draft_id === "string") return record.draft_id;
    if (typeof record.id === "string") return record.id;
  }
  const ids = new Set<string>();
  collectIds(data, ids);
  return ids.values().next().value;
};

export interface GoogleDraftConnectorShape {
  readonly findExisting: (
    request: SalesDraftRequestType,
  ) => Effect.Effect<string | undefined, GoogleDraftConnectorError>;
  readonly create: (
    request: SalesDraftRequestType,
  ) => Effect.Effect<{ readonly draftId: string }, GoogleDraftConnectorError>;
}

export class GoogleDraftConnector extends Context.Service<
  GoogleDraftConnector,
  GoogleDraftConnectorShape
>()("@awtprod/command-center/command-center/GoogleDraftConnector") {}

const processFailure = (cause: ProcessRunError) =>
  new GoogleDraftConnectorError({
    reason: "process",
    message: "The Gmail draft connector could not be started.",
    cause,
  });

export const layer = Layer.effect(
  GoogleDraftConnector,
  Effect.gen(function* () {
    const runner = yield* ProcessRunner;
    const serverConfig = yield* ServerConfig;
    const config = yield* CommandCenterConfig;
    const health = yield* ConnectionHealth;
    const verified = yield* Ref.make(false);
    const binary = process.env.COMMAND_CENTER_GOG_BINARY ?? "gog";
    const gogHome = `${serverConfig.secretsDir}/gog`;
    const environment: NodeJS.ProcessEnv = {
      HOME: gogHome,
      XDG_CONFIG_HOME: gogHome,
      PATH: "/usr/local/bin:/usr/bin:/bin",
      ...(process.env.GOG_KEYRING_PASSWORD === undefined
        ? {}
        : { GOG_KEYRING_PASSWORD: process.env.GOG_KEYRING_PASSWORD }),
      ...(process.env.GOG_KEYRING_BACKEND === undefined
        ? {}
        : { GOG_KEYRING_BACKEND: process.env.GOG_KEYRING_BACKEND }),
    };

    const resolveAccount = (selection: GoogleDraftSelection) =>
      config.resolveGoogleAccount(selection).pipe(
        Effect.mapError(
          (cause) =>
            new GoogleDraftConnectorError({
              reason: "configuration",
              message: "The dedicated Gmail draft connection is not available in this Space.",
              cause,
            }),
        ),
      );

    const verify = Effect.fn("GoogleDraftConnector.verify")(function* () {
      if (yield* Ref.get(verified)) return;
      const result = yield* runner
        .run({ command: binary, args: ["--version"], env: environment, extendEnv: false })
        .pipe(Effect.mapError(processFailure));
      if (result.code !== 0 || !hasPinnedGogVersion(`${result.stdout}\n${result.stderr}`)) {
        return yield* new GoogleDraftConnectorError({
          reason: "version",
          message: `Command Center requires gog ${PINNED_GOG_VERSION}.`,
        });
      }
      yield* Ref.set(verified, true);
    });

    const runJson = Effect.fn("GoogleDraftConnector.runJson")(function* (input: {
      readonly args: ReadonlyArray<string>;
      readonly stdin?: string | undefined;
    }) {
      const result = yield* runner
        .run({
          command: binary,
          args: input.args,
          ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
          env: environment,
          extendEnv: false,
          timeout: "45 seconds",
          maxOutputBytes: 4 * 1024 * 1024,
        })
        .pipe(Effect.mapError(processFailure));
      if (result.code !== 0) {
        return yield* new GoogleDraftConnectorError({
          reason: "process",
          message: result.stderr.trim() || "The Gmail draft request failed.",
        });
      }
      return yield* decodeUnknownJsonString(result.stdout).pipe(
        Effect.mapError(
          (cause) =>
            new GoogleDraftConnectorError({
              reason: "output",
              message: "The Gmail draft connector returned invalid JSON.",
              cause,
            }),
        ),
      );
    });

    const withHealth = <A>(
      selection: GoogleDraftSelection,
      effect: Effect.Effect<A, GoogleDraftConnectorError>,
    ) =>
      effect.pipe(
        Effect.tap(() => health.markConnected(selection).pipe(Effect.ignore)),
        Effect.tapError(() => health.markDegraded(selection).pipe(Effect.ignore)),
      );

    const findExisting: GoogleDraftConnectorShape["findExisting"] = Effect.fn(
      "GoogleDraftConnector.findExisting",
    )(function* (request) {
      return yield* withHealth(
        request,
        Effect.gen(function* () {
          const account = yield* resolveAccount(request);
          yield* verify();
          const list = yield* runJson({
            args: buildGoogleDraftListInvocation(account.accountAlias),
          });
          const ids = new Set<string>();
          collectIds(list, ids);
          for (const id of ids) {
            const draft = yield* runJson({
              args: buildGoogleDraftGetInvocation(account.accountAlias, id),
            });
            if (googleDraftMatches(draft, request)) return id;
          }
          return undefined;
        }),
      );
    });

    const create: GoogleDraftConnectorShape["create"] = Effect.fn("GoogleDraftConnector.create")(
      function* (request) {
        return yield* withHealth(
          request,
          Effect.gen(function* () {
            const account = yield* resolveAccount(request);
            yield* verify();
            const output = yield* runJson({
              args: buildGoogleDraftCreateInvocation(account.accountAlias, request),
              stdin: request.body,
            });
            const draftId = extractCreatedDraftId(output);
            if (draftId === undefined) {
              return yield* new GoogleDraftConnectorError({
                reason: "output",
                message: "The Gmail draft connector did not return a draft id.",
              });
            }
            return { draftId };
          }),
        );
      },
    );

    return GoogleDraftConnector.of({ findExisting, create });
  }),
);
