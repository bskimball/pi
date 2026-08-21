// Self-contained JSON Schema subset validator for task_start reportSchema.
// Supported: type object, properties of type string|number|boolean, required[], optional enum.

export type ReportStatus = "ok" | "invalid" | "missing" | "none-requested";

export interface ReportSchemaProperty {
  type?: unknown;
  enum?: unknown;
}

export interface ReportSchema {
  type?: unknown;
  properties?: Record<string, ReportSchemaProperty>;
  required?: unknown;
}

export interface ReportValidation {
  status: ReportStatus;
  parsed: Record<string, unknown> | null;
  error?: string;
}

const FENCE_RE = /```report\s*\r?\n([\s\S]*?)```/gi;

export function extractLastReportFence(text: string): string | undefined {
  let last: string | undefined;
  FENCE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FENCE_RE.exec(text)) !== null) {
    last = match[1];
  }
  return last;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function typeOk(expected: unknown, value: unknown): boolean {
  if (expected === "string") return typeof value === "string";
  if (expected === "number") return typeof value === "number" && Number.isFinite(value);
  if (expected === "boolean") return typeof value === "boolean";
  return false;
}

export function parseReportSchema(raw: string): { schema: ReportSchema; error?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      schema: {},
      error: `reportSchema is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!isPlainObject(parsed)) {
    return { schema: {}, error: "reportSchema must be a JSON object" };
  }
  const allowed = new Set(["type", "properties", "required"]);
  for (const key of Object.keys(parsed)) {
    if (!allowed.has(key)) {
      return { schema: {}, error: `reportSchema unknown key: ${key}` };
    }
  }
  if (parsed.type !== undefined && parsed.type !== "object") {
    return { schema: {}, error: "reportSchema.type must be object" };
  }
  if (parsed.properties !== undefined && !isPlainObject(parsed.properties)) {
    return { schema: {}, error: "reportSchema.properties must be an object" };
  }
  if (parsed.properties) {
    for (const [name, spec] of Object.entries(parsed.properties)) {
      if (!isPlainObject(spec)) {
        return { schema: {}, error: `reportSchema.properties.${name} must be an object` };
      }
      for (const k of Object.keys(spec)) {
        if (k !== "type" && k !== "enum") {
          return { schema: {}, error: `reportSchema.properties.${name} unknown key: ${k}` };
        }
      }
      if (spec.type !== "string" && spec.type !== "number" && spec.type !== "boolean") {
        return {
          schema: {},
          error: `reportSchema.properties.${name}.type must be string|number|boolean`,
        };
      }
      if (spec.enum !== undefined) {
        if (!Array.isArray(spec.enum) || spec.enum.length === 0) {
          return { schema: {}, error: `reportSchema.properties.${name}.enum must be a non-empty array` };
        }
        if (spec.enum.some((item) => typeof item !== "string")) {
          return { schema: {}, error: `reportSchema.properties.${name}.enum must be an array of strings` };
        }
      }
    }
  }
  if (parsed.required !== undefined) {
    if (
      !Array.isArray(parsed.required) ||
      parsed.required.some((item) => typeof item !== "string")
    ) {
      return { schema: {}, error: "reportSchema.required must be an array of strings" };
    }
  }
  return { schema: parsed as ReportSchema };
}

export function validateReportJson(
  schema: ReportSchema,
  jsonText: string,
): ReportValidation {
  let value: unknown;
  try {
    value = JSON.parse(jsonText);
  } catch (error) {
    return {
      status: "invalid",
      parsed: null,
      error: `report JSON parse failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!isPlainObject(value)) {
    return { status: "invalid", parsed: null, error: "report JSON must be an object" };
  }
  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required)
    ? schema.required.filter((key): key is string => typeof key === "string")
    : [];
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      return { status: "invalid", parsed: value, error: `missing required key: ${key}` };
    }
  }
  for (const [key, spec] of Object.entries(properties)) {
    if (!Object.hasOwn(value, key)) continue;
    const expected = spec?.type;
    if (expected !== undefined && !typeOk(expected, value[key])) {
      return {
        status: "invalid",
        parsed: value,
        error: `key ${key}: expected ${String(expected)}`,
      };
    }
    if (Array.isArray(spec?.enum) && !spec.enum.includes(value[key])) {
      return {
        status: "invalid",
        parsed: value,
        error: `key ${key}: value not in enum`,
      };
    }
  }
  return { status: "ok", parsed: value };
}

export function evaluateSettledReport(
  assistantText: string,
  reportSchema?: string,
): ReportValidation {
  if (!reportSchema?.trim()) {
    return { status: "none-requested", parsed: null };
  }
  const { schema, error } = parseReportSchema(reportSchema);
  if (error) {
    return { status: "invalid", parsed: null, error };
  }
  const fence = extractLastReportFence(assistantText);
  if (fence === undefined) {
    return { status: "missing", parsed: null, error: "no ```report``` fence in final text" };
  }
  return validateReportJson(schema, fence);
}

export function reportStatusLine(status: ReportStatus, parsed: Record<string, unknown> | null): string {
  if (status === "ok") {
    const keys = parsed ? Object.keys(parsed).length : 0;
    return `report: ok (${keys} keys)`;
  }
  if (status === "none-requested") return "report: none-requested";
  return `report: ${status}`;
}

export function reportInstruction(schemaJson: string): string {
  return [
    "Your FINAL message must include a fenced ```report``` code block whose content is JSON conforming to this schema.",
    "Use that fence exactly once at the end (last fence wins if multiple). Do not wrap the JSON in prose inside the fence.",
    schemaJson.trim(),
  ].join("\n");
}
