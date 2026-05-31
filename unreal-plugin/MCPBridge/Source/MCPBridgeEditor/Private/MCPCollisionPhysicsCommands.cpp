// MCPCollisionPhysicsCommands.cpp (Plan 20-01)
// Implements four collision and physics command handlers for the MCP bridge:
//   collision.read    -- read collision preset, enabled state, object type, and per-channel response map (PHY-01)
//   collision.set     -- apply collision preset or individual channel overrides to a component (PHY-02)
//   physics.material  -- read and set friction, restitution, density, and surface type (PHY-03)
//   physics.asset     -- return per-bone body setup with primitive shapes and dimensions (PHY-04)
//
// All handlers run on the game thread (guaranteed by FMCPCommandRouter::Dispatch).
// Threat mitigations applied:
//   T-20-01: collision.set response strings validated via explicit allowlist (Ignore/Overlap/Block only).
//            Modify() before mutation, PostEditChange() after.
//   T-20-02: physics.material write validates asset_path starts with "/Game/" or "/Engine/".
//            Modify() before property writes.
//   T-20-05: responses array iteration bounded to max 32 channels (ECollisionChannel enum range).

#include "MCPCollisionPhysicsCommands.h"

#include "Editor.h"
#include "Engine/World.h"
#include "GameFramework/Actor.h"
#include "EngineUtils.h"
#include "Components/PrimitiveComponent.h"
#include "Engine/EngineTypes.h"
#include "Engine/CollisionProfile.h"
#include "PhysicsEngine/BodyInstance.h"
#include "PhysicalMaterials/PhysicalMaterial.h"
#include "PhysicsEngine/PhysicsAsset.h"
#include "PhysicsEngine/SkeletalBodySetup.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Returns a JSON success response string (without trailing newline). */
static FString BuildPhySuccessResponse(const FString& CorrId, TSharedPtr<FJsonObject> Data)
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
static FString BuildPhyErrorResponse(const FString& CorrId, const FString& Error)
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

/** Convert ECollisionEnabled::Type to string. */
static FString CollisionEnabledToString(ECollisionEnabled::Type Type)
{
	switch (Type)
	{
		case ECollisionEnabled::NoCollision:       return TEXT("NoCollision");
		case ECollisionEnabled::QueryOnly:         return TEXT("QueryOnly");
		case ECollisionEnabled::PhysicsOnly:       return TEXT("PhysicsOnly");
		case ECollisionEnabled::QueryAndPhysics:   return TEXT("QueryAndPhysics");
		default:                                   return TEXT("Unknown");
	}
}

/** Convert ECollisionResponse to string. */
static FString CollisionResponseToString(ECollisionResponse Response)
{
	switch (Response)
	{
		case ECR_Ignore:  return TEXT("Ignore");
		case ECR_Overlap: return TEXT("Overlap");
		case ECR_Block:   return TEXT("Block");
		default:          return TEXT("Ignore");
	}
}

/** Convert string to ECollisionResponse (explicit allowlist per T-20-01). */
static bool StringToCollisionResponse(const FString& Str, ECollisionResponse& OutResponse)
{
	if (Str == TEXT("Ignore"))  { OutResponse = ECR_Ignore;  return true; }
	if (Str == TEXT("Overlap")) { OutResponse = ECR_Overlap; return true; }
	if (Str == TEXT("Block"))   { OutResponse = ECR_Block;   return true; }
	return false; // reject any other value
}

/** Build the per-channel collision response array for a UPrimitiveComponent. */
static TArray<TSharedPtr<FJsonValue>> BuildCollisionResponseArray(UPrimitiveComponent* Comp)
{
	TArray<TSharedPtr<FJsonValue>> ResponsesArray;

	UCollisionProfile* Profile = UCollisionProfile::Get();

	// Iterate all 32 possible ECollisionChannel values.
	// Channels ECC_WorldStatic(0) through ECC_GameTraceChannel18(31).
	for (int32 Ch = 0; Ch < 32; ++Ch)
	{
		const ECollisionChannel Channel = static_cast<ECollisionChannel>(Ch);
		const ECollisionResponse Response = Comp->GetCollisionResponseToChannel(Channel);

		FString ChannelName;
		if (Profile)
		{
			// GetChannelName returns the display name for a given channel index.
			ChannelName = Profile->ReturnChannelNameFromContainerIndex(static_cast<int32>(Channel)).ToString();
		}
		if (ChannelName.IsEmpty())
		{
			ChannelName = FString::Printf(TEXT("Channel%d"), Ch);
		}

		TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
		Entry->SetNumberField(TEXT("channel"),       static_cast<double>(Ch));
		Entry->SetStringField(TEXT("channel_name"),  ChannelName);
		Entry->SetStringField(TEXT("response"),      CollisionResponseToString(Response));
		ResponsesArray.Add(MakeShared<FJsonValueObject>(Entry));
	}

	return ResponsesArray;
}

