# Release Checklist

This document covers the unified release workflow for stable and nightly desktop releases.

Beta is the product label, not a release channel or version suffix. Release channels
remain stable and nightly. To ship 0.1.0 Beta, use `channel=stable` and
`version=0.1.0`. Removing the Beta label later is a branding change independent of
the version.

## What the workflow does

- Workflow: `.github/workflows/release.yml`
- Triggers:
  - push tag matching `v*.*.*` for stable releases
  - scheduled nightly check every three hours
  - manual `workflow_dispatch` with an explicit `validate` or `publish` mode
- Runs lint, typecheck, and tests alongside artifact builds. Publishing waits for every check.
- Reads the shared production T3 Connect relay URL and Clerk client configuration before packaging clients.
- Builds four artifacts in parallel for both channels:
  - macOS `arm64` DMG
  - macOS `x64` DMG
  - Linux `x64` AppImage
  - Windows `x64` NSIS installer
- In `validate` mode, retains one consolidated signed artifact bundle for 14 days without publishing
  npm, GitHub Releases, Vercel deployments, tags, aliases, or version commits.
- In `publish` mode, publishes one GitHub Release with all produced files.
  - Stable tags with a suffix after `X.Y.Z` (for example `1.2.3-alpha.1`) are published as GitHub prereleases.
  - Only plain stable `X.Y.Z` releases are marked as the repository's latest release.
  - Nightly runs are always GitHub prereleases and never marked latest.
  - Automatically generated release notes are pinned to the previous tag in the same channel, so stable compares to the previous stable tag and nightly compares to the previous nightly tag.
- Includes Electron auto-update metadata (for example `latest*.yml`, `nightly*.yml`, and `*.blockmap`) in release assets.
- Generates `SHA256SUMS.txt` and validates every updater-manifest file path and byte size before publication.
- Publishes the CLI package (`apps/server`, npm package `@awtprod/command-center`) with OIDC trusted publishing from the same workflow file:
  - stable releases publish npm dist-tag `latest`
  - nightly releases publish npm dist-tag `nightly`
- Deploys the hosted web app to the dedicated `awtprod-command-center` Vercel project only after a
  release is published. Stable releases update its production `vercel.app` domain; nightlies retain
  the generated preview deployment URL.
- Stable versions, including validation runs and prereleases, fail closed unless macOS and Windows signing
  configuration is complete. Pre-release and nightly builds may be unsigned only when no partial
  signing configuration is present.

## Required release credentials

Stable releases require these GitHub Actions secrets in addition to the platform and deployment
credentials documented below:

- `RELEASE_APP_ID`
- `RELEASE_APP_PRIVATE_KEY`

The finalize job uses them to commit and push aligned package versions to `main` as the Release App.
GitHub Release publication uses the repository-scoped workflow token so it has a rate-limit quota
independent from the shared Release App installation.

## T3 Connect relay deployment

The relay is a shared control plane versioned separately from client releases. Stable and nightly
client builds must point at the same relay so users see the same linked environments when switching
release channels.

`.github/workflows/deploy-relay.yml` deploys Alchemy stage `prod` on every push to `main`. The
release workflow reads the relay URL and Clerk client configuration from the existing `production`
GitHub Actions environment before building desktop, CLI, or hosted web artifacts.

Required repository variables shared by relay deployments:

- `CLOUDFLARE_ACCOUNT_ID`
- `PLANETSCALE_ORGANIZATION`
- `AXIOM_ORG_ID`

Required repository secrets shared by relay deployments:

- `CLOUDFLARE_API_TOKEN`
- `PLANETSCALE_API_TOKEN_ID`
- `PLANETSCALE_API_TOKEN`
- `AXIOM_TOKEN`

Required `production` environment variables:

- `RELAY_API_ZONE_NAME`
- `RELAY_TUNNEL_ZONE_NAME`
- `CLERK_PUBLISHABLE_KEY`
- `CLERK_JWT_AUDIENCE`
- `CLERK_JWT_TEMPLATE`
- `CLERK_CLI_OAUTH_CLIENT_ID`
- `APNS_ENVIRONMENT`
- `APNS_TEAM_ID`
- `APNS_KEY_ID`
- `APNS_BUNDLE_ID`

