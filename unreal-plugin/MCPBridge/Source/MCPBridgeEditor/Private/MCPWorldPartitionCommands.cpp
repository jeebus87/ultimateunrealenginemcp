// MCPWorldPartitionCommands.cpp (Plan 33-03)
// Implements four World Partition command handlers for the MCP bridge:
//   worldpartition.settings        -- read WP grid size, loading range, streaming config (WP-01)
//   worldpartition.dataLayers      -- list/create/toggle data layers, assign actors (WP-02)
//   worldpartition.streamingSources -- inspect streaming sources with shape, priority, target state (WP-03)
//   worldpartition.hlod            -- inspect HLOD layer config and trigger HLOD generation (WP-04)
//
// All handlers run on the game thread via AsyncTask(ENamedThreads::GameThread).
// asset_path is validated to start with "/Game/" or "/Engine/" before any
// StaticLoadObject call to prevent path traversal (T-18-01).
// Modify() is called before all data layer write operations (T-18-02, T-18-03).
//
// Converted from Optional/MCPWorldPartitionCommands.cpp.disabled to reflection-based
// approach (Plan 33-03). DataLayerEditor module header eliminated:
//   The DataLayerEditorSubsystem is accessed via FindObject<UClass> + GEditor->GetEditorSubsystemBase()
//   + UObject::FindFunction/ProcessEvent for write operations (create, assign_actor).

#include "MCPWorldPartitionCommands.h"
#include "ReflectionHelpers.h"

// Core World Partition headers (Engine module -- always available)
#include "WorldPartition/WorldPartition.h"
#include "WorldPartition/WorldPartitionSubsystem.h"
#include "WorldPartition/WorldPartitionStreamingSource.h"
#include "WorldPartition/WorldPartitionRuntimeHash.h"
#include "Components/WorldPartitionStreamingSourceComponent.h"

// Core Data Layer headers (Engine module -- always available)
#include "WorldPartition/DataLayer/DataLayerInstance.h"
#include "WorldPartition/DataLayer/DataLayerInstanceWithAsset.h"
#include "WorldPartition/DataLayer/WorldDataLayers.h"

// Core HLOD header (Engine module -- always available)
#include "WorldPartition/HLOD/HLODLayer.h"

// Asset Registry
#include "AssetRegistry/AssetRegistryModule.h"
#include "AssetRegistry/IAssetRegistry.h"

// JSON
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"

// Editor
#include "Editor.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "GameFramework/Actor.h"
#include "Components/ActorComponent.h"
#include "Async/Async.h"

// UE reflection (for DataLayerEditorSubsystem access)
#include "UObject/UnrealType.h"
#include "UObject/PropertyPortFlags.h"
#include "Subsystems/EditorSubsystem.h"

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Returns a JSON success response string (without trailing newline). */
static FString BuildWPSuccessResponse(const FString& CorrId, TSharedPtr<FJsonObject> Data)
{
	TSharedPtr<FJsonObject> Obj = MakeShared<FJsonObject>();
	Obj->SetBoolField(TEXT("success"), true);
	Obj->SetStringField(TEXT("correlationId"), CorrId);
	if (Data.IsValid())
	{
		Obj->SetObjectField(TEXT("data"), Data);
	}

	FString Output;
	TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Output);
	FJsonSerializer::Serialize(Obj.ToSharedRef(), Writer);
	return Output;
}

/** Returns a JSON error response string (without trailing newline). */
static FString BuildWPErrorResponse(const FString& CorrId, const FString& Error)
{
	TSharedPtr<FJsonObject> Obj = MakeShared<FJsonObject>();
	Obj->SetBoolField(TEXT("success"), false);
	Obj->SetStringField(TEXT("correlationId"), CorrId);
	Obj->SetStringField(TEXT("error"), Error);

	FString Output;
	TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Output);
	FJsonSerializer::Serialize(Obj.ToSharedRef(), Writer);
	return Output;
}

/**
 * Validate that asset_path starts with "/Game/" or "/Engine/" to prevent
 * path traversal attacks (T-18-01).
 */
static bool IsValidAssetPath(const FString& AssetPath)
{
	return AssetPath.StartsWith(TEXT("/Game/")) || AssetPath.StartsWith(TEXT("/Engine/"));
}

/**
 * Get the UDataLayerEditorSubsystem instance via reflection.
 * Finds the subsystem class via FindObject<UClass> and retrieves it from GEditor.
 * Returns nullptr if the DataLayerEditor module is not loaded.
 * (T-33-08: named error codes -- callers check for nullptr and emit named errors.)
 */
static UObject* GetDataLayerEditorSubsystem()
{
	if (!GEditor)
	{
		return nullptr;
	}

	// Check module availability first.
	if (!FModuleManager::Get().IsModuleLoaded(TEXT("DataLayerEditor")))
	{
		return nullptr;
	}

	// Find UDataLayerEditorSubsystem class via reflection (no header required).
	UClass* SubsystemClass = FindObject<UClass>(nullptr, TEXT("/Script/DataLayerEditor.DataLayerEditorSubsystem"));
	if (!SubsystemClass)
	{
		return nullptr;
	}

	// Retrieve the subsystem from GEditor via the base class API.
	return GEditor->GetEditorSubsystemBase(SubsystemClass);
}

