/** Extract a short mission label from a multi-line task prompt. Runtime-owned. */

function inline(value: string, max: number): string {
  const text = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 3))}...` : text;
}

export function missionFromPrompt(prompt: string): string {
  const lines = prompt
    .split(/\r?\n/)
    .map((line) => inline(line, 180))
    .filter(Boolean);
  const goal = lines.find((line) => /^goal\s*:/i.test(line));
  return inline((goal ?? lines[0] ?? "Mission").replace(/^goal\s*:\s*/i, ""), 140);
}
