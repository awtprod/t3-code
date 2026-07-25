# Dev mode vs serve mode

Two ways to run Command Center locally. Pick by what you are doing:

|            | `pnpm dev`                            | `pnpm serve`                                    |
| ---------- | ------------------------------------- | ----------------------------------------------- |
| Use it for | working **on** the app                | working **in** the app                          |
| Web assets | Vite dev server, unbundled ES modules | prebuilt `apps/web/dist`, served by the backend |
| Origins    | two (Vite `:5733` + backend `:13773`) | one (backend only)                              |
| Hot reload | yes                                   | no — rebuild to see changes                     |
| Boot cost  | see below                             | see below                                       |

## Measured boot cost

Chrome DevTools, cache disabled, home screen fully rendered, same machine:

|                  | `pnpm dev` (`localhost:5733`) | `pnpm serve` (`127.0.0.1:13791`) |
| ---------------- | ----------------------------- | -------------------------------- |
| Requests         | 250                           | 32                               |
| Decoded bytes    | 19.15 MB                      | 2.38 MB                          |
| DOMContentLoaded | 971 ms                        | 174 ms                           |

Serve mode is **~8x fewer requests and ~8x fewer bytes**. On loopback that is
under a second either way; over Tailscale from another machine, where every
request pays real latency, the request count is what dominates.

## Serve mode

```bash
pnpm serve                # build apps/web, then run the backend against it
pnpm serve:fast           # skip the build, reuse the existing apps/web/dist
```

Rebuild (`pnpm serve` without `--skip-build`) after any change under
`apps/web/src`. Server-side changes only need a restart.

### One origin, no baked-in URLs

Serve mode deliberately unsets `VITE_DEV_SERVER_URL`, `VITE_HTTP_URL`,
`VITE_WS_URL`, and `PORT` before building and before starting the backend:

- With `VITE_DEV_SERVER_URL` set, the backend 302-redirects every request to a
  Vite dev server that isn't running, and never resolves the static directory.
- `VITE_HTTP_URL`/`VITE_WS_URL` are **baked into the bundle at build time**. A
  value like `http://localhost:13773` would pin every client — including a
  Windows desktop reaching the box over Tailscale — at `localhost` on _its own_
  machine.

With all of them unset, the app falls back to its own window origin
(`resolveWindowOriginPrimaryTarget`), so the app, `/api`, and `/ws` are
same-origin from wherever it is reached. That also removes the dev-mode CORS
split entirely.

### Sourcemaps

The served build defaults to `T3CODE_WEB_SOURCEMAP=hidden`: `.map` files are
still emitted (so stack traces can be symbolicated offline) but no
`sourceMappingURL` comment is written, so browsers never fetch them. Measured:
16.7 MB of JS alongside 37.2 MB of sourcemaps — hidden keeps the latter off the
wire. Set `T3CODE_WEB_SOURCEMAP` explicitly to override (`false` to skip
emitting them at all, `true` for linked sourcemaps).

### Tailscale

`tailscale serve` proxies **one** port. In dev mode that has to be the Vite
port, which means `/api` and `/ws` come from a different origin. In serve mode
point it at the backend instead so a single tailnet origin carries everything:

```bash
pnpm serve --tailscale-serve
```

The server points Tailscale Serve at whatever port it actually listens on, so
this is what moves the tailnet origin off `:5733` and onto the backend. Verify
with `tailscale serve status`.

### Data directory footgun

`deriveServerPaths` picks `dev/` vs `userdata/` based on whether a dev URL is
set, unless the base directory is explicit. Serve mode sets no dev URL, so
**without an explicit `--home-dir`/`T3CODE_HOME` it reads a different SQLite
database than `pnpm dev` does** — your threads appear to have vanished. The
runner logs a warning when this happens. Pass a home dir to share one data
directory across both modes:

```bash
pnpm serve --home-dir /path/to/.t3
```

## Dev mode

```bash
pnpm dev                  # backend + web
pnpm dev:server           # backend only
pnpm dev:web              # web only
pnpm dev:desktop          # Electron shell + web
```

Ports are derived per checkout, so several worktrees can run at once;
`T3CODE_DEV_INSTANCE=<name>` forces a distinct port set. `pnpm dev:stop` reaps
a running instance, including orphaned Vite servers.
