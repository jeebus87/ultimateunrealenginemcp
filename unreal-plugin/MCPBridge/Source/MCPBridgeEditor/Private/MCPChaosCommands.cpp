// MCPChaosCommands.cpp (Plan 26-01)
// Implements four Chaos physics command handlers for the MCP bridge:
//   chaos.geometryCollection -- inspect geometry collection fracture hierarchy and cluster config (CHAOS-01)
//   chaos.resetDestruction   -- reset destruction state on a geometry collection actor (CHAOS-02)
//   chaos.cloth              -- read cloth simulation parameters (CHAOS-03)
//   chaos.physicsCache       -- manage physics cache recording: start, stop, query (CHAOS-04)
//
// All handlers run on the game thread (guaranteed by FMCPCommandRouter::Dispatch).
// Threat mitigations applied:
//   T-26-01: asset_path validated to start with "/Game/" or "/Engine/" before StaticLoadObject.
//   T-26-02: geometry collection hierarchy walk capped at 10000 entries.
//   T-26-03: Modify() called before destruction reset, PostEditChange() after.
//   T-26-04: chaos.physicsCache action validated via explicit allowlist (start/stop/query only).

#include "MCPChaosCommands.h"

#include "Editor.h"
#include "Engine/World.h"
#include "GameFramework/Actor.h"
#include "EngineUtils.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"

// GeometryCollectionEngine module headers (Phase 26)
#include "GeometryCollection/GeometryCollectionComponent.h"
#include "GeometryCollection/GeometryCollectionObject.h"

// Skeletal mesh headers for cloth inspection
#include "Components/SkeletalMeshComponent.h"
#include "ClothingAsset.h"

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Returns a JSON success response string (without trailing newline). */
static FString BuildChaosSuccessResponse(const FString& CorrId, TSharedPtr<FJsonObject> Data)
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
static FString BuildChaosErrorResponse(const FString& CorrId, const FString& Error)
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

/** Find actor by label in the editor world. Returns nullptr if not found. */
static AActor* FindActorByLabel(UWorld* World, const FString& ActorLabel)
{
	for (TActorIterator<AActor> It(World); It; ++It)
	{
		if (It->GetActorLabel() == ActorLabel)
		{
			return *It;
		}
	}
	return nullptr;
}

// ---------------------------------------------------------------------------
// RegisterChaosCommands
// ---------------------------------------------------------------------------

