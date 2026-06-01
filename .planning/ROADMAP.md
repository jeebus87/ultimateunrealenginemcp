# Roadmap: Ultimate Unreal Engine MCP

**Project:** Ultimate Unreal Engine MCP
**Core Value:** AI assistants can understand, navigate, generate, and modify any part of an Unreal Engine project through a single MCP interface that actually works.
**Granularity:** Fine (11 phases)
**Coverage:** 49/49 requirements mapped

---

## Phases

- [x] **Phase 1: MCP Server Foundation** - Scaffold TypeScript MCP server with stdio transport, KNOWN_ISSUES integration, and graceful plugin degradation (completed 2026-05-30)
- [x] **Phase 2: Project Config & File Intelligence** - Full read/write access to INI configs, .uproject, and .uplugin files (completed 2026-05-30)
- [x] **Phase 3: API Documentation Index** - Searchable UE 5.7 API reference with class lookup, signatures, includes, and deprecation warnings (completed 2026-05-30)
- [x] **Phase 4: C++ Source Intelligence** - Parse UE C++ source with full macro awareness, inheritance traversal, and include tracing (completed 2026-05-30)
- [x] **Phase 5: C++ Code Generation** - Generate and modify C++ classes (Actors, Components, GameMode, Interfaces) with UHT pre-validation (completed 2026-05-30)
- [x] **Phase 6: Build System Integration** - Trigger UBT builds, receive structured compiler errors, and get AI-informed fix suggestions (completed 2026-05-30)
- [x] **Phase 7: Editor Plugin TCP Infrastructure** - C++ UE Editor plugin with dual-module layout, FSocket TCP bridge, and game-thread dispatch (completed 2026-05-30)
- [x] **Phase 8: Blueprint Read** - Read Blueprint structure, variables, components, event graphs, function graphs, and project-wide BP listing (completed 2026-05-30)
- [x] **Phase 9: Editor Actor & Asset Operations** - Actor CRUD in open level, asset registry queries, reference tracing, and level layout reading (completed 2026-05-30)
- [x] **Phase 10: Blueprint Write** - Create Blueprint assets, add/connect nodes, add variables, and set default values (completed 2026-05-31)
- [x] **Phase 11: Blueprint-C++ Bridge** - Map C++ exposed members to Blueprints, find subclasses, and trace BP usage of C++ members (completed 2026-05-31)
- [x] **Phase 12: Editor State, Viewport & PIE Control** - View editor state, full viewport camera control and render mode switching, high-res screenshotting, PIE session control, runtime log reading, game state observation (completed 2026-05-31)
- [ ] **Phase 13: Sequencer & Cinematics** - Create/inspect/control Level Sequences, add tracks, keyframe properties, playback control, camera cuts
- [ ] **Phase 14: Enhanced Input Management** - Read/create Input Actions and Input Mapping Contexts, inspect bindings, manage modifiers and triggers
- [ ] **Phase 15: Material & Shader Tools** - Read material parameters, create material instances, set scalar/vector/texture parameters, inspect material graphs
- [ ] **Phase 16: Data Validation & CI/CD** - Run asset validation rules, check Blueprint correctness, surface validation errors, commandlet integration
- [ ] **Phase 17: Animation Assets** - Inspect Animation Blueprints, montages, blend spaces, state machines, retarget mappings, Control Rig
- [ ] **Phase 18: World Partition & Data Layers** - Manage data layers, streaming sources, partition cells, HLOD generation, World Partition config
- [ ] **Phase 19: Actor Selection & Duplication** - Editor actor selection/deselection, duplicate actors, convert actors, select by criteria
- [ ] **Phase 20: Collision & Physics Config** - Read/set collision presets, channels, physics materials, physics asset bodies, constraints
- [ ] **Phase 21: Asset Import/Export** - Trigger FBX/USD import via Interchange, export assets, batch import with custom pipelines
- [ ] **Phase 22: AI Systems** - Inspect Behavior Trees, State Trees, Blackboard keys, EQS queries, NavMesh, AI Perception
- [ ] **Phase 23: Audio & MetaSound** - Inspect sound assets, MetaSound patches, Audio Insights monitoring, sound cue management
- [ ] **Phase 24: PCG Framework** - Execute PCG graphs, inspect nodes, query results, standalone graph execution
- [ ] **Phase 25: Gameplay Ability System** - Inspect abilities, effects, attributes, attribute sets, gameplay tags, cues
- [x] **Phase 26: Chaos Physics** - Destruction state management, cloth config, physics asset inspection, geometry collections (completed 2026-05-31)
- [ ] **Phase 27: Virtual Production & Live Link** - Live Link subject management, data preview, broadcast component, hub recording
- [ ] **Phase 28: Motion Design** - Scene State management, Transition Logic, Text3D rich text, Remote Control, Data Link
- [ ] **Phase 29: Movie Render Pipeline** - Render queue management, burn-in config, EXR metadata, material parameter collection overrides
- [ ] **Phase 30: Networking & Replication** - Replication config inspection, net driver settings, online subsystem, Iris replication lifecycle
- [ ] **Phase 31: Visual Review Loop** - Base64 inline screenshots, autonomous camera navigation, multi-angle inspection, scene context, cleanup
- [ ] **Phase 33: Reflection-Based Handlers** - Convert 13 disabled optional handler files to use UE runtime reflection instead of direct includes

---

## Phase Details

### Phase 1: MCP Server Foundation
**Goal**: A working MCP server that AI assistants can connect to via stdio, with operational safety rails in place
**Depends on**: Nothing
**Requirements**: INF-01, INF-02, INF-06, INF-07
**Success Criteria** (what must be TRUE):
  1. Claude Desktop (or any MCP client) can connect to the server via stdio and list available tools
  2. All tool calls that require the editor plugin return a structured "plugin not connected" error instead of crashing
  3. Any operation reads KNOWN_ISSUES.md first and surfaces matching known issues to the caller
  4. Zero console.log calls exist in server code — all logging routes through console.error only
**Plans**: 4 plans

Plans:
- [x] 01-01-PLAN.md — Project scaffold: package.json, tsconfig (NodeNext), ESLint console.log ban, Vitest config, KNOWN_ISSUES.md seed, test scaffolds
- [x] 01-02-PLAN.md — Plugin bridge client (graceful degradation, exponential backoff), path traversal guard, structured logger
- [x] 01-03-PLAN.md — KNOWN_ISSUES store (markdown parser + mtime cache), withKnownIssues middleware, tool registration for list/add operations
- [x] 01-04-PLAN.md — Server entry point wiring all domains, six domain stub files, real unit tests replacing scaffolds, MCP Inspector smoke test checkpoint

