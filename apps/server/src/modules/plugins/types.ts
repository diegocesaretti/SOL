export * from "./types-base.js";

import {
  validateSettingValues as validateBaseSettingValues,
  type SolPluginSettingDefinition,
  type SolPluginSettingValue,
} from "./types-base.js";

export function missingRequiredSettingKeys(
  definitions: SolPluginSettingDefinition[],
  values: Record<string, SolPluginSettingValue>,
): string[] {
  return definitions
    .filter((definition) => definition.required && values[definition.key] === undefined && definition.default === undefined)
    .map((definition) => definition.key);
}

export function validateSettingValues(
  definitions: SolPluginSettingDefinition[],
  value: unknown,
  options: { allowMissingRequired?: boolean } = {},
): Record<string, SolPluginSettingValue> {
  if (!options.allowMissingRequired) return validateBaseSettingValues(definitions, value);
  return validateBaseSettingValues(
    definitions.map((definition) => ({ ...definition, required: false })),
    value,
  );
}
