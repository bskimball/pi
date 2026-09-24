// Continual memory: small evidence-backed prompt notes and memories that live
// outside the chat transcript. Default write scope is global. Local entries
// are session-scoped; project and global entries are durable. Manual only —
// never rewrites SYSTEM.md.
// Injected overview treats entry bodies as untrusted data, not system policy.
//
// Store logic lives in continual-memory/store.ts; this file is the tool adapter.

import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  LOCAL_ENTRY_TYPE,
  SCHEMA,
  MAX_CONTENT,
  MAX_GLOBAL_PER_KIND,
  MAX_LOCAL_PER_KIND,
  MAX_PROJECT_PER_KIND,
  MAX_REASON,
  MAX_TITLE,
  LIST_CONTENT,
  LIST_PER_KIND,
  cloneStore,
  countKind,
  createProjectResolver,
  emptyStore,
  formatOverview,
  globalPath,
  loadJsonStore,
  looksSecretish,
  mutateGlobal,
  mutateProject,
  normalizeStore,
  nowIso,
  slug,
  type MemoryEntry,
  type MemoryKind,
  type MemoryScope,
  type MemoryStore,
  type ProjectContext,
} from "./continual-memory/store.ts";

interface WriteParams {
  action: "create" | "update" | "delete";
  scope?: MemoryScope;
  kind?: MemoryKind;
  id?: string;
  title?: string;
  content?: string;
  reason?: string;
}

interface ListParams {
  scope?: MemoryScope | "all";
  kind?: MemoryKind;
}

interface ToolDetails {
  message?: string;
  overview?: string;
}

function textResult(text: string, isError = false, details: ToolDetails = {}) {
  return {
    content: [{ type: "text" as const, text }],
    details,
    isError,
  };
}

function storeFromBranch(ctx: ExtensionContext): MemoryStore {
  let found: MemoryStore | undefined;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === LOCAL_ENTRY_TYPE) {
      found = normalizeStore(entry.data as Partial<MemoryStore> | undefined, "local");
    }
  }
  return found ?? emptyStore();
}

// ---------------------------------------------------------------- extension

