import type {
  FlowConfigurableVariable,
  FlowConfigurableVariableOption,
  FlowConfigurableVariableValue,
} from "@ai-native-flow/flow-ir";

export type ConversationFlowVariables = Record<string, FlowConfigurableVariableValue>;
export const FLOW_MAX_OUTPUT_TOKENS_VARIABLE = "LLM_FLOW_MAX_OUTPUT_TOKENS";

const VARIABLE_NAME = /^[A-Z_][A-Z0-9_]*$/;
const RESERVED_VARIABLES = new Set([
  "LLM_API_KEY",
  "LLM_BASE_URL",
  "LLM_DEFAULT_MODEL",
  "NKG_HOSTED_RUN_AUTHORIZATION",
]);
const SECRET_LIKE_VARIABLE = /(?:_API_KEY|_SECRET|_PASSWORD|_AUTHORIZATION|_ACCESS_TOKEN)$/;

/** Reads only safe, well-formed declarations from untrusted stored Flow JSON. */
export function flowConfigurableVariables(graph: unknown): FlowConfigurableVariable[] {
  if (!isRecord(graph) || !Array.isArray(graph.configurableVariables)) return [];
  const names = new Set<string>();
  const result: FlowConfigurableVariable[] = [];
  for (const candidate of graph.configurableVariables.slice(0, 64)) {
    const field = normalizeDefinition(candidate);
    if (!field || names.has(field.name)) continue;
    names.add(field.name);
    result.push(field);
  }
  return result;
}

/** Keeps persisted values limited to variables and value domains exposed by this Flow. */
export function normalizeConversationFlowVariables(
  definitions: readonly FlowConfigurableVariable[],
  input: unknown,
): ConversationFlowVariables {
  if (!isRecord(input)) return {};
  const result: ConversationFlowVariables = {};
  for (const definition of definitions) {
    const value = input[definition.name];
    if (isAllowedValue(definition, value)) result[definition.name] = value;
  }
  return result;
}

/** Parses the primitive JSON record stored with a conversation. */
export function parseConversationFlowVariables(input: unknown): ConversationFlowVariables {
  if (!isRecord(input)) return {};
  return Object.fromEntries(Object.entries(input).filter((entry): entry is [string, FlowConfigurableVariableValue] =>
    VARIABLE_NAME.test(entry[0]) && isPrimitiveValue(entry[1]))) as ConversationFlowVariables;
}

export function configurableVariableDefaultLabel(definition: FlowConfigurableVariable): string {
  if (definition.defaultValue === undefined) return "由 Flow 决定";
  if (typeof definition.defaultValue === "boolean") return definition.defaultValue ? "开启" : "关闭";
  return String(definition.defaultValue);
}

function normalizeDefinition(input: unknown): FlowConfigurableVariable | undefined {
  if (!isRecord(input)) return undefined;
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const label = typeof input.label === "string" ? input.label.trim() : "";
  const type = input.type;
  if (!VARIABLE_NAME.test(name) || RESERVED_VARIABLES.has(name) || SECRET_LIKE_VARIABLE.test(name)) {
    return undefined;
  }
  if (!label || label.length > 80
    || (type !== "string" && type !== "number" && type !== "boolean" && type !== "select")) {
    return undefined;
  }
  const options = normalizeOptions(input.options);
  if (type === "select" && options.length === 0) return undefined;
  const defaultValue = isPrimitiveValue(input.defaultValue) ? input.defaultValue : undefined;
  if (type !== "select" && defaultValue !== undefined && typeof defaultValue !== type) return undefined;
  if (type === "select" && defaultValue !== undefined
    && !options.some((option) => option.value === defaultValue)) return undefined;
  const min = finiteNumber(input.min);
  const max = finiteNumber(input.max);
  const step = finiteNumber(input.step);
  if (min !== undefined && max !== undefined && min > max) return undefined;
  return {
    name,
    label,
    type,
    ...(typeof input.description === "string" && input.description.trim()
      ? { description: input.description.trim().slice(0, 500) }
      : {}),
    ...(defaultValue !== undefined ? { defaultValue } : {}),
    ...(typeof input.placeholder === "string" && input.placeholder.trim()
      ? { placeholder: input.placeholder.trim().slice(0, 160) }
      : {}),
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
    ...(step !== undefined && step > 0 ? { step } : {}),
    ...(options.length ? { options } : {}),
  };
}

function normalizeOptions(input: unknown): FlowConfigurableVariableOption[] {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 64).flatMap((candidate) => {
    if (!isRecord(candidate) || typeof candidate.label !== "string"
      || !candidate.label.trim() || !isPrimitiveValue(candidate.value)) return [];
    return [{ label: candidate.label.trim().slice(0, 80), value: candidate.value }];
  });
}

function isAllowedValue(definition: FlowConfigurableVariable, value: unknown): value is FlowConfigurableVariableValue {
  if (!isPrimitiveValue(value)) return false;
  if (definition.type === "select") {
    return definition.options?.some((option) => option.value === value) === true;
  }
  if (typeof value !== definition.type) return false;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return false;
    if (definition.min !== undefined && value < definition.min) return false;
    if (definition.max !== undefined && value > definition.max) return false;
  }
  return true;
}

function isPrimitiveValue(value: unknown): value is FlowConfigurableVariableValue {
  return typeof value === "string" || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value));
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