### Phase 2: Project Config & File Intelligence
**Goal**: Users can read and modify all Unreal Engine project configuration files through the MCP
**Depends on**: Phase 1
**Requirements**: CFG-01, CFG-02, CFG-03, CFG-04
**Success Criteria** (what must be TRUE):
  1. User can read any section/key from DefaultEngine.ini, DefaultGame.ini, or a custom config file
  2. User can add, update, or remove a config key and the change persists on disk in correct INI format
  3. User can read a .uproject file and see the project's modules, plugins, and engine version
  4. User can list all enabled plugins and their dependencies from the .uproject
**Plans**: 3 plans

Plans:
- [x] 02-01-PLAN.md — UE-aware INI parser (parseIni, setIniValue, writeIniRemoveKey) with full operator semantics (+, -, ., !) and TDD test suite
- [x] 02-02-PLAN.md — .uproject/.uplugin JSON parser with Zod schemas (UProjectSchema, UPluginSchema) and TDD test suite
- [x] 02-03-PLAN.md — Replace four config tool stubs with real implementations (ue_read_config, ue_write_config, ue_read_uproject, ue_list_plugins) + integration tests

### Phase 3: API Documentation Index
**Goal**: Users can look up any UE 5.7 API symbol without leaving the MCP or hallucinating signatures
**Depends on**: Phase 1
**Requirements**: DOC-01, DOC-02, DOC-03, DOC-04
**Success Criteria** (what must be TRUE):
  1. User can search by class name and receive matching UE 5.7 API results with links or inline detail
  2. User can look up a function and receive its exact signature, parameter types, and return type
  3. User can ask for the correct #include path for any UE class and receive it without guessing
  4. Deprecated API symbols are flagged with a deprecation warning and replacement suggestion when looked up
**Plans**: 3 plans

Plans:
- [x] 03-01-PLAN.md — ApiRecord type + DocIndex class (MiniSearch wrapper) with TDD unit tests (Wave 1)
- [x] 03-02-PLAN.md — Bundled curated UE 5.7 API data file (src/docs/data/ue57-api.ts, ~150+ records) (Wave 1)
- [x] 03-03-PLAN.md — Replace four doc tool stubs with real implementations (ue_search_api, ue_lookup_class, ue_get_include_path, ue_check_deprecation) + integration tests (Wave 2)

### Phase 4: C++ Source Intelligence
**Goal**: Users can fully navigate and understand any UE C++ file in their project
**Depends on**: Phase 1
**Requirements**: CPP-01, CPP-02, CPP-03, CPP-04
**Success Criteria** (what must be TRUE):
  1. User can read a C++ source file and receive all UCLASS, UPROPERTY, and UFUNCTION declarations parsed out with their specifiers
  2. User can query a class name and receive its full inheritance chain up to UObject or AActor
  3. User can trace all #include dependencies from a given header file
  4. User can provide a class name and receive the absolute file path to its .h and .cpp files
**Plans**: 3 plans

Plans:
- [x] 04-01-PLAN.md — UE macro regex parser (parseCppFile) with TDD test suite — UCLASS/UPROPERTY/UFUNCTION specifiers, inheritance, includes (Wave 1)
- [ ] 04-02-PLAN.md — CppClassIndex: project-wide class scanner with mtime cache, hierarchy traversal, include query, class file lookup (Wave 1)
- [ ] 04-03-PLAN.md — Replace four C++ tool stubs with real implementations (ue_read_cpp_class, ue_get_class_hierarchy, ue_trace_includes, ue_find_class_file) + integration tests (Wave 2)

### Phase 5: C++ Code Generation
**Goal**: Users can generate new UE C++ classes and modify existing ones without writing boilerplate or risking UHT errors
**Depends on**: Phase 4, Phase 3
**Requirements**: GEN-01, GEN-02, GEN-03, GEN-04, GEN-05, GEN-06, GEN-07, GEN-08
**Success Criteria** (what must be TRUE):
  1. User can generate a new Actor class and receive a valid .h/.cpp pair with correct UCLASS macro, generated.h include, and Super constructor
  2. User can generate ActorComponent and SceneComponent classes with correct component registration boilerplate
  3. User can generate GameMode, GameState, PlayerState, and PlayerController classes with appropriate parent classes
  4. User can generate a UINTERFACE + IInterface pair following UE's dual-class pattern
  5. User can add a UPROPERTY or UFUNCTION declaration to an existing class without breaking the existing file structure
  6. User can add an #include directive and it is inserted in the correct position in the file
  7. Any generated or modified C++ file is pre-validated against UHT rules and rejected with a clear error before being written to disk if it would fail
**Plans**: 4 plans

Plans:
- [ ] 05-01-PLAN.md — UHT pre-validator (validateUhtRules) with TDD test suite: GENERATED_BODY check, generated.h last-include rule, duplicate name detection (Wave 1)
- [x] 05-02-PLAN.md — Class generator (generateClass) with TDD test suite: Actor, ActorComponent, SceneComponent, GameMode, GameState, PlayerState, PlayerController, Interface templates (Wave 1)
- [ ] 05-03-PLAN.md — File modifier (addProperty, addFunction, addInclude) with TDD test suite: parse-then-splice strategy, UHT validation on output (Wave 2)
- [ ] 05-04-PLAN.md — Wire four generation tool handlers into src/tools/cpp/index.ts (ue_generate_class, ue_add_property, ue_add_function, ue_add_include) + 20 integration tests (Wave 3)

### Phase 6: Build System Integration
**Goal**: Users can trigger builds and get actionable error feedback without leaving the MCP
**Depends on**: Phase 5
**Requirements**: BLD-01, BLD-02, BLD-03
**Success Criteria** (what must be TRUE):
  1. User can invoke a build tool call and UnrealBuildTool runs for the correct target
  2. User receives compiler errors as structured data (file path, line number, column, message, severity) not raw text
  3. User receives at least one AI-informed fix suggestion for common UE build error patterns (missing include, wrong macro, GENERATED_BODY missing, etc.)
**Plans**: 3 plans

Plans:
- [ ] 06-01-PLAN.md — TDD: error-parser (parseErrors) + fix-suggester (suggestFix) — structured BuildError output and 4-pattern fix suggestions (Wave 1)
- [ ] 06-02-PLAN.md — execFileNoThrow utility + ubt-runner (runUbt): UBT discovery, dotnet/exe dispatch, concurrent build guard (Wave 1)
- [ ] 06-03-PLAN.md — Wire ue_build and ue_get_build_errors tool handlers with path guard + integration tests (Wave 2)

