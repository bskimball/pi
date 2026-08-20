export function textResult(text: string, isError = false, details: unknown = {}) {
  return {
    content: [{ type: "text" as const, text }],
    details,
    isError,
  };
}
