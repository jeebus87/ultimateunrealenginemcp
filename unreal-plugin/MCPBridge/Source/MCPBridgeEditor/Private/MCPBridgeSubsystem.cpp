// MCPBridgeSubsystem.cpp
// Wires FMCPCommandRouter and FMCPTcpServer into the editor subsystem lifecycle.
// All handlers use UE reflection for optional plugin access — no optional module linking required.

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
#include "MCPValidationCommands.h"
#include "MCPMaterialCommands.h"
#include "MCPWorldPartitionCommands.h"
#include "MCPImportExportCommands.h"
#include "MCPAudioCommands.h"
#include "MCPGASCommands.h"
#include "MCPChaosCommands.h"
#include "MCPLiveLinkCommands.h"
#include "MCPMotionDesignCommands.h"
#include "MCPMovieRenderCommands.h"
#include "MCPNetworkingCommands.h"
#include "MCPAnimationCommands.h"
#include "MCPAICommands.h"
#include "Misc/ConfigCacheIni.h"

void UMCPBridgeSubsystem::Initialize(FSubsystemCollectionBase& Collection)
{
	Super::Initialize(Collection);

	const int32 Port = GetConfiguredPort();

	Router = MakeUnique<FMCPCommandRouter>();

	// Core handlers
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

	// Reflection-based handlers (use FModuleManager runtime checks internally)
	RegisterValidationCommands(*Router);
	RegisterMaterialCommands(*Router);
	RegisterWorldPartitionCommands(*Router);
	RegisterImportExportCommands(*Router);
	RegisterAudioCommands(*Router);
	RegisterGASCommands(*Router);
	RegisterChaosCommands(*Router);
	RegisterLiveLinkCommands(*Router);
	RegisterMotionDesignCommands(*Router);
	RegisterMovieRenderCommands(*Router);
	RegisterNetworkingCommands(*Router);
	RegisterAnimationCommands(*Router);
	RegisterAICommands(*Router);

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