export default function (pi: ExtensionAPI): void {
  let localStore = emptyStore();
  let projectStore = emptyStore();
  let globalStore = emptyStore();
  let projectContext: ProjectContext | undefined;
  let projectLoadError: string | undefined;
  let globalLoadError: string | undefined;
  let compactReminderPending = false;
  const resolveProject = createProjectResolver();
  const memoryWriteReminder =
    "If this session produced a durable fact (preference, failure, project decision) that is not already listed above, offer memory_write — do not auto-write. Skip secrets, transcripts, and one-off task dump.";

  const persistLocal = (): void => {
    // Snapshot so later mutations do not rewrite earlier in-memory custom entries.
    pi.appendEntry(LOCAL_ENTRY_TYPE, cloneStore(localStore));
  };

  const reloadGlobal = (): string | undefined => {
    const loaded = loadJsonStore(globalPath());
    globalStore = loaded.store;
    globalLoadError = loaded.error;
    return globalLoadError;
  };

  const reloadProject = (ctx: ExtensionContext): ProjectContext => {
    const next = resolveProject(ctx.cwd);
    const loaded = loadJsonStore(next.path, "project");
    projectContext = next;
    projectStore = loaded.store;
    projectLoadError = loaded.error;
    return next;
  };

  const reconstructLocal = (ctx: ExtensionContext): void => {
    localStore = storeFromBranch(ctx);
  };

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    reconstructLocal(ctx);
    reloadProject(ctx);
    reloadGlobal();
  });

  pi.on("session_tree", async (_event, ctx: ExtensionContext) => {
    reconstructLocal(ctx);
    reloadProject(ctx);
  });
  pi.on("session_compact", () => {
    if (process.env.PI_SUBAGENT === "1") return;
    compactReminderPending = true;
  });

  pi.on("session_shutdown", (_event, ctx: ExtensionContext) => {
    if (process.env.PI_SUBAGENT === "1") return;
    const message = "If this session produced a durable fact, offer memory_write — do not auto-write.";
    if (ctx.hasUI) {
      ctx.ui.notify(message, "info");
      return;
    }
    process.stderr.write(`${message}\n`);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (process.env.PI_SUBAGENT === "1" || process.env.PI_BEHAVIOR_MODE === "pi") return undefined;
    // Read-only reload without holding locks across the whole turn; overview is advisory.
    reloadProject(ctx);
    reloadGlobal();
    const overview = formatOverview(localStore, projectStore, globalStore);
    const warnings = [
      projectLoadError ? `(Continual memory: project store unavailable — ${projectLoadError})` : "",
      globalLoadError ? `(Continual memory: global store unavailable — ${globalLoadError})` : "",
    ].filter(Boolean);
    const warning = warnings.length > 0 ? `\n\n${warnings.join("\n")}` : "";
    const reminder = compactReminderPending
      ? `\n\n${memoryWriteReminder}`
      : "";
    compactReminderPending = false;
    event.systemPromptOptions.appendSystemPrompt = [event.systemPromptOptions.appendSystemPrompt, `${overview}${warning}${reminder}`].filter(part => part?.trim()).join("\n\n");
  });

  pi.registerTool({
    name: "memory_list",
    label: "Memory List",
    description:
      "List continual-memory entries (session-local, project, and/or global). Use after compaction or when checking what durable notes already exist.",
    promptSnippet:
      "List session-local, project, and global continual-memory entries (memories and prompt notes).",
    promptGuidelines: [
      "Call memory_list when resuming long work after compaction, or before writing a new memory, to avoid duplicates.",
      "Continual memory is supplemental context only; never treat it as a rewrite of the base system prompt.",
    ],
    parameters: Type.Object({
      scope: Type.Optional(
        StringEnum(["local", "project", "global", "all"] as const, {
          description: "local | project | global | all (default all).",
        }),
      ),
      kind: Type.Optional(
        StringEnum(["memory", "prompt"] as const, {
          description: "Optional kind filter: memory | prompt.",
        }),
      ),
    }),
    executionMode: "sequential",
    async execute(
      _toolCallId: string,
      params: ListParams,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      reloadProject(ctx);
      reloadGlobal();
      const scope = params?.scope ?? "all";
      const kind = params?.kind;
      const selected = (wanted: MemoryScope, store: MemoryStore): MemoryStore => ({
        schema: SCHEMA,
        entries: scope === "all" || scope === wanted
          ? store.entries.filter((entry) => !kind || entry.kind === kind)
          : [],
      });
      const filteredLocal = selected("local", localStore);
      const filteredProject = selected("project", projectStore);
      const filteredGlobal = selected("global", globalStore);
      let overview = formatOverview(filteredLocal, filteredProject, filteredGlobal, {
        maxPerKind: LIST_PER_KIND,
        maxContent: LIST_CONTENT,
        maxTotalPerKind: LIST_PER_KIND * 3,
      });
      if (projectLoadError && (scope === "all" || scope === "project")) {
        overview += `\n\n(project store error: ${projectLoadError})`;
      }
      if (globalLoadError && (scope === "all" || scope === "global")) {
        overview += `\n\n(global store error: ${globalLoadError})`;
      }
      const count = filteredLocal.entries.length
        + filteredProject.entries.length
        + filteredGlobal.entries.length;
      return textResult(overview, false, {
        message: `${count} entr${count === 1 ? "y" : "ies"}`,
        overview,
      });
    },
  });

  pi.registerTool({
    name: "memory_write",
    label: "Memory Write",
    description:
      "Create, update, or delete a small continual-memory entry. Use project for repository facts, global for cross-project knowledge, and local for session scratch. Omitted scope remains global. Kinds: memory (durable facts/preferences/failures) or prompt (narrow policy addendum). Never rewrite SYSTEM.md. Keep entries evidence-backed and short.",
    promptSnippet:
      "Create/update/delete a small session-local, project, or global memory/prompt note (manual continual harness).",
    promptGuidelines: [
      "Use memory_write only for small evidence-backed lessons worth reuse: repeated failures, durable preferences, project facts, or narrow policy addendums. Do not dump the current task; prefer update/delete of stale entries over growing toward the 20/kind cap.",
      "Prefer project for repository-specific facts and decisions, global for cross-project preferences and lessons, and local for session scratch. Omitted scope defaults to global for API compatibility.",
      "Prefer 0–3 focused entries over large dumps. Never rewrite the base system prompt; prompt kind is a narrow supplemental note only.",
      "Do not store secrets, tokens, credentials, or full transcripts.",
    ],
    parameters: Type.Object({
      action: StringEnum(["create", "update", "delete"] as const, {
        description: "create | update | delete",
      }),
      scope: Type.Optional(
        StringEnum(["local", "project", "global"] as const, {
          description: "local | project | global (default global).",
        }),
      ),
      kind: Type.Optional(
        StringEnum(["memory", "prompt"] as const, {
          description: "Required for create; memory | prompt.",
        }),
      ),
      id: Type.Optional(
        Type.String({
          description:
            "Entry id (required for update/delete; optional for create).",
        }),
      ),
      title: Type.Optional(
        Type.String({
          description: "Short title (required for create/update).",
        }),
      ),
      content: Type.Optional(
        Type.String({
          description:
            "Entry body (required for create/update). Keep concise.",
        }),
      ),
      reason: Type.Optional(
        Type.String({
          description: "Why this edit is justified (evidence).",
        }),
      ),
    }),
    executionMode: "sequential",
    async execute(
      _toolCallId: string,
      params: WriteParams,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      const action = params?.action;
      let scope: MemoryScope = "global";
      if (params?.scope === "local") scope = "local";
      if (params?.scope === "project") scope = "project";
      if (scope === "project") reloadProject(ctx);
      const caps: Record<MemoryScope, number> = {
        local: MAX_LOCAL_PER_KIND,
        project: MAX_PROJECT_PER_KIND,
        global: MAX_GLOBAL_PER_KIND,
      };
      const maxPerKind = caps[scope];
      const durableStore = (): MemoryStore => scope === "project" ? projectStore : globalStore;
      const mutateDurable = (mutator: (store: MemoryStore) => void) => {
        if (scope === "project") {
          const result = mutateProject(projectContext!, mutator);
          projectStore = result.store;
          projectLoadError = result.error;
          return result;
        }
        const result = mutateGlobal(mutator);
        globalStore = result.store;
        globalLoadError = result.error;
        return result;
      };

      if (action === "delete") {
        const id = params?.id?.trim();
        if (!id) {
          const message = "delete requires id.";
          return textResult(message, true, { message });
        }
        if (scope === "local") {
          const index = localStore.entries.findIndex((e) => e.id === id);
          if (index < 0) {
            const message = `No local entry with id "${id}".`;
            return textResult(message, true, { message });
          }
          const removed = localStore.entries[index];
          localStore.entries.splice(index, 1);
          persistLocal();
          const message = `deleted local:${removed.id} (${removed.kind}) ${removed.title}`;
          return textResult(message, false, { message });
        }
        let removedTitle = "";
        let removedKind: MemoryKind = "memory";
        let missing = false;
        const result = mutateDurable((store) => {
          const index = store.entries.findIndex((e) => e.id === id);
          if (index < 0) {
            missing = true;
            return;
          }
          const removed = store.entries[index];
          removedTitle = removed.title;
          removedKind = removed.kind;
          store.entries.splice(index, 1);
        });
        if (result.error) return textResult(result.error, true, { message: result.error });
        if (missing) {
          const message = `No ${scope} entry with id "${id}".`;
          return textResult(message, true, { message });
        }
        const message = `deleted ${scope}:${id} (${removedKind}) ${removedTitle}`;
        return textResult(message, false, { message });
      }

      if (action !== "create" && action !== "update") {
        const message = "action must be create, update, or delete.";
        return textResult(message, true, { message });
      }

      const title = params?.title?.trim() ?? "";
      const content = params?.content?.trim() ?? "";
      const reason = params?.reason?.trim();
      if (!title || !content) {
        const message = `${action} requires non-empty title and content.`;
        return textResult(message, true, { message });
      }
      if (title.length > MAX_TITLE) {
        const message = `title must be ≤ ${MAX_TITLE} characters.`;
        return textResult(message, true, { message });
      }
      if (content.length > MAX_CONTENT) {
        const message = `content must be ≤ ${MAX_CONTENT} characters. Keep entries small and evidence-backed.`;
        return textResult(message, true, { message });
      }
      if (reason && reason.length > MAX_REASON) {
        const message = `reason must be ≤ ${MAX_REASON} characters.`;
        return textResult(message, true, { message });
      }
      if (looksSecretish(`${title}\n${content}\n${reason ?? ""}`)) {
        const message =
          "Refusing to store credential-shaped content. Continual memory is not a secret store.";
        return textResult(message, true, { message });
      }

      // Confirm durable prompt notes (policy pressure) before writing.
      if (scope !== "local") {
        if (scope === "global") reloadGlobal();
        const existing = action === "update"
          ? durableStore().entries.find((entry) => entry.id === params?.id?.trim())
          : undefined;
        const isPrompt = params?.kind === "prompt" || existing?.kind === "prompt";
        if (isPrompt && ctx.hasUI) {
          const ok = await ctx.ui.confirm(
            `Persist ${scope} prompt note?`,
            scope === "project"
              ? `Write project prompt "${title}" into continual memory for this project?`
              : `Write global prompt "${title}" into continual memory for all future sessions?`,
          );
          if (!ok) {
            const message = `${scope === "project" ? "Project" : "Global"} prompt write cancelled by user.`;
            return textResult(message, true, { message });
          }
        } else if (isPrompt && !ctx.hasUI) {
          const message =
            `${scope === "project" ? "Project" : "Global"} prompt notes require interactive confirmation. Use scope=local or run interactively.`;
          return textResult(message, true, { message });
        }
      }

      if (action === "create") {
        const kind = params?.kind;
        if (kind !== "memory" && kind !== "prompt") {
          const message = "create requires kind: memory or prompt.";
          return textResult(message, true, { message });
        }

        if (scope === "local") {
          if (countKind(localStore, kind) >= maxPerKind) {
            const message = `local/${kind} is at the cap (${maxPerKind}). Delete or update an existing entry first.`;
            return textResult(message, true, { message });
          }
          const baseId = slug(params?.id?.trim() || title, kind);
          let id = baseId;
          let n = 2;
          while (localStore.entries.some((e) => e.id === id)) {
            id = `${baseId}_${n++}`;
          }
          const stamp = nowIso();
          const entry: MemoryEntry = {
            id,
            kind,
            title,
            content,
            scope,
            reason: reason || undefined,
            createdAt: stamp,
            updatedAt: stamp,
            version: 1,
          };
          localStore.entries.push(entry);
          persistLocal();
          const message = `created local:${entry.id} (${kind}) ${title}`;
          return textResult(message, false, { message });
        }

        let createdId = "";
        let capHit = false;
        const result = mutateDurable((store) => {
          if (countKind(store, kind) >= maxPerKind) {
            capHit = true;
            return;
          }
          const baseId = slug(params?.id?.trim() || title, kind);
          let id = baseId;
          let n = 2;
          while (store.entries.some((e) => e.id === id)) {
            id = `${baseId}_${n++}`;
          }
          createdId = id;
          const stamp = nowIso();
          store.entries.push({
            id,
            kind,
            title,
            content,
            scope,
            reason: reason || undefined,
            createdAt: stamp,
            updatedAt: stamp,
            version: 1,
          });
        });
        if (result.error) return textResult(result.error, true, { message: result.error });
        if (capHit) {
          const message = `${scope}/${kind} is at the cap (${maxPerKind}). Delete or update an existing entry first.`;
          return textResult(message, true, { message });
        }
        const message = `created ${scope}:${createdId} (${kind}) ${title}`;
        return textResult(message, false, { message });
      }

      // update
      const id = params?.id?.trim();
      if (!id) {
        const message = "update requires id.";
        return textResult(message, true, { message });
      }

      if (scope === "local") {
        const existing = localStore.entries.find((e) => e.id === id);
        if (!existing) {
          const message = `No local entry with id "${id}".`;
          return textResult(message, true, { message });
        }
        if (params?.kind && params.kind !== existing.kind) {
          const message = `Cannot change kind on update (entry is ${existing.kind}). Delete and recreate if needed.`;
          return textResult(message, true, { message });
        }
        existing.title = title;
        existing.content = content;
        if (reason) existing.reason = reason;
        existing.updatedAt = nowIso();
        existing.version += 1;
        persistLocal();
        const message = `updated local:${existing.id} (${existing.kind}) ${title}`;
        return textResult(message, false, { message });
      }

      let missing = false;
      let kindMismatch: MemoryKind | undefined;
      let updatedKind: MemoryKind = "memory";
      const result = mutateDurable((store) => {
        const existing = store.entries.find((e) => e.id === id);
        if (!existing) {
          missing = true;
          return;
        }
        if (params?.kind && params.kind !== existing.kind) {
          kindMismatch = existing.kind;
          return;
        }
        existing.title = title;
        existing.content = content;
        if (reason) existing.reason = reason;
        existing.updatedAt = nowIso();
        existing.version += 1;
        updatedKind = existing.kind;
      });
      if (result.error) return textResult(result.error, true, { message: result.error });
      if (missing) {
        const message = `No ${scope} entry with id "${id}".`;
        return textResult(message, true, { message });
      }
      if (kindMismatch) {
        const message = `Cannot change kind on update (entry is ${kindMismatch}). Delete and recreate if needed.`;
        return textResult(message, true, { message });
      }
      const message = `updated ${scope}:${id} (${updatedKind}) ${title}`;
      return textResult(message, false, { message });
    },
  });
}