/** Build the full collision data JSON object for a component. */
static TSharedPtr<FJsonObject> BuildCollisionData(UPrimitiveComponent* Comp)
{
	UCollisionProfile* Profile = UCollisionProfile::Get();

	const FString ProfileName      = Comp->GetCollisionProfileName().ToString();
	const FString EnabledStr       = CollisionEnabledToString(Comp->GetCollisionEnabled());
	const ECollisionChannel ObjCh  = Comp->GetCollisionObjectType();
	const int32 ObjectTypeInt      = static_cast<int32>(ObjCh);

	FString ObjectTypeName;
	if (Profile)
	{
		ObjectTypeName = Profile->ReturnChannelNameFromContainerIndex(static_cast<int32>(ObjCh)).ToString();
	}
	if (ObjectTypeName.IsEmpty())
	{
		ObjectTypeName = FString::Printf(TEXT("Channel%d"), ObjectTypeInt);
	}

	TArray<TSharedPtr<FJsonValue>> ResponsesArray = BuildCollisionResponseArray(Comp);

	TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
	Data->SetStringField(TEXT("component_name"),    Comp->GetName());
	Data->SetStringField(TEXT("profile_name"),      ProfileName);
	Data->SetStringField(TEXT("collision_enabled"), EnabledStr);
	Data->SetNumberField(TEXT("object_type"),       static_cast<double>(ObjectTypeInt));
	Data->SetStringField(TEXT("object_type_name"),  ObjectTypeName);
	Data->SetArrayField(TEXT("responses"),          ResponsesArray);

	return Data;
}

// ---------------------------------------------------------------------------
// RegisterCollisionPhysicsCommands
// ---------------------------------------------------------------------------

