import { isElectron } from "./env";

export interface PwaRegistrationEnvironment {
  readonly electron: boolean;
  readonly production: boolean;
  readonly secureContext: boolean;
  readonly serviceWorkerSupported: boolean;
}

export function shouldRegisterPwaServiceWorker(environment: PwaRegistrationEnvironment): boolean {
  return (
    environment.production &&
    !environment.electron &&
    environment.secureContext &&
    environment.serviceWorkerSupported
  );
}

export function registerPwaServiceWorker(): void {
  const serviceWorkerSupported = "serviceWorker" in navigator;
  if (
    !shouldRegisterPwaServiceWorker({
      electron: isElectron,
      production: import.meta.env.PROD,
      secureContext: window.isSecureContext,
      serviceWorkerSupported,
    })
  ) {
    return;
  }

  void navigator.serviceWorker.register("/service-worker.js").catch(() => undefined);
}
