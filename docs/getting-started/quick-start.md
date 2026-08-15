# Quick start

See [dev mode vs serve mode](./dev-vs-serve.md) for which of the first two to
use day to day — `pnpm serve` boots the home screen in 32 requests / 2.4 MB
against dev mode's 250 / 19.2 MB.

```bash
# Development (with hot reload)
bun run dev

# Production build as the daily driver (one origin, no Vite)
pnpm serve
pnpm serve:fast   # reuse the existing apps/web/dist

# Desktop development
bun run dev:desktop

# Desktop development on an isolated port set
T3CODE_DEV_INSTANCE=feature-xyz bun run dev:desktop

# Production
bun run build
bun run start

# Build a shareable macOS .dmg (arm64 by default)
bun run dist:desktop:dmg

# Or from any project directory after publishing:
npx t3
```
