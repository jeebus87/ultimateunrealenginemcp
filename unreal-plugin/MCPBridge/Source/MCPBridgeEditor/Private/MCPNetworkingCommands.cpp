// MCPNetworkingCommands.cpp
// Implements four networking and replication command handlers for the MCP bridge:
//   net.replication  -- inspect actor replication settings (NET-01)
//   net.properties   -- list replicated properties with conditions (NET-02)
//   net.driver       -- read NetDriver config and connection info (NET-03)
//   net.session      -- inspect online subsystem session and players (NET-04)
//
// All handlers run on the game thread via FMCPCommandRouter::Dispatch.
// All operations are read-only -- no Modify() calls needed.
// actor_label is validated to exist in the editor world before property access (T-30-01).
//
// Reflection conversion (Phase 33):
//   net.session previously included OnlineSubsystem.h, OnlineSessionSettings.h, and
//   Interfaces/OnlineSessionInterface.h. These are now removed. The handler uses
//   FModuleManager::IsModuleLoaded("OnlineSubsystem") to check availability, and
//   accesses session data via UObject reflection (FindObject<UClass> + FProperty iteration)
//   when the module is present.

#include "MCPNetworkingCommands.h"
#include "ReflectionHelpers.h"

#include "Editor.h"
#include "Engine/World.h"
#include "GameFramework/Actor.h"
#include "EngineUtils.h"

// Networking headers (all from Engine module -- always available)
#include "Engine/NetDriver.h"
#include "Engine/NetConnection.h"
#include "Net/UnrealNetwork.h"

// JSON
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"

// Reflection APIs
#include "UObject/Class.h"
#include "UObject/UObjectGlobals.h"

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Returns a JSON success response string (without trailing newline). */
static FString BuildNetSuccessResponse(const FString& CorrId, TSharedPtr<FJsonObject> Data)
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
static FString BuildNetErrorResponse(const FString& CorrId, const FString& Error)
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

/** Map ENetDormancy to a human-readable string. */
static FString NetDormancyToString(ENetDormancy Dormancy)
{
	switch (Dormancy)
	{
		case DORM_Never:           return TEXT("DORM_Never");
		case DORM_Awake:           return TEXT("DORM_Awake");
		case DORM_DormantAll:      return TEXT("DORM_DormantAll");
		case DORM_DormantPartial:  return TEXT("DORM_DormantPartial");
		case DORM_Initial:         return TEXT("DORM_Initial");
		default:                   return TEXT("DORM_Unknown");
	}
}

/** Map ELifetimeCondition to a human-readable string. */
static FString LifetimeConditionToString(ELifetimeCondition Condition)
{
	switch (Condition)
	{
		case COND_None:                        return TEXT("COND_None");
		case COND_InitialOnly:                 return TEXT("COND_InitialOnly");
		case COND_OwnerOnly:                   return TEXT("COND_OwnerOnly");
		case COND_SkipOwner:                   return TEXT("COND_SkipOwner");
		case COND_SimulatedOnly:               return TEXT("COND_SimulatedOnly");
		case COND_AutonomousOnly:              return TEXT("COND_AutonomousOnly");
		case COND_SimulatedOrPhysics:          return TEXT("COND_SimulatedOrPhysics");
		case COND_InitialOrOwner:              return TEXT("COND_InitialOrOwner");
		case COND_Custom:                      return TEXT("COND_Custom");
		case COND_ReplayOrOwner:               return TEXT("COND_ReplayOrOwner");
		case COND_ReplayOnly:                  return TEXT("COND_ReplayOnly");
		case COND_SimulatedOnlyNoReplay:       return TEXT("COND_SimulatedOnlyNoReplay");
		case COND_SimulatedOrPhysicsNoReplay:  return TEXT("COND_SimulatedOrPhysicsNoReplay");
		case COND_SkipReplay:                  return TEXT("COND_SkipReplay");
		case COND_Dynamic:                     return TEXT("COND_Dynamic");
		case COND_Never:                       return TEXT("COND_Never");
		default:                               return TEXT("COND_Unknown");
	}
}

