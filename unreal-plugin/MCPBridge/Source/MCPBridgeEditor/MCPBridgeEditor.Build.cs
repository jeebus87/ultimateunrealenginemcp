// MCPBridgeEditor.Build.cs
// Editor module: UEditorSubsystem lifecycle, editor API handlers.
// Depends on MCPBridgeRuntime for the TCP server.
// This module is guarded by WITH_EDITOR -- never ships to cooked builds.
//
// Only modules that ship with every UE 5.7 binary install are linked here.
// Handlers for optional plugins live in the Private/Optional/ subfolder
// and are NOT compiled by default. To enable them, move them to Private/
// and add their module dependencies below.

using UnrealBuildTool;

public class MCPBridgeEditor : ModuleRules
{
    public MCPBridgeEditor(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = ModuleRules.PCHUsageMode.UseExplicitOrSharedPCHs;

        PublicDependencyModuleNames.AddRange(new string[]
        {
            "Core",
            "MCPBridgeRuntime",
        });

        PrivateDependencyModuleNames.AddRange(new string[]
        {
            // Core engine (always present)
            "CoreUObject",
            "Engine",
            "UnrealEd",
            "EditorSubsystem",
            "Json",
            "SlateCore",
            "InputCore",
            "AssetTools",
            "AssetRegistry",
            "LevelEditor",
            "PhysicsCore",

            // Blueprint (always present in editor)
            "Kismet",
            "BlueprintGraph",

            // Sequencer (always present in editor)
            "LevelSequence",
            "LevelSequenceEditor",
            "MovieScene",
            "MovieSceneTracks",

            // Input (always present)
            "EnhancedInput",

            // AI (always present)
            "AIModule",
            "NavigationSystem",
            "GameplayTags",
            "GameplayTasks",
        });
    }
}