// ---------------------------------------------------------------------------
// RegisterWorldPartitionCommands
// ---------------------------------------------------------------------------

void RegisterWorldPartitionCommands(FMCPCommandRouter& Router)
{
	// -----------------------------------------------------------------------
	// worldpartition.settings (WP-01)
	// Reads World Partition settings from the currently open world.
	// No required payload -- reads from current editor world context.
	// Returns: grid_size, loading_range, enable_streaming, runtime_hash_name.
	// Uses core WorldPartition Engine APIs directly (no optional module).
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("worldpartition.settings"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

		AsyncTask(ENamedThreads::GameThread, [CorrId, SendResponse]()
		{
			if (!GEditor)
			{
				SendResponse(BuildWPErrorResponse(CorrId, TEXT("editor_not_available")) + TEXT("\n"));
				return;
			}

			UWorld* World = GEditor->GetEditorWorldContext().World();
			if (!World)
			{
				SendResponse(BuildWPErrorResponse(CorrId, TEXT("no_world_open")) + TEXT("\n"));
				return;
			}

			UWorldPartition* WorldPartition = World->GetWorldPartition();
			if (!WorldPartition)
			{
				SendResponse(BuildWPErrorResponse(CorrId, TEXT("world_does_not_use_world_partition")) + TEXT("\n"));
				return;
			}

			// Read World Partition settings.
			// Default grid size is 12800 (12800 UU = 128m, the standard UE WP cell size).
			double GridSize = 12800.0;
			double LoadingRange = 25600.0;
			bool bStreamingEnabled = WorldPartition->IsStreamingEnabled();

			// Get the runtime hash class name for diagnostics.
			FString RuntimeHashName = TEXT("none");
			if (WorldPartition->RuntimeHash)
			{
				RuntimeHashName = WorldPartition->RuntimeHash->GetClass()->GetName();

				// Try to read grid cell size from the runtime hash via reflection.
				// UWorldPartitionRuntimeSpatialHash exposes a property "CellSize" or similar.
				for (TFieldIterator<FDoubleProperty> PropIt(WorldPartition->RuntimeHash->GetClass()); PropIt; ++PropIt)
				{
					const FString PropName = PropIt->GetName();
					if (PropName.Contains(TEXT("CellSize")) || PropName.Contains(TEXT("GridSize")))
					{
						GridSize = PropIt->GetPropertyValue_InContainer(WorldPartition->RuntimeHash);
						break;
					}
				}
				for (TFieldIterator<FFloatProperty> PropIt(WorldPartition->RuntimeHash->GetClass()); PropIt; ++PropIt)
				{
					const FString PropName = PropIt->GetName();
					if (PropName.Contains(TEXT("LoadingRange")) || PropName.Contains(TEXT("StreamingRange")))
					{
						LoadingRange = static_cast<double>(PropIt->GetPropertyValue_InContainer(WorldPartition->RuntimeHash));
						break;
					}
					if (PropName.Contains(TEXT("CellSize")) || PropName.Contains(TEXT("GridSize")))
					{
						GridSize = static_cast<double>(PropIt->GetPropertyValue_InContainer(WorldPartition->RuntimeHash));
						break;
					}
				}
			}

			TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
			Data->SetNumberField(TEXT("grid_size"), GridSize);
			Data->SetNumberField(TEXT("loading_range"), LoadingRange);
			Data->SetBoolField(TEXT("enable_streaming"), bStreamingEnabled);
			Data->SetStringField(TEXT("runtime_hash_name"), RuntimeHashName);

			SendResponse(BuildWPSuccessResponse(CorrId, Data) + TEXT("\n"));
		});
	});

	// -----------------------------------------------------------------------
	// worldpartition.dataLayers (WP-02)
	// Manages data layers: list, create, toggle state, and assign actors.
	// Required payload field: action ("list" | "create" | "toggle" | "assign_actor")
	//
	// list:         Returns array of data layer objects with name, type, state.
	//               Uses core AWorldDataLayers API -- no DataLayerEditor module needed.
	// create:       Requires layer_name (string), layer_type ("Runtime"/"Editor").
	//               Uses UDataLayerEditorSubsystem via reflection (DataLayerEditor module).
	// toggle:       Requires layer_name (string), initial_state ("Unloaded"/"Loaded"/"Activated").
	//               Uses core UDataLayerInstance::SetInitialRuntimeState -- no optional module.
	// assign_actor: Requires layer_name (string), actor_label (string).
	//               Uses UDataLayerEditorSubsystem::AddActorToDataLayer via ProcessEvent reflection.
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("worldpartition.dataLayers"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

		// Extract payload.
		TSharedPtr<FJsonObject> Payload;
		const TSharedPtr<FJsonValue>* PayloadVal = Cmd->Values.Find(TEXT("payload"));
		if (PayloadVal && (*PayloadVal)->Type == EJson::Object)
		{
			Payload = (*PayloadVal)->AsObject();
		}

		FString Action;
		if (!Payload.IsValid() || !Payload->TryGetStringField(TEXT("action"), Action) || Action.IsEmpty())
		{
			SendResponse(BuildWPErrorResponse(CorrId, TEXT("missing_action")) + TEXT("\n"));
			return;
		}

		// Capture payload fields before async dispatch.
		FString LayerName;
		FString LayerType;
		FString InitialState;
		FString ActorLabel;
		if (Payload.IsValid())
		{
			Payload->TryGetStringField(TEXT("layer_name"), LayerName);
			Payload->TryGetStringField(TEXT("layer_type"), LayerType);
			Payload->TryGetStringField(TEXT("initial_state"), InitialState);
			Payload->TryGetStringField(TEXT("actor_label"), ActorLabel);
		}

		AsyncTask(ENamedThreads::GameThread, [CorrId, SendResponse, Action, LayerName, LayerType, InitialState, ActorLabel]()
		{
			if (!GEditor)
			{
				SendResponse(BuildWPErrorResponse(CorrId, TEXT("editor_not_available")) + TEXT("\n"));
				return;
			}

			UWorld* World = GEditor->GetEditorWorldContext().World();
			if (!World)
			{
				SendResponse(BuildWPErrorResponse(CorrId, TEXT("no_world_open")) + TEXT("\n"));
				return;
			}

			UWorldPartition* WorldPartition = World->GetWorldPartition();
			if (!WorldPartition)
			{
				SendResponse(BuildWPErrorResponse(CorrId, TEXT("world_does_not_use_world_partition")) + TEXT("\n"));
				return;
			}

			// ------------------------------------------------------------------
			// action: list
			// Uses core AWorldDataLayers/UDataLayerInstance APIs (no optional module).
			// ------------------------------------------------------------------
			if (Action == TEXT("list"))
			{
				TArray<TSharedPtr<FJsonValue>> LayersArray;

				// Find AWorldDataLayers actor to enumerate data layer instances.
				AWorldDataLayers* WorldDataLayers = nullptr;
				for (TActorIterator<AWorldDataLayers> It(World); It; ++It)
				{
					WorldDataLayers = *It;
					break;
				}

				if (WorldDataLayers)
				{
					WorldDataLayers->ForEachDataLayerInstance([&LayersArray](UDataLayerInstance* DataLayerInstance) -> bool
					{
						if (!DataLayerInstance)
						{
							return true; // continue
						}

						FString TypeStr = TEXT("Editor");
						const UDataLayerInstanceWithAsset* DLWithAsset = Cast<UDataLayerInstanceWithAsset>(DataLayerInstance);
						if (DLWithAsset && DLWithAsset->GetAsset())
						{
							TypeStr = (DLWithAsset->GetAsset()->IsRuntime()) ? TEXT("Runtime") : TEXT("Editor");
						}

						FString StateStr = TEXT("Unloaded");
						EDataLayerRuntimeState RuntimeState = DataLayerInstance->GetInitialRuntimeState();
						if (RuntimeState == EDataLayerRuntimeState::Loaded)
						{
							StateStr = TEXT("Loaded");
						}
						else if (RuntimeState == EDataLayerRuntimeState::Activated)
						{
							StateStr = TEXT("Activated");
						}

						TSharedPtr<FJsonObject> LayerObj = MakeShared<FJsonObject>();
						LayerObj->SetStringField(TEXT("name"), DataLayerInstance->GetDataLayerFullName());
						LayerObj->SetStringField(TEXT("type"), TypeStr);
						LayerObj->SetStringField(TEXT("initial_runtime_state"), StateStr);
						LayerObj->SetBoolField(TEXT("is_initially_visible"), DataLayerInstance->IsInitiallyVisible());
						LayersArray.Add(MakeShared<FJsonValueObject>(LayerObj));

						return true; // continue iteration
					});
				}

				TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
				Data->SetArrayField(TEXT("layers"), LayersArray);
				Data->SetNumberField(TEXT("count"), static_cast<double>(LayersArray.Num()));

				SendResponse(BuildWPSuccessResponse(CorrId, Data) + TEXT("\n"));
				return;
			}

			// ------------------------------------------------------------------
			// action: create
			// Uses UDataLayerEditorSubsystem via reflection (DataLayerEditor module).
			// Calls CreateDataLayerInstance via UObject::FindFunction + ProcessEvent.
			// ------------------------------------------------------------------
			if (Action == TEXT("create"))
			{
				// Validate inputs (T-18-02).
				if (LayerName.IsEmpty())
				{
					SendResponse(BuildWPErrorResponse(CorrId, TEXT("missing_layer_name")) + TEXT("\n"));
					return;
				}

				// Find AWorldDataLayers actor and call Modify() before mutation.
				AWorldDataLayers* WorldDataLayers = nullptr;
				for (TActorIterator<AWorldDataLayers> It(World); It; ++It)
				{
					WorldDataLayers = *It;
					break;
				}

				if (!WorldDataLayers)
				{
					SendResponse(BuildWPErrorResponse(CorrId, TEXT("no_world_data_layers_actor")) + TEXT("\n"));
					return;
				}

				WorldDataLayers->Modify();

				// Get UDataLayerEditorSubsystem via reflection (no DataLayerEditor header).
				UObject* DataLayerSubsystem = GetDataLayerEditorSubsystem();
				if (!DataLayerSubsystem)
				{
					// DataLayerEditor module not available (T-33-08: named error code).
					MCPReflect::SendModuleNotAvailable(SendResponse, CorrId, TEXT("DataLayerEditor"));
					return;
				}

				// Call CreateDataLayerInstance via UFunction reflection.
				// FDataLayerCreationParameters is a struct -- we need to pass it via ProcessEvent.
				// Since the struct layout may vary, we use an alternative API if available:
				// Try calling a simpler function or use FindFunction to discover what's exposed.
				UFunction* CreateFunc = DataLayerSubsystem->FindFunction(TEXT("CreateDataLayerInstance"));
				if (!CreateFunc)
				{
					SendResponse(BuildWPErrorResponse(CorrId, TEXT("create_data_layer_function_not_found")) + TEXT("\n"));
					return;
				}

				// Allocate parameter struct on stack using the function's params size.
				// We need to find the WorldDataLayers and bIsPrivate parameters by name.
				// Default to private data layer instance (no asset required).
				TArray<uint8> ParamsBuffer;
				ParamsBuffer.SetNumZeroed(CreateFunc->ParmsSize);

				// Set the WorldDataLayers parameter via reflection.
				for (TFieldIterator<FObjectProperty> PropIt(CreateFunc); PropIt && (PropIt->PropertyFlags & CPF_Parm); ++PropIt)
				{
					if (PropIt->GetName().Contains(TEXT("WorldDataLayers")))
					{
						PropIt->SetObjectPropertyValue(PropIt->ContainerPtrToValuePtr<void>(ParamsBuffer.GetData()), WorldDataLayers);
					}
				}
				for (TFieldIterator<FBoolProperty> PropIt(CreateFunc); PropIt && (PropIt->PropertyFlags & CPF_Parm); ++PropIt)
				{
					if (PropIt->GetName().Contains(TEXT("Private")))
					{
						PropIt->SetPropertyValue(PropIt->ContainerPtrToValuePtr<void>(ParamsBuffer.GetData()), true);
					}
				}

				DataLayerSubsystem->ProcessEvent(CreateFunc, ParamsBuffer.GetData());

				// Read the return value (UDataLayerInstance*) via the ReturnValue property.
				UDataLayerInstance* NewDataLayerInstance = nullptr;
				for (TFieldIterator<FObjectProperty> PropIt(CreateFunc); PropIt && (PropIt->PropertyFlags & CPF_Parm); ++PropIt)
				{
					if (PropIt->PropertyFlags & CPF_ReturnParm)
					{
						UObject* RetVal = PropIt->GetObjectPropertyValue(PropIt->ContainerPtrToValuePtr<void>(ParamsBuffer.GetData()));
						NewDataLayerInstance = Cast<UDataLayerInstance>(RetVal);
						break;
					}
				}

				if (!NewDataLayerInstance)
				{
					SendResponse(BuildWPErrorResponse(CorrId, TEXT("failed_to_create_data_layer")) + TEXT("\n"));
					return;
				}

				TSharedPtr<FJsonObject> LayerObj = MakeShared<FJsonObject>();
				LayerObj->SetStringField(TEXT("name"), NewDataLayerInstance->GetDataLayerFullName());
				LayerObj->SetStringField(TEXT("type"), LayerType.IsEmpty() ? TEXT("Editor") : LayerType);
				LayerObj->SetStringField(TEXT("instance_name"), NewDataLayerInstance->GetDataLayerFullName());

				TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
				Data->SetObjectField(TEXT("created_layer"), LayerObj);

				SendResponse(BuildWPSuccessResponse(CorrId, Data) + TEXT("\n"));
				return;
			}

			// ------------------------------------------------------------------
			// action: toggle
			// Uses core UDataLayerInstance::SetInitialRuntimeState (no optional module).
			// ------------------------------------------------------------------
			if (Action == TEXT("toggle"))
			{
				// Validate inputs (T-18-02).
				if (LayerName.IsEmpty())
				{
					SendResponse(BuildWPErrorResponse(CorrId, TEXT("missing_layer_name")) + TEXT("\n"));
					return;
				}
				if (InitialState.IsEmpty())
				{
					SendResponse(BuildWPErrorResponse(CorrId, TEXT("missing_initial_state")) + TEXT("\n"));
					return;
				}

				// Find the data layer instance by name.
				AWorldDataLayers* WorldDataLayers = nullptr;
				for (TActorIterator<AWorldDataLayers> It(World); It; ++It)
				{
					WorldDataLayers = *It;
					break;
				}

				if (!WorldDataLayers)
				{
					SendResponse(BuildWPErrorResponse(CorrId, TEXT("no_world_data_layers_actor")) + TEXT("\n"));
					return;
				}

				UDataLayerInstance* FoundLayer = nullptr;
				WorldDataLayers->ForEachDataLayerInstance([&FoundLayer, &LayerName](UDataLayerInstance* DataLayerInstance) -> bool
				{
					if (DataLayerInstance && DataLayerInstance->GetDataLayerFullName() == LayerName)
					{
						FoundLayer = DataLayerInstance;
						return false; // stop iteration
					}
					return true;
				});

				if (!FoundLayer)
				{
					SendResponse(BuildWPErrorResponse(CorrId, TEXT("data_layer_not_found")) + TEXT("\n"));
					return;
				}

				// Modify() before mutation (T-18-02).
				FoundLayer->Modify();

				// Parse the initial state string.
				EDataLayerRuntimeState NewState = EDataLayerRuntimeState::Unloaded;
				if (InitialState == TEXT("Loaded"))
				{
					NewState = EDataLayerRuntimeState::Loaded;
				}
				else if (InitialState == TEXT("Activated"))
				{
					NewState = EDataLayerRuntimeState::Activated;
				}

				FoundLayer->SetInitialRuntimeState(NewState);

				TSharedPtr<FJsonObject> LayerObj = MakeShared<FJsonObject>();
				LayerObj->SetStringField(TEXT("name"), LayerName);
				LayerObj->SetStringField(TEXT("initial_runtime_state"), InitialState);

				TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
				Data->SetObjectField(TEXT("updated_layer"), LayerObj);

				SendResponse(BuildWPSuccessResponse(CorrId, Data) + TEXT("\n"));
				return;
			}

			// ------------------------------------------------------------------
			// action: assign_actor
			// Uses UDataLayerEditorSubsystem::AddActorToDataLayer via ProcessEvent.
			// ------------------------------------------------------------------
			if (Action == TEXT("assign_actor"))
			{
				// Validate inputs (T-18-03).
				if (LayerName.IsEmpty())
				{
					SendResponse(BuildWPErrorResponse(CorrId, TEXT("missing_layer_name")) + TEXT("\n"));
					return;
				}
				if (ActorLabel.IsEmpty())
				{
					SendResponse(BuildWPErrorResponse(CorrId, TEXT("missing_actor_label")) + TEXT("\n"));
					return;
				}

				// Find actor by label.
				AActor* FoundActor = nullptr;
				for (TActorIterator<AActor> It(World); It; ++It)
				{
					if ((*It)->GetActorLabel() == ActorLabel)
					{
						FoundActor = *It;
						break;
					}
				}

				if (!FoundActor)
				{
					SendResponse(BuildWPErrorResponse(CorrId, TEXT("actor_not_found")) + TEXT("\n"));
					return;
				}

				// Find the data layer instance.
				AWorldDataLayers* WorldDataLayers = nullptr;
				for (TActorIterator<AWorldDataLayers> It(World); It; ++It)
				{
					WorldDataLayers = *It;
					break;
				}

				if (!WorldDataLayers)
				{
					SendResponse(BuildWPErrorResponse(CorrId, TEXT("no_world_data_layers_actor")) + TEXT("\n"));
					return;
				}

				UDataLayerInstance* FoundLayer = nullptr;
				WorldDataLayers->ForEachDataLayerInstance([&FoundLayer, &LayerName](UDataLayerInstance* DataLayerInstance) -> bool
				{
					if (DataLayerInstance && DataLayerInstance->GetDataLayerFullName() == LayerName)
					{
						FoundLayer = DataLayerInstance;
						return false;
					}
					return true;
				});

				if (!FoundLayer)
				{
					SendResponse(BuildWPErrorResponse(CorrId, TEXT("data_layer_not_found")) + TEXT("\n"));
					return;
				}

				// Get UDataLayerEditorSubsystem via reflection (no DataLayerEditor header).
				UObject* DataLayerSubsystem = GetDataLayerEditorSubsystem();
				if (!DataLayerSubsystem)
				{
					// DataLayerEditor module not available (T-33-08: named error code).
					MCPReflect::SendModuleNotAvailable(SendResponse, CorrId, TEXT("DataLayerEditor"));
					return;
				}

				// Modify() before mutation (T-18-03).
				FoundActor->Modify();

				// Call AddActorToDataLayer via UFunction reflection.
				UFunction* AddActorFunc = DataLayerSubsystem->FindFunction(TEXT("AddActorToDataLayer"));
				if (!AddActorFunc)
				{
					SendResponse(BuildWPErrorResponse(CorrId, TEXT("add_actor_to_data_layer_function_not_found")) + TEXT("\n"));
					return;
				}

				// Allocate parameter struct on stack.
				TArray<uint8> ParamsBuffer;
				ParamsBuffer.SetNumZeroed(AddActorFunc->ParmsSize);

				// Set Actor and DataLayerInstance parameters via property reflection.
				for (TFieldIterator<FObjectProperty> PropIt(AddActorFunc); PropIt && (PropIt->PropertyFlags & CPF_Parm); ++PropIt)
				{
					if (!(PropIt->PropertyFlags & CPF_ReturnParm))
					{
						const FString ParamName = PropIt->GetName();
						if (ParamName.Contains(TEXT("Actor")))
						{
							PropIt->SetObjectPropertyValue(PropIt->ContainerPtrToValuePtr<void>(ParamsBuffer.GetData()), FoundActor);
						}
						else if (ParamName.Contains(TEXT("DataLayer")) || ParamName.Contains(TEXT("Layer")))
						{
							PropIt->SetObjectPropertyValue(PropIt->ContainerPtrToValuePtr<void>(ParamsBuffer.GetData()), FoundLayer);
						}
					}
				}

				DataLayerSubsystem->ProcessEvent(AddActorFunc, ParamsBuffer.GetData());

				// Read bool return value.
				bool bSuccess = false;
				for (TFieldIterator<FBoolProperty> PropIt(AddActorFunc); PropIt && (PropIt->PropertyFlags & CPF_Parm); ++PropIt)
				{
					if (PropIt->PropertyFlags & CPF_ReturnParm)
					{
						bSuccess = PropIt->GetPropertyValue(PropIt->ContainerPtrToValuePtr<void>(ParamsBuffer.GetData()));
						break;
					}
				}

				if (!bSuccess)
				{
					SendResponse(BuildWPErrorResponse(CorrId, TEXT("failed_to_assign_actor_to_layer")) + TEXT("\n"));
					return;
				}

				TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
				Data->SetStringField(TEXT("actor_label"), ActorLabel);
				Data->SetStringField(TEXT("layer_name"), LayerName);
				Data->SetBoolField(TEXT("success"), true);

				SendResponse(BuildWPSuccessResponse(CorrId, Data) + TEXT("\n"));
				return;
			}

			// Unknown action.
			SendResponse(BuildWPErrorResponse(CorrId, TEXT("unknown_action")) + TEXT("\n"));
		});
	});

	// -----------------------------------------------------------------------
	// worldpartition.streamingSources (WP-03)
	// Inspects World Partition streaming source components on all actors.
	// Optional payload field: actor_label (string) -- filter to a specific actor.
	// Returns: streaming_sources array with actor_label, component_name,
	//   target_state, shapes, priority.
	// Uses core WorldPartition Engine APIs directly (no optional module).
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("worldpartition.streamingSources"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

		// Extract optional actor_label filter.
		FString ActorLabelFilter;
		const TSharedPtr<FJsonValue>* PayloadVal = Cmd->Values.Find(TEXT("payload"));
		if (PayloadVal && (*PayloadVal)->Type == EJson::Object)
		{
			TSharedPtr<FJsonObject> Payload = (*PayloadVal)->AsObject();
			Payload->TryGetStringField(TEXT("actor_label"), ActorLabelFilter);
		}

		AsyncTask(ENamedThreads::GameThread, [CorrId, SendResponse, ActorLabelFilter]()
		{
			if (!GEditor)
			{
				SendResponse(BuildWPErrorResponse(CorrId, TEXT("editor_not_available")) + TEXT("\n"));
				return;
			}

			UWorld* World = GEditor->GetEditorWorldContext().World();
			if (!World)
			{
				SendResponse(BuildWPErrorResponse(CorrId, TEXT("no_world_open")) + TEXT("\n"));
				return;
			}

			TArray<TSharedPtr<FJsonValue>> SourcesArray;

			// Iterate all actors and look for streaming source components.
			for (TActorIterator<AActor> It(World); It; ++It)
			{
				AActor* Actor = *It;
				if (!Actor)
				{
					continue;
				}

				// Apply actor_label filter if provided.
				if (!ActorLabelFilter.IsEmpty() && Actor->GetActorLabel() != ActorLabelFilter)
				{
					continue;
				}

				// Find all UWorldPartitionStreamingSourceComponent on this actor.
				TArray<UWorldPartitionStreamingSourceComponent*> StreamingComponents;
				Actor->GetComponents<UWorldPartitionStreamingSourceComponent>(StreamingComponents);

				for (UWorldPartitionStreamingSourceComponent* SourceComp : StreamingComponents)
				{
					if (!SourceComp)
					{
						continue;
					}

					// Use GetStreamingSource() to access TargetState (which is private on the component).
					FWorldPartitionStreamingSource StreamingSource;
					FString TargetStateStr = TEXT("Loaded");
					if (SourceComp->GetStreamingSource(StreamingSource))
					{
						if (StreamingSource.TargetState == EStreamingSourceTargetState::Activated)
						{
							TargetStateStr = TEXT("Activated");
						}
						else if (StreamingSource.TargetState == EStreamingSourceTargetState::Loaded)
						{
							TargetStateStr = TEXT("Loaded");
						}
					}

					// Build shapes array from the component's public Shapes property.
					TArray<TSharedPtr<FJsonValue>> ShapesArray;
					for (const FStreamingSourceShape& Shape : SourceComp->Shapes)
					{
						TSharedPtr<FJsonObject> ShapeObj = MakeShared<FJsonObject>();
						ShapeObj->SetNumberField(TEXT("radius"), static_cast<double>(Shape.Radius));
						ShapeObj->SetBoolField(TEXT("use_grid_loading_range"), Shape.bUseGridLoadingRange);
						ShapeObj->SetNumberField(TEXT("pos_x"), static_cast<double>(Shape.Location.X));
						ShapeObj->SetNumberField(TEXT("pos_y"), static_cast<double>(Shape.Location.Y));
						ShapeObj->SetNumberField(TEXT("pos_z"), static_cast<double>(Shape.Location.Z));
						ShapesArray.Add(MakeShared<FJsonValueObject>(ShapeObj));
					}

					TSharedPtr<FJsonObject> SourceObj = MakeShared<FJsonObject>();
					SourceObj->SetStringField(TEXT("actor_label"), Actor->GetActorLabel());
					SourceObj->SetStringField(TEXT("component_name"), SourceComp->GetName());
					SourceObj->SetStringField(TEXT("target_state"), TargetStateStr);
					SourceObj->SetNumberField(TEXT("priority"), static_cast<double>(static_cast<int32>(SourceComp->Priority)));
					SourceObj->SetArrayField(TEXT("shapes"), ShapesArray);
					SourcesArray.Add(MakeShared<FJsonValueObject>(SourceObj));
				}
			}

			TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
			Data->SetArrayField(TEXT("streaming_sources"), SourcesArray);
			Data->SetNumberField(TEXT("count"), static_cast<double>(SourcesArray.Num()));
			if (!ActorLabelFilter.IsEmpty())
			{
				Data->SetStringField(TEXT("actor_label_filter"), ActorLabelFilter);
			}

			SendResponse(BuildWPSuccessResponse(CorrId, Data) + TEXT("\n"));
		});
	});

	// -----------------------------------------------------------------------
	// worldpartition.hlod (WP-04)
	// Inspects HLOD layer configuration and triggers HLOD generation.
	// Required payload field: action ("inspect" | "generate")
	//
	// inspect:  Returns array of HLOD layers with name, cell_size, hlod_level, etc.
	// generate: Fire-and-forget HLOD build trigger -- returns status "triggered".
	// Uses core HLODLayer Engine APIs directly (no optional module).
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("worldpartition.hlod"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

		// Extract payload.
		TSharedPtr<FJsonObject> Payload;
		const TSharedPtr<FJsonValue>* PayloadVal = Cmd->Values.Find(TEXT("payload"));
		if (PayloadVal && (*PayloadVal)->Type == EJson::Object)
		{
			Payload = (*PayloadVal)->AsObject();
		}

		FString Action;
		if (!Payload.IsValid() || !Payload->TryGetStringField(TEXT("action"), Action) || Action.IsEmpty())
		{
			SendResponse(BuildWPErrorResponse(CorrId, TEXT("missing_action")) + TEXT("\n"));
			return;
		}

		// Capture optional asset_path for HLOD inspect filtering (validated below T-18-01).
		FString AssetPath;
		if (Payload.IsValid())
		{
			Payload->TryGetStringField(TEXT("asset_path"), AssetPath);
		}

		// Validate asset_path if provided (T-18-01, T-33-07).
		if (!AssetPath.IsEmpty() && !IsValidAssetPath(AssetPath))
		{
			SendResponse(BuildWPErrorResponse(CorrId, TEXT("invalid_asset_path")) + TEXT("\n"));
			return;
		}

		AsyncTask(ENamedThreads::GameThread, [CorrId, SendResponse, Action, AssetPath]()
		{
			if (!GEditor)
			{
				SendResponse(BuildWPErrorResponse(CorrId, TEXT("editor_not_available")) + TEXT("\n"));
				return;
			}

			// ------------------------------------------------------------------
			// action: inspect
			// ------------------------------------------------------------------
			if (Action == TEXT("inspect"))
			{
				// Get all UHLODLayer assets from the asset registry.
				FAssetRegistryModule& RegistryModule = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry"));
				IAssetRegistry& Registry = RegistryModule.Get();

				TArray<FAssetData> HLODAssets;
				FTopLevelAssetPath HLODLayerClass(TEXT("/Script/Engine"), TEXT("HLODLayer"));
				Registry.GetAssetsByClass(HLODLayerClass, HLODAssets, /*bSearchSubClasses=*/true);

				TArray<TSharedPtr<FJsonValue>> HLODLayersArray;

				for (const FAssetData& AssetData : HLODAssets)
				{
					FString LayerAssetPath = AssetData.GetObjectPathString();

					// Apply asset_path filter if provided.
					if (!AssetPath.IsEmpty() && LayerAssetPath != AssetPath)
					{
						continue;
					}

					// Load the HLOD layer asset.
					UHLODLayer* HLODLayer = Cast<UHLODLayer>(StaticLoadObject(UHLODLayer::StaticClass(), nullptr, *LayerAssetPath));
					if (!HLODLayer)
					{
						continue;
					}

					TSharedPtr<FJsonObject> LayerObj = MakeShared<FJsonObject>();
					LayerObj->SetStringField(TEXT("layer_name"), HLODLayer->GetName());
					LayerObj->SetStringField(TEXT("asset_path"), LayerAssetPath);

					// IsSpatiallyLoaded() is deprecated in UE 5.7 (properties moved to partition settings).
					// Suppress warning since we still want to report the legacy value for informational purposes.
					PRAGMA_DISABLE_DEPRECATION_WARNINGS
					LayerObj->SetBoolField(TEXT("is_spatially_loaded"), HLODLayer->IsSpatiallyLoaded());
					PRAGMA_ENABLE_DEPRECATION_WARNINGS

					// Read cell size via reflection -- UHLODLayer::CellSize or similar property.
					double CellSize = 0.0;
					int32 HLODLevel = 0;
					double LoadingRange = 0.0;

					for (TFieldIterator<FDoubleProperty> PropIt(HLODLayer->GetClass()); PropIt; ++PropIt)
					{
						const FString PropName = PropIt->GetName();
						if (PropName.Contains(TEXT("CellSize")))
						{
							CellSize = PropIt->GetPropertyValue_InContainer(HLODLayer);
						}
					}
					for (TFieldIterator<FFloatProperty> PropIt(HLODLayer->GetClass()); PropIt; ++PropIt)
					{
						const FString PropName = PropIt->GetName();
						if (PropName.Contains(TEXT("CellSize")))
						{
							CellSize = static_cast<double>(PropIt->GetPropertyValue_InContainer(HLODLayer));
						}
						else if (PropName.Contains(TEXT("LoadingRange")))
						{
							LoadingRange = static_cast<double>(PropIt->GetPropertyValue_InContainer(HLODLayer));
						}
					}
					for (TFieldIterator<FIntProperty> PropIt(HLODLayer->GetClass()); PropIt; ++PropIt)
					{
						const FString PropName = PropIt->GetName();
						if (PropName.Contains(TEXT("HLODLevel")) || PropName.Contains(TEXT("Level")))
						{
							HLODLevel = PropIt->GetPropertyValue_InContainer(HLODLayer);
						}
					}

					LayerObj->SetNumberField(TEXT("cell_size"), CellSize);
					LayerObj->SetNumberField(TEXT("loading_range"), LoadingRange);
					LayerObj->SetNumberField(TEXT("hlod_level"), static_cast<double>(HLODLevel));

					HLODLayersArray.Add(MakeShared<FJsonValueObject>(LayerObj));
				}

				TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
				Data->SetArrayField(TEXT("hlod_layers"), HLODLayersArray);
				Data->SetNumberField(TEXT("count"), static_cast<double>(HLODLayersArray.Num()));

				SendResponse(BuildWPSuccessResponse(CorrId, Data) + TEXT("\n"));
				return;
			}

			// ------------------------------------------------------------------
			// action: generate
			// ------------------------------------------------------------------
			if (Action == TEXT("generate"))
			{
				UWorld* World = GEditor->GetEditorWorldContext().World();
				if (!World)
				{
					SendResponse(BuildWPErrorResponse(CorrId, TEXT("no_world_open")) + TEXT("\n"));
					return;
				}

				UWorldPartition* WorldPartition = World->GetWorldPartition();
				if (!WorldPartition)
				{
					SendResponse(BuildWPErrorResponse(CorrId, TEXT("world_does_not_use_world_partition")) + TEXT("\n"));
					return;
				}

				// Fire-and-forget HLOD generation trigger (T-18-04: accepted DoS risk).
				// Use GEditor->Exec with the HLODBuilder commandlet to trigger generation.
				// This is async -- the editor will show progress. We return "triggered" immediately.
				if (GEditor)
				{
					GEditor->Exec(World, TEXT("wp.Runtime.BuildHLODs"), *GLog);
				}

				TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
				Data->SetStringField(TEXT("status"), TEXT("triggered"));
				Data->SetStringField(TEXT("message"), TEXT("HLOD generation has been triggered. Check the editor Output Log for progress and completion status."));

				SendResponse(BuildWPSuccessResponse(CorrId, Data) + TEXT("\n"));
				return;
			}

			// Unknown action.
			SendResponse(BuildWPErrorResponse(CorrId, TEXT("unknown_action")) + TEXT("\n"));
		});
	});
}
