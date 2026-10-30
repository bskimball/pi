import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export interface MuseModel {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
}

export function museBinary(): string {
  const override = process.env.PI_MUSE_BINARY?.trim();
  if (process.platform !== "win32") return override || "muse";
  const dir = join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Programs", "muse");
  // Older config wrote this versioned path into the environment; Muse updates remove it.
  const staleInstalledBinary = override && !existsSync(override)
    && dirname(resolve(override)).toLowerCase() === resolve(dir).toLowerCase()
    && /^muse-bin-[0-9]+\.[0-9]+\.[0-9]+-R[0-9]+(?:\.[0-9]+)?\.exe$/i.test(basename(override));
  if (override && !staleInstalledBinary) return override;
  const version = readFileSync(join(dir, ".muse-version"), "utf8").trim();
  if (!/^[0-9]+\.[0-9]+\.[0-9]+-R[0-9]+(?:\.[0-9]+)?$/.test(version)) {
    throw new Error("Invalid installed Muse version; set PI_MUSE_BINARY to the Muse executable.");
  }
  const binary = join(dir, `muse-bin-${version}.exe`);
  if (!existsSync(binary)) throw new Error(`Muse executable is missing: ${binary}`);
  return binary;
}

function limit(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function museCatalog(): { models: MuseModel[]; defaultId: string } {
  const dir = join(process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share"), "muse", "model-catalog");
  const models = new Map<string, MuseModel>();
  let defaultId: string | undefined;
  for (const file of readdirSync(dir).filter(name => name.endsWith(".json")).sort()) {
    const catalog: unknown = JSON.parse(readFileSync(join(dir, file), "utf8"));
    if (!catalog || typeof catalog !== "object" || !("rows" in catalog) || !Array.isArray(catalog.rows)) {
      throw new Error(`Invalid Muse model catalog: ${file}`);
    }
    for (const row of catalog.rows) {
      if (!row || typeof row !== "object" || typeof row.model_id !== "string") continue;
      if (row.model_id.startsWith("muse-image-")) continue;
      models.set(row.model_id, {
        id: row.model_id,
        name: typeof row.display_label === "string" ? row.display_label : row.model_id,
        contextWindow: limit(row.context_limit, 1_000_000),
        maxTokens: limit(row.output_limit, 128_000),
      });
      if (row.is_default && (!defaultId || row.is_current)) defaultId = row.model_id;
    }
  }
  if (!defaultId || !models.has(defaultId)) throw new Error("Muse chat model catalog has no default model. Run Muse Code to refresh its catalog.");
  return { models: [...models.values()], defaultId };
}
