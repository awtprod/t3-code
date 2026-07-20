export function SplashScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div
        className="flex size-24 items-center justify-center"
        aria-label="Command Center splash screen"
      >
        <img
          alt="Command Center"
          className="size-16 object-contain"
          src="/command-center-mark.svg"
        />
      </div>
    </div>
  );
}
