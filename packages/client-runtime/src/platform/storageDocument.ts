import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  type BearerConnectionProfile,
  type ConnectionRegistration,
  ConnectionCredential,
  ConnectionProfile,
} from "../connection/catalog.ts";
import { type ConnectionTarget, PersistedConnectionTarget } from "../connection/model.ts";
import * as TokenStore from "../authorization/tokenStore.ts";
import { StoredGitHubRoutingPermission } from "../connection/githubRoutingPermissions.ts";

export const StoredConnectionCredential = Schema.Struct({
  connectionId: Schema.String,
  credential: ConnectionCredential,
});
export type StoredConnectionCredential = typeof StoredConnectionCredential.Type;

export const ConnectionCatalogDocument = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  targets: Schema.Array(PersistedConnectionTarget),
  profiles: Schema.Array(ConnectionProfile),
  credentials: Schema.Array(StoredConnectionCredential),
  remoteDpopTokens: Schema.Array(TokenStore.RemoteDpopAccessToken),
  githubRoutingPermissions: Schema.optionalKey(Schema.Array(StoredGitHubRoutingPermission)),
  // Saved environments the user switched off. They stay registered with their
  // credentials and cache but never connect until switched back on. Older
  // documents predate the key, so decoding defaults it to none.
  disabledEnvironmentIds: Schema.Array(EnvironmentId).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
});
export type ConnectionCatalogDocument = typeof ConnectionCatalogDocument.Type;

export const EMPTY_CONNECTION_CATALOG_DOCUMENT: ConnectionCatalogDocument = Object.freeze({
  schemaVersion: 1,
  targets: [],
  profiles: [],
  credentials: [],
  remoteDpopTokens: [],
  disabledEnvironmentIds: [],
});

export function replaceCatalogValue<A>(
  values: ReadonlyArray<A>,
  key: (value: A) => string,
  next: A,
): ReadonlyArray<A> {
  const nextKey = key(next);
  return [...values.filter((value) => key(value) !== nextKey), next];
}

export function removeCatalogValue<A>(
  values: ReadonlyArray<A>,
  key: (value: A) => string,
  removedKey: string,
): ReadonlyArray<A> {
  return values.filter((value) => key(value) !== removedKey);
}

function connectionIdOf(target: ConnectionTarget): string | null {
  switch (target._tag) {
    case "PrimaryConnectionTarget":
    case "RelayConnectionTarget":
      return null;
    case "BearerConnectionTarget":
    case "SshConnectionTarget":
      return target.connectionId;
  }
}

function routeKey(target: ConnectionTarget): string {
  return connectionIdOf(target) ?? target._tag;
}

function removeRouteMetadata(
  document: ConnectionCatalogDocument,
  removed: ReadonlyArray<ConnectionTarget>,
): ConnectionCatalogDocument {
  const connectionIds = new Set(removed.flatMap((target) => connectionIdOf(target) ?? []));
  const relayRemoved = removed.some((target) => target._tag === "RelayConnectionTarget");
  const environmentIds = new Set(removed.map((target) => target.environmentId));
  return {
    ...document,
    profiles: document.profiles.filter((value) => !connectionIds.has(value.connectionId)),
    credentials: document.credentials.filter((value) => !connectionIds.has(value.connectionId)),
    // The DPoP token belongs to the T3 Connect route.
    remoteDpopTokens: relayRemoved
      ? document.remoteDpopTokens.filter((value) => !environmentIds.has(value.environmentId))
      : document.remoteDpopTokens,
  };
}

/**
 * Normalizes a saved bearer URL the way the desktop main process does when it
 * looks up the remote primary's credential: http(s) only, no userinfo, query or
 * fragment, trailing slashes collapsed to one. Anything else never matches.
 */
function normalizeSavedBearerUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password || url.search || url.hash) return null;
    url.pathname = url.pathname.replace(/\/*$/, "/");
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * True when `candidate` is another bearer profile for the same environment and
 * the same server URL as `current`. Such a profile can only hold an older bearer
 * for that exact server: the renderer resolves the target's connection, and the
 * desktop main process matches the remote primary by URL, so keeping it lets a
 * stale token be sent in place of the current one.
 *
 * Profiles for the same environment at a different URL are kept on purpose.
 * The main process can still be pointed at that URL, and one environment may be
 * reachable over several routes.
 */
function isSupersededBearerProfile(
  candidate: ConnectionCatalogDocument["profiles"][number],
  current: BearerConnectionProfile,
): boolean {
  if (
    candidate._tag !== "BearerConnectionProfile" ||
    candidate.connectionId === current.connectionId ||
    candidate.environmentId !== current.environmentId
  ) {
    return false;
  }
  const currentUrl = normalizeSavedBearerUrl(current.httpBaseUrl);
  return currentUrl !== null && normalizeSavedBearerUrl(candidate.httpBaseUrl) === currentUrl;
}

/**
 * Drops the bearer profiles, and their credentials, that `current` supersedes.
 * A connection that any saved target references is never dropped.
 */
function dropSupersededBearerConnections(
  document: ConnectionCatalogDocument,
  current: BearerConnectionProfile,
): { readonly document: ConnectionCatalogDocument; readonly dropped: ReadonlyArray<string> } {
  const referenced = new Set(
    document.targets.flatMap((target) =>
      target._tag === "BearerConnectionTarget" || target._tag === "SshConnectionTarget"
        ? [target.connectionId]
        : [],
    ),
  );
  const dropped = new Set(
    document.profiles
      .filter(
        (profile) =>
          isSupersededBearerProfile(profile, current) && !referenced.has(profile.connectionId),
      )
      .map((profile) => profile.connectionId),
  );
  if (dropped.size === 0) {
    return { document, dropped: [] };
  }
  return {
    document: {
      ...document,
      profiles: document.profiles.filter((profile) => !dropped.has(profile.connectionId)),
      credentials: document.credentials.filter((entry) => !dropped.has(entry.connectionId)),
    },
    dropped: [...dropped],
  };
}

/**
 * Removes orphaned bearer connections that older builds left behind: for each
 * saved bearer target, every other bearer profile (and its credential) for the
 * same environment and URL that no target references. Returns the input
 * document itself when there is nothing to remove.
 */
export function pruneSupersededBearerConnections(document: ConnectionCatalogDocument): {
  readonly document: ConnectionCatalogDocument;
  readonly dropped: ReadonlyArray<string>;
} {
  let next = document;
  const dropped: Array<string> = [];
  for (const target of document.targets) {
    if (target._tag !== "BearerConnectionTarget") continue;
    const current = next.profiles.find(
      (profile): profile is BearerConnectionProfile =>
        profile._tag === "BearerConnectionProfile" &&
        profile.connectionId === target.connectionId &&
        profile.environmentId === target.environmentId,
    );
    if (current === undefined) continue;
    const result = dropSupersededBearerConnections(next, current);
    next = result.document;
    dropped.push(...result.dropped);
  }
  return { document: next, dropped };
}

/**
 * An environment's saved routes in preference order. Targets of one
 * environment keep their relative order in `targets`, so a document written
 * before routes existed is one environment with one route.
 */
export function catalogRoutes(
  document: ConnectionCatalogDocument,
  environmentId: EnvironmentId,
): ReadonlyArray<PersistedConnectionTarget> {
  return document.targets.filter((target) => target.environmentId === environmentId);
}

/**
 * Replaces an environment's routes with `routes`, preferred first. Records
 * owned by a dropped route go with it; the environment keeps its position in
 * the catalog. An empty list leaves the environment's other records in place;
 * use `removeConnectionFromCatalog` to forget the environment.
 */
export function setRoutesInCatalog(
  document: ConnectionCatalogDocument,
  environmentId: EnvironmentId,
  routes: ReadonlyArray<PersistedConnectionTarget>,
): ConnectionCatalogDocument {
  const kept = new Set(routes.map(routeKey));
  const dropped = catalogRoutes(document, environmentId).filter(
    (target) => !kept.has(routeKey(target)),
  );
  const firstIndex = document.targets.findIndex((target) => target.environmentId === environmentId);
  const others = document.targets.filter((target) => target.environmentId !== environmentId);
  const insertAt =
    firstIndex === -1
      ? others.length
      : document.targets.slice(0, firstIndex).filter((t) => t.environmentId !== environmentId)
          .length;
  return {
    ...removeRouteMetadata(document, dropped),
    targets: [...others.slice(0, insertAt), ...routes, ...others.slice(insertAt)],
  };
}

/** Saves one route of an environment, keeping its other routes. */
export function registerConnectionInCatalog(
  document: ConnectionCatalogDocument,
  registration: ConnectionRegistration,
  routes: ReadonlyArray<PersistedConnectionTarget> = [registration.target],
): ConnectionCatalogDocument {
  // Re-registering (for example editing a label or URL) keeps the disabled
  // flag; only `setConnectionEnabledInCatalog` or removal changes it.
  const next = setRoutesInCatalog(document, registration.target.environmentId, routes);

  switch (registration._tag) {
    case "RelayConnectionRegistration":
      return next;
    case "BearerConnectionRegistration": {
      // Removing only dropped routes leaves any other bearer saved for this
      // server behind (for example one whose target was already gone), and the
      // desktop main process could pick its stale token. The new bearer
      // supersedes every unreferenced one for the same environment and URL.
      const pruned = dropSupersededBearerConnections(next, registration.profile).document;
      return {
        ...pruned,
        profiles: replaceCatalogValue(
          pruned.profiles,
          (value) => value.connectionId,
          registration.profile,
        ),
        credentials: replaceCatalogValue(pruned.credentials, (value) => value.connectionId, {
          connectionId: registration.target.connectionId,
          credential: registration.credential,
        }),
      };
    }
    case "SshConnectionRegistration":
      return {
        ...next,
        profiles: replaceCatalogValue(
          next.profiles,
          (value) => value.connectionId,
          registration.profile,
        ),
      };
  }
}

/** Forgets an environment and every route it had. */
export function removeConnectionFromCatalog(
  document: ConnectionCatalogDocument,
  environmentId: EnvironmentId,
): ConnectionCatalogDocument {
  const next = setRoutesInCatalog(document, environmentId, []);
  return {
    ...next,
    remoteDpopTokens: removeCatalogValue(
      next.remoteDpopTokens,
      (value) => value.environmentId,
      environmentId,
    ),
    disabledEnvironmentIds: removeCatalogValue(
      next.disabledEnvironmentIds,
      (value) => value,
      environmentId,
    ),
    ...(next.githubRoutingPermissions === undefined
      ? {}
      : {
          githubRoutingPermissions: next.githubRoutingPermissions.filter(
            (permission) => permission.environmentId !== environmentId,
          ),
        }),
  };
}

/** Flips the disabled flag for a saved environment; unknown ids are ignored. */
export function setConnectionEnabledInCatalog(
  document: ConnectionCatalogDocument,
  environmentId: EnvironmentId,
  enabled: boolean,
): ConnectionCatalogDocument {
  const registered = document.targets.some((target) => target.environmentId === environmentId);
  const without = removeCatalogValue(
    document.disabledEnvironmentIds,
    (value) => value,
    environmentId,
  );
  return {
    ...document,
    disabledEnvironmentIds: registered && !enabled ? [...without, environmentId] : without,
  };
}

export function putRemoteDpopTokenInCatalog(
  document: ConnectionCatalogDocument,
  token: TokenStore.RemoteDpopAccessToken,
): ConnectionCatalogDocument {
  const registered = document.targets.some(
    (target) =>
      target._tag === "RelayConnectionTarget" && target.environmentId === token.environmentId,
  );
  if (!registered) {
    return document;
  }
  return {
    ...document,
    remoteDpopTokens: replaceCatalogValue(
      document.remoteDpopTokens,
      (value) => value.environmentId,
      token,
    ),
  };
}