### Phase 7: Editor Plugin TCP Infrastructure
**Goal**: A C++ UE Editor plugin is installable, starts a TCP server, and can receive and respond to JSON commands from the MCP server
**Depends on**: Phase 1
**Requirements**: INF-03, INF-04, INF-05
**Success Criteria** (what must be TRUE):
  1. User can install the plugin into a UE 5.7 project and it compiles without errors against a binary (Launcher) engine install
  2. The plugin starts a TCP server on port 55557 (configurable) when the editor launches, and the MCP server can connect to it
  3. The plugin uses separate Runtime and Editor modules with correct packaging — it does not cause cook/ship errors
  4. Any UE API call dispatched through the plugin runs on the game thread via AsyncTask without triggering game-thread assertions
**Plans**: 3 plans

Plans:
- [x] 07-01-PLAN.md — C++ plugin scaffold: MCPBridge.uplugin, Runtime + Editor Build.cs, module stubs, UEditorSubsystem (INF-04) (Wave 1)
- [x] 07-02-PLAN.md — TCP server implementation: FMCPTcpServer (FSocket/FTSTicker), FMCPCommandRouter (AsyncTask dispatch, ping/pong), subsystem wiring (INF-03, INF-05) (Wave 2)
- [x] 07-03-PLAN.md — TypeScript client: real sendCommand() with JSON-newline framing + correlationId, 10s timeout, mock-server integration test (INF-03) (Wave 1)

### Phase 8: Blueprint Read
**Goal**: Users can inspect any Blueprint in their project — its structure, variables, and event/function graphs — without crashing the editor
**Depends on**: Phase 7
**Requirements**: BPR-01, BPR-02, BPR-03, BPR-04
**Success Criteria** (what must be TRUE):
  1. User can read a Blueprint asset and receive its parent class, component list, and all variable declarations
  2. User can inspect the event graph of a Blueprint and receive all nodes and their connections as structured data
  3. User can inspect a custom function graph within a Blueprint and receive its nodes and pin connections
  4. User can list all Blueprint assets in the project with their file paths and parent classes
**Plans**: 3 plans

Plans:
- [x] 08-01-PLAN.md — C++ Blueprint handlers: blueprint.read, blueprint.graph, blueprint.list in MCPBridgeEditor; Build.cs module deps (Kismet, BlueprintGraph, AssetRegistry); subsystem wiring (BPR-01, BPR-02, BPR-03, BPR-04) (Wave 1)
- [x] 08-02-PLAN.md — TypeScript types (types.ts) + real tool implementations: ue_read_blueprint, ue_read_blueprint_graph, ue_list_blueprints replacing stubs (BPR-01, BPR-02, BPR-03, BPR-04) (Wave 1)
- [x] 08-03-PLAN.md — Integration tests: 20+ test cases using mock TCP server; export named handler functions for testability (BPR-01, BPR-02, BPR-03, BPR-04) (Wave 2)

### Phase 9: Editor Actor & Asset Operations
**Goal**: Users can inspect, spawn, move, delete actors in the open level and query the asset registry — all through the MCP
**Depends on**: Phase 7
**Requirements**: EDT-01, EDT-02, EDT-03, EDT-04, EDT-05, EDT-06, EDT-07
**Success Criteria** (what must be TRUE):
  1. User can list all actors in the currently open level with their class, label, and world transform
  2. User can spawn an actor of a given class into the level at a specified location and see it appear in the editor
  3. User can move, rotate, and scale an existing placed actor by label or ID and the change is reflected immediately in the editor viewport
  4. User can delete an actor from the level and it is removed from the level without editor instability
  5. User can query the asset registry by type, path prefix, or tag and receive matching asset paths
  6. User can trace the reference and dependency graph for a given asset (what it references, what references it)
  7. User can read the level layout — placed actor list with world composition or world partition structure
**Plans**: 3 plans

Plans:
- [x] 09-01-PLAN.md — C++ actor command handlers: actor.list, actor.spawn, actor.transform, actor.delete + Build.cs module additions (EDT-01..04) (Wave 1)
- [x] 09-02-PLAN.md — C++ asset & level command handlers: asset.query, asset.references, level.layout via IAssetRegistry (EDT-05..07) (Wave 1)
- [x] 09-03-PLAN.md — TypeScript tool implementations: replace stubs, add ue_transform_actor/ue_trace_references/ue_read_level_layout, >= 20 tests (EDT-01..07) (Wave 2)

### Phase 10: Blueprint Write
**Goal**: Users can create new Blueprint assets and modify existing Blueprint graphs through the MCP without corrupting assets
**Depends on**: Phase 8
**Requirements**: BPW-01, BPW-02, BPW-03, BPW-04, BPW-05
**Success Criteria** (what must be TRUE):
  1. User can create a new Blueprint asset from a C++ or Blueprint parent class and it opens correctly in the editor
  2. User can add a node to a Blueprint event graph by node type and it appears in the graph without editor errors
  3. User can connect two node pins in a Blueprint graph and the connection persists after save
  4. User can add a new variable to a Blueprint and it appears in the My Blueprint panel with the correct type
  5. User can set a default value on a Blueprint variable or node input and the value is saved correctly
**Plans**: 3 plans

Plans:
- [ ] 10-01-PLAN.md — C++ write handlers: blueprint.create, blueprint.addNode, blueprint.connectPins, blueprint.addVariable, blueprint.setDefault + subsystem wiring (BPW-01..05) (Wave 1)
- [ ] 10-02-PLAN.md — TypeScript types (5 new result types) + 5 write tool implementations replacing stubs + 3 new tool registrations, injected bridge for testability (BPW-01..05) (Wave 2)
- [x] 10-03-PLAN.md — Integration tests: 28 test cases (injected mock + mock TCP server on port 55563) covering all five write handlers (BPW-01..05) (Wave 3)

### Phase 11: Blueprint-C++ Bridge
**Goal**: Users can understand and navigate the full relationship between C++ exposed members and Blueprint usage across their project
**Depends on**: Phase 8, Phase 4
**Requirements**: BPC-01, BPC-02, BPC-03
**Success Criteria** (what must be TRUE):
  1. User can query a C++ class and receive all UFUNCTION/UPROPERTY members flagged as BlueprintCallable, BlueprintReadWrite, etc.
  2. User can provide a C++ class name and receive all Blueprint assets that subclass it
  3. User can query a specific C++ UFUNCTION or UPROPERTY and receive all Blueprints that reference or call it
**Plans**: 3 plans

Plans:
- [x] 11-01-PLAN.md — C++ plugin handlers: blueprint.subclasses and blueprint.cppUsage + subsystem wiring (BPC-02, BPC-03 plugin side)
- [x] 11-02-PLAN.md — TypeScript types + three tool handlers: ue_cpp_exposed_members, ue_find_blueprint_subclasses, ue_trace_cpp_in_blueprints (BPC-01, BPC-02, BPC-03)
- [x] 11-03-PLAN.md — Integration tests: 20+ test cases using fixture file and mock TCP server (BPC-01, BPC-02, BPC-03)

