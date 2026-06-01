# Phase 33: Reflection-Based Optional Handlers - Context

**Gathered:** 2026-05-31
**Status:** Ready for planning
**Mode:** Best (research-informed, zero user prompts)

<domain>
## Phase Boundary

Rewrite all 13 disabled C++ handler files to use UE runtime reflection instead of direct `#include` of optional plugin headers. This means every handler compiles against core engine modules only, but still works when the optional plugin is enabled at runtime. The handlers use `FindObject<UClass>`, `FProperty` iteration, and `FModuleManager::IsModuleLoaded()` to access plugin types without compile-time linking.

**The problem:** 13 handler files are currently disabled (renamed to `.cpp.disabled` in `Private/Optional/`) because they `#include` headers from optional UE plugins (MetaSound, LiveLink, Chaos Cloth, IKRig, etc.). If those modules are linked in Build.cs but the plugin isn't enabled in the user's project, the DLL fails to load at editor startup.

**The fix:** Rewrite each handler to:
1. NOT `#include` any optional plugin headers
2. Use `FModuleManager::IsModuleLoaded("ModuleName")` to check availability at runtime
3. Use `FindObject<UClass>` or `StaticLoadClass` to find UClasses by path string
4. Use `TFieldIterator<FProperty>` and `FProperty::GetValue_InContainer` to read properties
5. Use `UObject::FindFunction` + `ProcessEvent` to call UFUNCTIONs
6. Return `"module_not_available"` gracefully when the plugin isn't enabled

</domain>

<decisions>
## Implementation Decisions

### Handlers to convert (13 files, 26 .h/.cpp pairs)
1. **MCPAnimationCommands** — IKRig (retarget mappings only; AnimBP/Montage/BlendSpace use core Animation modules)
2. **MCPValidationCommands** — DataValidation
3. **MCPMaterialCommands** — MaterialEditor
4. **MCPWorldPartitionCommands** — WorldPartitionEditor, DataLayerEditor
5. **MCPImportExportCommands** — InterchangeEngine, InterchangeCore, InterchangePipelines
6. **MCPAudioCommands** — MetasoundEngine, MetasoundFrontend
7. **MCPGASCommands** — GameplayAbilities
8. **MCPChaosCommands** — GeometryCollectionEngine, Chaos, ChaosCloth
9. **MCPLiveLinkCommands** — LiveLinkInterface, LiveLink
10. **MCPMotionDesignCommands** — AvalancheTransition, RemoteControl
11. **MCPMovieRenderCommands** — MovieRenderPipelineCore, MovieRenderPipelineEditor
12. **MCPNetworkingCommands** — OnlineSubsystem, OnlineSubsystemUtils
13. **MCPAICommands** — StateTreeModule (BehaviorTree/Blackboard/EQS/NavMesh are fine — only StateTree needs reflection)

### Reflection Pattern (use for ALL handlers)
```cpp
// Instead of: #include "MetaSoundSource.h"
// Do this:
UClass* MetaSoundClass = FindObject<UClass>(nullptr, TEXT("/Script/MetasoundEngine.MetaSoundSource"));
if (!MetaSoundClass)
{
    // Plugin not available — return graceful error
    SendError(SendResponse, CorrelationId, TEXT("metasound_plugin_not_enabled"));
    return;
}

// Instead of: Asset->SomeProperty
// Do this:
FProperty* Prop = MetaSoundClass->FindPropertyByName(TEXT("SomeProperty"));
if (Prop)
{
    FString Value;
    Prop->GetValue_InContainer(AssetObject, &Value);
}

// Instead of: Asset->SomeFunction(args)
// Do this:
UFunction* Func = AssetObject->FindFunction(TEXT("SomeFunction"));
if (Func)
{
    struct { /* params */ } Params;
    AssetObject->ProcessEvent(Func, &Params);
}
```

### Non-Negotiable Constraints
- All handlers MUST compile with ONLY the core Build.cs modules (no optional deps)
- All handlers MUST work at runtime when the plugin IS enabled (correct data returned)
- All handlers MUST return `"module_not_available"` when the plugin is NOT enabled
- All handlers MUST use AsyncTask(GameThread) dispatch
- No console.log in TypeScript
- The `.disabled` files in `Optional/` are the reference implementations — use them as spec for what each handler should return

### After conversion
- Move converted `.cpp`/`.h` files from `Optional/` back to `Private/`
- Delete the `.disabled` files
- Re-add `#include` and `Register*Commands(*Router)` calls in MCPBridgeSubsystem.cpp
- NO changes to Build.cs — keep only core modules

### Build.cs stays minimal
Do NOT add any optional modules back to Build.cs. The entire point is that the plugin compiles and loads with core modules only.

</decisions>

<code_context>
## Existing Code Insights

### Reference implementations (what each handler should do)
All 13 `.cpp.disabled` files in `Private/Optional/` contain the working implementations that used direct includes. These are the specification — the reflection-based versions must return identical JSON responses.

### Reflection utilities already in codebase
- `MCPMotionDesignCommands.cpp` already uses `FindObject<UClass>` and FProperty reflection for Avalanche types — this is the proven pattern to follow
- `MCPChaosCommands.cpp` uses `FFloatProperty` reflection for cloth params

### Key UE reflection APIs
- `FindObject<UClass>(nullptr, TEXT("/Script/ModuleName.ClassName"))` — find UClass by full path
- `StaticLoadObject(UClass::StaticClass(), nullptr, *AssetPath)` — load asset as UObject*
- `TFieldIterator<FProperty>(UClass*)` — iterate all properties of a class
- `FProperty::ContainerPtrToValuePtr<void>(Object)` — get property value pointer
- `FNumericProperty::GetSignedIntPropertyValue` / `GetFloatingPointPropertyValue` — read numeric values
- `FStrProperty`, `FNameProperty`, `FBoolProperty` — typed property access
- `FArrayProperty` + `FScriptArrayHelper` — iterate TArray properties
- `UObject::FindFunction(FName)` + `ProcessEvent` — call UFUNCTION by name

</code_context>

<specifics>
## Specific Ideas

- Group the 13 handlers into waves by complexity: simple reflection (Validation, Material, Networking) first, complex (Animation, Audio, GAS) second
- For MCPAICommands: only the StateTree handler needs reflection — BehaviorTree, Blackboard, EQS, NavMesh all use core AIModule headers. Split into: core AI (compiles now) + StateTree (reflection)
- Create a shared `ReflectionHelpers.h` with utility functions: `GetStringProperty`, `GetFloatProperty`, `GetBoolProperty`, `GetArrayProperty` to reduce boilerplate across 13 files

</specifics>

<deferred>
## Deferred Ideas

- Auto-detection of which optional plugins are enabled and dynamic handler registration
- Plugin dependency graph visualization in the MCP tools
- Hot-reload of handlers when plugins are enabled/disabled during editor session

</deferred>
