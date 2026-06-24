/**
 * Pinned model catalog for GLM coding plan.
 *
 * Hardcoded to the exact models available on the Z.AI / Bigmodel coding-plan
 * tier. This replaces the previous `_reverse/models_catalog.json` import,
 * removing that runtime dependency. Update this list when new GLM models are
 * released or specs change.
 *
 * @see .omo/plans/zcode-proxy.md Task 3
 */
import type { ModelDef } from "./types.js";

/** All models available on the GLM coding plan, pinned with verified specs. */
export const MODELS: ModelDef[] = [
  { id: "glm-5-turbo", name: "GLM 5 Turbo", contextWindow: 200_000, maxOutputTokens: 128_000, reasoning: true },
  { id: "glm-5.2", name: "GLM 5.2", contextWindow: 1_000_000, maxOutputTokens: 128_000, reasoning: true },
];

/** Look up a model by id. Returns `undefined` for unknown models. */
export function getModel(id: string): ModelDef | undefined {
  return MODELS.find((m) => m.id === id);
}

/** All model ids. */
export function listModelIds(): string[] {
  return MODELS.map((m) => m.id);
}