### Phase 12: Editor State, Viewport & PIE Control
**Goal**: Users have complete access to editor state, viewport camera control, screenshotting, and PIE session management through the MCP
**Depends on**: Phase 7
**Requirements**: PIE-01, PIE-02, PIE-03, PIE-04, PIE-05, PIE-06, PIE-07, PIE-08
**Success Criteria** (what must be TRUE):
  1. User can query the editor and receive currently selected actors, open assets, and viewport camera position
  2. User can start and stop PIE sessions from the MCP
  3. User can read PIE output logs and runtime warnings while a session is active
  4. User can query runtime game state during PIE — actor positions, variable values, active game mode
  5. User can take viewport screenshots at specified resolution and receive the image path
  6. User can control viewport camera — set position, rotation, FOV, orbit around target
  7. User can switch viewport render modes (lit, unlit, wireframe, collision visualization)
  8. User can take high-resolution screenshots with custom camera angles for documentation
**Plans**: 3 plans

Plans:
- [ ] 12-01-PLAN.md — C++ editor state + PIE handlers: editor.state, pie.start, pie.stop, pie.logs, pie.gameState + subsystem wiring (PIE-01..04) (Wave 1)
- [ ] 12-02-PLAN.md — C++ viewport handlers: viewport.screenshot, viewport.camera, viewport.renderMode, viewport.hiresScreenshot + Build.cs SlateCore + subsystem wiring (PIE-05..08) (Wave 1)
- [ ] 12-03-PLAN.md — TypeScript src/tools/viewport/index.ts: 9 tools, src/index.ts wiring, >= 22 tests in tests/viewport.test.ts (PIE-01..08) (Wave 2)

### Phase 13: Sequencer & Cinematics
**Goal**: Users can create, inspect, and control Level Sequences including tracks, keyframes, and playback through the MCP
**Depends on**: Phase 7
**Requirements**: SEQ-01, SEQ-02, SEQ-03, SEQ-04, SEQ-05
**Success Criteria** (what must be TRUE):
  1. User can create a new Level Sequence asset and open it in the editor
  2. User can list all tracks in a sequence with their bound objects and property names
  3. User can add a property track or transform track to a sequence for a given actor
  4. User can add keyframes at specified times with values on existing tracks
  5. User can control sequence playback — play, pause, stop, scrub to time
**Plans**: 3 plans

Plans:
- [x] 13-01-PLAN.md — C++ plugin handlers: sequencer.create, sequencer.tracks, sequencer.addTrack, sequencer.addKey, sequencer.playback + Build.cs LevelSequence/MovieScene deps + subsystem wiring (SEQ-01..05) (Wave 1)
- [x] 13-02-PLAN.md — TypeScript src/tools/sequencer/index.ts: five tools + src/index.ts wiring (SEQ-01..05) (Wave 2)
- [x] 13-03-PLAN.md — Integration tests: 24 test cases using injected mock bridge (SEQ-01..05) (Wave 3)

### Phase 14: Enhanced Input Management
**Goal**: Users can read, create, and manage Enhanced Input configuration through the MCP
**Depends on**: Phase 7
**Requirements**: INP-01, INP-02, INP-03, INP-04
**Success Criteria** (what must be TRUE):
  1. User can list all Input Action assets in the project with their value types
  2. User can create a new Input Action asset with specified value type (bool, float, Vector2D, Vector3D)
  3. User can list all Input Mapping Contexts with their action-to-key bindings
  4. User can add or modify key bindings in an Input Mapping Context (action, key, modifiers, triggers)
**Plans**: 3 plans

Plans:
- [x] 14-01-PLAN.md — C++ plugin handlers: input.listActions, input.createAction, input.listContexts, input.addBinding + Build.cs EnhancedInput dep + subsystem wiring (INP-01..04) (Wave 1)
- [x] 14-02-PLAN.md — TypeScript src/tools/input/index.ts: four tools + src/index.ts wiring (INP-01..04) (Wave 1)
- [ ] 14-03-PLAN.md — Integration tests: 24+ test cases using mock bridge (INP-01..04) (Wave 2)

### Phase 15: Material & Shader Tools
**Goal**: Users can inspect and modify material parameters and create material instances through the MCP
**Depends on**: Phase 7
**Requirements**: MAT-01, MAT-02, MAT-03, MAT-04
**Success Criteria** (what must be TRUE):
  1. User can read all parameters from a material or material instance (scalar, vector, texture)
  2. User can create a new Material Instance Dynamic from a parent material
  3. User can set scalar, vector, and texture parameter values on a material instance
  4. User can list all materials used by a specific actor or static mesh asset
**Plans**: TBD

### Phase 16: Data Validation & CI/CD
**Goal**: Users can run data validation rules and surface asset quality issues through the MCP
**Depends on**: Phase 7
**Requirements**: VAL-01, VAL-02, VAL-03, VAL-04
**Success Criteria** (what must be TRUE):
  1. User can run validation on a specific asset and receive structured pass/fail results with error descriptions
  2. User can run validation on all assets in a folder and receive a summary report
  3. User can run project-wide validation and receive categorized results (errors, warnings, info)
  4. User can check if a Blueprint compiles successfully and receive structured compiler messages
**Plans**: 3 plans

Plans:
- [x] 16-01-PLAN.md — C++ validation handlers: validate.asset, validate.folder, validate.project, validate.blueprint + Build.cs DataValidation dep + subsystem wiring (VAL-01..04) (Wave 1)
- [x] 16-02-PLAN.md — TypeScript types + four tool handlers: ue_validate_asset, ue_validate_folder, ue_validate_project, ue_check_blueprint + src/index.ts wiring (VAL-01..04) (Wave 1)
- [ ] 16-03-PLAN.md — Integration tests: 25+ test cases (injected mock + mock TCP server on port 55564) covering all four validation handlers (VAL-01..04) (Wave 2)

### Phase 17: Animation Assets
**Goal**: Users can inspect and manage animation assets — AnimBPs, montages, blend spaces, state machines, and retarget mappings
**Depends on**: Phase 7
**Requirements**: ANIM-01, ANIM-02, ANIM-03, ANIM-04, ANIM-05
**Success Criteria** (what must be TRUE):
  1. User can list all animation assets in the project by type (AnimBP, Montage, BlendSpace)
  2. User can inspect an Animation Blueprint's state machines, states, and transitions
  3. User can read montage sections, notifies, and slot assignments
  4. User can inspect blend space axes, sample points, and grid configuration
  5. User can read retarget source/target skeleton mappings
**Plans**: 3 plans

