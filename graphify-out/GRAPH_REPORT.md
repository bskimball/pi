# Graph Report - .pi  (2026-08-16)

## Corpus Check
- 189 files · ~699,534 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1672 nodes · 3606 edges · 97 communities (85 shown, 12 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 85 edges (avg confidence: 0.76)
- Token cost: 36,500 input · 12,400 output

## Graph Freshness
- Built from commit: `ad151f20`
- Worktree: dirty (uncommitted changes at build time)
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- lib render safety.ts
- lib unified edit.ts
- lib · apex amp task.ts
- extensions graphify.ts
- extensions prompt commands.ts
- themes · colors
- extensions powershell.ts
- lib · extensions continual memory.ts
- lib segmenter safety.ts
- themes · vars
- lib observatory.ts
- apex async task.ts
- lib unified edit adapter.ts
- lib model circuit breaker.ts
- lib · apex apex ui.ts
- lib · extensions bg process.ts
- lib status view.ts
- lib tool receipt.ts
- lsp manager.ts
- lib · extensions crash logger.ts
- lib worker runtime.ts
- bin browser connect.mjs
- extensions todo list.ts
- extensions web search.ts
- LspClient
- lib · normalizeToLF
- CONTEXT.md · Pi Custom Configuration Architecture
- package.json · dependencies
- lib · JobRegistry
- lib · WorkerRuntime
- lib terminal restore watchdog.mjs
- lib · ActivityLedger
- lib · safeVisibleWidth
- lib todo list preview.mjs
- LspManager
- lib · .handleEvent
- lsp command.ts
- tsconfig.json · compilerOptions
- lib · safeTruncateToWidth
- references · Graphify Skill Pipeline
- lib ui common.ts
- lib todo list.ts
- lsp client.ts
- lsp config.ts
- shark art encode shark.py
- lib · applyEditsToNormalizedContent
- lib · applyPlan
- extensions read guard.ts
- lib star field.ts
- lsp package.json
- lib · applyReplacementsPreservingUnchangedLines
- lib pixel art.ts
- lsp positions.ts
- generate image generate_image.py
- agents · Coordination Model
- lib observatory preview.mjs
- lib user profile.ts
- shark art emit ts.py
- lib wait policy.ts
- apex · extensions
- test todo list render.test.ts
- reference · Pi Session TUI Screenshot
- lib · ModelCircuitBreaker
- inactive · Classic CDP Port 29300
- inactive · Deploy via Stevedore Delegation
- current · Deep Space Signal Landing Concept
- current · Orbital Sonar Pi Terminal HUD
- current · Shark to Skill Constellation Map
- current · Refined Observatory Landing
- current · Real Agent Roster Landing
- concepts · Vertical Signal Timeline
- concepts · Mission Cards Concept UI
- reference · Resumed Session After Abort
- reference · Review Session Native Crash
- reference · Planning Agent Update Tasks
- reference · Concurrent Task Activity Transcript
- Great White Side Profile Reference
- shark art preview png.py
- concepts · Mono HUD Concept UI
- concepts · Mono Missions Concept UI
- pi tui · Librarian Task Receipt Screenshot
- pi tui · Tool Call Footer Screenshot
- pi tui · Oracle Sub Agent Process Screenshot
- reference · Pixel Cosmic Shark Crop
- reference · Todos Not Flipped After Commit
- reference · Graph Validation and Portability Handoff
- agents · Final Text Handoff Requirement
- test document.test.ts
- amp prompts · Amp Main Smallest Correct Change
- background process · bg_* Long Running Job Tools
- generate image · generate_image.py Script
- mcp scripting recipes · Bounded Fan out Partial Failures
- amp prompts · Amp Fast Speed First Agency
- agents · Scribe Agent
- agents · Stevedore Agent
- references · Native CLAUDE.md Integration
- reference · Mouse CSI After Prompt

## Architectural Domains
- **agent**: communities 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 28, 29, 30, 31, 32, 33, 34, 35, 36, 38, 39, 40, 41, 42, 43, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 58, 59, 60, 62, 63, 64, 87, 88, 90, 91, 92, 94, 95, 96
- **reference**: communities 61, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 79, 80, 81, 82, 83, 84, 85, 86, 89, 93, 97
- **tools**: communities 44, 57, 77
- **.agents**: communities 26
- **package.json**: communities 27
- **tsconfig.json**: communities 37

## God Nodes (most connected - your core abstractions)
### Module
1. `async-task.ts` - 110 edges
2. `observatory.ts` - 91 edges
3. `unified-edit.ts` - 85 edges
4. `amp-task.ts` - 72 edges
5. `graphify.ts` - 68 edges
### Callable
1. `safeTruncateToWidth()` - 63 edges
2. `cleanInline()` - 44 edges
3. `toolRenderers()` - 29 edges
4. `LspClient` - 27 edges
5. `safeLine()` - 26 edges
### Config
1. `colors` - 53 edges
2. `vars` - 38 edges
3. `compilerOptions` - 10 edges
4. `extensions` - 4 edges
5. `export` - 4 edges

## Surprising Connections (you probably didn't know these)
- `Apex UI Stability Work` --semantically_similar_to--> `Presentation Gate`  [INFERRED] [semantically similar]
  AGENTS.md → CONTEXT.md
- `Sync vs Async Task` --semantically_similar_to--> `Task Delegation Tools`  [INFERRED] [semantically similar]
  CONTEXT.md → README.md
- `Pi Workspace AGENTS.md Rules` --semantically_similar_to--> `Pi Custom Configuration Architecture`  [INFERRED] [semantically similar]
  AGENTS.md → CONTEXT.md
- `Amp Librarian Multi-Repo Understanding` --semantically_similar_to--> `Existing Graph Fast Path Query`  [INFERRED] [semantically similar]
  reference/amp-prompts/amp-librarian.txt → agent/skills/graphify/SKILL.md
- `Amp Oracle Advisor Role` --semantically_similar_to--> `Deploy via Stevedore Delegation`  [INFERRED] [semantically similar]
  reference/amp-prompts/amp-oracle.txt → agent/prompts/inactive/deploy.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Nested Parallel Task Rail** — reference_pi_tui_concepts_concept_1_signal_rail_timeline, reference_pi_tui_concepts_concept_1_signal_rail_oracle, reference_pi_tui_concepts_concept_1_signal_rail_scout [EXTRACTED 1.00]
- **Stacked Sub-Agent Mission Cards** — reference_pi_tui_concepts_concept_2_mission_cards_scout, reference_pi_tui_concepts_concept_2_mission_cards_librarian, reference_pi_tui_concepts_concept_2_mission_cards_output [EXTRACTED 1.00]
- **Monospace Nested HUD** — reference_pi_tui_concepts_concept_3_mono_hud_header, reference_pi_tui_concepts_concept_3_mono_hud_tree, reference_pi_tui_concepts_concept_3_mono_hud_followup [EXTRACTED 1.00]
- **Observatory Empty-State Layout** — reference_current_cosmic_shark_concept_a_deep_space_shark, reference_current_cosmic_shark_concept_a_deep_space_awaiting, reference_current_cosmic_shark_concept_a_deep_space_status [EXTRACTED 1.00]
- **Three-Column Sonar Terminal** — reference_current_cosmic_shark_concept_b_orbital_sonar_radar, reference_current_cosmic_shark_concept_b_orbital_sonar_pathways, reference_current_cosmic_shark_concept_b_orbital_sonar_instruments, reference_current_cosmic_shark_concept_b_orbital_sonar_offgrid [EXTRACTED 1.00]
- **Mapped Inventory Landing** — reference_current_cosmic_shark_concept_c_constellation_map, reference_current_cosmic_shark_concept_c_constellation_pathways, reference_current_cosmic_shark_concept_c_constellation_instruments, reference_current_cosmic_shark_concept_c_constellation_inventory [EXTRACTED 1.00]
- **Refined Two-Column Inventory Landing** — reference_current_cosmic_shark_concept_d_refined_landing_shark, reference_current_cosmic_shark_concept_d_refined_landing_inventory, reference_current_cosmic_shark_concept_d_refined_landing_no_project [EXTRACTED 1.00]
- **Real Named Inventory Columns** — reference_current_cosmic_shark_concept_e_real_inventory_roster, reference_current_cosmic_shark_concept_e_real_inventory_prompts, reference_current_cosmic_shark_concept_e_real_inventory_skills [EXTRACTED 1.00]
- **Dedicated Chrome classic CDP 29300 pathway** — agent_prompts_inactive_browser_dedicated_debug_chrome, agent_prompts_inactive_browser_classic_cdp_29300, agent_prompts_inactive_browser_browser_connect, agent_skills_agent_browser_skill_dedicated_target [EXTRACTED 1.00]
- **Graphify pipeline and optional-step references** — agent_skills_graphify_skill_pipeline, agent_skills_graphify_references_add_watch_ingest_url, agent_skills_graphify_references_add_watch_folder_watch, agent_skills_graphify_references_exports_export_flags, agent_skills_graphify_references_extraction_spec_semantic_subagent, agent_skills_graphify_references_github_and_merge_clone_merge, agent_skills_graphify_references_hooks_post_commit, agent_skills_graphify_references_query_bfs_dfs, agent_skills_graphify_references_transcribe_whisper, agent_skills_graphify_references_update_incremental [EXTRACTED 1.00]
- **Delegated Task Presentation** — reference_pi_tui_screenshot_2026_07_17_075750_task_tree, reference_pi_tui_screenshot_2026_07_17_075750_bash_expand, reference_pi_tui_screenshot_2026_07_17_075750_footer [EXTRACTED 1.00]
- **Live Sub-Agent Activity** — reference_pi_tui_screenshot_of_sub_agent_process_oracle_task, reference_pi_tui_screenshot_of_sub_agent_process_python, reference_pi_tui_screenshot_of_sub_agent_process_planning [EXTRACTED 1.00]
- **Tool Result Plus Footer** — reference_pi_tui_screenshot_of_input_footer_tool_call_python, reference_pi_tui_screenshot_of_input_footer_tool_call_exit_129, reference_pi_tui_screenshot_of_input_footer_tool_call_footer [EXTRACTED 1.00]
- **Live Parallel Workers Then CSI Leak** — reference_screenshot_2026_08_14_072609_task_wait, reference_screenshot_2026_08_14_072609_task_7_machinist, reference_screenshot_2026_08_14_072609_task_8_scribe, reference_screenshot_2026_08_14_072609_mouse_csi [EXTRACTED 1.00]
- **Validation Then Portability Audit** — reference_screenshot_2026_08_14_082441_validation, reference_screenshot_2026_08_14_082441_portability, reference_screenshot_2026_08_14_082441_scout_audit [EXTRACTED 1.00]
- **Edit Failure and Shell Leak** — reference_screenshot_2026_08_13_141314_ins_pre_error, reference_screenshot_2026_08_13_141314_file_not_found, reference_screenshot_2026_08_13_141314_mouse_csi [EXTRACTED 1.00]
- **Visible Pi Session Surfaces** — reference_screenshot_2026_08_12_160704_rpc_status, reference_screenshot_2026_08_12_160704_get_search_content, reference_screenshot_2026_08_12_160704_todos, reference_screenshot_2026_08_12_160704_mouse_csi [EXTRACTED 1.00]
- **Resume After Compaction Failures** — reference_screenshot_2026_08_12_164458_operation_aborted, reference_screenshot_2026_08_12_164458_unknown_worker, reference_screenshot_2026_08_12_164458_todo_read [EXTRACTED 1.00]
- **Review Held Then Native Crash** — reference_screenshot_2026_08_12_194318_cli_ts, reference_screenshot_2026_08_12_194318_todos, reference_screenshot_2026_08_12_194318_v8_fatal [EXTRACTED 1.00]
- **Shared Worker Preamble Files** — agent_agents__shared_specialist_norms, agent_agents__shared_sync_worker_mode, agent_agents__shared_async_worker_mode, agent_agents__handoff_final_text_handoff [EXTRACTED 1.00]
- **Recognizable Great White Profile Cues** — reference_shark_countershading, reference_shark_cues, reference_shark_diver_scale [EXTRACTED 1.00]
- **Specialist Agent Catalog** — agent_agents_advisor_advisor, agent_agents_artisan_artisan, agent_agents_inspector_inspector, agent_agents_librarian_librarian, agent_agents_machinist_machinist, agent_agents_oracle_oracle, agent_agents_picasso_picasso, agent_agents_scout_scout, agent_agents_scribe_scribe, agent_agents_stevedore_stevedore, readme_md_task_delegation [EXTRACTED 1.00]
- **Amp reference prompt family** — reference_amp_prompts_amp_fast_speed_first, reference_amp_prompts_amp_main_smallest_correct_change, reference_amp_prompts_amp_orchestrator_coordination, reference_amp_prompts_amp_rush_execute, reference_amp_prompts_amp_subagent_pragmatic_engineer [INFERRED 0.85]
- **Apex Presentation and Identity Surfaces** — agents_md_apex_ui_stability, context_md_presentation_gate, context_md_tool_receipt, agents_md_observatory_landing, agents_md_cosmic_shark [INFERRED 0.85]

## Communities (97 total, 12 thin omitted)

### Community 0 - "lib render safety.ts"
Cohesion: 0.10
Nodes (38): applyGuardedText(), attachHostPainter(), findOwnMethod(), GUARDED_TEXT, guardUnbrokenRuns(), HOST_DO_RENDER_KEY, HOST_PAINTERS_KEY, HOST_WRAP_KEY (+30 more)

### Community 1 - "lib unified edit.ts"
Cohesion: 0.09
Nodes (27): applyAnchorInsertOperation(), applyReplaceOperation(), applyRowOperations(), Edit, EditDetailsLike, FileSnapshot, FuzzyMatchResult, getContextualReplacePairs() (+19 more)

### Community 2 - "lib · apex amp task.ts"
Cohesion: 0.07
Nodes (51): acquireSlot(), activeRuns, AGENT_HUES, agentHue(), ansiFg(), budgetLabel(), DEFAULT_AGENT_HUES, execute() (+43 more)

### Community 3 - "extensions graphify.ts"
Cohesion: 0.06
Nodes (55): boundModelOutput(), buildGraphifyArgv(), buildSystemBlock(), clampBudget(), clampTimeoutMs(), collectPathsFromToolInput(), DEFAULT_BUDGET, DEFAULT_EXECUTABLE (+47 more)

### Community 4 - "extensions prompt commands.ts"
Cohesion: 0.07
Nodes (46): composeStockRowWithStatus(), FooterConstructor, FooterPrototype, FooterRender, FooterRuntime, globalPatchState, installOrchestrateFooterPatch(), installRuntimeOrchestrateFooterPatch() (+38 more)

### Community 5 - "themes · colors"
Cohesion: 0.04
Nodes (53): colors, accent, bashMode, border, borderAccent, borderMuted, customMessageBg, customMessageLabel (+45 more)

### Community 6 - "extensions powershell.ts"
Cohesion: 0.07
Nodes (34): killDirect(), killGroupOrDirect(), KillOptions, killProcessTree(), killProcessTreeSync(), killWindowsProcessTree(), posixKill(), taskkillPath() (+26 more)

### Community 7 - "lib · extensions continual memory.ts"
Cohesion: 0.09
Nodes (45): acquireGlobalLock(), atomicWriteJson(), cloneStore(), compactText(), countKind(), emptyStore(), formatOverview(), globalLockPath() (+37 more)

### Community 8 - "lib segmenter safety.ts"
Cohesion: 0.09
Nodes (40): agentDir(), callNative(), codePointWidth(), collectAllOrFail(), fallbackSegments(), graphemeSegments(), hangulSyllableType(), INSTALL_KEY (+32 more)

### Community 9 - "themes · vars"
Cohesion: 0.04
Nodes (44): export, cardBg, infoBg, pageBg, name, $schema, vars, agentAdvisor (+36 more)

### Community 10 - "lib observatory.ts"
Cohesion: 0.08
Nodes (38): agentPreferenceRank(), Block, FEATURED_EXTENSION_COMMANDS, featuredAt(), featuredEntries(), featuredRow(), Fg, isAllAgentsChoice() (+30 more)

### Community 11 - "apex async task.ts"
Cohesion: 0.12
Nodes (29): AsyncRenderState, controlCallLine(), controlFallbackLines(), controlLines(), detailRecord(), ensureSessionDir(), EXCLUDED_CHILD_TOOLS, GenerationSnapshot (+21 more)

### Community 12 - "lib unified edit adapter.ts"
Cohesion: 0.19
Nodes (12): formatUnifiedEditArg(), renderablePaths(), shortenPath(), checkCanCreatePath(), formatSummary(), preflightPlan(), prepareUnifiedArguments(), TOOL_DESCRIPTION (+4 more)

### Community 13 - "lib model circuit breaker.ts"
Cohesion: 0.10
Nodes (32): atomicWriteJson(), AttemptDecision, CIRCUIT_FAILURE_THRESHOLD, CIRCUIT_FAILURE_WINDOW_MS, CIRCUIT_HALF_OPEN_TRIAL_MS, CIRCUIT_MAX_ENTRIES, CIRCUIT_MAX_FAILURE_TIMESTAMPS, CIRCUIT_OPEN_COOLDOWN_MS (+24 more)

### Community 14 - "lib · apex apex ui.ts"
Cohesion: 0.10
Nodes (29): applyRandomWorkingIndicator(), clearObservatory(), contextFill(), installLayout(), launchFeatured(), openObservatoryOrb(), randomWorkingFrames(), renderWorkingDots() (+21 more)

### Community 15 - "lib · extensions bg process.ts"
Cohesion: 0.11
Nodes (24): execute(), bgCallLine(), BgJobView, bgPayload, coerceJob(), record(), finiteNumber(), contextCheckpointNote() (+16 more)

### Community 16 - "lib status view.ts"
Cohesion: 0.14
Nodes (33): ControlReceipt, BgCardOptions, bgJobCard(), bgListCard(), jobKind(), jobMeta(), jobSubject(), streamNote() (+25 more)

### Community 17 - "lib tool receipt.ts"
Cohesion: 0.05
Nodes (58): controlRenderers(), BuiltinName, BuiltinRenderState, installBuiltinTools(), primaryArg(), readPriorContent(), registerBuiltin(), resolveToolPath() (+50 more)

### Community 18 - "lsp manager.ts"
Cohesion: 0.20
Nodes (26): asRange(), boundText(), clampLimit(), DIAG_SEV, formatDiagnostics(), formatHover(), formatLocations(), formatSymbols() (+18 more)

### Community 19 - "lib · extensions crash logger.ts"
Cohesion: 0.06
Nodes (45): isolatedChildEnv(), attachJsonlReader(), encodeJsonl(), JsonlLineHandler, MAX_JSONL_LINE, parseJsonlLine(), stubOversizedRecord(), collect() (+37 more)

### Community 20 - "lib worker runtime.ts"
Cohesion: 0.11
Nodes (22): Worker, WorkerView, Activity, canStartWorker(), CapWorker, countLiveWorkers(), hasActiveTools(), isLiveLifecycle() (+14 more)

### Community 21 - "bin browser connect.mjs"
Cohesion: 0.22
Nodes (25): connect(), ensureClassicCdp(), expandHome(), fail(), fileExists(), findChrome(), findOnPath(), getCdpVersion() (+17 more)

### Community 22 - "extensions todo list.ts"
Cohesion: 0.15
Nodes (22): RegisteredTool, safeLine(), TodoListView, defaultTodoPanelLines(), execute(), markTodoEnded(), markTodoStarted(), renderCall() (+14 more)

### Community 23 - "extensions web search.ts"
Cohesion: 0.07
Nodes (36): ToolSpec, FetchArgs, fetchContentSpec, getSearchContentSpec, hostOf(), quoted(), scrubSecrets(), SearchArgs (+28 more)

### Community 24 - "LspClient"
Cohesion: 0.16
Nodes (5): LspClient, isWindowsCmdScript(), timeouts(), pickEncodingFromInitializeResult(), PositionEncoding

### Community 25 - "lib · normalizeToLF"
Cohesion: 0.16
Nodes (17): buildPatchPlan(), buildPlan(), buildPreviewPlan(), buildRowPlan(), createSnapshotStore(), isPatchLikePayload(), isPatchPayload(), maybeReadNormalized() (+9 more)

### Community 26 - "CONTEXT.md · Pi Custom Configuration Architecture"
Cohesion: 0.10
Nodes (22): Shared Specialist Norms, Advisor Agent, Oracle Agent, Scout Agent, Apex UI Stability Work, Cosmic Shark Wordmark, Observatory Landing Screen, Pi Workspace AGENTS.md Rules (+14 more)

### Community 27 - "package.json · dependencies"
Cohesion: 0.09
Nodes (21): diff, @earendil-works/pi-ai, @earendil-works/pi-coding-agent, @earendil-works/pi-tui, dependencies, diff, @earendil-works/pi-ai, @earendil-works/pi-coding-agent (+13 more)

### Community 29 - "lib · WorkerRuntime"
Cohesion: 0.22
Nodes (3): isTerminalLifecycle(), RuntimeClient, WorkerRuntime

### Community 30 - "lib terminal restore watchdog.mjs"
Cohesion: 0.20
Nodes (18): appendCrashLog(), clearState(), crashLogPath(), envOrDefault(), isAlive(), lastPhasePath(), lifecycleLogPath(), logLifecycle() (+10 more)

### Community 31 - "lib · ActivityLedger"
Cohesion: 0.17
Nodes (4): ActivityLedger, ActivityLedgerOptions, ActivityStatus, closeActivity()

### Community 32 - "lib · safeVisibleWidth"
Cohesion: 0.22
Nodes (17): center(), constellationBlock(), constellationCell(), evenSpan(), horizonRule(), indent(), inventoryColumns(), inventoryStacked() (+9 more)

### Community 33 - "lib todo list preview.mjs"
Cohesion: 0.11
Nodes (12): ANSI, hostileStatus, nullProto, OVERRIDES, problems, revoked, SCENARIOS, theme (+4 more)

### Community 34 - "LspManager"
Cohesion: 0.26
Nodes (3): execute(), LspManager, textResult()

### Community 35 - "lib · .handleEvent"
Cohesion: 0.20
Nodes (4): appendLatestText(), extractTextDelta(), storeLatestText(), WorkerRuntimeEventHooks

### Community 36 - "lsp command.ts"
Cohesion: 0.24
Nodes (12): assertCmdSafeToken(), buildCmdExeCLine(), candidatesForBase(), firstResolvable(), isExplicitCommandPath(), killWindowsProcessTree(), quoteCmdArg(), resolveCommandPath() (+4 more)

### Community 37 - "tsconfig.json · compilerOptions"
Cohesion: 0.12
Nodes (16): agent/extensions/**/*.ts, agent/types/**/*.d.ts, ./agent/types/pi-mcp-adapter.d.ts, node, compilerOptions, allowImportingTsExtensions, module, moduleResolution (+8 more)

### Community 38 - "lib · safeTruncateToWidth"
Cohesion: 0.31
Nodes (16): numberReadLines(), previewRows(), fallbackCodePointWidth(), fallbackTruncateToWidth(), fallbackVisibleWidth(), isCombiningCodePoint(), normalizedWidth(), padStartToWidth() (+8 more)

### Community 39 - "references · Graphify Skill Pipeline"
Cohesion: 0.13
Nodes (16): graphify --watch Folder Watcher, graphify add URL Ingest, Graphify Extra Export Flags, Graphify MCP stdio Server, Required Edge Confidence Scores, Semantic Extraction Subagent Schema, GitHub Clone and Cross-Repo Merge, Graphify Post-Commit Hook (+8 more)

### Community 40 - "lib ui common.ts"
Cohesion: 0.16
Nodes (14): ActivityCardStatus, activityGlyph(), activityRows(), ActivityRowsOptions, boundedRailTextLines(), durationText(), TaskCardActivity, TaskCardTheme (+6 more)

### Community 41 - "lib todo list.ts"
Cohesion: 0.20
Nodes (16): emptyStateLines(), buildTodoList(), progressRail(), readProp(), renderTodoList(), safeText(), TITLE_TONES, TODO_GLYPHS (+8 more)

### Community 42 - "lsp client.ts"
Cohesion: 0.27
Nodes (9): createAbortError(), isAbortError(), raceAbort(), throwIfAborted(), ClientOptions, DiagnosticWaitResult, DocumentState, PendingDiagnosticWaiter (+1 more)

### Community 43 - "lsp config.ts"
Cohesion: 0.13
Nodes (23): DEFAULT_DIAGNOSTICS_WAIT_MS, DEFAULT_INIT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, DEFAULTS, LanguageServerConfig, loadUserConfig(), LspUserConfig, ResolvedServer (+15 more)

### Community 44 - "shark art encode shark.py"
Cohesion: 0.21
Nodes (13): box_downsample(), draw_mask(), encode(), preview(), Render a designed shark silhouette into a truecolor half-block cell grid. Each…, Rasterize the designed silhouette; also return the body-depth field. The body…, Normalized distance to the nearest non-shark pixel, clipped at THIN_SCALE., Weighted box average of `values` into a cols x rows grid. Returns (averaged… (+5 more)

### Community 45 - "lib · applyEditsToNormalizedContent"
Cohesion: 0.19
Nodes (13): applyEditsToNormalizedContent(), countNeedleOccurrences(), countOccurrences(), deriveUpdatedContent(), findMatchIndex(), fuzzyFindText(), getDuplicateError(), getEmptyOldTextError() (+5 more)

### Community 46 - "lib · applyPlan"
Cohesion: 0.35
Nodes (11): applyAddChange(), applyDeleteChange(), applyPlan(), applyUpdateChange(), applyWriteChange(), combineDetails(), detailsForChange(), detectLineEnding() (+3 more)

### Community 47 - "extensions read guard.ts"
Cohesion: 0.20
Nodes (7): downscaleImages(), ImageBlock, ImageReadRecord, isImageBlock(), isWildcardOnlyGrepPattern(), ALLOWED, BLOCKED

### Community 48 - "lib star field.ts"
Cohesion: 0.24
Nodes (10): ANSI, fg(), rule(), WIDTH, constellation(), hashSeed(), makeRandom(), Star (+2 more)

### Community 49 - "lsp package.json"
Cohesion: 0.18
Nodes (10): dependencies, vscode-jsonrpc, name, pi, extensions, private, type, version (+2 more)

### Community 50 - "lib · applyReplacementsPreservingUnchangedLines"
Cohesion: 0.50
Nodes (5): applyReplacementsPreservingUnchangedLines(), applyTextReplacements(), getLineSpans(), getReplacementLineRange(), splitLinesWithEndings()

### Community 51 - "lib pixel art.ts"
Cohesion: 0.24
Nodes (9): lateralLine(), logoBlock(), LOWER_HALF, parseHex(), pixelCell(), pixelCells(), pixelRows(), TRUECOLOR (+1 more)

### Community 52 - "lsp positions.ts"
Cohesion: 0.50
Nodes (7): characterOf(), externalToLsp(), lineAt(), offsetOf(), Position, toLspPosition(), utf8Width()

### Community 53 - "generate image generate_image.py"
Cohesion: 0.39
Nodes (8): decode_image_batch(), get_api_key(), main(), png_metadata(), Validate a PNG header and return bounded artifact metadata., Decode and validate a complete response batch before any output write., request_images(), validate_png_file()

### Community 54 - "agents · Coordination Model"
Cohesion: 0.29
Nodes (8): Artisan Agent, Inspector Agent, Librarian Agent, Machinist Agent, Picasso Agent, Brainstorm Prompt Template, Coordination Model, Lead Engineer System Prompt

### Community 55 - "lib observatory preview.mjs"
Cohesion: 0.15
Nodes (12): isProjectAgentFile(), buildObservatory(), collectAgents(), collectPool(), isPathwayEntry(), listInventory(), OBSERVATORY_MAX_LINES, ANSI (+4 more)

### Community 56 - "lib user profile.ts"
Cohesion: 0.48
Nodes (3): loadUserProfile(), MAX_USER_PROFILE_CHARS, USER_PROFILE_FILE

### Community 57 - "shark art emit ts.py"
Cohesion: 0.43
Nodes (6): block(), hex6(), main(), pack_cell(), Generate agent/extensions/apex/lib/shark-art.ts from the shark encoder. Runs…, One packed cell string: "" | "trrggbb" | "brrggbb" | "rrggbbRRGGBB".

### Community 58 - "lib wait policy.ts"
Cohesion: 0.60
Nodes (3): register(), waitForSnapshot(), WaitOutcome

### Community 59 - "apex · extensions"
Cohesion: 0.33
Nodes (5): pi, extensions, amp-task.ts, apex-ui.ts, async-task.ts

### Community 61 - "reference · Pi Session TUI Screenshot"
Cohesion: 0.33
Nodes (6): get_search_content Expired responseId, Leaked Mouse CSI After Prompt, Pi Session TUI Screenshot, Unclean Exit Leaves Shell in Raw Mode, RPC Status Panel, Autotask CLI Todo List

### Community 63 - "inactive · Classic CDP Port 29300"
Cohesion: 0.50
Nodes (5): browser-connect.mjs Helper, Classic CDP Port 29300, Dedicated Authenticated Debug Chrome, Never Plain agent-browser, agent-browser Skill Dedicated Target

### Community 64 - "inactive · Deploy via Stevedore Delegation"
Cohesion: 0.40
Nodes (5): Ship Entire Dirty Worktree, Deploy via Stevedore Delegation, Mandatory Worktree Resolution, Amp Oracle Advisor Role, Claude Code Read-Only Planning

### Community 65 - "current · Deep Space Signal Landing Concept"
Cohesion: 0.40
Nodes (5): AWAITING A SIGNAL, Deep Space Signal Landing Concept, Empty Inventory Uses Awaiting Signal, Full Profile Pixel Shark, Idle Model Status Footer

### Community 66 - "current · Orbital Sonar Pi Terminal HUD"
Cohesion: 0.40
Nodes (5): Orbital Sonar Pi Terminal HUD, Instrument Palette, Off-Grid Offline Status, Slash Command Pathways, Degree-Ring Radar Shark

### Community 67 - "current · Shark to Skill Constellation Map"
Cohesion: 0.40
Nodes (5): Constellation Console Concept, Instruments agent-browser plan autoresearch, 3 Prompts 16 Skills 9 Agents, Shark-to-Skill Constellation Map, Pathways brainstorm browser deploy

### Community 68 - "current · Refined Observatory Landing"
Cohesion: 0.40
Nodes (5): Refined Observatory Landing, Custom Prompts Agents Project Skills, No Project Footer, User Inventory With Empty Project Signal, Starfield Countershaded Shark

### Community 69 - "current · Real Agent Roster Landing"
Cohesion: 0.40
Nodes (5): Real Agent Roster Landing, Single Custom Prompt brainstorm, Truthful User Inventory Listing, Specialist Agent Roster, Project Skills Row

### Community 70 - "concepts · Vertical Signal Timeline"
Cohesion: 0.40
Nodes (5): Signal Rail Concept UI, Nested Oracle Deep Review, Keep Parallel Sub-Agents Visible, Nested Scout Dependency Map, Vertical Signal Timeline

### Community 71 - "concepts · Mission Cards Concept UI"
Cohesion: 0.40
Nodes (5): Mission Cards Concept UI, Librarian Mission Card, JSON Output Card, Card Surfaces Keep Steps Collapsed, Scout Mission Card

### Community 72 - "reference · Resumed Session After Abort"
Cohesion: 0.40
Nodes (5): Workers Unregistered After Compaction, Operation Aborted Banner, Resumed Session After Abort, todo_read Empty After Resume, Unknown Worker task_2

### Community 73 - "reference · Review Session Native Crash"
Cohesion: 0.40
Nodes (5): cli.ts File Ownership Collision, Hold Writers Until Review Lands, Review Session Native Crash, In-Progress Review Todos, Node V8 Fatal Unreachable Code

### Community 74 - "reference · Planning Agent Update Tasks"
Cohesion: 0.40
Nodes (5): AGENTS.md Successful Edit, System Cannot Find File Specified, INS.PRE Outside File Bounds, Mouse CSI After Unclean Prompt, Planning Agent Update Tasks

### Community 75 - "reference · Concurrent Task Activity Transcript"
Cohesion: 0.40
Nodes (5): Mouse CSI After Session End, task_7 Machinist URL Validator Work, task_8 Scribe Graph Docs Sync, Concurrent Task Activity Transcript, task_wait Still Running Polls

### Community 76 - "Great White Side Profile Reference"
Cohesion: 0.40
Nodes (5): Natural Gray-White Countershading, Dorsal Snout Belly Forked Tail, Diver Silhouette Scale Cue, Great White Side Profile Reference, Anatomical Source for Observatory Shark

### Community 77 - "shark art preview png.py"
Cohesion: 0.50
Nodes (4): parse(), Render ANSI truecolor half-block text to a PNG, approximating a terminal. Lets…, Yield (char, fg, bg) per cell, tracking 24-bit SGR colour only., render()

### Community 79 - "concepts · Mono HUD Concept UI"
Cohesion: 0.50
Nodes (4): Mono HUD Concept UI, Follow-up Risks Prompt, Session Header Metadata, ASCII Nested Task Tree

### Community 80 - "concepts · Mono Missions Concept UI"
Cohesion: 0.50
Nodes (4): Mono Missions Concept UI, Side-by-Side Scout Librarian Missions, Model Provider Output Block, Parallel Missions Share Horizontal Space

### Community 81 - "pi tui · Librarian Task Receipt Screenshot"
Cohesion: 0.50
Nodes (4): Collapsed Large Bash Result, Footer Context MCP Tasks, Librarian Task Receipt Screenshot, Librarian Tool Call Tree

### Community 82 - "pi tui · Tool Call Footer Screenshot"
Cohesion: 0.50
Nodes (4): Tool Call Footer Screenshot, Command Exit Code 129, Input Footer MCP Oracle Task, Picasso Frontmatter Python Asserts

### Community 83 - "pi tui · Oracle Sub Agent Process Screenshot"
Cohesion: 0.50
Nodes (4): Oracle Sub-Agent Process Screenshot, Oracle Task Tool Tree, Planning Fresh Pi CLI Validation, Picasso Validation Python Block

### Community 84 - "reference · Pixel Cosmic Shark Crop"
Cohesion: 0.50
Nodes (4): Truecolor Bitmap Shark Tier, Violet-to-Cyan Countershading, Tight Profile Crop Against Void, Pixel Cosmic Shark Crop

### Community 85 - "reference · Todos Not Flipped After Commit"
Cohesion: 0.50
Nodes (4): Admit Work Finished But List Left Open, Todos Not Flipped After Commit, todo_read Tool Call, todo_read Incomplete Work Exchange

### Community 86 - "reference · Graph Validation and Portability Handoff"
Cohesion: 0.67
Nodes (4): Graph Validation and Portability Handoff, Portable Skill vs Personal Docs, Scout m365 Portability Audit, Microsoft Graph Offline Validation

### Community 87 - "agents · Final Text Handoff Requirement"
Cohesion: 0.67
Nodes (3): Final Text Handoff Requirement, Async Worker Mode Semantics, Sync Worker Mode Semantics

### Community 89 - "amp prompts · Amp Main Smallest Correct Change"
Cohesion: 0.67
Nodes (3): Amp Main Smallest Correct Change, Amp Orchestrator Coordination-First, Amp Subagent Pragmatic Engineer

## Knowledge Gaps
- **438 isolated node(s):** `port`, `profileDir`, `DEFAULT_AGENT_HUES`, `AGENT_HUES`, `MissionActivity` (+433 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **12 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `safeTruncateToWidth()` connect `lib · safeTruncateToWidth` to `lib · safeVisibleWidth`, `lib · apex amp task.ts`, `extensions prompt commands.ts`, `extensions powershell.ts`, `lib ui common.ts`, `lib todo list.ts`, `lib observatory.ts`, `apex async task.ts`, `lib unified edit adapter.ts`, `lib status view.ts`, `lib tool receipt.ts`, `extensions todo list.ts`?**
  _High betweenness centrality (0.067) - this node is a cross-community bridge._
- **Why does `cleanInline()` connect `lib · apex amp task.ts` to `extensions graphify.ts`, `lib · safeTruncateToWidth`, `extensions powershell.ts`, `lib ui common.ts`, `lib todo list.ts`, `lib observatory.ts`, `apex async task.ts`, `lib unified edit adapter.ts`, `lib · apex apex ui.ts`, `lib · extensions bg process.ts`, `lib status view.ts`, `lib tool receipt.ts`, `extensions web search.ts`, `extensions todo list.ts`, `lib observatory preview.mjs`?**
  _High betweenness centrality (0.033) - this node is a cross-community bridge._
- **Why does `withApexPresentation()` connect `lib tool receipt.ts` to `lib · apex amp task.ts`, `extensions graphify.ts`, `extensions powershell.ts`, `lib · extensions continual memory.ts`, `apex async task.ts`, `lib unified edit adapter.ts`, `lib · extensions bg process.ts`, `extensions todo list.ts`, `extensions web search.ts`?**
  _High betweenness centrality (0.029) - this node is a cross-community bridge._
- **What connects `port`, `profileDir`, `DEFAULT_AGENT_HUES` to the rest of the system?**
  _438 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `lib render safety.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.09745293466223699 - nodes in this community are weakly interconnected._
- **Should `lib unified edit.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.09195402298850575 - nodes in this community are weakly interconnected._
- **Should `lib · apex amp task.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.06594071385359952 - nodes in this community are weakly interconnected._