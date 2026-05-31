// MCPBridgeSubsystem.cpp
// Wires FMCPCommandRouter and FMCPTcpServer into the editor subsystem lifecycle.
//
// Core handlers are always registered. Optional-plugin handlers are guarded by
// preprocessor defines set in Build.cs. When a plugin module is not linked,
// the corresponding Register*Commands() call is skipped and the TypeScript
// side returns "plugin_not_connected" gracefully.

#include "MCPBridgeSubsystem.h"
#include "MCPBlueprintHandlers.h"
#include "MCPActorCommands.h"
#include "MCPAssetCommands.h"
#include "MCPBlueprintWriteHandlers.h"
#include "MCPEditorStateCommands.h"
#include "MCPPieCommands.h"
#include "MCPViewportCommands.h"
#include "MCPInputHandlers.h"
#include "MCPSequencerCommands.h"
#include "MCPSelectionCommands.h"
#include "MCPCollisionPhysicsCommands.h"
#include "Misc/ConfigCacheIni.h"

// Optional module handlers — only included when their Build.cs dependencies are linked.
// To enable: add the module to Build.cs PrivateDependencyModuleNames and uncomment here.
// #include "MCPValidationCommands.h"    // Requires: DataValidation
// #include "MCPMaterialCommands.h"      // Requires: MaterialEditor
// #include "MCPWorldPartitionCommands.h" // Requires: WorldPartitionEditor, DataLayerEditor
// #include "MCPImportExportCommands.h"  // Requires: InterchangeEngine, InterchangeCore, InterchangePipelines
// #include "MCPAudioCommands.h"         // Requires: MetasoundEngine, MetasoundFrontend
// #include "MCPGASCommands.h"           // Requires: GameplayAbilities
// #include "MCPChaosCommands.h"         // Requires: GeometryCollectionEngine, Chaos, ChaosCloth
// #include "MCPLiveLinkCommands.h"      // Requires: LiveLinkInterface, LiveLink
// #include "MCPMotionDesignCommands.h"  // Requires: AvalancheTransition, RemoteControl
// #include "MCPMovieRenderCommands.h"   // Requires: MovieRenderPipelineCore, MovieRenderPipelineEditor
// #include "MCPNetworkingCommands.h"    // Requires: OnlineSubsystem, OnlineSubsystemUtils

void UMCPBridgeSubsystem::Initialize(FSubsystemCollectionBase& Collection)
{
	Super::Initialize(Collection);

	const int32 Port = GetConfiguredPort();

	Router = MakeUnique<FMCPCommandRouter>();

	// --- Core handlers (always available) ---
	RegisterBlueprintHandlers(*Router);
	RegisterBlueprintBridgeHandlers(*Router);
	RegisterActorCommands(*Router);
	RegisterAssetCommands(*Router);
	RegisterBlueprintWriteHandlers(*Router);
	RegisterEditorStateCommands(*Router);
	RegisterPieCommands(*Router);
	RegisterViewportCommands(*Router);
	RegisterInputHandlers(*Router);
	RegisterSequencerCommands(*Router);
	RegisterSelectionCommands(*Router);
	RegisterCollisionPhysicsCommands(*Router);

	// --- Optional handlers (uncomment when plugin dependencies are enabled) ---
	// RegisterValidationCommands(*Router);
	// RegisterMaterialCommands(*Router);
	// RegisterWorldPartitionCommands(*Router);
	// RegisterImportExportCommands(*Router);
	// RegisterAudioCommands(*Router);
	// RegisterGASCommands(*Router);
	// RegisterChaosCommands(*Router);
	// RegisterLiveLinkCommands(*Router);
	// RegisterMotionDesignCommands(*Router);
	// RegisterMovieRenderCommands(*Router);
	// RegisterNetworkingCommands(*Router);

	// Create and start the TCP server.
	TcpServer = MakeUnique<FMCPTcpServer>(*Router);
	bServerRunning = TcpServer->Start(Port);

	if (!bServerRunning)
	{
		UE_LOG(LogTemp, Error, TEXT("[MCPBridge] Failed to start TCP server on port %d."), Port);
	}
	else
	{
		UE_LOG(LogTemp, Log, TEXT("[MCPBridge] TCP server started on port %d."), Port);
	}
}

void UMCPBridgeSubsystem::Deinitialize()
{
	if (TcpServer.IsValid())
	{
		TcpServer->Stop();
		TcpServer.Reset();
	}
	if (Router.IsValid())
	{
		Router.Reset();
	}
	bServerRunning = false;

	Super::Deinitialize();
}

int32 UMCPBridgeSubsystem::GetConfiguredPort() const
{
	int32 Port = 55557;
	if (GConfig)
	{
		GConfig->GetInt(TEXT("MCPBridge"), TEXT("Port"), Port, GEngineIni);
	}
	return Port;
}