void RegisterCollisionPhysicsCommands(FMCPCommandRouter& Router)
{
	// -----------------------------------------------------------------------
	// collision.read (PHY-01)
	// Reads the full collision configuration from a UPrimitiveComponent on an actor.
	//
	// Payload fields:
	//   actor_label    string (required) -- label of the actor in the editor world
	//   component_name string (optional) -- name of UPrimitiveComponent; defaults to first primitive
	//
	// Returns: profile_name, collision_enabled, object_type (int+name), responses array (all 32 channels).
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("collision.read"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

		// Extract payload.
		TSharedPtr<FJsonObject> Payload;
		const TSharedPtr<FJsonValue>* PayloadVal = Cmd->Values.Find(TEXT("payload"));
		if (PayloadVal && (*PayloadVal)->Type == EJson::Object)
		{
			Payload = (*PayloadVal)->AsObject();
		}

		// Require actor_label.
		FString ActorLabel;
		if (!Payload.IsValid() || !Payload->TryGetStringField(TEXT("actor_label"), ActorLabel) || ActorLabel.IsEmpty())
		{
			SendResponse(BuildPhyErrorResponse(CorrId, TEXT("missing_actor_label")) + TEXT("\n"));
			return;
		}

		// Optional component_name.
		FString ComponentName;
		Payload->TryGetStringField(TEXT("component_name"), ComponentName);

		// Get editor world.
		if (!GEditor)
		{
			SendResponse(BuildPhyErrorResponse(CorrId, TEXT("no_editor")) + TEXT("\n"));
			return;
		}
		UWorld* World = GEditor->GetEditorWorldContext().World();
		if (!World)
		{
			SendResponse(BuildPhyErrorResponse(CorrId, TEXT("no_world_open")) + TEXT("\n"));
			return;
		}

		// Find actor by label.
		AActor* FoundActor = nullptr;
		for (TActorIterator<AActor> It(World); It; ++It)
		{
			if (It->GetActorLabel() == ActorLabel)
			{
				FoundActor = *It;
				break;
			}
		}
		if (!FoundActor)
		{
			SendResponse(BuildPhyErrorResponse(CorrId, TEXT("actor_not_found")) + TEXT("\n"));
			return;
		}

		// Locate target UPrimitiveComponent.
		UPrimitiveComponent* TargetComp = nullptr;

		TArray<UPrimitiveComponent*> PrimComps;
		FoundActor->GetComponents<UPrimitiveComponent>(PrimComps);

		if (!ComponentName.IsEmpty())
		{
			for (UPrimitiveComponent* Comp : PrimComps)
			{
				if (Comp && Comp->GetName() == ComponentName)
				{
					TargetComp = Comp;
					break;
				}
			}
			if (!TargetComp)
			{
				SendResponse(BuildPhyErrorResponse(CorrId, TEXT("component_not_found")) + TEXT("\n"));
				return;
			}
		}
		else
		{
			// Default to first primitive component.
			if (PrimComps.Num() > 0)
			{
				TargetComp = PrimComps[0];
			}
		}

		if (!TargetComp)
		{
			SendResponse(BuildPhyErrorResponse(CorrId, TEXT("no_primitive_component_found")) + TEXT("\n"));
			return;
		}

		TSharedPtr<FJsonObject> Data = BuildCollisionData(TargetComp);
		Data->SetStringField(TEXT("actor_label"), ActorLabel);

		SendResponse(BuildPhySuccessResponse(CorrId, Data) + TEXT("\n"));
	});

	// -----------------------------------------------------------------------
	// collision.set (PHY-02)
	// Applies a collision preset or per-channel overrides to a UPrimitiveComponent.
	// Calls Modify() before changes, PostEditChange() after.
	//
	// Payload fields:
	//   actor_label    string (required)
	//   component_name string (optional) -- defaults to first primitive component
	//   preset         string (optional) -- collision profile name to apply
	//   responses      array  (optional) -- [{channel: int, response: string}, ...]
	//                                       response must be "Ignore", "Overlap", or "Block"
	//
	// Threat T-20-01: response strings validated via explicit allowlist.
	// Threat T-20-05: responses array capped at 32 entries.
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("collision.set"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

		// Extract payload.
		TSharedPtr<FJsonObject> Payload;
		const TSharedPtr<FJsonValue>* PayloadVal = Cmd->Values.Find(TEXT("payload"));
		if (PayloadVal && (*PayloadVal)->Type == EJson::Object)
		{
			Payload = (*PayloadVal)->AsObject();
		}

		// Require actor_label.
		FString ActorLabel;
		if (!Payload.IsValid() || !Payload->TryGetStringField(TEXT("actor_label"), ActorLabel) || ActorLabel.IsEmpty())
		{
			SendResponse(BuildPhyErrorResponse(CorrId, TEXT("missing_actor_label")) + TEXT("\n"));
			return;
		}

		// Optional component_name.
		FString ComponentName;
		Payload->TryGetStringField(TEXT("component_name"), ComponentName);

		// Optional preset.
		FString Preset;
		const bool bHasPreset = Payload->TryGetStringField(TEXT("preset"), Preset) && !Preset.IsEmpty();

		// Optional responses array.
		const TArray<TSharedPtr<FJsonValue>>* ResponsesJsonArr = nullptr;
		const bool bHasResponses = Payload->TryGetArrayField(TEXT("responses"), ResponsesJsonArr)
			&& ResponsesJsonArr != nullptr
			&& ResponsesJsonArr->Num() > 0;

		if (!bHasPreset && !bHasResponses)
		{
			SendResponse(BuildPhyErrorResponse(CorrId, TEXT("missing_preset_or_responses")) + TEXT("\n"));
			return;
		}

		// Get editor world.
		if (!GEditor)
		{
			SendResponse(BuildPhyErrorResponse(CorrId, TEXT("no_editor")) + TEXT("\n"));
			return;
		}
		UWorld* World = GEditor->GetEditorWorldContext().World();
		if (!World)
		{
			SendResponse(BuildPhyErrorResponse(CorrId, TEXT("no_world_open")) + TEXT("\n"));
			return;
		}

		// Find actor by label.
		AActor* FoundActor = nullptr;
		for (TActorIterator<AActor> It(World); It; ++It)
		{
			if (It->GetActorLabel() == ActorLabel)
			{
				FoundActor = *It;
				break;
			}
		}
		if (!FoundActor)
		{
			SendResponse(BuildPhyErrorResponse(CorrId, TEXT("actor_not_found")) + TEXT("\n"));
			return;
		}

		// Locate target UPrimitiveComponent.
		UPrimitiveComponent* TargetComp = nullptr;

		TArray<UPrimitiveComponent*> PrimComps;
		FoundActor->GetComponents<UPrimitiveComponent>(PrimComps);

		if (!ComponentName.IsEmpty())
		{
			for (UPrimitiveComponent* Comp : PrimComps)
			{
				if (Comp && Comp->GetName() == ComponentName)
				{
					TargetComp = Comp;
					break;
				}
			}
			if (!TargetComp)
			{
				SendResponse(BuildPhyErrorResponse(CorrId, TEXT("component_not_found")) + TEXT("\n"));
				return;
			}
		}
		else
		{
			if (PrimComps.Num() > 0)
			{
				TargetComp = PrimComps[0];
			}
		}

		if (!TargetComp)
		{
			SendResponse(BuildPhyErrorResponse(CorrId, TEXT("no_primitive_component_found")) + TEXT("\n"));
			return;
		}

		// Modify() before any state change -- required for UE undo/redo history (T-20-01).
		TargetComp->Modify();

		// Apply collision profile preset if provided.
		if (bHasPreset)
		{
			TargetComp->SetCollisionProfileName(FName(*Preset));
		}

		// Apply per-channel overrides if provided.
		if (bHasResponses && ResponsesJsonArr != nullptr)
		{
			// Threat T-20-05: cap at 32 entries (ECollisionChannel enum range).
			const int32 MaxEntries = FMath::Min(ResponsesJsonArr->Num(), 32);
			for (int32 Idx = 0; Idx < MaxEntries; ++Idx)
			{
				const TSharedPtr<FJsonValue>& Entry = (*ResponsesJsonArr)[Idx];
				if (!Entry.IsValid() || Entry->Type != EJson::Object)
				{
					continue;
				}
				const TSharedPtr<FJsonObject> EntryObj = Entry->AsObject();

				double ChannelNum = 0.0;
				FString ResponseStr;
				if (!EntryObj->TryGetNumberField(TEXT("channel"), ChannelNum) ||
					!EntryObj->TryGetStringField(TEXT("response"), ResponseStr))
				{
					continue;
				}

				const int32 ChInt = static_cast<int32>(ChannelNum);
				if (ChInt < 0 || ChInt >= 32)
				{
					continue;
				}

				// Threat T-20-01: explicit allowlist for response strings.
				ECollisionResponse NewResponse = ECR_Ignore;
				if (!StringToCollisionResponse(ResponseStr, NewResponse))
				{
					// Invalid response string -- skip this entry.
					continue;
				}

				const ECollisionChannel Channel = static_cast<ECollisionChannel>(ChInt);
				TargetComp->SetCollisionResponseToChannel(Channel, NewResponse);
			}
		}

		// Notify editor of the change.
		TargetComp->PostEditChange();

		// Return updated collision state.
		TSharedPtr<FJsonObject> Data = BuildCollisionData(TargetComp);
		Data->SetStringField(TEXT("actor_label"), ActorLabel);

		SendResponse(BuildPhySuccessResponse(CorrId, Data) + TEXT("\n"));
	});

	// -----------------------------------------------------------------------
	// physics.material (PHY-03)
	// Reads or writes properties of a UPhysicalMaterial asset: friction, static_friction,
	// restitution, density, and surface_type.
	//
	// Payload fields:
	//   asset_path     string (required) -- path to UPhysicalMaterial (e.g., "/Game/PM_Rock")
	//   action         string (required) -- "read" or "write"
	//   friction       float  (optional, write only)
	//   static_friction float (optional, write only)
	//   restitution    float  (optional, write only)
	//   density        float  (optional, write only)
	//   surface_type   int    (optional, write only)
	//
	// Threat T-20-02: asset_path validated to start with "/Game/" or "/Engine/" on write.
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("physics.material"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

		// Extract payload.
		TSharedPtr<FJsonObject> Payload;
		const TSharedPtr<FJsonValue>* PayloadVal = Cmd->Values.Find(TEXT("payload"));
		if (PayloadVal && (*PayloadVal)->Type == EJson::Object)
		{
			Payload = (*PayloadVal)->AsObject();
		}

		// Require asset_path.
		FString AssetPath;
		if (!Payload.IsValid() || !Payload->TryGetStringField(TEXT("asset_path"), AssetPath) || AssetPath.IsEmpty())
		{
			SendResponse(BuildPhyErrorResponse(CorrId, TEXT("missing_asset_path")) + TEXT("\n"));
			return;
		}

		// Require action.
		FString Action;
		if (!Payload->TryGetStringField(TEXT("action"), Action) || Action.IsEmpty())
		{
			SendResponse(BuildPhyErrorResponse(CorrId, TEXT("missing_action")) + TEXT("\n"));
			return;
		}

		const bool bIsRead  = (Action == TEXT("read"));
		const bool bIsWrite = (Action == TEXT("write"));

		if (!bIsRead && !bIsWrite)
		{
			SendResponse(BuildPhyErrorResponse(CorrId, TEXT("invalid_action: must be read or write")) + TEXT("\n"));
			return;
		}

		// Threat T-20-02: validate asset path prefix on write.
		if (bIsWrite)
		{
			const bool bValidPath = AssetPath.StartsWith(TEXT("/Game/")) || AssetPath.StartsWith(TEXT("/Engine/"));
			if (!bValidPath)
			{
				SendResponse(BuildPhyErrorResponse(CorrId, TEXT("invalid_asset_path: must start with /Game/ or /Engine/")) + TEXT("\n"));
				return;
			}
		}

		// Load the physical material.
		UPhysicalMaterial* PhysMat = Cast<UPhysicalMaterial>(
			StaticLoadObject(UPhysicalMaterial::StaticClass(), nullptr, *AssetPath));
		if (!PhysMat)
		{
			SendResponse(BuildPhyErrorResponse(CorrId, TEXT("physical_material_not_found")) + TEXT("\n"));
			return;
		}

		if (bIsWrite)
		{
			// Modify() before any property change (T-20-02).
			PhysMat->Modify();

			double Val = 0.0;
			if (Payload->TryGetNumberField(TEXT("friction"), Val))
			{
				PhysMat->Friction = static_cast<float>(Val);
			}
			if (Payload->TryGetNumberField(TEXT("static_friction"), Val))
			{
				PhysMat->StaticFriction = static_cast<float>(Val);
			}
			if (Payload->TryGetNumberField(TEXT("restitution"), Val))
			{
				PhysMat->Restitution = static_cast<float>(Val);
			}
			if (Payload->TryGetNumberField(TEXT("density"), Val))
			{
				PhysMat->Density = static_cast<float>(Val);
			}
			if (Payload->TryGetNumberField(TEXT("surface_type"), Val))
			{
				PhysMat->SurfaceType = static_cast<EPhysicalSurface>(static_cast<int32>(Val));
			}

			PhysMat->PostEditChange();
		}

		// Build response data (same for both read and write, returns current values).
		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetStringField(TEXT("asset_path"),      AssetPath);
		Data->SetNumberField(TEXT("friction"),         static_cast<double>(PhysMat->Friction));
		Data->SetNumberField(TEXT("static_friction"),  static_cast<double>(PhysMat->StaticFriction));
		Data->SetNumberField(TEXT("restitution"),      static_cast<double>(PhysMat->Restitution));
		Data->SetNumberField(TEXT("density"),          static_cast<double>(PhysMat->Density));
		Data->SetNumberField(TEXT("surface_type"),     static_cast<double>(static_cast<int32>(PhysMat->SurfaceType.GetValue())));

		// Surface type name via UPhysicsSettings surface names.
		// We use a numeric representation here since the name lookup requires project-specific surface config.
		Data->SetStringField(TEXT("action"), Action);

		SendResponse(BuildPhySuccessResponse(CorrId, Data) + TEXT("\n"));
	});

	// -----------------------------------------------------------------------
	// physics.asset (PHY-04)
	// Returns per-bone body setup data from a UPhysicsAsset, including primitive
	// shapes (capsules, spheres, boxes) and their dimensions.
	//
	// Payload fields:
	//   asset_path  string (required) -- path to UPhysicsAsset
	//
	// Returns: array of body setups, each with bone_name, physics_type, and primitives.
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("physics.asset"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

		// Extract payload.
		TSharedPtr<FJsonObject> Payload;
		const TSharedPtr<FJsonValue>* PayloadVal = Cmd->Values.Find(TEXT("payload"));
		if (PayloadVal && (*PayloadVal)->Type == EJson::Object)
		{
			Payload = (*PayloadVal)->AsObject();
		}

		// Require asset_path.
		FString AssetPath;
		if (!Payload.IsValid() || !Payload->TryGetStringField(TEXT("asset_path"), AssetPath) || AssetPath.IsEmpty())
		{
			SendResponse(BuildPhyErrorResponse(CorrId, TEXT("missing_asset_path")) + TEXT("\n"));
			return;
		}

		// Load the physics asset.
		UPhysicsAsset* PhysAsset = Cast<UPhysicsAsset>(
			StaticLoadObject(UPhysicsAsset::StaticClass(), nullptr, *AssetPath));
		if (!PhysAsset)
		{
			SendResponse(BuildPhyErrorResponse(CorrId, TEXT("physics_asset_not_found")) + TEXT("\n"));
			return;
		}

		// Helper: convert physics type enum to string.
		auto PhysicsTypeToString = [](EPhysicsType Type) -> FString
		{
			switch (Type)
			{
				case EPhysicsType::PhysType_Simulated: return TEXT("Simulated");
				case EPhysicsType::PhysType_Kinematic: return TEXT("Kinematic");
				case EPhysicsType::PhysType_Default:   return TEXT("Default");
				default:                               return TEXT("Unknown");
			}
		};

		// Iterate all body setups.
		TArray<TSharedPtr<FJsonValue>> BodySetupsArray;

		for (USkeletalBodySetup* BodySetup : PhysAsset->SkeletalBodySetups)
		{
			if (!BodySetup)
			{
				continue;
			}

			TArray<TSharedPtr<FJsonValue>> PrimitivesArray;

			// Capsules (SphylElems).
			for (const FKSphylElem& Capsule : BodySetup->AggGeom.SphylElems)
			{
				TSharedPtr<FJsonObject> PrimObj = MakeShared<FJsonObject>();
				PrimObj->SetStringField(TEXT("type"), TEXT("capsule"));

				TSharedPtr<FJsonObject> CenterObj = MakeShared<FJsonObject>();
				CenterObj->SetNumberField(TEXT("x"), static_cast<double>(Capsule.Center.X));
				CenterObj->SetNumberField(TEXT("y"), static_cast<double>(Capsule.Center.Y));
				CenterObj->SetNumberField(TEXT("z"), static_cast<double>(Capsule.Center.Z));
				PrimObj->SetObjectField(TEXT("center"), CenterObj);

				TSharedPtr<FJsonObject> RotObj = MakeShared<FJsonObject>();
				RotObj->SetNumberField(TEXT("pitch"), static_cast<double>(Capsule.Rotation.Pitch));
				RotObj->SetNumberField(TEXT("yaw"),   static_cast<double>(Capsule.Rotation.Yaw));
				RotObj->SetNumberField(TEXT("roll"),  static_cast<double>(Capsule.Rotation.Roll));
				PrimObj->SetObjectField(TEXT("rotation"), RotObj);

				PrimObj->SetNumberField(TEXT("radius"), static_cast<double>(Capsule.Radius));
				PrimObj->SetNumberField(TEXT("length"), static_cast<double>(Capsule.Length));

				PrimitivesArray.Add(MakeShared<FJsonValueObject>(PrimObj));
			}

			// Spheres (SphereElems).
			for (const FKSphereElem& Sphere : BodySetup->AggGeom.SphereElems)
			{
				TSharedPtr<FJsonObject> PrimObj = MakeShared<FJsonObject>();
				PrimObj->SetStringField(TEXT("type"), TEXT("sphere"));

				TSharedPtr<FJsonObject> CenterObj = MakeShared<FJsonObject>();
				CenterObj->SetNumberField(TEXT("x"), static_cast<double>(Sphere.Center.X));
				CenterObj->SetNumberField(TEXT("y"), static_cast<double>(Sphere.Center.Y));
				CenterObj->SetNumberField(TEXT("z"), static_cast<double>(Sphere.Center.Z));
				PrimObj->SetObjectField(TEXT("center"), CenterObj);

				PrimObj->SetNumberField(TEXT("radius"), static_cast<double>(Sphere.Radius));

				PrimitivesArray.Add(MakeShared<FJsonValueObject>(PrimObj));
			}

			// Boxes (BoxElems).
			for (const FKBoxElem& Box : BodySetup->AggGeom.BoxElems)
			{
				TSharedPtr<FJsonObject> PrimObj = MakeShared<FJsonObject>();
				PrimObj->SetStringField(TEXT("type"), TEXT("box"));

				TSharedPtr<FJsonObject> CenterObj = MakeShared<FJsonObject>();
				CenterObj->SetNumberField(TEXT("x"), static_cast<double>(Box.Center.X));
				CenterObj->SetNumberField(TEXT("y"), static_cast<double>(Box.Center.Y));
				CenterObj->SetNumberField(TEXT("z"), static_cast<double>(Box.Center.Z));
				PrimObj->SetObjectField(TEXT("center"), CenterObj);

				TSharedPtr<FJsonObject> RotObj = MakeShared<FJsonObject>();
				RotObj->SetNumberField(TEXT("pitch"), static_cast<double>(Box.Rotation.Pitch));
				RotObj->SetNumberField(TEXT("yaw"),   static_cast<double>(Box.Rotation.Yaw));
				RotObj->SetNumberField(TEXT("roll"),  static_cast<double>(Box.Rotation.Roll));
				PrimObj->SetObjectField(TEXT("rotation"), RotObj);

				PrimObj->SetNumberField(TEXT("extent_x"), static_cast<double>(Box.X));
				PrimObj->SetNumberField(TEXT("extent_y"), static_cast<double>(Box.Y));
				PrimObj->SetNumberField(TEXT("extent_z"), static_cast<double>(Box.Z));

				PrimitivesArray.Add(MakeShared<FJsonValueObject>(PrimObj));
			}

			// Convex (ConvexElems) -- vertex count only (geometry is complex).
			for (const FKConvexElem& Convex : BodySetup->AggGeom.ConvexElems)
			{
				TSharedPtr<FJsonObject> PrimObj = MakeShared<FJsonObject>();
				PrimObj->SetStringField(TEXT("type"), TEXT("convex"));
				PrimObj->SetNumberField(TEXT("vertex_count"), static_cast<double>(Convex.VertexData.Num()));

				PrimitivesArray.Add(MakeShared<FJsonValueObject>(PrimObj));
			}

			// Build body setup entry.
			TSharedPtr<FJsonObject> BodyObj = MakeShared<FJsonObject>();
			BodyObj->SetStringField(TEXT("bone_name"),    BodySetup->BoneName.ToString());
			BodyObj->SetStringField(TEXT("physics_type"), PhysicsTypeToString(BodySetup->PhysicsType));
			BodyObj->SetArrayField(TEXT("primitives"),    PrimitivesArray);

			// Mass override if applicable.
			if (BodySetup->DefaultInstance.bOverrideMass)
			{
				BodyObj->SetBoolField(TEXT("mass_override_enabled"), true);
				BodyObj->SetNumberField(TEXT("mass_override"),
					static_cast<double>(BodySetup->DefaultInstance.GetMassOverride()));
			}
			else
			{
				BodyObj->SetBoolField(TEXT("mass_override_enabled"), false);
			}

			BodySetupsArray.Add(MakeShared<FJsonValueObject>(BodyObj));
		}

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetStringField(TEXT("asset_path"),   AssetPath);
		Data->SetNumberField(TEXT("body_count"),   static_cast<double>(BodySetupsArray.Num()));
		Data->SetArrayField(TEXT("body_setups"),   BodySetupsArray);

		SendResponse(BuildPhySuccessResponse(CorrId, Data) + TEXT("\n"));
	});
}
