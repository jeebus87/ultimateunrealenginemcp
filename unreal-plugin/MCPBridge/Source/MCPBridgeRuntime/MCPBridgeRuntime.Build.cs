// MCPBridgeRuntime.Build.cs
// Runtime module: TCP server, JSON framing, command router.
// IMPORTANT: Do NOT add any editor module dependencies here.
// Editor-only code lives exclusively in MCPBridgeEditor.

using UnrealBuildTool;

public class MCPBridgeRuntime : ModuleRules
{
    public MCPBridgeRuntime(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = ModuleRules.PCHUsageMode.UseExplicitOrSharedPCHs;

        PublicDependencyModuleNames.AddRange(new string[]
        {
            "Core",
        });

        PrivateDependencyModuleNames.AddRange(new string[]
        {
            "CoreUObject",
            "Engine",
            "Sockets",
            "Networking",
            "Json",
        });
    }
}
