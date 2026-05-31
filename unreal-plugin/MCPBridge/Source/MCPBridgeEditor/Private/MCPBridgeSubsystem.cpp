// MCPBridgeSubsystem.cpp (updated by Plans 07-02, 08-01, 09-01, 09-02, 10-01, 12-01, 12-02, 13-01, 17-01, 18-01, 19-01, 20-01, 21-01, 22-01, 23-01, 25-01, 26-01, 27-01, 28-01, 29-01, 30-01)
// Wires FMCPCommandRouter and FMCPTcpServer into the editor subsystem lifecycle.

#include "MCPBridgeSubsystem.h"
#include "MCPBlueprintHandlers.h"
#include "MCPActorCommands.h"
#include "MCPAssetCommands.h"
#include "MCPBlueprintWriteHandlers.h"
#include "MCPEditorStateCommands.h"
#include "MCPPieCommands.h"
#include "MCPViewportCommands.h"
#include "MCPValidationCommands.h"
#include "MCPInputHandlers.h"
#include "MCPMaterialCommands.h"
#include "MCPSequencerCommands.h"
#include "MCPAnimationCommands.h"
#include "MCPWorldPartitionCommands.h"
#include "MCPAICommands.h"
#include "MCPSelectionCommands.h"
#include "MCPCollisionPhysicsCommands.h"
#include "MCPImportExportCommands.h"
#include "MCPMotionDesignCommands.h"
#include "MCPChaosCommands.h"
#include "MCPAudioCommands.h"
#include "MCPGASCommands.h"
#include "MCPLiveLinkCommands.h"
#include "MCPMovieRenderCommands.h"
#include "MCPNetworkingCommands.h"
#include "Misc/ConfigCacheIni.h"

void UMCPBridgeSubsystem::Initialize(FSubsystemCollectionBase& Collection)
{
	Super::Initialize(Collection);

	const int32 Port = GetConfiguredPort();

	// Create the router (registers built-in ping handler in constructor).
	Router = MakeUnique<FMCPCommandRouter>();

	// Register Blueprint command handlers (blueprint.read, blueprint.graph, blueprint.list).
	RegisterBlueprintHandlers(*Router);

	// Register Blueprint-C++ bridge handlers (blueprint.subclasses, blueprint.cppUsage).
	RegisterBlueprintBridgeHandlers(*Router);

	// Register Actor command handlers (actor.list, actor.spawn, actor.transform, actor.delete).
	RegisterActorCommands(*Router);

	// Register Asset/Level command handlers (asset.query, asset.references, level.layout).
	RegisterAssetCommands(*Router);

	// Register Blueprint write command handlers (blueprint.create, addNode, connectPins, addVariable, setDefault).
	RegisterBlueprintWriteHandlers(*Router);

	// Register Editor State command handlers (editor.state).
	RegisterEditorStateCommands(*Router);

	// Register PIE command handlers (pie.start, pie.stop, pie.logs, pie.gameState).
	RegisterPieCommands(*Router);

	// Register Viewport command handlers (viewport.screenshot, viewport.camera, viewport.renderMode, viewport.hiresScreenshot).
	RegisterViewportCommands(*Router);

	// Register validation command handlers (validate.asset, validate.folder, validate.project, validate.blueprint).
	RegisterValidationCommands(*Router);

	// Register Enhanced Input command handlers (input.listActions, input.createAction, input.listContexts, input.addBinding).
	RegisterInputHandlers(*Router);

	// Register Material command handlers (material.params, material.createInstance, material.setParam, material.actorMaterials).
	RegisterMaterialCommands(*Router);

	// Register Sequencer command handlers (sequencer.create, tracks, addTrack, addKey, playback).
	RegisterSequencerCommands(*Router);

	// Register Animation command handlers (animation.list, inspectAnimBP, inspectMontage, inspectBlendSpace, retargetMappings).
	RegisterAnimationCommands(*Router);

	// Register World Partition command handlers (worldpartition.settings, dataLayers, streamingSources, hlod).
	RegisterWorldPartitionCommands(*Router);

	// Register AI system command handlers (ai.behaviorTree, ai.stateTree, ai.blackboard, ai.eqs, ai.navmesh).
	RegisterAICommands(*Router);

	// Register Selection command handlers (selection.select, selection.get, selection.duplicate, selection.convert).
	RegisterSelectionCommands(*Router);

	// Register Collision & Physics command handlers (collision.read, collision.set, physics.material, physics.asset).
	RegisterCollisionPhysicsCommands(*Router);

	// Register Import/Export command handlers (import.fbx, import.usd, export.mesh, import.batch).
	RegisterImportExportCommands(*Router);

	// Register Motion Design command handlers (motiondesign.sceneStates, transition, transitionLogic, remoteControl).
	RegisterMotionDesignCommands(*Router);

	// Register Chaos physics command handlers (chaos.geometryCollection, chaos.resetDestruction, chaos.cloth, chaos.physicsCache).
	RegisterChaosCommands(*Router);

	// Register Audio command handlers (audio.list, audio.metasound, audio.soundcue, audio.insights).
	RegisterAudioCommands(*Router);

	// Register GAS command handlers (gas.abilities, gas.effects, gas.attributes, gas.tags).
	RegisterGASCommands(*Router);

	// Register Live Link command handlers (livelink.sources, livelink.subjects, livelink.control, livelink.preview).
	RegisterLiveLinkCommands(*Router);

	// Register Movie Render Pipeline command handlers (movierender.queue, movierender.addJob, movierender.control, movierender.configure).
	RegisterMovieRenderCommands(*Router);

	// Register Networking command handlers (net.replication, net.properties, net.driver, net.session).
	RegisterNetworkingCommands(*Router);

	// Create and start the TCP server.
	TcpServer = MakeUnique<FMCPTcpServer>(*Router);
	bServerRunning = TcpServer->Start(Port);

	if (!bServerRunning)
	{
		UE_LOG(LogTemp, Error, TEXT("[MCPBridge] Failed to start TCP server on port %d."), Port);
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
