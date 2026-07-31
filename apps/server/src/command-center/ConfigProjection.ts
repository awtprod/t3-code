import type { LoadedCommandCenterConfig } from "./Config.ts";

export interface ConfigSyncState {
  readonly fingerprint: string;
  readonly observed: LoadedCommandCenterConfig;
  readonly projection: LoadedCommandCenterConfig | null;
}

export const configProjectionFingerprint = (loaded: LoadedCommandCenterConfig): string =>
  JSON.stringify({
    health: loaded.health,
    timezone: loaded.timezone,
    routing: loaded.routing,
    spaces: loaded.spaces.map(
      ({ createdAt: _createdAt, updatedAt: _updatedAt, ...space }) => space,
    ),
    connections: loaded.connections.map(
      ({ lastCheckedAt: _lastCheckedAt, ...connection }) => connection,
    ),
    automations: loaded.automations,
  });
