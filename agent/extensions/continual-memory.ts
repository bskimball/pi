// Continual memory: small evidence-backed prompt notes and memories that live
// outside the chat transcript. Default write scope is global. Local entries
// are session-scoped (resume via appendEntry on the active branch); global
// entries persist under ~/.pi/agent/harness/global.json. Manual only — never
// rewrites SYSTEM.md.
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
  MAX_ID,
  MAX_LOCAL_PER_KIND,
  MAX_REASON,
  MAX_TITLE,
  LIST_CONTENT,
  LIST_PER_KIND,
  OVERVIEW_CONTENT,
  OVERVIEW_PER_KIND,
  cloneStore,
  compactText,
  countKind,
  emptyStore,
  formatOverview,
  globalPath,
  loadJsonStore,
  looksSecretish,
  mutateGlobal,
  normalizeStore,
  nowIso,
  slug,
  type MemoryEntry,
  type MemoryKind,
  type MemoryScope,
  type MemoryStore,
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
  scope?: "local" | "global" | "all";
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
  let globalStore = emptyStore();
  let globalLoadError: string | undefined;

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

  const reconstructLocal = (ctx: ExtensionContext): void => {
    localStore = storeFromBranch(ctx);
  };

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    reconstructLocal(ctx);
    reloadGlobal();
  });

  pi.on("session_tree", async (_event, ctx: ExtensionContext) => {
    reconstructLocal(ctx);
  });

  pi.on("before_agent_start", async (event) => {
    // Read-only reload without holding lock across the whole turn; overview is advisory.
    const loaded = loadJsonStore(globalPath());
    if (!loaded.error) globalStore = loaded.store;
    globalLoadError = loaded.error;
    const overview = formatOverview(localStore, globalStore);
    const warning = globalLoadError
      ? `\n\n(Continual memory: global store unavailable — ${globalLoadError})`
      : "";
    return {
      systemPrompt: `${event.systemPrompt}\n\n${overview}${warning}`,
    };
  });

  pi.registerTool({
    name: "memory_list",
    label: "Memory List",
    description:
      "List continual-memory entries (session-local and/or global). Use after compaction or when checking what durable notes already exist.",
    promptSnippet:
      "List session-local and global continual-memory entries (memories and prompt notes).",
    promptGuidelines: [
      "Call memory_list when resuming long work after compaction, or before writing a new memory, to avoid duplicates.",
      "Continual memory is supplemental context only; never treat it as a rewrite of the base system prompt.",
    ],
    parameters: Type.Object({
      scope: Type.Optional(
        StringEnum(["local", "global", "all"] as const, {
          description: "local | global | all (default all).",
        }),
      ),
      kind: Type.Optional(
        StringEnum(["memory", "prompt"] as const, {
          description: "Optional kind filter: memory | prompt.",
        }),
      ),
    }),
    executionMode: "sequential",
    async execute(_toolCallId: string, params: ListParams) {
      reloadGlobal();
      const scope = params?.scope ?? "all";
      const kind = params?.kind;
      const local =
        scope === "all" || scope === "local" ? localStore : emptyStore();
      const global =
        scope === "all" || scope === "global" ? globalStore : emptyStore();

      const filteredLocal: MemoryStore = {
        schema: SCHEMA,
        entries: local.entries.filter((e) => !kind || e.kind === kind),
      };
      const filteredGlobal: MemoryStore = {
        schema: SCHEMA,
        entries: global.entries.filter((e) => !kind || e.kind === kind),
      };
      let overview = formatOverview(filteredLocal, filteredGlobal, {
        maxPerKind: LIST_PER_KIND,
        maxContent: LIST_CONTENT,
      });
      if (globalLoadError && (scope === "all" || scope === "global")) {
        overview += `\n\n(global store error: ${globalLoadError})`;
      }
      const count =
        filteredLocal.entries.length + filteredGlobal.entries.length;
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
      "Create, update, or delete a small continual-memory entry. Prefer global for durable facts the next chat should see; use local only for this-session scratch. Kinds: memory (durable facts/preferences/failures) or prompt (narrow policy addendum). Never rewrite SYSTEM.md. Keep entries evidence-backed and short.",
    promptSnippet:
      "Create/update/delete a small session-local or global memory/prompt note (manual continual harness).",
    promptGuidelines: [
      "Use memory_write only for small evidence-backed lessons worth reuse: repeated failures, durable preferences, project facts, or narrow policy addendums. Do not dump the current task; prefer update/delete of stale entries over growing toward the 20/kind cap.",
      "Default scope is global (cross-session). Use local only for this-session scratch that must not follow into a new chat.",
      "Prefer 0–3 focused entries over large dumps. Never rewrite the base system prompt; prompt kind is a narrow supplemental note only.",
      "Do not store secrets, tokens, credentials, or full transcripts.",
    ],
    parameters: Type.Object({
      action: StringEnum(["create", "update", "delete"] as const, {
        description: "create | update | delete",
      }),
      scope: Type.Optional(
        StringEnum(["local", "global"] as const, {
          description: "global (default) or local (this session only).",
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
      const scope: MemoryScope =
        params?.scope === "local" ? "local" : "global";
      const maxPerKind =
        scope === "local" ? MAX_LOCAL_PER_KIND : MAX_GLOBAL_PER_KIND;

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
        const result = mutateGlobal((store) => {
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
        if (result.error) {
          globalLoadError = result.error;
          return textResult(result.error, true, { message: result.error });
        }
        globalStore = result.store;
        globalLoadError = undefined;
        if (missing) {
          const message = `No global entry with id "${id}".`;
          return textResult(message, true, { message });
        }
        const message = `deleted global:${id} (${removedKind}) ${removedTitle}`;
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

      // Confirm global prompt notes (durable policy pressure) before writing.
      if (scope === "global") {
        reloadGlobal();
        const existing =
          action === "update"
            ? globalStore.entries.find((e) => e.id === params?.id?.trim())
            : undefined;
        const isPrompt =
          params?.kind === "prompt" || existing?.kind === "prompt";
        if (isPrompt && ctx.hasUI) {
          const ok = await ctx.ui.confirm(
            "Persist global prompt note?",
            `Write global prompt "${title}" into continual memory for all future sessions?`,
          );
          if (!ok) {
            const message = "Global prompt write cancelled by user.";
            return textResult(message, true, { message });
          }
        } else if (isPrompt && !ctx.hasUI) {
          const message =
            "Global prompt notes require interactive confirmation. Use scope=local or run interactively.";
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
        const result = mutateGlobal((store) => {
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
            scope: "global",
            reason: reason || undefined,
            createdAt: stamp,
            updatedAt: stamp,
            version: 1,
          });
        });
        if (result.error) {
          globalLoadError = result.error;
          return textResult(result.error, true, { message: result.error });
        }
        globalStore = result.store;
        globalLoadError = undefined;
        if (capHit) {
          const message = `global/${kind} is at the cap (${maxPerKind}). Delete or update an existing entry first.`;
          return textResult(message, true, { message });
        }
        const message = `created global:${createdId} (${kind}) ${title}`;
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
      const result = mutateGlobal((store) => {
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
      if (result.error) {
        globalLoadError = result.error;
        return textResult(result.error, true, { message: result.error });
      }
      globalStore = result.store;
      globalLoadError = undefined;
      if (missing) {
        const message = `No global entry with id "${id}".`;
        return textResult(message, true, { message });
      }
      if (kindMismatch) {
        const message = `Cannot change kind on update (entry is ${kindMismatch}). Delete and recreate if needed.`;
        return textResult(message, true, { message });
      }
      const message = `updated global:${id} (${updatedKind}) ${title}`;
      return textResult(message, false, { message });
    },
  });
}
