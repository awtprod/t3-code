declare const __T3CODE_REMOTE_ONLY__: boolean;

// This is injected by the desktop packer. It is deliberately build-time only:
// a remote-only installer must never become capable of launching a local
// backend because of a persisted setting or a process environment variable.
export const isRemoteOnlyDesktopBuild =
  typeof __T3CODE_REMOTE_ONLY__ !== "undefined" && __T3CODE_REMOTE_ONLY__;