Plans:
- [ ] 17-01-PLAN.md — C++ animation handlers: animation.list, inspectAnimBP, inspectMontage, inspectBlendSpace, retargetMappings + Build.cs AnimGraph/IKRig deps + subsystem wiring (ANIM-01..05) (Wave 1)
- [ ] 17-02-PLAN.md — TypeScript types + five tool handlers: ue_list_animation_assets, ue_inspect_anim_blueprint, ue_inspect_montage, ue_inspect_blend_space, ue_read_retarget_mappings + src/index.ts wiring (ANIM-01..05) (Wave 1)
- [x] 17-03-PLAN.md — Integration tests: 25+ test cases using injected mock bridge (ANIM-01..05) (Wave 2)

### Phase 18: World Partition & Data Layers
**Goal**: Users can manage World Partition configuration, data layers, and streaming sources through the MCP
**Depends on**: Phase 7
**Requirements**: WP-01, WP-02, WP-03, WP-04
**Success Criteria** (what must be TRUE):
  1. User can read World Partition settings — grid size, loading range, streaming configuration
  2. User can list and manage data layers — create, enable/disable, assign actors to layers
  3. User can inspect and configure streaming sources and their target states
  4. User can trigger HLOD generation and inspect HLOD layer configuration
**Plans**: 3 plans

Plans:
- [ ] 18-01-PLAN.md — C++ plugin handlers: worldpartition.settings, worldpartition.dataLayers, worldpartition.streamingSources, worldpartition.hlod + Build.cs WorldPartitionEditor dep + subsystem wiring (WP-01..04) (Wave 1)
- [ ] 18-02-PLAN.md — TypeScript types + four tool handlers: ue_read_world_partition, ue_manage_data_layers, ue_inspect_streaming_sources, ue_trigger_hlod_generation + src/index.ts wiring (WP-01..04) (Wave 1)
- [x] 18-03-PLAN.md — Integration tests: 27+ test cases using injected mock bridge (WP-01..04) (Wave 2)

### Phase 19: Actor Selection & Duplication
**Goal**: Users can control editor actor selection and duplicate/convert actors through the MCP
**Depends on**: Phase 7
**Requirements**: SEL-01, SEL-02, SEL-03, SEL-04
**Success Criteria** (what must be TRUE):
  1. User can select/deselect specific actors in the editor by name or class
  2. User can get the current selection and select all/none/invert
  3. User can duplicate selected actors with an optional offset
  4. User can convert actors to a different class (e.g., StaticMeshActor to Blueprint)
**Plans**: 3 plans

Plans:
- [ ] 19-01-PLAN.md — C++ plugin handlers: selection.select, selection.get, selection.duplicate, selection.convert + subsystem wiring (SEL-01..04) (Wave 1)
- [ ] 19-02-PLAN.md — TypeScript src/tools/selection/index.ts: four tools + src/index.ts wiring (SEL-01..04) (Wave 1)
- [x] 19-03-PLAN.md — Integration tests: 27+ test cases using injected mock bridge (SEL-01..04) (Wave 2)

### Phase 20: Collision & Physics Config
**Goal**: Users can read and modify collision and physics settings on actors and assets through the MCP
**Depends on**: Phase 7
**Requirements**: PHY-01, PHY-02, PHY-03, PHY-04
**Success Criteria** (what must be TRUE):
  1. User can read collision preset and channel responses on a component
  2. User can set collision presets and individual channel responses
  3. User can read/set physical material properties (friction, restitution, density)
  4. User can inspect physics asset body setup — capsules, spheres, boxes per bone
**Plans**: TBD

### Phase 21: Asset Import/Export
**Goal**: Users can import and export assets through the MCP using the Interchange framework
**Depends on**: Phase 7
**Requirements**: IMP-01, IMP-02, IMP-03, IMP-04
**Success Criteria** (what must be TRUE):
  1. User can import an FBX file into the project at a specified content path
  2. User can import a USD file into the project using Interchange pipeline
  3. User can export a static mesh or skeletal mesh to FBX format
  4. User can batch import multiple files from a directory with configurable import settings
**Plans**: TBD

### Phase 22: AI Systems
**Goal**: Users can inspect and manage AI assets — Behavior Trees, State Trees, Blackboards, EQS, and NavMesh
**Depends on**: Phase 7
**Requirements**: AI-01, AI-02, AI-03, AI-04, AI-05
**Success Criteria** (what must be TRUE):
  1. User can inspect a Behavior Tree's node hierarchy, decorators, and services
  2. User can read State Tree states, transitions, and tasks
  3. User can list and inspect Blackboard keys with their types and values
  4. User can inspect EQS query templates — generators, tests, and scoring
  5. User can query NavMesh build status, bounds, and reachability between points
**Plans**: 3 plans

Plans:
- [ ] 22-01-PLAN.md — C++ plugin handlers: ai.behaviorTree, ai.stateTree, ai.blackboard, ai.eqs, ai.navmesh + Build.cs AIModule/StateTreeModule/NavigationSystem deps + subsystem wiring (AI-01..05) (Wave 1)
- [ ] 22-02-PLAN.md — TypeScript types + five tool handlers: ue_inspect_behavior_tree, ue_inspect_state_tree, ue_inspect_blackboard, ue_inspect_eqs, ue_query_navmesh + src/index.ts wiring (AI-01..05) (Wave 1)
- [ ] 22-03-PLAN.md — Integration tests: 27+ test cases using injected mock bridge (AI-01..05) (Wave 2)

### Phase 23: Audio & MetaSound
**Goal**: Users can inspect and manage audio assets, MetaSound patches, and Audio Insights through the MCP
**Depends on**: Phase 7
**Requirements**: AUD-01, AUD-02, AUD-03, AUD-04
**Success Criteria** (what must be TRUE):
  1. User can list all sound assets by type (SoundWave, SoundCue, MetaSound)
  2. User can inspect a MetaSound patch's graph nodes, inputs, and outputs
  3. User can read SoundCue node graphs and attenuation settings
  4. User can query Audio Insights monitoring data (live loudness, event history)
**Plans**: 3 plans

Plans:
- [x] 23-01-PLAN.md — C++ plugin handlers: audio.list, audio.metasound, audio.soundcue, audio.insights + Build.cs MetasoundEngine/MetasoundFrontend deps + subsystem wiring (AUD-01..04) (Wave 1)
- [ ] 23-02-PLAN.md — TypeScript types + four tool handlers: ue_list_sound_assets, ue_inspect_metasound, ue_inspect_sound_cue, ue_query_audio_insights + src/index.ts wiring (AUD-01..04) (Wave 1)
- [x] 23-03-PLAN.md — Integration tests: 27+ test cases using injected mock bridge (AUD-01..04) (Wave 2)

