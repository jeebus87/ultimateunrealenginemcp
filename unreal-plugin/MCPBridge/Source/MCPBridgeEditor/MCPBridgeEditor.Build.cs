// MCPBridgeEditor.Build.cs
// Editor module: UEditorSubsystem lifecycle, editor API handlers (Phases 8-29).
// Depends on MCPBridgeRuntime for the TCP server.
// This module is guarded by WITH_EDITOR -- never ships to cooked builds.

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
            "CoreUObject",
            "Engine",
            "UnrealEd",
            "EditorSubsystem",
            "Json",
            "Kismet",
            "BlueprintGraph",
            "AssetRegistry",
            "InputCore",
            "EnhancedInput",
            "LevelEditor",
            "SlateCore",
            "DataValidation",
            "LevelSequence",
            "MovieScene",
            "MovieSceneTracks",
            "LevelSequenceEditor",
            "MaterialEditor",
            "AssetTools",
            "AnimGraph",
            "AnimGraphRuntime",
            "IKRig",
            "WorldPartitionEditor",
            "DataLayerEditor",
            "PhysicsCore",
            "MetasoundEngine",
            "MetasoundFrontend",
            "InterchangeEngine",
            "InterchangeCore",              // UInterchangeSourceData
            "InterchangePipelines",
            "AIModule",
            "StateTreeModule",
            "NavigationSystem",
            "GameplayAbilities",        // Phase 25 - GAS
            "GameplayTags",             // Phase 25 - GAS
            "GameplayTasks",            // Phase 25 - GAS
            "GeometryCollectionEngine", // Phase 26 - Chaos destruction (UGeometryCollectionComponent)
            "Chaos",                    // Phase 26 - FManagedArrayCollection, FTransformCollection
            "ClothingSystemRuntimeCommon", // Phase 26 - UClothingAssetCommon
            "ChaosCloth",               // Phase 26 - Chaos cloth simulation parameters
            "LiveLinkInterface",        // Phase 27 - ILiveLinkClient, FLiveLinkSubjectKey, FLiveLinkSubjectFrameData
            "LiveLink",                 // Phase 27 - ULiveLinkSubjectSettings for per-subject enabled state control
            "AvalancheTransition",      // Phase 28 - Motion Design Transition Logic trees (experimental)
            "RemoteControl",            // Phase 28 - Remote Control preset read/write
            "MovieRenderPipelineCore",  // Phase 29 - UMoviePipelineQueue, UMoviePipelineExecutorJob, config/settings types
            "MovieRenderPipelineSettings", // Phase 29 - UMoviePipelineBurnInSetting
            "MovieRenderPipelineEditor", // Phase 29 - UMoviePipelineQueueSubsystem
            "OnlineSubsystem",          // Phase 30 - IOnlineSubsystem, IOnlineSession, FOnlineSessionSettings
            "OnlineSubsystemUtils",     // Phase 30 - Online subsystem helper utilities
        });
    }
}
