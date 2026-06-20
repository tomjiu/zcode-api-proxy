/**
 * Bundled config template — embedded into the compiled binary via import attribute.
 * Source of truth: config.example.yaml at repo root.
 */
import content from "../../config.example.yaml" with { type: "text" };

export const EXAMPLE_CONFIG_YAML: string = content;