### Phase 24: PCG Framework
**Goal**: Users can execute and inspect Procedural Content Generation graphs through the MCP
**Depends on**: Phase 7
**Requirements**: PCG-01, PCG-02, PCG-03, PCG-04
**Success Criteria** (what must be TRUE):
  1. User can list all PCG graph assets in the project
  2. User can inspect a PCG graph's nodes, connections, and parameters
  3. User can execute a PCG graph with specified parameter overrides
  4. User can query PCG execution results — generated point counts, mesh instances, timing
**Plans**: 3 plans

Plans:
- [ ] 24-01-PLAN.md — C++ plugin handlers: pcg.list, pcg.inspect, pcg.execute, pcg.results + Build.cs PCG dep + subsystem wiring (PCG-01..04) (Wave 1)
- [ ] 24-02-PLAN.md — TypeScript src/tools/pcg/index.ts: four tools + src/index.ts wiring (PCG-01..04) (Wave 1)
- [ ] 24-03-PLAN.md — Integration tests: 25+ test cases using injected mock bridge (PCG-01..04) (Wave 2)

### Phase 25: Gameplay Ability System
**Goal**: Users can inspect and manage GAS assets — abilities, effects, attributes, and gameplay tags
**Depends on**: Phase 7
**Requirements**: GAS-01, GAS-02, GAS-03, GAS-04
**Success Criteria** (what must be TRUE):
  1. User can list all Gameplay Ability classes and their configuration (tags, costs, cooldowns)
  2. User can inspect Gameplay Effects — modifiers, duration, stacking, period
  3. User can read Attribute Set definitions with base values and clamping rules
  4. User can query the Gameplay Tag hierarchy and find all assets using a specific tag
**Plans**: 3 plans

Plans:
- [ ] 25-01-PLAN.md — C++ plugin handlers: gas.abilities, gas.effects, gas.attributes, gas.tags + Build.cs GameplayAbilities/GameplayTags/GameplayTasks deps + subsystem wiring (GAS-01..04) (Wave 1)
- [ ] 25-02-PLAN.md — TypeScript src/tools/gas/index.ts: four tools + src/index.ts wiring (GAS-01..04) (Wave 1)
- [x] 25-03-PLAN.md — Integration tests: 27+ test cases using injected mock bridge (GAS-01..04) (Wave 2)

### Phase 26: Chaos Physics
**Goal**: Users can manage Chaos physics state — destruction, cloth, geometry collections, and physics caching
**Depends on**: Phase 7
**Requirements**: CHAOS-01, CHAOS-02, CHAOS-03, CHAOS-04
**Success Criteria** (what must be TRUE):
  1. User can inspect geometry collection fracture hierarchy and cluster configuration
  2. User can reset destruction state on geometry collection actors via C++/MCP
  3. User can read cloth simulation parameters — stiffness, damping, collision thickness
  4. User can manage physics cache recording — start, stop, query cached frames
**Plans**: 3 plans

Plans:
- [x] 26-01-PLAN.md — C++ plugin handlers: chaos.geometryCollection, chaos.resetDestruction, chaos.cloth, chaos.physicsCache + Build.cs GeometryCollectionEngine/ChaosCloth deps + subsystem wiring (CHAOS-01..04) (Wave 1)
- [x] 26-02-PLAN.md — TypeScript src/tools/chaos/index.ts: four tools + src/index.ts wiring (CHAOS-01..04) (Wave 1)
- [x] 26-03-PLAN.md — Integration tests: 27+ test cases using injected mock bridge (CHAOS-01..04) (Wave 2)

### Phase 27: Virtual Production & Live Link
**Goal**: Users can manage Live Link sources, subjects, and data preview through the MCP
**Depends on**: Phase 7
**Requirements**: LL-01, LL-02, LL-03, LL-04
**Success Criteria** (what must be TRUE):
  1. User can list all active Live Link sources and their connection status
  2. User can list all Live Link subjects with their roles (Animation, Transform, Camera)
  3. User can pause/resume individual Live Link subjects
  4. User can inspect Live Link data preview — current frame data for any subject
**Plans**: 3 plans

Plans:
- [ ] 27-01-PLAN.md — C++ plugin handlers: livelink.sources, livelink.subjects, livelink.control, livelink.preview + Build.cs LiveLinkInterface/LiveLink deps + subsystem wiring (LL-01..04) (Wave 1)
- [ ] 27-02-PLAN.md — TypeScript types + four tool handlers: ue_list_livelink_sources, ue_list_livelink_subjects, ue_control_livelink_subject, ue_preview_livelink_data + src/index.ts wiring (LL-01..04) (Wave 1)
- [ ] 27-03-PLAN.md — Integration tests: 27+ test cases using injected mock bridge (LL-01..04) (Wave 2)

### Phase 28: Motion Design
**Goal**: Users can manage Motion Design systems — Scene State, Transition Logic, and Remote Control
**Depends on**: Phase 7
**Requirements**: MD-01, MD-02, MD-03, MD-04
**Success Criteria** (what must be TRUE):
  1. User can list Scene State machines with their states and categories
  2. User can trigger Scene State transitions and set state property values
  3. User can inspect Transition Logic sequences — in/out labels, layer changes
  4. User can read and modify Remote Control preset properties and trigger events
**Plans**: 3 plans

Plans:
- [ ] 28-01-PLAN.md — C++ plugin handlers: motiondesign.sceneStates, transition, transitionLogic, remoteControl + Build.cs AvalancheRundown/AvalancheTransition/RemoteControl deps + subsystem wiring (MD-01..04) (Wave 1)
- [ ] 28-02-PLAN.md — TypeScript types + four tool handlers: ue_list_scene_states, ue_trigger_scene_transition, ue_inspect_transition_logic, ue_manage_remote_control + src/index.ts wiring (MD-01..04) (Wave 1)
- [ ] 28-03-PLAN.md — Integration tests: 27+ test cases using injected mock bridge (MD-01..04) (Wave 2)

### Phase 29: Movie Render Pipeline
**Goal**: Users can manage Movie Render Pipeline render jobs, queue, and output configuration
**Depends on**: Phase 7
**Requirements**: MRP-01, MRP-02, MRP-03, MRP-04
**Success Criteria** (what must be TRUE):
  1. User can list render queue jobs with their status and output settings
  2. User can add a render job with specified sequence, output format, and resolution
  3. User can start/stop render queue execution and monitor progress
  4. User can configure burn-in text, EXR metadata, and file naming tokens
**Plans**: TBD

### Phase 30: Networking & Replication
**Goal**: Users can inspect networking configuration — replication settings, net drivers, and multiplayer session info
**Depends on**: Phase 7
**Requirements**: NET-01, NET-02, NET-03, NET-04
**Success Criteria** (what must be TRUE):
  1. User can inspect actor replication settings — bReplicates, bAlwaysRelevant, NetUpdateFrequency
  2. User can list all replicated properties on an actor with their conditions
  3. User can read NetDriver configuration and active connection count
  4. User can inspect online subsystem session information and player list
