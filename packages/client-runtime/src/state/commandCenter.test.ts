import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Layer from "effect/Layer";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createCommandCenterEnvironmentAtoms } from "./commandCenter.ts";

describe("Command Center environment atoms", () => {
  const runtime = Atom.runtime(Layer.empty) as unknown as Atom.AtomRuntime<
    EnvironmentRegistry,
    never
  >;
  const atoms = createCommandCenterEnvironmentAtoms(runtime);
  const environmentId = EnvironmentId.make("environment-example");

  it("keys timeline state by environment and Space filter", () => {
    const target = { environmentId, input: { limit: 200 } };
    expect(atoms.timeline(target)).toBe(atoms.timeline({ ...target }));
    expect(
      atoms.timeline({
        environmentId,
        input: { limit: 200, spaceId: "space-example" as never },
      }),
    ).not.toBe(atoms.timeline(target));
  });

  it("keys durable subscriptions by replay cursor", () => {
    const first = atoms.events({ environmentId, input: { afterSequence: 1 } });
    expect(first).toBe(atoms.events({ environmentId, input: { afterSequence: 1 } }));
    expect(first).not.toBe(atoms.events({ environmentId, input: { afterSequence: 2 } }));
  });

  it("keys Artifact queries by their required Space scope", () => {
    const first = atoms.artifacts({
      environmentId,
      input: { spaceId: "space-a" as never },
    });
    expect(first).toBe(atoms.artifacts({ environmentId, input: { spaceId: "space-a" as never } }));
    expect(first).not.toBe(
      atoms.artifacts({ environmentId, input: { spaceId: "space-b" as never } }),
    );
  });

  it("keys exact automation source by environment, Space, and automation", () => {
    const first = atoms.automationDefinition({
      environmentId,
      input: {
        automationId: "automation-a" as never,
        spaceId: "space-a" as never,
      },
    });
    expect(first).toBe(
      atoms.automationDefinition({
        environmentId,
        input: {
          automationId: "automation-a" as never,
          spaceId: "space-a" as never,
        },
      }),
    );
    expect(first).not.toBe(
      atoms.automationDefinition({
        environmentId,
        input: {
          automationId: "automation-b" as never,
          spaceId: "space-a" as never,
        },
      }),
    );
  });
});