Optional `production` environment variables:

- `RELAY_DOMAIN` when overriding the derived `relay.<RELAY_API_ZONE_NAME>` domain
- `RELAY_TUNNEL_CLEANUP_MODE` with `off`, `dry-run`, or `enabled`. Missing and blank values use
  `off`.
- `RELAY_LEGACY_TUNNEL_CLEANUP_MODE` with the same values, for tunnels whose host never registered
  recovery. Missing and blank values use `off`.

Required `production` environment secrets:

- `CLERK_SECRET_KEY`
- `APNS_PRIVATE_KEY`

After changing a variable or secret, run the **Deploy T3 Connect relay** workflow manually from
`main` with **force** unchecked. Alchemy compares the values the Worker reads and redeploys it when
one changed. Check **force** only to redeploy resources with no detected change: a forced run also
replaces the Postgres runtime role and its password
([alchemy-run/alchemy#1832](https://github.com/alchemy-run/alchemy/issues/1832)).

The account-scoped repository credentials are consumed by Alchemy while provisioning relay stages; they
are not bound into the relay Worker. The production deployment uses an Axiom personal access token,
so `AXIOM_ORG_ID` must accompany `AXIOM_TOKEN`. The `prod` stage owns the retained PlanetScale
database. Local personal stages provision isolated branches from it and are never deployed by CI.
Production adopts the configured relay API and tunnel DNS zones as retained Cloudflare resources.
Personal stages reference the production-owned zones.

Developers deploy personal stages locally rather than through pull-request automation:

```sh
vp run --filter t3code-relay deploy -- --stage "$USER" --env-file .env.local
```

### Managed tunnel cleanup rollout

Keep `RELAY_TUNNEL_CLEANUP_MODE=off` for the first production deploy. That deploy applies the
nullable allocation migration and adds the recovery endpoints. Web and mobile clients need no
coordinated release. CLI and desktop server builds must reach users before cleanup is enabled,
because those builds register recovery and replace a deleted tunnel after wake.

1. Deploy the relay and migration with cleanup `off`.
2. Release the server build and confirm current hosts register recovery. Older hosts stay marked
   legacy and are only candidates under the legacy switch below.
3. Set `dry-run`, run a relay deploy, and read the sweep counters (`scanned`, `wouldDelete`,
   `skippedLegacy`, `skippedOrphan`, `failed`, `truncated`) across several sweeps. Each sweep records
   them, and the active `mode`, as `relay.managed_endpoint_reaper.*` attributes on its
   `relay.managed_endpoint_reaper.sweep` span in Axiom.
4. Run the disposable-host canary below.
5. Set `enabled` only after the canary recovers without a server restart.

The job runs every five minutes with a five-minute grace period for tunnels that lost their
connector, so a candidate is usually removed five to ten minutes after it goes down. Tunnels that
never connected wait an hour. One sweep attempts at most 100 deletions, so a backlog takes longer.
Changing `RELAY_TUNNEL_CLEANUP_MODE`, including turning cleanup off during an incident, needs a relay
deploy without force. Confirm the new `mode` on the next sweep span.

To roll back, set cleanup to `off` and run a relay deploy before downgrading any host. Keep the
recovery endpoints deployed while current server builds are in use. The nullable columns can stay.

### Legacy tunnel cleanup

A legacy tunnel belongs to a host that never registered recovery, usually one that went offline
before the recovery build shipped. `RELAY_LEGACY_TUNNEL_CLEANUP_MODE` deletes these once Cloudflare
reports them down, or never connected, for more than 7 days. It is independent of
`RELAY_TUNNEL_CLEANUP_MODE`, and every other check still applies.

A deleted legacy tunnel keeps its allocation, so its hostname is kept. When the host comes back:

- On a build with recovery, the connector is rejected and the host requests a replacement tunnel at
  the same hostname.
- On an older build with a CLI link, startup provisions a new tunnel.
- On an older build linked from web or mobile, the host stays offline until T3 Code on that computer
  is updated.

Ship the web and mobile builds that show the offline reason before enabling legacy cleanup, so a
user whose host is affected sees what to do. The relay adds the `tunnel_released_at` allocation
column in its first deploy with this change; the legacy switch stays `off` until you set it.

1. Run `vp run --filter t3code-relay tunnels:census` with a read-only Cloudflare token. It counts
   tunnels in every relay stage. The reaper only sees its own stage's tunnels, so clean up the rest
   by hand.
2. Set the legacy mode to `dry-run`, deploy, and read `wouldDeleteLegacy`, `legacyOver30Days`,
   `totalDown`, and `totalInactive` on the sweep spans for a day. `wouldDeleteLegacy` counts only the
   tunnels a sweep inspected, at most 500 per status. `totalDown` and `totalInactive` are Cloudflare's
   counts of this stage's tunnels down for over five minutes and never connected for over an hour.
   They include ones the reaper skips, so they are an upper bound on the backlog. The share of `wouldDeleteLegacy` in each sweep's `scanned` estimates how
   much of that total is eligible.
3. Run the legacy steps of the disposable-host canary below.
4. Before enabling, confirm the web and mobile builds that show the "update T3 Code on that computer"
   message are live. Without them, a user whose older host lost its tunnel only sees it as offline.
5. Set the legacy mode to `enabled`. One sweep deletes at most 100 tunnels, four at a time, and
   stops starting new deletions after 90 seconds. A backlog of 20,000 takes about 17 hours if each
   sweep finishes its 100. Watch `deletedLegacy`, `attempted`, `failed`, and `truncated`. An
   `attempted` well under 100 with `truncated` set means the sweep stopped early: either the time
   budget ran out or Cloudflare rate-limited a deletion. The counters don't say which; the relay
   logs a warning with the Cloudflare error for each failed deletion.

In Axiom, filter the relay traces dataset on `name == "relay.managed_endpoint_reaper.sweep"` and
chart the `attributes.custom.relay.managed_endpoint_reaper.*` fields over time.

Set the legacy mode back to `off` and deploy if any of these happen:

- `failed` stays above a few per sweep. Read the warning log for the Cloudflare error.
- Users report an environment that is offline with the update message after they have updated T3
  Code on that computer and restarted it.
- Relay request errors rise while sweeps run. Deletions share the Postgres connection pool with
  request handlers.

Turning the legacy mode off stops new legacy deletions; `RELAY_TUNNEL_CLEANUP_MODE` keeps deleting
tunnels of hosts with recovery while it is `enabled`. Deleted tunnels stay deleted; their hosts
recover as described above.

### Disposable-host canary

This test has not been run against a real Cloudflare account. Run it against a disposable relay
stage, test Cloudflare account, disposable host, and disposable T3 home. Keep production cleanup at
`off` or `dry-run` until it passes. Do not stop a daily-use T3 server.

1. Deploy the disposable stage with cleanup `dry-run`. Link a first disposable environment through
   web or mobile settings and confirm its tunnel is healthy and recovery is registered.
2. Stop that host and restart the same T3 home on a different local port. Confirm the public
   hostname reaches the new port and sends nothing to the old one.
3. Link a second disposable environment with a server build that predates recovery registration.
   Capture its managed `cloudflared` child PID, confirm it belongs to that host, and pause only that
   child with `kill -STOP <legacy-pid>`. Wait until Cloudflare reports it down for over five minutes.
4. Capture the first environment's `cloudflared` child PID from its server logs, confirm ownership,
   and pause it with `kill -STOP <first-pid>`. Wait until Cloudflare reports it down for over five
   minutes.
5. Confirm dry-run counts the first tunnel in `wouldDelete` and the second in `skippedLegacy`.
6. Set cleanup `enabled` on the disposable stage and deploy. Confirm in the test Cloudflare account
   that the first tunnel is deleted and the legacy tunnel still exists.
7. Resume the first child with `kill -CONT <first-pid>`. Confirm the running server detects the
   repeated rejection, requests recovery, and becomes reachable at the same hostname without a
   restart.
8. Resume the legacy child with `kill -CONT <legacy-pid>` and confirm its tunnel reconnects.
9. Repeat with a physical sleep and wake cycle on a disposable laptop before broad rollout.

Legacy cleanup, on the same disposable stage:

10. Set `RELAY_LEGACY_TUNNEL_GRACE_MINUTES=10` and the legacy mode to `dry-run`, then deploy. The
    override shortens the 7-day grace period and is ignored on `prod`. Pause the legacy child again
    and wait until Cloudflare reports it down for over ten minutes.
11. Confirm the sweep counts it in `wouldDeleteLegacy`, then set the legacy mode to `enabled` and
    deploy. Confirm the legacy tunnel is deleted and its allocation row remains.
12. With the legacy host still on its old build, resume the child. A CLI-linked host provisions a
    new tunnel on its next restart; a web- or mobile-linked host stays offline.
13. Update that host to the current build and start it. Confirm it requests recovery and is
    reachable at the same hostname.
14. Remove `RELAY_LEGACY_TUNNEL_GRACE_MINUTES` from the disposable stage.

## Marketing site deployment

Configure the `production` GitHub environment with the relay and Clerk values above. Configure
these repository-level release credentials before running stable validation:

- Release GitHub App: `RELEASE_APP_ID` and `RELEASE_APP_PRIVATE_KEY`; the installation needs
  repository Contents read/write access so the workflow can create releases and finalize versions.
- Apple signing/notarization: the secrets and variables in the macOS section below.
- Azure Trusted Signing: the secrets in the Windows section below.
- Vercel: `VERCEL_TOKEN`, `VERCEL_ORG_ID`, and `VERCEL_PROJECT_ID` for the dedicated project.

Discord secrets are optional. Both announcement steps use `continue-on-error`, so missing Discord
configuration cannot block a release.

## Android APK mirror

`.github/workflows/mobile-android-apk.yml` checks Google Play hourly and publishes the newest
build on the `v2` closed testing track to the rolling `android-nightly` prerelease, for nightly
users who can't join the Play testing group. Those v2-preview builds are the only Android builds that can
connect to a nightly server. The APK is the universal APK Play generates and signs from the
uploaded bundle, so no signing key lives in GitHub. The job skips itself until
`GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` holds a Play service account key with the "Release to
production, exclude devices, and use Play App Signing" permission, which downloading generated
APKs requires. The job reads tracks without opening a Play edit, so it can share the service
account EAS Submit uses.

## Hosted web app release deployment

The hosted app is intentionally not deployed by Vercel's Git integration. The
web project disables automatic Git deployments in `apps/web/vercel.ts` via
`git.deploymentEnabled: false`. `.github/workflows/release.yml` builds the web
app with Vercel CLI as a staged production deployment (`--skip-domain`) while
the desktop jobs run, and aliases the channel domains to it after the GitHub
Release succeeds.

Required GitHub Actions secrets:

- `VERCEL_TOKEN`
- `VERCEL_ORG_ID`
- `VERCEL_PROJECT_ID`

Optional GitHub Actions variables:

- `VERCEL_TEAM_SLUG`: overrides the Vercel CLI scope when the team slug is preferred over the `VERCEL_ORG_ID` secret.
- `T3CODE_WEB_ROUTER_URL`: defaults to `https://awtprod-command-center.vercel.app`.

Required Vercel project:

- Project name: `awtprod-command-center`
- Production domain: `https://awtprod-command-center.vercel.app`
- Root directory: `apps/web`

The release deploy job rewrites package versions before upload so the About panel renders the
release version. Stable releases use a production deployment. Nightly releases use a preview
deployment and print its generated URL in the workflow summary. Because there are no fixed channel
aliases, hosted channel switching is hidden unless `VITE_HOSTED_APP_CHANNEL_SWITCHING=1` is supplied
for a future deployment strategy that supports it.

One-time Vercel dashboard setup:

1. Create or select `awtprod-command-center` and set its root directory to `apps/web`.
2. Record its project and organization IDs in the repository secrets above.
3. Disable automatic Git deployments in the dashboard if desired; the committed
   `vercel.ts` setting is the source-of-truth, but disconnecting Git in the
   dashboard is also safe.
4. Confirm the project production domain is `https://awtprod-command-center.vercel.app`.

## Nightly builds

- Workflow: `.github/workflows/release.yml`
- Triggers:
  - scheduled check every three hours
  - manual `workflow_dispatch` with `channel=nightly`
- Runs the same desktop quality gates and artifact matrix as the tagged release flow.
- Publishes a GitHub prerelease only:
  - tag format: `nightly-vX.Y.Z-nightly.YYYYMMDD.<run_number>`
  - release name includes the short commit SHA
  - `make_latest` is always `false`
- Uses the next stable patch version as the nightly base. For example, `0.0.17` produces nightlies on `0.0.18-nightly.*`.
- Publishes Electron auto-update metadata to the dedicated `nightly` updater channel, so desktop users can opt into that track independently from stable.
- Publishes the CLI package (`apps/server`, npm package `@awtprod/command-center`) to the `nightly` npm dist-tag using the same nightly version.
- Does not commit version bumps back to `main`.

## Server self-update release invariant

Connected servers update to the client's exact version, not to an npm dist-tag. Every released
desktop or hosted client version must therefore have a matching
`@awtprod/command-center@<version>` package available on npm before users can receive that client.

The workflow enforces this ordering:

1. `publish_cli` publishes the exact stable or nightly version to npm.
2. `release` depends on `publish_cli` before exposing desktop artifacts in GitHub Releases.
3. `deploy_web` depends on `release` before moving the hosted channel to the new client.
   `build_web` builds that client earlier with `vercel deploy --prod --skip-domain`, which
   leaves the custom domains alone but moves the project's own `*.vercel.app` production
   hostname. That hostname is behind Vercel SSO, so users only get the client through the
   custom domains.

Preserve these dependencies when changing the release graph. Publishing a client first would leave
the **Update server** action targeting a package version that does not exist yet.

For a release smoke test, confirm `npm view @awtprod/command-center@<version> version` returns the expected version, then
connect the new client to a server on the previous version and verify that the update action
reconnects to the matching server. When the release adds database migrations, verify that the
remote update applies them and reconnects. A failed trial must restore the database snapshot and
restart the previous server. If the installed launcher does not support the target protocol,
verify that the update stops before restart and run
`npx @awtprod/command-center@<version> service update` once on the server machine. Also test the
manual or desktop-managed guidance when those environments are available.

## Desktop auto-update notes

- Runtime updater: `electron-updater` in `apps/desktop/src/main.ts`.
- Update UX:
  - Background checks run on startup delay + interval.
  - No automatic download or install.
  - The desktop UI shows a rocket update button when an update is available; click once to download, click again after download to restart/install.
- Provider: GitHub Releases (`provider: github`) configured at build time.
- Repository slug source:
  - `T3CODE_DESKTOP_UPDATE_REPOSITORY` (format `owner/repo`), if set.
  - otherwise `GITHUB_REPOSITORY` from GitHub Actions.
- Temporary private-repo auth workaround:
  - set `T3CODE_DESKTOP_UPDATE_GITHUB_TOKEN` (or `GH_TOKEN`) in the desktop app runtime environment.
  - the app forwards it as an `Authorization: Bearer <token>` request header for updater HTTP calls.
- Required release assets for updater:
  - platform installers (`.exe`, `.dmg`, `.AppImage`, `.deb`, plus macOS `.zip` for Squirrel.Mac update payloads)
  - channel metadata: `latest*.yml` for stable releases, `nightly*.yml` for nightly releases
  - `*.blockmap` files (used for differential downloads)
- macOS metadata note:
  - `electron-updater` reads `latest-mac.yml` on stable and `nightly-mac.yml` on nightly, for both Intel and Apple Silicon.
  - The workflow merges the per-arch mac manifests into one channel-specific mac manifest before publishing the GitHub Release.

### Windows payload topology and update validation

Windows packages the bundled server and only its runtime-external/native
dependency closure in `resources/server.asar`. Native modules and helper
executables declared as unpacked by that archive must be present at the matching
paths below `resources/server.asar.unpacked`. The Windows-native backend reads
the archive in place through Electron. Packaged Windows builds also ship a
Linux-only `resources/wsl-runtime.tar.gz` plus its SHA-256 sidecar. WSL verifies
and extracts that archive into `~/.t3/wsl-runtime/sha256-<archive-digest>` inside
the selected distro, then reuses it for later launches of the same update. The
Windows-side `wsl-server-tree/<version>` extraction remains a fallback and is
removed after the distro-local runtime passes preflight.

The artifact builder rejects a Windows package when any of these invariants
break:

- `resources/server.asar` is absent or does not contain the server entry.
- Any file marked unpacked in the ASAR header is absent from
  `resources/server.asar.unpacked`.
- On same-architecture Windows builds, the packaged primary cannot load the fff
  native library from inside `server.asar` through its `.unpacked` sibling.
- The isolated, extracted sidecar cannot load the server entry with plain Node.
- A Windows build with a WSL node-pty prebuild omits the WSL archive or SHA-256
  sidecar, the sidecar digest does not match the emitted archive, or required
  Linux runtime members are absent.
- The emitted WSL archive contains Windows/Darwin node-pty payloads, ConPTY,
  pnpm install metadata, or Windows-only FFF, ffi-rs, or msgpackr bindings.
- The external Windows resource monitor is absent.
- The unpacked Windows application contains more than 80 files.

Cross-architecture Windows builds retain every structural and extracted-sidecar
check, but skip executing the target Electron binary. A same-architecture build
for each release target must exercise the primary native-load probe.

NSIS differential packaging remains enabled. A sidecar layout transition can
produce a larger one-time download; subsequent small releases retain their
blockmaps, with a 60 MB maximum for a representative sidecar-to-sidecar update.

## 0) npm OIDC trusted publishing setup (CLI)

The workflow publishes the CLI with `npm publish` from `apps/server` after bumping
the package version to the release tag version.

Checklist:

1. Create the public npm package `@awtprod/command-center` under the `awtprod` scope.
2. In npm package settings, configure Trusted Publisher:
   - Provider: GitHub Actions
   - Repository: this repo
   - Workflow file: `.github/workflows/release.yml`
   - Environment (if used): match your npm trusted publishing config
3. Ensure npm account and org policies allow trusted publishing for the package.
4. Create release tag `vX.Y.Z` and push; workflow will:
   - set `apps/server/package.json` version to `X.Y.Z`
   - build web + server
   - run `npm publish --access public --tag latest`
5. Nightly runs from the same workflow file publish with `npm publish --access public --tag nightly`.

## 1) Signed validation release

Use this before every stable publication. It performs the full signed build matrix but has no
publication side effects.

1. Open **Actions → Release → Run workflow**.
2. Select `mode=validate`, `channel=stable`, and enter the exact version (for v1, `1.0.0`).
3. Wait for every preflight, relay, signing, build, and artifact-validation job to pass.
4. Download the `command-center-<version>-validation` artifact.
5. Verify signatures, notarization, install/uninstall behavior, protocols, embedded backend startup,
   clean-profile functionality, SSH launch, persistence, and mock-server updater detection on every
   supported OS.
6. Only after acceptance passes, run the same version with `mode=publish`.

## 2) Apple signing + notarization setup (macOS)

Required secrets used by the workflow:

- `CSC_LINK`
- `CSC_KEY_PASSWORD`
- `APPLE_API_KEY`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`
- `MACOS_PROVISIONING_PROFILE` (base64-encoded provisioning profile with Associated Domains)

Required repository variables:

- `APPLE_TEAM_ID`

Optional repository variables:

- `CLERK_PASSKEY_RP_DOMAINS`: comma-separated production Clerk RP domains. It is required by the
  stable release workflow so associated-domain intent is explicit.

Checklist:

1. Apple Developer account access:
   - Team has rights to create Developer ID certificates.
2. Create an explicit App ID for `com.awtprod.commandcenter` and enable Associated Domains.
3. Create a `Developer ID Application` certificate and a compatible provisioning profile for that
   App ID with Associated Domains enabled.
4. Export the certificate + private key as `.p12` from Keychain.
5. Base64-encode the `.p12` and store as `CSC_LINK`.
6. Base64-encode the provisioning profile and store it as `MACOS_PROVISIONING_PROFILE`.
7. Store the `.p12` export password as `CSC_KEY_PASSWORD`, and set `APPLE_TEAM_ID` to the
   10-character Apple Developer Team ID.
8. In App Store Connect, create an API key (Team key).
9. Add API key values:
   - `APPLE_API_KEY`: contents of the downloaded `.p8`
   - `APPLE_API_KEY_ID`: Key ID
   - `APPLE_API_ISSUER`: Issuer ID
10. Complete the Clerk Native API and AASA setup in [T3 Connect Clerk Setup](../cloud/t3-connect-clerk.md#desktop-passkeys).
11. Run a stable validation and confirm macOS artifacts are signed/notarized and contain the expected
    `com.apple.developer.associated-domains` entitlement.

Notes:

- `APPLE_API_KEY` is stored as raw key text in secrets.
- The workflow writes it to a temporary `AuthKey_<id>.p8` file at runtime.
- The workflow decodes `MACOS_PROVISIONING_PROFILE`, validates it with `security cms`, and passes it
  to the desktop packager.
- In-app browser passkeys depend on the same profile. The packager adds each entitlement only when
  the profile grants it, because macOS will not launch an app that claims more than its profile
  allows. The build log reports which ones it enabled.
  - `keychain-access-groups` (`<TEAM_ID>.com.t3tools.t3code.webauthn`) enables Touch ID passkeys.
    Profiles that grant the team's keychain groups (`<TEAM_ID>.*`) cover it.
  - `com.apple.developer.web-browser.public-key-credential` lets the system passkey sheet (iCloud
    Keychain, password managers, phones, security keys) serve any site. Apple grants it as a
    managed capability: the Account Holder requests it through the
    [macOS Browsers Passkeys form](https://developer.apple.com/contact/request/macos-browsers-passkeys/).
    After approval, regenerate the profile and update `MACOS_PROVISIONING_PROFILE`.

## 3) Azure Trusted Signing setup (Windows)

Required secrets used by the workflow:

- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID`
- `AZURE_CLIENT_SECRET`
- `AZURE_TRUSTED_SIGNING_ENDPOINT`
- `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`
- `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`
- `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`

Checklist:

1. Create Azure Trusted Signing account and certificate profile.
2. Record ATS values:
   - Endpoint
   - Account name
   - Certificate profile name
   - Publisher name
3. Create/choose an Entra app registration (service principal).
4. Grant service principal permissions required by Trusted Signing.
5. Create a client secret for the service principal.
6. Add Azure secrets listed above in GitHub Actions secrets.
7. Re-run a tag release and confirm Windows installer is signed.

## 4) Ongoing release checklist

1. Ensure `main` is green in CI.
2. Run `mode=validate` for the intended version and complete the clean-profile acceptance matrix.
3. Run `mode=publish` for the same version. A pushed stable tag also invokes publish mode, but the
   manual interface is preferred for the first release.
4. Verify workflow steps:
   - preflight passes
   - release quality checks pass
   - all matrix builds pass
   - release job uploads expected files
5. Smoke test downloaded artifacts.

## 5) Troubleshooting

- macOS build unsigned when expected signed:
  - Check all Apple secrets plus `APPLE_TEAM_ID` are populated and non-empty.
  - Confirm the provisioning profile belongs to `APPLE_TEAM_ID.com.awtprod.commandcenter` and includes
    Associated Domains.
- Windows build unsigned when expected signed:
  - Check all Azure ATS and auth secrets are populated and non-empty.
- Build fails with signing error:
  - Re-check certificate/profile names, associated domains, and tenant/client credentials. Stable
    validation and publication intentionally do not have an unsigned fallback.