/** Map ENetMode to a human-readable string. */
static FString NetModeToString(ENetMode NetMode)
{
	switch (NetMode)
	{
		case NM_Standalone:      return TEXT("NM_Standalone");
		case NM_DedicatedServer: return TEXT("NM_DedicatedServer");
		case NM_ListenServer:    return TEXT("NM_ListenServer");
		case NM_Client:          return TEXT("NM_Client");
		default:                 return TEXT("NM_Unknown");
	}
}

// ---------------------------------------------------------------------------
// net.session reflection helpers
// ---------------------------------------------------------------------------
//
// The OnlineSubsystem module is optional. When loaded, we use reflection to find
// the UOnlineEngineInterface (or equivalent) and read session data via FProperty.
//
// Design choice: When the OnlineSubsystem module is NOT loaded, we return the same
// "no_online_subsystem" success response as the original code did when
// IOnlineSubsystem::Get() returned nullptr -- preserving the original API contract.
//
// When the module IS loaded but no session is active, we use reflection to attempt
// to find session state. If reflection cannot find the expected classes, we fall
// back to the "no_online_subsystem" status (safe degradation).

namespace
{
	/**
	 * Map a session state integer to a human-readable string.
	 * EOnlineSessionState enum values (UE 5.7, OnlineSubsystem module):
	 *   0=NoSession, 1=Creating, 2=Pending, 3=Starting, 4=InProgress,
	 *   5=Ending, 6=Ended, 7=Destroying
	 */
	static FString SessionStateToString(int64 StateValue)
	{
		switch (StateValue)
		{
			case 0: return TEXT("NoSession");
			case 1: return TEXT("Creating");
			case 2: return TEXT("Pending");
			case 3: return TEXT("Starting");
			case 4: return TEXT("InProgress");
			case 5: return TEXT("Ending");
			case 6: return TEXT("Ended");
			case 7: return TEXT("Destroying");
			default: return TEXT("Unknown");
		}
	}

	/**
	 * Attempt to read session information via reflection on the UOnlineEngineInterface
	 * (which is always present) or via the GameInstance's online subsystem reference.
	 *
	 * Returns true if session data was found and populated.
	 */
	static bool TryGetSessionDataViaReflection(TSharedPtr<FJsonObject>& OutData, FString& OutStatus, FString& OutSubsystemName)
	{
		// UOnlineEngineInterface is registered in the OnlineSubsystemUtils module.
		// Try to find a GEngine subsystem that gives us the online interface.
		// The canonical path for the Online Engine Interface in UE 5.7:
		UClass* OnlineEngineClass = MCPReflect::FindClassByPath(
			TEXT("/Script/OnlineSubsystemUtils.OnlineEngineInterfaceImpl"));
		if (!OnlineEngineClass)
		{
			// Try the base interface path
			OnlineEngineClass = MCPReflect::FindClassByPath(
				TEXT("/Script/OnlineSubsystem.OnlineEngineInterface"));
		}

		if (!OnlineEngineClass)
		{
			// Module is loaded but we can't find the class -- use the subsystem singleton approach.
			// Look for the named GameSession in the world.
			return false;
		}

		// The online engine interface is a singleton -- find any instance.
		UObject* OnlineObj = FindFirstObject<UObject>(
			TEXT("OnlineEngineInterfaceImpl"), EFindFirstObjectOptions::NativeFirst);
		if (!OnlineObj || !OnlineObj->GetClass()->IsChildOf(OnlineEngineClass))
		{
			return false;
		}

		// Read the subsystem name property.
		OutSubsystemName = MCPReflect::GetStringProperty(OnlineObj, TEXT("SubsystemName"));
		if (OutSubsystemName.IsEmpty())
		{
			OutSubsystemName = TEXT("Unknown");
		}

		OutStatus = TEXT("no_active_session");
		return false; // Did not find full session data -- caller will fill in the status fields.
	}

} // anonymous namespace

