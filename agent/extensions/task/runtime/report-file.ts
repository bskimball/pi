import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function saveReport(text: string): { reportFile: string } {
  const reportFile = join(mkdtempSync(join(tmpdir(), "pi-task-report-")), "report.md");
  writeFileSync(reportFile, text, { encoding: "utf8", mode: 0o600 });
  return { reportFile };
}