**Plans**: 3 plans

Plans:
- [ ] 30-01-PLAN.md — C++ plugin handlers: net.replication, net.properties, net.driver, net.session + Build.cs OnlineSubsystem/OnlineSubsystemUtils deps + subsystem wiring (NET-01..04) (Wave 1)
- [ ] 30-02-PLAN.md — TypeScript src/tools/networking/index.ts: four tools + src/index.ts wiring (NET-01..04) (Wave 1)
- [ ] 30-03-PLAN.md — Integration tests: 27+ test cases using injected mock bridge (NET-01..04) (Wave 2)

### Phase 31: Visual Review Loop
**Goal**: Claude can see viewport screenshots inline and iterate on editor changes through a screenshot→review→fix→screenshot feedback loop
**Depends on**: Phase 12
**Requirements**: VIS-01, VIS-02, VIS-03, VIS-04, VIS-05, VIS-06, VIS-07, VIS-08
**Success Criteria** (what must be TRUE):
  1. Screenshot tools return base64 image data inline (not just file paths) so Claude sees the viewport directly in conversation
  2. Claude can autonomously navigate the editor — fly to any actor by label, frame it from any angle, zoom into details — without the user providing coordinates
  3. Claude can orbit the camera around a target, take screenshots from multiple angles, and describe what it sees — without the user manually sharing images
  4. An `ue_iterate_scene` tool combines screenshot + structured scene description (actor list, visible materials, lighting) in one call so Claude has both visual and semantic context to make targeted fixes
  5. Claude cleans up intermediate screenshots after a review loop completes, only keeping final verified shots if requested
**Plans**: 3 plans

Plans:
- [ ] 31-01-PLAN.md — C++ viewport commands: viewport.lookAt, viewport.frustumActors, viewport.focusActor, viewport.cleanupScreenshots + actor label resolution (VIS-03, VIS-05, VIS-07, VIS-08) (Wave 1)
- [ ] 31-02-PLAN.md — TypeScript base64 image return + 7 new tools: ue_visual_review, ue_look_at, ue_orbit_review, ue_iterate_scene, ue_fly_through, ue_focus_actor, ue_cleanup_screenshots (VIS-01..08) (Wave 1)
- [ ] 31-03-PLAN.md — Integration tests: 30+ test cases for all visual review tools using injected mock bridge (VIS-01..08) (Wave 2)

### Phase 33: Reflection-Based Handlers
**Goal**: All 13 disabled optional handler files compile without optional module dependencies and work at runtime via UE reflection
**Depends on**: Phase 7 (handlers already exist as .disabled files)
**Requirements**: REFLECT-01
**Success Criteria** (what must be TRUE):
  1. All 13 handler .cpp files compile with only the core Build.cs modules (no optional deps)
  2. When optional plugin IS enabled, handlers return identical JSON to their .disabled predecessors
  3. When optional plugin is NOT enabled, handlers return module_not_available gracefully
  4. Build.cs has zero changes from its current state
  5. All .disabled files deleted, handlers active in MCPBridgeSubsystem.cpp
**Plans**: 5 plans

Plans:
- [ ] 33-01-PLAN.md — ReflectionHelpers.h + convert Validation, Networking, Material handlers (REFLECT-01) (Wave 1)
- [ ] 33-02-PLAN.md — Convert LiveLink, MovieRender, ImportExport handlers (REFLECT-01) (Wave 1)
- [ ] 33-03-PLAN.md — Convert Audio, Animation, WorldPartition handlers (REFLECT-01) (Wave 1)
- [ ] 33-04-PLAN.md — Convert GAS, Chaos, AI, MotionDesign handlers (REFLECT-01) (Wave 1)
- [ ] 33-05-PLAN.md — Wire all 13 handlers into MCPBridgeSubsystem.cpp, delete .disabled files (REFLECT-01) (Wave 2)
---

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. MCP Server Foundation | 4/4 | Complete   | 2026-05-30 |
| 2. Project Config & File Intelligence | 3/3 | Complete | 2026-05-30 |
| 3. API Documentation Index | 0/3 | Not started | - |
| 4. C++ Source Intelligence | 0/3 | Not started | - |
| 5. C++ Code Generation | 1/4 | In Progress | - |
| 6. Build System Integration | 0/3 | Not started | - |
| 7. Editor Plugin TCP Infrastructure | 2/3 | In Progress|  |
| 8. Blueprint Read | 3/3 | Complete   | 2026-05-30 |
| 9. Editor Actor & Asset Operations | 3/3 | Complete   | 2026-05-30 |
| 10. Blueprint Write | 0/3 | Not started | - |
| 11. Blueprint-C++ Bridge | 3/3 | Complete   | 2026-05-31 |
| 12. Editor State & PIE Control | 0/3 | Not started | - |
| 13. Sequencer & Cinematics | 3/3 | Complete   | 2026-05-30 |
| 14. Enhanced Input Management | 2/3 | In Progress|  |
| 15. Material & Shader Tools | 2/3 | In Progress|  |
| 16. Data Validation & CI/CD | 2/3 | In Progress|  |
| 17. Animation Assets | 1/3 | In Progress|  |
| 18. World Partition & Data Layers | 1/3 | In Progress|  |
| 19. Actor Selection & Duplication | 1/3 | In Progress|  |
| 20. Collision & Physics Config | 1/3 | In Progress|  |
| 21. Asset Import/Export | 0/? | Not started | - |
| 22. AI Systems | 0/3 | Not started | - |
| 23. Audio & MetaSound | 2/3 | In Progress|  |
| 24. PCG Framework | 0/3 | Not started | - |
| 25. Gameplay Ability System | 1/3 | In Progress|  |
| 26. Chaos Physics | 3/3 | Complete   | 2026-05-31 |
| 27. Virtual Production & Live Link | 0/3 | Not started | - |
| 28. Motion Design | 0/3 | Not started | - |
| 29. Movie Render Pipeline | 0/? | Not started | - |
| 30. Networking & Replication | 0/3 | Not started | - |
| 31. Visual Review Loop | 0/3 | Not started | - |
| 33. Reflection-Based Handlers | 0/5 | Not started | - |

---

## Coverage Map