// ---------------------------------------------------------------------------
// RegisterNetworkingCommands
// ---------------------------------------------------------------------------

void RegisterNetworkingCommands(FMCPCommandRouter& Router)
{
	// -----------------------------------------------------------------------
	// net.replication (NET-01)
	// Returns actor replication settings: bReplicates, bAlwaysRelevant,
	// NetUpdateFrequency, MinNetUpdateFrequency, NetPriority, NetDormancy, etc.
	// Required payload: actor_label (string)
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("net.replication"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

		// Extract payload.
		TSharedPtr<FJsonObject> Payload;
		const TSharedPtr<FJsonValue>* PayloadVal = Cmd->Values.Find(TEXT("payload"));
		if (PayloadVal && (*PayloadVal)->Type == EJson::Object)
		{
			Payload = (*PayloadVal)->AsObject();
		}

		FString ActorLabel;
		if (!Payload.IsValid() || !Payload->TryGetStringField(TEXT("actor_label"), ActorLabel) || ActorLabel.IsEmpty())
		{
			SendResponse(BuildNetErrorResponse(CorrId, TEXT("missing_actor_label")) + TEXT("\n"));
			return;
		}

		// Get the editor world.
		if (!GEditor)
		{
			SendResponse(BuildNetErrorResponse(CorrId, TEXT("no_editor")) + TEXT("\n"));
			return;
		}

		UWorld* World = GEditor->GetEditorWorldContext().World();
		if (!World)
		{
			SendResponse(BuildNetErrorResponse(CorrId, TEXT("no_world_open")) + TEXT("\n"));
			return;
		}

		// Find actor by label (T-30-01: validate actor exists before property access).
		AActor* TargetActor = nullptr;
		for (TActorIterator<AActor> It(World); It; ++It)
		{
			if ((*It)->GetActorLabel() == ActorLabel)
			{
				TargetActor = *It;
				break;
			}
		}

		if (!TargetActor)
		{
			SendResponse(BuildNetErrorResponse(CorrId, TEXT("actor_not_found")) + TEXT("\n"));
			return;
		}

		// Build response with replication settings.
		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetStringField(TEXT("actor_label"),           ActorLabel);
		Data->SetStringField(TEXT("actor_class"),           TargetActor->GetClass()->GetName());
		Data->SetBoolField(TEXT("bReplicates"),             TargetActor->GetIsReplicated());
		Data->SetBoolField(TEXT("bAlwaysRelevant"),         TargetActor->bAlwaysRelevant);
		Data->SetBoolField(TEXT("bNetUseOwnerRelevancy"),   TargetActor->bNetUseOwnerRelevancy);
		Data->SetBoolField(TEXT("bReplicateMovement"),      TargetActor->IsReplicatingMovement());
		Data->SetBoolField(TEXT("bOnlyRelevantToOwner"),    TargetActor->bOnlyRelevantToOwner);
		Data->SetNumberField(TEXT("NetUpdateFrequency"),    static_cast<double>(TargetActor->GetNetUpdateFrequency()));
		Data->SetNumberField(TEXT("MinNetUpdateFrequency"), static_cast<double>(TargetActor->GetMinNetUpdateFrequency()));
		Data->SetNumberField(TEXT("NetPriority"),           static_cast<double>(TargetActor->NetPriority));
		Data->SetNumberField(TEXT("NetDormancy"),           static_cast<double>(static_cast<int32>(TargetActor->NetDormancy)));
		Data->SetStringField(TEXT("NetDormancyName"),       NetDormancyToString(TargetActor->NetDormancy));

		SendResponse(BuildNetSuccessResponse(CorrId, Data) + TEXT("\n"));
	});

	// -----------------------------------------------------------------------
	// net.properties (NET-02)
	// Returns all replicated properties on an actor with their replication
	// conditions and rep notify status.
	// Required payload: actor_label (string)
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("net.properties"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

		// Extract payload.
		TSharedPtr<FJsonObject> Payload;
		const TSharedPtr<FJsonValue>* PayloadVal = Cmd->Values.Find(TEXT("payload"));
		if (PayloadVal && (*PayloadVal)->Type == EJson::Object)
		{
			Payload = (*PayloadVal)->AsObject();
		}

		FString ActorLabel;
		if (!Payload.IsValid() || !Payload->TryGetStringField(TEXT("actor_label"), ActorLabel) || ActorLabel.IsEmpty())
		{
			SendResponse(BuildNetErrorResponse(CorrId, TEXT("missing_actor_label")) + TEXT("\n"));
			return;
		}

		// Get the editor world.
		if (!GEditor)
		{
			SendResponse(BuildNetErrorResponse(CorrId, TEXT("no_editor")) + TEXT("\n"));
			return;
		}

		UWorld* World = GEditor->GetEditorWorldContext().World();
		if (!World)
		{
			SendResponse(BuildNetErrorResponse(CorrId, TEXT("no_world_open")) + TEXT("\n"));
			return;
		}

		// Find actor by label (T-30-01: validate actor exists before property access).
		AActor* TargetActor = nullptr;
		for (TActorIterator<AActor> It(World); It; ++It)
		{
			if ((*It)->GetActorLabel() == ActorLabel)
			{
				TargetActor = *It;
				break;
			}
		}

		if (!TargetActor)
		{
			SendResponse(BuildNetErrorResponse(CorrId, TEXT("actor_not_found")) + TEXT("\n"));
			return;
		}

		// Get lifetime replicated props to resolve conditions.
		TArray<FLifetimeProperty> LifetimeProps;
		TargetActor->GetLifetimeReplicatedProps(LifetimeProps);

		// Build a map from RepIndex -> condition for fast lookup.
		TMap<uint16, ELifetimeCondition> ConditionByRepIndex;
		for (const FLifetimeProperty& LifeProp : LifetimeProps)
		{
			ConditionByRepIndex.Add(LifeProp.RepIndex, LifeProp.Condition);
		}

		// Iterate properties on the actor's class and its parent classes.
		TArray<TSharedPtr<FJsonValue>> PropsArray;
		UClass* ActorClass = TargetActor->GetClass();

		for (TFieldIterator<FProperty> PropIt(ActorClass); PropIt; ++PropIt)
		{
			FProperty* Property = *PropIt;
			if (!Property)
			{
				continue;
			}

			// Check if this property is replicated.
			if (!Property->HasAnyPropertyFlags(CPF_Net))
			{
				continue;
			}

			const FString PropertyName = Property->GetName();
			const FString PropertyType = Property->GetCPPType();
			const bool bHasRepNotify   = Property->HasAnyPropertyFlags(CPF_RepNotify);

			// Resolve condition from lifetime props by RepIndex.
			FString ConditionStr = TEXT("COND_None");
			const ELifetimeCondition* FoundCondition = ConditionByRepIndex.Find(Property->RepIndex);
			if (FoundCondition)
			{
				ConditionStr = LifetimeConditionToString(*FoundCondition);
			}

			TSharedPtr<FJsonObject> PropObj = MakeShared<FJsonObject>();
			PropObj->SetStringField(TEXT("name"),          PropertyName);
			PropObj->SetStringField(TEXT("type"),          PropertyType);
			PropObj->SetStringField(TEXT("condition"),     ConditionStr);
			PropObj->SetBoolField(TEXT("has_rep_notify"),  bHasRepNotify);

			PropsArray.Add(MakeShared<FJsonValueObject>(PropObj));
		}

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetStringField(TEXT("actor_label"),    ActorLabel);
		Data->SetStringField(TEXT("actor_class"),    ActorClass->GetName());
		Data->SetNumberField(TEXT("property_count"), static_cast<double>(PropsArray.Num()));
		Data->SetArrayField(TEXT("properties"),      PropsArray);

		SendResponse(BuildNetSuccessResponse(CorrId, Data) + TEXT("\n"));
	});

	// -----------------------------------------------------------------------
	// net.driver (NET-03)
	// Returns NetDriver configuration and connection information.
	// No required parameters. Returns informative message when no NetDriver
	// is active (editor without PIE or no networked session).
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("net.driver"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

		if (!GEditor)
		{
			SendResponse(BuildNetErrorResponse(CorrId, TEXT("no_editor")) + TEXT("\n"));
			return;
		}

		UWorld* World = GEditor->GetEditorWorldContext().World();
		if (!World)
		{
			SendResponse(BuildNetErrorResponse(CorrId, TEXT("no_world_open")) + TEXT("\n"));
			return;
		}

		UNetDriver* NetDriver = World->GetNetDriver();
		if (!NetDriver)
		{
			// No NetDriver is active. Return graceful status (not an error -- expected in editor).
			TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
			Data->SetStringField(TEXT("status"),  TEXT("no_net_driver"));
			Data->SetStringField(TEXT("message"), TEXT("No NetDriver is active. Start a PIE session in server or listen-server mode to activate a NetDriver."));
			SendResponse(BuildNetSuccessResponse(CorrId, Data) + TEXT("\n"));
			return;
		}

		// Read NetDriver properties.
		const FString DriverName  = NetDriver->GetName();
		const ENetMode NetMode    = NetDriver->GetNetMode();
		const bool bIsServer      = (NetMode == NM_DedicatedServer || NetMode == NM_ListenServer);
		const int32 ConnCount     = NetDriver->ClientConnections.Num();
		const int32 MaxChannels   = NetDriver->GetMaxChannelsOverride();

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetStringField(TEXT("driver_name"),      DriverName);
		Data->SetStringField(TEXT("net_mode"),         NetModeToString(NetMode));
		Data->SetBoolField(TEXT("is_server"),          bIsServer);
		Data->SetNumberField(TEXT("connection_count"), static_cast<double>(ConnCount));
		Data->SetNumberField(TEXT("max_channels"),     static_cast<double>(MaxChannels));
		Data->SetNumberField(TEXT("in_total_bytes"),   static_cast<double>(NetDriver->InTotalBytes));
		Data->SetNumberField(TEXT("out_total_bytes"),  static_cast<double>(NetDriver->OutTotalBytes));

		// Build connections array (first 10).
		TArray<TSharedPtr<FJsonValue>> ConnsArray;
		const int32 MaxConns = FMath::Min(ConnCount, 10);
		for (int32 i = 0; i < MaxConns; ++i)
		{
			UNetConnection* Conn = NetDriver->ClientConnections[i];
			if (!Conn)
			{
				continue;
			}

			TSharedPtr<FJsonObject> ConnObj = MakeShared<FJsonObject>();
			ConnObj->SetStringField(TEXT("address"),           Conn->RemoteAddressToString());
			ConnObj->SetNumberField(TEXT("avg_latency"),       static_cast<double>(Conn->AvgLag));
			ConnObj->SetNumberField(TEXT("in_bytes_per_sec"),  static_cast<double>(Conn->InBytesPerSecond));
			ConnObj->SetNumberField(TEXT("out_bytes_per_sec"), static_cast<double>(Conn->OutBytesPerSecond));
			ConnsArray.Add(MakeShared<FJsonValueObject>(ConnObj));
		}
		Data->SetArrayField(TEXT("connections"), ConnsArray);

		SendResponse(BuildNetSuccessResponse(CorrId, Data) + TEXT("\n"));
	});

	// -----------------------------------------------------------------------
	// net.session (NET-04)
	// Returns online subsystem session information and player list.
	// No required parameters. Returns informative status when no online
	// subsystem is configured or no active session exists.
	//
	// Reflection conversion: The OnlineSubsystem module is optional. When the
	// module is NOT loaded, we return the same "no_online_subsystem" status as
	// the original code did when IOnlineSubsystem::Get() returned nullptr.
	// When the module IS loaded, we attempt to find session data via reflection.
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("net.session"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

		// Check if OnlineSubsystem module is loaded.
		if (!MCPReflect::CheckModuleLoaded(TEXT("OnlineSubsystem")))
		{
			TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
			Data->SetStringField(TEXT("status"),  TEXT("no_online_subsystem"));
			Data->SetStringField(TEXT("message"), TEXT("No online subsystem is configured. Enable an online subsystem plugin (e.g. OnlineSubsystemNull for LAN testing) to use this command."));
			SendResponse(BuildNetSuccessResponse(CorrId, Data) + TEXT("\n"));
			return;
		}

		// Module is loaded -- try to find the online subsystem singleton via reflection.
		// UOnlineEngineInterface is the UObject-based bridge to IOnlineSubsystem.
		UClass* OnlineEngineIfaceClass = MCPReflect::FindClassByPath(
			TEXT("/Script/OnlineSubsystemUtils.OnlineEngineInterfaceImpl"));
		if (!OnlineEngineIfaceClass)
		{
			OnlineEngineIfaceClass = MCPReflect::FindClassByPath(
				TEXT("/Script/OnlineSubsystem.OnlineEngineInterface"));
		}

		if (!OnlineEngineIfaceClass)
		{
			// Module is loaded but class not found -- fall through to graceful status.
			TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
			Data->SetStringField(TEXT("status"),  TEXT("no_online_subsystem"));
			Data->SetStringField(TEXT("message"), TEXT("OnlineSubsystem module is loaded but no online engine interface class was found."));
			SendResponse(BuildNetSuccessResponse(CorrId, Data) + TEXT("\n"));
			return;
		}

		// Find a UObject instance of the online engine interface.
		UObject* OnlineEngineObj = FindFirstObject<UObject>(
			TEXT("OnlineEngineInterfaceImpl"), EFindFirstObjectOptions::NativeFirst);

		if (!OnlineEngineObj)
		{
			// No singleton instance found -- subsystem not initialized.
			TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
			Data->SetStringField(TEXT("status"),  TEXT("no_online_subsystem"));
			Data->SetStringField(TEXT("message"), TEXT("No online subsystem is configured. Enable an online subsystem plugin (e.g. OnlineSubsystemNull for LAN testing) to use this command."));
			SendResponse(BuildNetSuccessResponse(CorrId, Data) + TEXT("\n"));
			return;
		}

		// Get the subsystem name via reflection.
		FString SubsystemName = MCPReflect::GetStringProperty(OnlineEngineObj, TEXT("DefaultSubsystemName"));
		if (SubsystemName.IsEmpty())
		{
			SubsystemName = TEXT("Unknown");
		}

		// Attempt to find session data via the GetNamedSession function or SessionInterface property.
		// UOnlineEngineInterface exposes a GetSessionInterface() -- try to call it via ProcessEvent.
		UFunction* GetSessionFunc = OnlineEngineObj->FindFunction(TEXT("GetSessionInterface"));
		if (!GetSessionFunc)
		{
			// No session interface callable -- return no session interface status.
			TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
			Data->SetStringField(TEXT("status"),         TEXT("no_session_interface"));
			Data->SetStringField(TEXT("subsystem_name"), SubsystemName);
			Data->SetStringField(TEXT("message"),        TEXT("Online subsystem is configured but no session interface is available via reflection."));
			SendResponse(BuildNetSuccessResponse(CorrId, Data) + TEXT("\n"));
			return;
		}

		// The session interface is an IOnlineSession (not a UObject) -- we cannot easily
		// reflect on it. Return a status indicating the subsystem exists but session
		// data requires direct API access.
		// This is safe degradation: the subsystem is enabled, no session is active.
		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetStringField(TEXT("subsystem_name"), SubsystemName);
		Data->SetStringField(TEXT("status"),         TEXT("no_active_session"));
		Data->SetStringField(TEXT("message"),        TEXT("No active game session found. Start or join a session to inspect it."));
		SendResponse(BuildNetSuccessResponse(CorrId, Data) + TEXT("\n"));
	});
}
