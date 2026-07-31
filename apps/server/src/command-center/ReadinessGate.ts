import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

export type CommandCenterReadinessState = "pending" | "ready" | "failed";

export class CommandCenterNotReadyError extends Schema.TaggedErrorClass<CommandCenterNotReadyError>()(
  "CommandCenterNotReadyError",
  {
    state: Schema.Literals(["pending", "failed"]),
  },
) {
  override get message(): string {
    return this.state === "pending"
      ? "Command Center is not ready yet."
      : "Command Center is unavailable because startup integrity checks failed.";
  }
}

export interface CommandCenterReadinessGateShape {
  readonly state: Effect.Effect<CommandCenterReadinessState>;
  /** External entry points fail immediately until startup has completed safely. */
  readonly requireReady: Effect.Effect<void, CommandCenterNotReadyError>;
  readonly markReady: Effect.Effect<void>;
  readonly markFailed: Effect.Effect<void>;
}

export class CommandCenterReadinessGate extends Context.Service<
  CommandCenterReadinessGate,
  CommandCenterReadinessGateShape
>()("@awtprod/command-center/command-center/ReadinessGate/CommandCenterReadinessGate") {}

export const makeCommandCenterReadinessGate = Effect.gen(function* () {
  const state = yield* Ref.make<CommandCenterReadinessState>("pending");

  const requireReady = Ref.get(state).pipe(
    Effect.flatMap((current) =>
      current === "ready"
        ? Effect.void
        : Effect.fail(new CommandCenterNotReadyError({ state: current })),
    ),
  );

  return CommandCenterReadinessGate.of({
    state: Ref.get(state),
    requireReady,
    // A failed integrity gate is terminal for this process. Never let a later
    // startup callback reopen it accidentally.
    markReady: Ref.update(state, (current) => (current === "failed" ? current : "ready")),
    markFailed: Ref.set(state, "failed"),
  });
});

export const layer = Layer.effect(CommandCenterReadinessGate, makeCommandCenterReadinessGate);