| Requirement | Phase | Status |
|-------------|-------|--------|
| INF-01 | Phase 1 | Pending |
| INF-02 | Phase 1 | Pending |
| INF-06 | Phase 1 | Pending |
| INF-07 | Phase 1 | Pending |
| CFG-01 | Phase 2 | Pending |
| CFG-02 | Phase 2 | Pending |
| CFG-03 | Phase 2 | Pending |
| CFG-04 | Phase 2 | Pending |
| DOC-01 | Phase 3 | Pending |
| DOC-02 | Phase 3 | Pending |
| DOC-03 | Phase 3 | Pending |
| DOC-04 | Phase 3 | Pending |
| CPP-01 | Phase 4 | Pending |
| CPP-02 | Phase 4 | Pending |
| CPP-03 | Phase 4 | Pending |
| CPP-04 | Phase 4 | Pending |
| GEN-01 | Phase 5 | Complete (05-02) |
| GEN-02 | Phase 5 | Complete (05-02) |
| GEN-03 | Phase 5 | Complete (05-02) |
| GEN-04 | Phase 5 | Complete (05-02) |
| GEN-05 | Phase 5 | Pending |
| GEN-06 | Phase 5 | Pending |
| GEN-07 | Phase 5 | Pending |
| GEN-08 | Phase 5 | Pending |
| BLD-01 | Phase 6 | Pending |
| BLD-02 | Phase 6 | Pending |
| BLD-03 | Phase 6 | Pending |
| INF-03 | Phase 7 | Pending |
| INF-04 | Phase 7 | Pending |
| INF-05 | Phase 7 | Pending |
| BPR-01 | Phase 8 | Pending |
| BPR-02 | Phase 8 | Pending |
| BPR-03 | Phase 8 | Pending |
| BPR-04 | Phase 8 | Pending |
| EDT-01 | Phase 9 | Pending |
| EDT-02 | Phase 9 | Pending |
| EDT-03 | Phase 9 | Pending |
| EDT-04 | Phase 9 | Pending |
| EDT-05 | Phase 9 | Pending |
| EDT-06 | Phase 9 | Pending |
| EDT-07 | Phase 9 | Pending |
| BPW-01 | Phase 10 | Pending |
| BPW-02 | Phase 10 | Pending |
| BPW-03 | Phase 10 | Pending |
| BPW-04 | Phase 10 | Pending |
| BPW-05 | Phase 10 | Pending |
| BPC-01 | Phase 11 | Pending |
| BPC-02 | Phase 11 | Pending |
| BPC-03 | Phase 11 | Pending |
| PIE-01 | Phase 12 | Pending |
| PIE-02 | Phase 12 | Pending |
| PIE-03 | Phase 12 | Pending |
| PIE-04 | Phase 12 | Pending |
| PIE-05 | Phase 12 | Pending |
| PIE-06 | Phase 12 | Pending |
| PIE-07 | Phase 12 | Pending |
| PIE-08 | Phase 12 | Pending |
| SEQ-01 | Phase 13 | Pending |
| SEQ-02 | Phase 13 | Pending |
| SEQ-03 | Phase 13 | Pending |
| SEQ-04 | Phase 13 | Pending |
| SEQ-05 | Phase 13 | Pending |
| INP-01 | Phase 14 | Pending |
| INP-02 | Phase 14 | Pending |
| INP-03 | Phase 14 | Pending |
| INP-04 | Phase 14 | Pending |
| MAT-01 | Phase 15 | Pending |
| MAT-02 | Phase 15 | Pending |
| MAT-03 | Phase 15 | Pending |
| MAT-04 | Phase 15 | Pending |
| VAL-01 | Phase 16 | Pending |
| VAL-02 | Phase 16 | Pending |
| VAL-03 | Phase 16 | Pending |
| VAL-04 | Phase 16 | Pending |
| ANIM-01 | Phase 17 | Pending |
| ANIM-02 | Phase 17 | Pending |
| ANIM-03 | Phase 17 | Pending |
| ANIM-04 | Phase 17 | Pending |
| ANIM-05 | Phase 17 | Pending |
| WP-01 | Phase 18 | Pending |
| WP-02 | Phase 18 | Pending |
| WP-03 | Phase 18 | Pending |
| WP-04 | Phase 18 | Pending |
| SEL-01 | Phase 19 | Pending |
| SEL-02 | Phase 19 | Pending |
| SEL-03 | Phase 19 | Pending |
| SEL-04 | Phase 19 | Pending |
| PHY-01 | Phase 20 | Pending |
| PHY-02 | Phase 20 | Pending |
| PHY-03 | Phase 20 | Pending |
| PHY-04 | Phase 20 | Pending |
| IMP-01 | Phase 21 | Pending |
| IMP-02 | Phase 21 | Pending |
| IMP-03 | Phase 21 | Pending |
| IMP-04 | Phase 21 | Pending |
| AI-01 | Phase 22 | Pending |
| AI-02 | Phase 22 | Pending |
| AI-03 | Phase 22 | Pending |
| AI-04 | Phase 22 | Pending |
| AI-05 | Phase 22 | Pending |
| AUD-01 | Phase 23 | Pending |
| AUD-02 | Phase 23 | Pending |
| AUD-03 | Phase 23 | Pending |
| AUD-04 | Phase 23 | Pending |
| PCG-01 | Phase 24 | Pending |
| PCG-02 | Phase 24 | Pending |
| PCG-03 | Phase 24 | Pending |
| PCG-04 | Phase 24 | Pending |
| GAS-01 | Phase 25 | Pending |
| GAS-02 | Phase 25 | Pending |
| GAS-03 | Phase 25 | Pending |
| GAS-04 | Phase 25 | Pending |
| CHAOS-01 | Phase 26 | Pending |
| CHAOS-02 | Phase 26 | Pending |
| CHAOS-03 | Phase 26 | Pending |
| CHAOS-04 | Phase 26 | Pending |
| LL-01 | Phase 27 | Pending |
| LL-02 | Phase 27 | Pending |
| LL-03 | Phase 27 | Pending |
| LL-04 | Phase 27 | Pending |
| MD-01 | Phase 28 | Pending |
| MD-02 | Phase 28 | Pending |
| MD-03 | Phase 28 | Pending |
| MD-04 | Phase 28 | Pending |
| MRP-01 | Phase 29 | Pending |
| MRP-02 | Phase 29 | Pending |
| MRP-03 | Phase 29 | Pending |
| MRP-04 | Phase 29 | Pending |
| NET-01 | Phase 30 | Pending |
| NET-02 | Phase 30 | Pending |
| NET-03 | Phase 30 | Pending |
| NET-04 | Phase 30 | Pending |
| VIS-01 | Phase 31 | Pending |
| VIS-02 | Phase 31 | Pending |
| VIS-03 | Phase 31 | Pending |
| VIS-04 | Phase 31 | Pending |
| VIS-05 | Phase 31 | Pending |
| VIS-06 | Phase 31 | Pending |
| VIS-07 | Phase 31 | Pending |
| VIS-08 | Phase 31 | Pending |
| REFLECT-01 | Phase 33 | Pending |

**Total:** 142/142 requirements mapped

---

*Roadmap created: 2026-05-30*
*Last updated: 2026-05-30 — Phase 33 plans created (5 plans, 2 waves)*