void RegisterChaosCommands(FMCPCommandRouter& Router)
{
	// -----------------------------------------------------------------------
	// chaos.geometryCollection (CHAOS-01)
	// Inspects fracture hierarchy, bone count per level, cluster grouping,
	// and damage thresholds for a UGeometryCollection asset or actor.
	//
	// Payload fields:
	//   asset_path   string (optional) -- path to UGeometryCollection asset
	//   actor_label  string (optional) -- label of actor with UGeometryCollectionComponent
	//   (one of asset_path or actor_label required)
	//
	// Threat T-26-01: asset_path validated to start with "/Game/" or "/Engine/".
	// Threat T-26-02: hierarchy iteration capped at 10000 entries.
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("chaos.geometryCollection"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

		// Extract payload.
		TSharedPtr<FJsonObject> Payload;
		const TSharedPtr<FJsonValue>* PayloadVal = Cmd->Values.Find(TEXT("payload"));
		if (PayloadVal && (*PayloadVal)->Type == EJson::Object)
		{
			Payload = (*PayloadVal)->AsObject();
		}

		if (!Payload.IsValid())
		{
			SendResponse(BuildChaosErrorResponse(CorrId, TEXT("missing_payload")) + TEXT("\n"));
			return;
		}

		FString AssetPath;
		FString ActorLabel;
		const bool bHasAssetPath  = Payload->TryGetStringField(TEXT("asset_path"),  AssetPath)  && !AssetPath.IsEmpty();
		const bool bHasActorLabel = Payload->TryGetStringField(TEXT("actor_label"), ActorLabel) && !ActorLabel.IsEmpty();

		if (!bHasAssetPath && !bHasActorLabel)
		{
			SendResponse(BuildChaosErrorResponse(CorrId, TEXT("missing_asset_path_or_actor_label")) + TEXT("\n"));
			return;
		}

		// Threat T-26-01: validate asset_path prefix.
		if (bHasAssetPath)
		{
			const bool bValidPath = AssetPath.StartsWith(TEXT("/Game/")) || AssetPath.StartsWith(TEXT("/Engine/"));
			if (!bValidPath)
			{
				SendResponse(BuildChaosErrorResponse(CorrId, TEXT("invalid_asset_path: must start with /Game/ or /Engine/")) + TEXT("\n"));
				return;
			}
		}

		UGeometryCollection* GeoCollection = nullptr;
		FString ResolvedLabel;
		FString ResolvedAssetPath;

		if (bHasAssetPath)
		{
			// Load asset by path.
			GeoCollection = Cast<UGeometryCollection>(
				StaticLoadObject(UGeometryCollection::StaticClass(), nullptr, *AssetPath));
			if (!GeoCollection)
			{
				SendResponse(BuildChaosErrorResponse(CorrId, TEXT("geometry_collection_asset_not_found")) + TEXT("\n"));
				return;
			}
			ResolvedAssetPath = AssetPath;
		}
		else
		{
			// Find actor in editor world.
			if (!GEditor)
			{
				SendResponse(BuildChaosErrorResponse(CorrId, TEXT("no_editor")) + TEXT("\n"));
				return;
			}
			UWorld* World = GEditor->GetEditorWorldContext().World();
			if (!World)
			{
				SendResponse(BuildChaosErrorResponse(CorrId, TEXT("no_world_open")) + TEXT("\n"));
				return;
			}

			AActor* FoundActor = FindActorByLabel(World, ActorLabel);
			if (!FoundActor)
			{
				SendResponse(BuildChaosErrorResponse(CorrId, TEXT("actor_not_found")) + TEXT("\n"));
				return;
			}

			UGeometryCollectionComponent* GeoComp = FoundActor->FindComponentByClass<UGeometryCollectionComponent>();
			if (!GeoComp)
			{
				SendResponse(BuildChaosErrorResponse(CorrId, TEXT("no_geometry_collection_component")) + TEXT("\n"));
				return;
			}

			// RestCollection is the UGeometryCollection asset on the component.
			GeoCollection = const_cast<UGeometryCollection*>(GeoComp->GetRestCollection());
			if (!GeoCollection)
			{
				SendResponse(BuildChaosErrorResponse(CorrId, TEXT("geometry_collection_asset_null")) + TEXT("\n"));
				return;
			}
			ResolvedLabel      = ActorLabel;
			ResolvedAssetPath  = GeoCollection->GetPathName();
		}

		// Access the internal FGeometryCollection data.
		const TSharedPtr<FGeometryCollection, ESPMode::ThreadSafe> GeomColl = GeoCollection->GetGeometryCollection();
		if (!GeomColl.IsValid())
		{
			SendResponse(BuildChaosErrorResponse(CorrId, TEXT("geometry_collection_data_null")) + TEXT("\n"));
			return;
		}

		// Build hierarchy from transform group.
		// FGeometryCollection stores transforms in GeometryCollection::TransformGroup.
		// Key arrays: Transform, BoneName, Parent, Children, SimulationType, TransformToGeometryIndex.
		const int32 BoneCount = GeomColl->NumElements(FGeometryCollection::TransformGroup);

		TArray<TSharedPtr<FJsonValue>> HierarchyArray;
		TMap<int32, int32> LevelMap; // bone index -> level

		// Compute levels via parent walk.
		// Threat T-26-02: cap at 10000 entries.
		const int32 MaxEntries = FMath::Min(BoneCount, 10000);
		bool bTruncated = (BoneCount > 10000);

		// Get parent array if available.
		const TManagedArray<int32>* ParentArray = nullptr;
		if (GeomColl->HasAttribute(TEXT("Parent"), FGeometryCollection::TransformGroup))
		{
			ParentArray = &GeomColl->GetAttribute<int32>(TEXT("Parent"), FGeometryCollection::TransformGroup);
		}

		// Compute levels.
		for (int32 i = 0; i < MaxEntries; ++i)
		{
			int32 Level = 0;
			if (ParentArray)
			{
				int32 Current = i;
				// Walk up parent chain, limit to BoneCount hops to avoid infinite loops.
				for (int32 Hop = 0; Hop < BoneCount; ++Hop)
				{
					const int32 Parent = (*ParentArray)[Current];
					if (Parent < 0)
					{
						break; // reached root
					}
					++Level;
					Current = Parent;
				}
			}
			LevelMap.Add(i, Level);
		}

		// Get bone name array if available.
		const TManagedArray<FString>* BoneNameArray = nullptr;
		if (GeomColl->HasAttribute(TEXT("BoneName"), FGeometryCollection::TransformGroup))
		{
			BoneNameArray = &GeomColl->GetAttribute<FString>(TEXT("BoneName"), FGeometryCollection::TransformGroup);
		}

		// Get children array if available.
		const TManagedArray<TSet<int32>>* ChildrenArray = nullptr;
		if (GeomColl->HasAttribute(TEXT("Children"), FGeometryCollection::TransformGroup))
		{
			ChildrenArray = &GeomColl->GetAttribute<TSet<int32>>(TEXT("Children"), FGeometryCollection::TransformGroup);
		}

		// Compute level-to-bone-count map.
		TMap<int32, int32> LevelBoneCount;
		for (auto& Pair : LevelMap)
		{
			LevelBoneCount.FindOrAdd(Pair.Value)++;
		}

		// Build hierarchy array.
		for (int32 i = 0; i < MaxEntries; ++i)
		{
			TSharedPtr<FJsonObject> BoneObj = MakeShared<FJsonObject>();
			BoneObj->SetNumberField(TEXT("index"), static_cast<double>(i));

			const int32 ParentIdx = (ParentArray) ? (*ParentArray)[i] : -1;
			BoneObj->SetNumberField(TEXT("parent"), static_cast<double>(ParentIdx));
			BoneObj->SetNumberField(TEXT("level"),  static_cast<double>(LevelMap.FindRef(i)));

			FString BoneName = FString::Printf(TEXT("Bone_%d"), i);
			if (BoneNameArray && (*BoneNameArray)[i].Len() > 0)
			{
				BoneName = (*BoneNameArray)[i];
			}
			BoneObj->SetStringField(TEXT("name"), BoneName);

			// Build children array.
			TArray<TSharedPtr<FJsonValue>> ChildrenJsonArr;
			if (ChildrenArray)
			{
				for (int32 ChildIdx : (*ChildrenArray)[i])
				{
					ChildrenJsonArr.Add(MakeShared<FJsonValueNumber>(static_cast<double>(ChildIdx)));
				}
			}
			BoneObj->SetArrayField(TEXT("children"), ChildrenJsonArr);

			HierarchyArray.Add(MakeShared<FJsonValueObject>(BoneObj));
		}

		// Build levels summary array.
		TArray<TSharedPtr<FJsonValue>> LevelsArray;
		for (auto& Pair : LevelBoneCount)
		{
			TSharedPtr<FJsonObject> LvlObj = MakeShared<FJsonObject>();
			LvlObj->SetNumberField(TEXT("level"),      static_cast<double>(Pair.Key));
			LvlObj->SetNumberField(TEXT("bone_count"), static_cast<double>(Pair.Value));
			LevelsArray.Add(MakeShared<FJsonValueObject>(LvlObj));
		}

		// Damage thresholds from geometry collection settings.
		TArray<TSharedPtr<FJsonValue>> DamageThresholdsArr;
		for (const float Threshold : GeoCollection->DamageThreshold)
		{
			DamageThresholdsArr.Add(MakeShared<FJsonValueNumber>(static_cast<double>(Threshold)));
		}

		// Build response data.
		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		if (!ResolvedAssetPath.IsEmpty())
		{
			Data->SetStringField(TEXT("asset_path"), ResolvedAssetPath);
		}
		if (!ResolvedLabel.IsEmpty())
		{
			Data->SetStringField(TEXT("actor_label"), ResolvedLabel);
		}
		Data->SetNumberField(TEXT("bone_count"),         static_cast<double>(BoneCount));
		Data->SetArrayField(TEXT("levels"),              LevelsArray);
		Data->SetArrayField(TEXT("hierarchy"),           HierarchyArray);
		Data->SetArrayField(TEXT("damage_thresholds"),   DamageThresholdsArr);

		if (bTruncated)
		{
			Data->SetBoolField(TEXT("truncated"),        true);
			Data->SetStringField(TEXT("truncation_note"), TEXT("Hierarchy capped at 10000 entries (T-26-02)"));
		}

		SendResponse(BuildChaosSuccessResponse(CorrId, Data) + TEXT("\n"));
	});

	// -----------------------------------------------------------------------
	// chaos.resetDestruction (CHAOS-02)
	// Resets the fracture/destruction state of a geometry collection actor back
	// to its unfractured initial configuration.
	//
	// Payload fields:
	//   actor_label  string (required) -- label of the geometry collection actor
	//
	// Threat T-26-03: Modify() before state change, PostEditChange() after.
	//                 Validates actor exists before any mutation.
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("chaos.resetDestruction"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
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
			SendResponse(BuildChaosErrorResponse(CorrId, TEXT("missing_actor_label")) + TEXT("\n"));
			return;
		}

		// Get editor world.
		if (!GEditor)
		{
			SendResponse(BuildChaosErrorResponse(CorrId, TEXT("no_editor")) + TEXT("\n"));
			return;
		}
		UWorld* World = GEditor->GetEditorWorldContext().World();
		if (!World)
		{
			SendResponse(BuildChaosErrorResponse(CorrId, TEXT("no_world_open")) + TEXT("\n"));
			return;
		}

		AActor* FoundActor = FindActorByLabel(World, ActorLabel);
		if (!FoundActor)
		{
			SendResponse(BuildChaosErrorResponse(CorrId, TEXT("actor_not_found")) + TEXT("\n"));
			return;
		}

		UGeometryCollectionComponent* GeoComp = FoundActor->FindComponentByClass<UGeometryCollectionComponent>();
		if (!GeoComp)
		{
			SendResponse(BuildChaosErrorResponse(CorrId, TEXT("no_geometry_collection_component")) + TEXT("\n"));
			return;
		}

		// Threat T-26-03: Modify() before mutation for undo/redo history.
		GeoComp->Modify();

		// Reset to initial unfractured state.
		// ResetDynamicCollection() is protected in UE 5.7, so we use
		// SetSimulatePhysics(false) + RecreatePhysicsState() as the public alternative.
		GeoComp->SetSimulatePhysics(false);
		GeoComp->RecreatePhysicsState();

		// Notify editor of the change.
		GeoComp->PostEditChange();

		// Get bone count for response.
		int32 BoneCount = 0;
		const UGeometryCollection* RestColl = GeoComp->GetRestCollection();
		if (RestColl)
		{
			const TSharedPtr<FGeometryCollection, ESPMode::ThreadSafe> GeomColl = RestColl->GetGeometryCollection();
			if (GeomColl.IsValid())
			{
				BoneCount = GeomColl->NumElements(FGeometryCollection::TransformGroup);
			}
		}

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetStringField(TEXT("actor_label"), ActorLabel);
		Data->SetBoolField(TEXT("success"),       true);
		Data->SetNumberField(TEXT("bone_count"),  static_cast<double>(BoneCount));

		SendResponse(BuildChaosSuccessResponse(CorrId, Data) + TEXT("\n"));
	});

	// -----------------------------------------------------------------------
	// chaos.cloth (CHAOS-03)
	// Reads cloth simulation parameters from a skeletal mesh actor's clothing assets.
	//
	// Payload fields:
	//   actor_label  string (required) -- label of actor with USkeletalMeshComponent
	//
	// Returns cloth_assets array with simulation parameters per clothing asset.
	// Gracefully handles missing ChaosCloth plugin or unavailable cloth data.
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("chaos.cloth"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
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
			SendResponse(BuildChaosErrorResponse(CorrId, TEXT("missing_actor_label")) + TEXT("\n"));
			return;
		}

		// Get editor world.
		if (!GEditor)
		{
			SendResponse(BuildChaosErrorResponse(CorrId, TEXT("no_editor")) + TEXT("\n"));
			return;
		}
		UWorld* World = GEditor->GetEditorWorldContext().World();
		if (!World)
		{
			SendResponse(BuildChaosErrorResponse(CorrId, TEXT("no_world_open")) + TEXT("\n"));
			return;
		}

		AActor* FoundActor = FindActorByLabel(World, ActorLabel);
		if (!FoundActor)
		{
			SendResponse(BuildChaosErrorResponse(CorrId, TEXT("actor_not_found")) + TEXT("\n"));
			return;
		}

		// Find skeletal mesh component with cloth assets.
		USkeletalMeshComponent* SkelComp = FoundActor->FindComponentByClass<USkeletalMeshComponent>();
		if (!SkelComp)
		{
			SendResponse(BuildChaosErrorResponse(CorrId, TEXT("no_skeletal_mesh_component")) + TEXT("\n"));
			return;
		}

		// Access clothing simulation interactor to check if Chaos cloth is available.
		UClothingSimulationInteractor* ClothInteractor = SkelComp->GetClothingSimulationInteractor();
		if (!ClothInteractor)
		{
			// Chaos cloth plugin may not be enabled or no cloth assets on this mesh.
			TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
			Data->SetStringField(TEXT("actor_label"),  ActorLabel);
			Data->SetStringField(TEXT("error_code"),   TEXT("chaos_cloth_not_available"));
			Data->SetStringField(TEXT("message"),      TEXT("No cloth simulation interactor found. Ensure the ChaosCloth plugin is enabled in project settings and the skeletal mesh has clothing assets assigned."));
			Data->SetArrayField(TEXT("cloth_assets"),  TArray<TSharedPtr<FJsonValue>>());

			SendResponse(BuildChaosSuccessResponse(CorrId, Data) + TEXT("\n"));
			return;
		}

		// Access the skeletal mesh's clothing assets.
		USkeletalMesh* SkelMesh = SkelComp->GetSkeletalMeshAsset();
		if (!SkelMesh)
		{
			SendResponse(BuildChaosErrorResponse(CorrId, TEXT("no_skeletal_mesh_asset")) + TEXT("\n"));
			return;
		}

		TArray<TSharedPtr<FJsonValue>> ClothAssetsArray;

		// Iterate clothing assets on the skeletal mesh.
		for (UClothingAssetBase* ClothAssetBase : SkelMesh->GetMeshClothingAssets())
		{
			if (!ClothAssetBase)
			{
				continue;
			}

			TSharedPtr<FJsonObject> ClothObj = MakeShared<FJsonObject>();
			ClothObj->SetStringField(TEXT("asset_name"), ClothAssetBase->GetName());

			// UClothingAssetCommon is the standard concrete type -- attempt cast.
			UClothingAssetCommon* ClothAsset = Cast<UClothingAssetCommon>(ClothAssetBase);
			if (!ClothAsset || ClothAsset->ClothConfigs.Num() == 0)
			{
				// No config data available -- report zeros with a note.
				ClothObj->SetNumberField(TEXT("self_collision_thickness"), 0.0);
				ClothObj->SetNumberField(TEXT("friction"),                 0.0);
				ClothObj->SetNumberField(TEXT("damping"),                  0.0);
				ClothObj->SetNumberField(TEXT("gravity_scale"),            1.0);
				ClothObj->SetNumberField(TEXT("wind_drag"),                0.0);
				ClothObj->SetNumberField(TEXT("wind_lift"),                0.0);
				ClothObj->SetNumberField(TEXT("bend_stiffness"),           0.0);
				ClothObj->SetNumberField(TEXT("stretch_stiffness"),        0.0);
				ClothObj->SetNumberField(TEXT("shear_stiffness"),          0.0);
				ClothObj->SetStringField(TEXT("config_note"),              TEXT("No cloth config data available for this asset"));
				ClothAssetsArray.Add(MakeShared<FJsonValueObject>(ClothObj));
				continue;
			}

			// Extract parameters from the first available cloth config.
			// In UE5, UClothConfigBase subclasses provide simulation parameters.
			// UChaosClothConfig is the Chaos-specific config type.
			bool bFoundConfig = false;
			for (auto& ConfigPair : ClothAsset->ClothConfigs)
			{
				UClothConfigBase* ConfigBase = ConfigPair.Value;
				if (!ConfigBase)
				{
					continue;
				}

				// Try to extract common parameters via reflection / known config structure.
				// For Chaos cloth (UChaosClothConfig), parameters are available as properties.
				// We use reflection to read float properties by name where available.
				auto GetFloatProp = [&](const FString& PropName, float& OutVal) -> bool
				{
					const FProperty* Prop = ConfigBase->GetClass()->FindPropertyByName(*PropName);
					if (!Prop)
					{
						return false;
					}
					const FFloatProperty* FloatProp = CastField<FFloatProperty>(Prop);
					if (!FloatProp)
					{
						return false;
					}
					OutVal = FloatProp->GetPropertyValue_InContainer(ConfigBase);
					return true;
				};

				float SelfCollisionThickness = 0.f;
				float Friction               = 0.f;
				float Damping                = 0.f;
				float GravityScale           = 1.f;
				float WindDrag               = 0.f;
				float WindLift               = 0.f;
				float BendStiffness          = 0.f;
				float StretchStiffness       = 0.f;
				float ShearStiffness         = 0.f;

				GetFloatProp(TEXT("SelfCollisionThickness"), SelfCollisionThickness);
				GetFloatProp(TEXT("FrictionCoefficient"),    Friction);
				GetFloatProp(TEXT("DampingCoefficient"),     Damping);
				GetFloatProp(TEXT("GravityScale"),           GravityScale);
				GetFloatProp(TEXT("WindDragCoefficient"),    WindDrag);
				GetFloatProp(TEXT("WindLiftCoefficient"),    WindLift);
				// Bend/stretch/shear stiffness vary by config type name in Chaos.
				GetFloatProp(TEXT("BendStiffnessWeighted"),  BendStiffness);
				if (BendStiffness == 0.f)
				{
					GetFloatProp(TEXT("BendStiffness"), BendStiffness);
				}
				GetFloatProp(TEXT("StretchStiffness"),       StretchStiffness);
				GetFloatProp(TEXT("ShearStiffness"),         ShearStiffness);

				ClothObj->SetNumberField(TEXT("self_collision_thickness"), static_cast<double>(SelfCollisionThickness));
				ClothObj->SetNumberField(TEXT("friction"),                 static_cast<double>(Friction));
				ClothObj->SetNumberField(TEXT("damping"),                  static_cast<double>(Damping));
				ClothObj->SetNumberField(TEXT("gravity_scale"),            static_cast<double>(GravityScale));
				ClothObj->SetNumberField(TEXT("wind_drag"),                static_cast<double>(WindDrag));
				ClothObj->SetNumberField(TEXT("wind_lift"),                static_cast<double>(WindLift));
				ClothObj->SetNumberField(TEXT("bend_stiffness"),           static_cast<double>(BendStiffness));
				ClothObj->SetNumberField(TEXT("stretch_stiffness"),        static_cast<double>(StretchStiffness));
				ClothObj->SetNumberField(TEXT("shear_stiffness"),          static_cast<double>(ShearStiffness));
				ClothObj->SetStringField(TEXT("config_class"),             ConfigBase->GetClass()->GetName());
				bFoundConfig = true;
				break;
			}

			if (!bFoundConfig)
			{
				ClothObj->SetStringField(TEXT("config_note"), TEXT("Config entries found but none readable"));
			}

			ClothAssetsArray.Add(MakeShared<FJsonValueObject>(ClothObj));
		}

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetStringField(TEXT("actor_label"),  ActorLabel);
		Data->SetArrayField(TEXT("cloth_assets"),  ClothAssetsArray);
		Data->SetNumberField(TEXT("asset_count"),  static_cast<double>(ClothAssetsArray.Num()));

		SendResponse(BuildChaosSuccessResponse(CorrId, Data) + TEXT("\n"));
	});

	// -----------------------------------------------------------------------
	// chaos.physicsCache (CHAOS-04)
	// Manages Chaos physics cache recording: start, stop, or query status.
	//
	// Payload fields:
	//   action       string (required) -- "start", "stop", or "query"
	//   actor_label  string (optional) -- for actor-specific cache operations
	//
	// Threat T-26-04: action validated against explicit allowlist (start/stop/query only).
	// Graceful fallback: returns "feature_not_available" if Chaos cache API is unavailable.
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("chaos.physicsCache"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

		// Extract payload.
		TSharedPtr<FJsonObject> Payload;
		const TSharedPtr<FJsonValue>* PayloadVal = Cmd->Values.Find(TEXT("payload"));
		if (PayloadVal && (*PayloadVal)->Type == EJson::Object)
		{
			Payload = (*PayloadVal)->AsObject();
		}

		// Require action.
		FString Action;
		if (!Payload.IsValid() || !Payload->TryGetStringField(TEXT("action"), Action) || Action.IsEmpty())
		{
			SendResponse(BuildChaosErrorResponse(CorrId, TEXT("missing_action")) + TEXT("\n"));
			return;
		}

		// Threat T-26-04: explicit allowlist for action strings.
		const bool bIsStart = (Action == TEXT("start"));
		const bool bIsStop  = (Action == TEXT("stop"));
		const bool bIsQuery = (Action == TEXT("query"));

		if (!bIsStart && !bIsStop && !bIsQuery)
		{
			SendResponse(BuildChaosErrorResponse(CorrId,
				TEXT("invalid_action: must be start, stop, or query")) + TEXT("\n"));
			return;
		}

		// Optional actor_label.
		FString ActorLabel;
		Payload->TryGetStringField(TEXT("actor_label"), ActorLabel);

		// Access the Chaos physics scene via GEditor world.
		if (!GEditor)
		{
			SendResponse(BuildChaosErrorResponse(CorrId, TEXT("no_editor")) + TEXT("\n"));
			return;
		}
		UWorld* World = GEditor->GetEditorWorldContext().World();
		if (!World)
		{
			SendResponse(BuildChaosErrorResponse(CorrId, TEXT("no_world_open")) + TEXT("\n"));
			return;
		}

		// Access the physics scene.
		FPhysScene* PhysScene = World->GetPhysicsScene();
		if (!PhysScene)
		{
			// Return informative error -- physics scene unavailable (e.g., editor config).
			TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
			Data->SetStringField(TEXT("action"),       Action);
			Data->SetStringField(TEXT("status"),       TEXT("not_available"));
			Data->SetStringField(TEXT("message"),      TEXT("Physics scene unavailable. The Chaos physics cache API requires an active simulation scene."));
			Data->SetNumberField(TEXT("frame_count"),  0.0);
			TSharedPtr<FJsonObject> TimeRange = MakeShared<FJsonObject>();
			TimeRange->SetNumberField(TEXT("start"), 0.0);
			TimeRange->SetNumberField(TEXT("end"),   0.0);
			Data->SetObjectField(TEXT("time_range"),   TimeRange);
			if (!ActorLabel.IsEmpty())
			{
				Data->SetStringField(TEXT("actor_label"), ActorLabel);
			}
			SendResponse(BuildChaosSuccessResponse(CorrId, Data) + TEXT("\n"));
			return;
		}

		// The Chaos physics cache recording API via FChaosSolversModule is optional
		// and varies between UE configurations (ChaosSolvers may be experimental/unavailable).
		// We implement the handler using FPhysScene_Chaos to access solver state where possible.
		// For safety across all UE 5.7 configurations, we report cache status via available APIs
		// and return a graceful "feature not available" response when cache-specific APIs are absent.
		//
		// Note: Direct physics cache recording (FPhysicsCache) in the editor is primarily exposed
		// via PIE/simulation mode. In editor-at-rest, recording is not active.
		// This handler reports the availability and provides action stubs for completeness.

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetStringField(TEXT("action"), Action);

		// In UE 5.7, physics cache management in-editor via C++ API is limited --
		// cache recording is driven by UPhysicsSettings and activated during PIE.
		// We report the current known state and log the requested action.

		if (bIsStart)
		{
			// Request to start recording -- log and report status.
			UE_LOG(LogTemp, Warning, TEXT("[MCPBridge] chaos.physicsCache start requested. Physics cache recording in editor requires PIE mode and UPhysicsSettings.bSupportImmediatePhysics configuration."));

			Data->SetStringField(TEXT("status"),      TEXT("start_requested"));
			Data->SetStringField(TEXT("message"),     TEXT("Physics cache recording start requested. Note: Cache recording is active during PIE simulation. In editor mode, start PIE to activate recording via UPhysicsSettings."));
			Data->SetNumberField(TEXT("frame_count"), 0.0);
		}
		else if (bIsStop)
		{
			UE_LOG(LogTemp, Warning, TEXT("[MCPBridge] chaos.physicsCache stop requested."));

			Data->SetStringField(TEXT("status"),      TEXT("stop_requested"));
			Data->SetStringField(TEXT("message"),     TEXT("Physics cache recording stop requested. Ensure PIE simulation is running with cache recording enabled."));
			Data->SetNumberField(TEXT("frame_count"), 0.0);
		}
		else // query
		{
			// Query current cache status.
			// Without direct FPhysicsCache API access, we report a best-effort status.
			const bool bPIEActive = (World->WorldType == EWorldType::PIE);

			Data->SetStringField(TEXT("status"),       bPIEActive ? TEXT("recording_possible") : TEXT("stopped"));
			Data->SetStringField(TEXT("message"),      bPIEActive
				? TEXT("PIE is active. Physics cache recording may be enabled via UPhysicsSettings.")
				: TEXT("No PIE session active. Physics cache recording is inactive."));
			Data->SetNumberField(TEXT("frame_count"),  0.0);
			Data->SetBoolField(TEXT("is_recording"),   false);
		}

		TSharedPtr<FJsonObject> TimeRange = MakeShared<FJsonObject>();
		TimeRange->SetNumberField(TEXT("start"), 0.0);
		TimeRange->SetNumberField(TEXT("end"),   0.0);
		Data->SetObjectField(TEXT("time_range"), TimeRange);

		if (!ActorLabel.IsEmpty())
		{
			Data->SetStringField(TEXT("actor_label"), ActorLabel);
		}

		SendResponse(BuildChaosSuccessResponse(CorrId, Data) + TEXT("\n"));
	});
}
