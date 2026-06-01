// MCPAssetCommands.cpp
// Implements three MCP command handlers for asset registry queries and level layout.
//
//   asset.query      (EDT-05) -- Query assets by class, path prefix, or tag via IAssetRegistry
//   asset.references (EDT-06) -- Trace hard dependencies and referencers for a package
//   level.layout     (EDT-07) -- Return placed actors grouped by sublevel + world partition info
//
// All handlers are guaranteed to run on the game thread (FMCPCommandRouter guarantee via AsyncTask).
// Asset registry queries use pre-indexed data -- no asset loading, no filesystem scan.

#include "MCPAssetCommands.h"

#include "AssetRegistry/AssetRegistryModule.h"
#include "AssetRegistry/IAssetRegistry.h"
#include "AssetRegistry/ARFilter.h"
#include "Editor.h"
#include "Engine/World.h"
#include "Engine/LevelStreaming.h"
#include "EngineUtils.h"
#include "GameFramework/Actor.h"
#include "WorldPartition/WorldPartition.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "AssetToolsModule.h"
#include "IAssetTools.h"
#include "Curves/CurveFloat.h"
#include "Curves/RichCurve.h"
#include "UObject/SavePackage.h"
#include "UObject/Package.h"

// ---------------------------------------------------------------------------
// File-scope JSON response helpers (identical pattern to MCPCommandRouter.cpp)
// ---------------------------------------------------------------------------

static FString BuildSuccessResponse(const FString& CorrId, TSharedPtr<FJsonObject> Data)
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
	Output += TEXT("\n");
	return Output;
}

static FString BuildErrorResponse(const FString& CorrId, const FString& Err)
{
	TSharedPtr<FJsonObject> Obj = MakeShared<FJsonObject>();
	Obj->SetBoolField(TEXT("success"), false);
	if (!CorrId.IsEmpty())
	{
		Obj->SetStringField(TEXT("correlationId"), CorrId);
	}
	Obj->SetStringField(TEXT("error"), Err);

	FString Output;
	TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Output);
	FJsonSerializer::Serialize(Obj.ToSharedRef(), Writer);
	Output += TEXT("\n");
	return Output;
}

// ---------------------------------------------------------------------------
// RegisterAssetCommands
// ---------------------------------------------------------------------------

void RegisterAssetCommands(FMCPCommandRouter& Router)
{
	// -----------------------------------------------------------------------
	// asset.query (EDT-05)
	// Query the Asset Registry for assets matching optional class, path, tag filters.
	// Uses FARFilter + IAssetRegistry::GetAssets — never walks the filesystem.
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("asset.query"), [](TSharedPtr<FJsonObject> Command, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Command.IsValid() ? Command->GetStringField(TEXT("correlationId")) : TEXT("");

		// Access the asset registry (pre-indexed, no I/O).
		FAssetRegistryModule& ARModule = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry"));
		IAssetRegistry& AssetRegistry = ARModule.Get();

		// Read optional payload fields.
		FString AssetClass;
		FString PathPrefix;
		FString TagKey;
		FString TagValue;
		double LimitRaw = 100.0;

		Command->TryGetStringField(TEXT("asset_class"), AssetClass);
		Command->TryGetStringField(TEXT("path_prefix"), PathPrefix);
		Command->TryGetStringField(TEXT("tag_key"), TagKey);
		Command->TryGetStringField(TEXT("tag_value"), TagValue);
		Command->TryGetNumberField(TEXT("limit"), LimitRaw);

		const int32 Limit = FMath::Clamp(static_cast<int32>(LimitRaw), 1, 500);

		// Build filter — all fields optional.
		FARFilter Filter;
		Filter.bRecursivePaths = true;

		if (!AssetClass.IsEmpty())
		{
			// UE 5.1+ API: ClassPaths preferred over deprecated ClassNames.
			// Add with /Script/Engine prefix for engine classes; also add the
			// deprecated ClassNames as a fallback to catch game/plugin classes.
			Filter.ClassPaths.Add(FTopLevelAssetPath(TEXT("/Script/Engine"), FName(*AssetClass)));

			PRAGMA_DISABLE_DEPRECATION_WARNINGS
			Filter.ClassNames.Add(FName(*AssetClass));
			PRAGMA_ENABLE_DEPRECATION_WARNINGS
		}

		if (!PathPrefix.IsEmpty())
		{
			Filter.PackagePaths.Add(FName(*PathPrefix));
		}

		if (!TagKey.IsEmpty())
		{
			Filter.TagsAndValues.Add(FName(*TagKey), TagValue);
		}

		TArray<FAssetData> Assets;
		AssetRegistry.GetAssets(Filter, Assets);

		const int32 Total = Assets.Num();
		const int32 ReturnCount = FMath::Min(Limit, Total);

		TArray<TSharedPtr<FJsonValue>> AssetArr;
		AssetArr.Reserve(ReturnCount);
		for (int32 i = 0; i < ReturnCount; ++i)
		{
			const FAssetData& AD = Assets[i];
			TSharedPtr<FJsonObject> AObj = MakeShared<FJsonObject>();
			AObj->SetStringField(TEXT("package"), AD.PackageName.ToString());
			AObj->SetStringField(TEXT("name"), AD.AssetName.ToString());
			AObj->SetStringField(TEXT("class"), AD.AssetClassPath.ToString());
			AssetArr.Add(MakeShared<FJsonValueObject>(AObj));
		}

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetArrayField(TEXT("assets"), AssetArr);
		Data->SetNumberField(TEXT("count"), ReturnCount);
		Data->SetNumberField(TEXT("total"), Total);

		SendResponse(BuildSuccessResponse(CorrId, Data));
	});

	// -----------------------------------------------------------------------
	// asset.references (EDT-06)
	// Trace both directions of hard asset references for a given package path.
	// Uses pre-indexed IAssetRegistry data — never loads an asset.
	// T-09-08: package_path field is validated before any registry call.
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("asset.references"), [](TSharedPtr<FJsonObject> Command, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Command.IsValid() ? Command->GetStringField(TEXT("correlationId")) : TEXT("");

		// Validate required field (T-09-08 mitigation).
		FString PackagePath;
		if (!Command.IsValid() || !Command->TryGetStringField(TEXT("package_path"), PackagePath) || PackagePath.IsEmpty())
		{
			SendResponse(BuildErrorResponse(CorrId, TEXT("missing_package_path")));
			return;
		}

		FAssetRegistryModule& ARModule = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry"));
		IAssetRegistry& AssetRegistry = ARModule.Get();

		// Dependencies: what this asset references (outgoing).
		TArray<FName> Dependencies;
		AssetRegistry.GetDependencies(FName(*PackagePath), Dependencies);

		// Referencers: what references this asset (incoming).
		TArray<FName> Referencers;
		AssetRegistry.GetReferencers(FName(*PackagePath), Referencers);

		// Convert FName arrays to JSON string arrays.
		TArray<TSharedPtr<FJsonValue>> DepArr;
		DepArr.Reserve(Dependencies.Num());
		for (const FName& Dep : Dependencies)
		{
			DepArr.Add(MakeShared<FJsonValueString>(Dep.ToString()));
		}

		TArray<TSharedPtr<FJsonValue>> RefArr;
		RefArr.Reserve(Referencers.Num());
		for (const FName& Ref : Referencers)
		{
			RefArr.Add(MakeShared<FJsonValueString>(Ref.ToString()));
		}

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetStringField(TEXT("package"), PackagePath);
		Data->SetArrayField(TEXT("dependencies"), DepArr);
		Data->SetArrayField(TEXT("referencers"), RefArr);
		Data->SetNumberField(TEXT("dependency_count"), Dependencies.Num());
		Data->SetNumberField(TEXT("referencer_count"), Referencers.Num());

		SendResponse(BuildSuccessResponse(CorrId, Data));
	});

	// -----------------------------------------------------------------------
	// level.layout (EDT-07)
	// Return placed actors grouped by sublevel, plus streaming level list
	// and world partition flag.
	// T-09-10 mitigation: uses TActorIterator (no asset loading) for actor data.
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("level.layout"), [](TSharedPtr<FJsonObject> Command, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Command.IsValid() ? Command->GetStringField(TEXT("correlationId")) : TEXT("");

		if (!GEditor)
		{
			SendResponse(BuildErrorResponse(CorrId, TEXT("no_editor")));
			return;
		}

		UWorld* World = GEditor->GetEditorWorldContext().World();
		if (!World)
		{
			SendResponse(BuildErrorResponse(CorrId, TEXT("no_world_open")));
			return;
		}

		// Collect streaming level info.
		TArray<TSharedPtr<FJsonValue>> StreamingArr;
		for (ULevelStreaming* SL : World->GetStreamingLevels())
		{
			if (!SL)
			{
				continue;
			}
			TSharedPtr<FJsonObject> LObj = MakeShared<FJsonObject>();
			LObj->SetStringField(TEXT("package"), SL->GetWorldAssetPackageName());
			LObj->SetBoolField(TEXT("loaded"), SL->IsLevelLoaded());
			StreamingArr.Add(MakeShared<FJsonValueObject>(LObj));
		}

		// World partition availability.
		UWorldPartition* WP = World->GetWorldPartition();
		const bool bHasWorldPartition = (WP != nullptr);

		// Collect placed actors from persistent level and all loaded streaming levels.
		// TActorIterator does not load assets -- safe per T-09-10 mitigation.
		TArray<TSharedPtr<FJsonValue>> ActorArr;
		for (TActorIterator<AActor> It(World, AActor::StaticClass()); It; ++It)
		{
			AActor* A = *It;
			if (!A)
			{
				continue;
			}

			// Skip internal default objects that UE places automatically.
			if (A->GetName().StartsWith(TEXT("Default_")))
			{
				continue;
			}

			TSharedPtr<FJsonObject> AObj = MakeShared<FJsonObject>();
			AObj->SetStringField(TEXT("label"), A->GetActorLabel());
			AObj->SetStringField(TEXT("class"), A->GetClass()->GetName());
			AObj->SetStringField(TEXT("id"), A->GetName());

			ULevel* Level = A->GetLevel();
			AObj->SetStringField(TEXT("sublevel"),
				Level ? Level->GetPackage()->GetName() : TEXT("persistent"));

			FVector Loc = A->GetActorLocation();
			TSharedPtr<FJsonObject> LocObj = MakeShared<FJsonObject>();
			LocObj->SetNumberField(TEXT("x"), Loc.X);
			LocObj->SetNumberField(TEXT("y"), Loc.Y);
			LocObj->SetNumberField(TEXT("z"), Loc.Z);
			AObj->SetObjectField(TEXT("location"), LocObj);

			ActorArr.Add(MakeShared<FJsonValueObject>(AObj));
		}

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetBoolField(TEXT("world_partition"), bHasWorldPartition);
		Data->SetArrayField(TEXT("streaming_levels"), StreamingArr);
		Data->SetArrayField(TEXT("actors"), ActorArr);
		Data->SetNumberField(TEXT("actor_count"), ActorArr.Num());

		SendResponse(BuildSuccessResponse(CorrId, Data));
	});

	// -----------------------------------------------------------------------
	// asset.createDataAsset
	// Creates a UPrimaryDataAsset (or subclass) in /Game/.
	// Payload: { asset_path, class_name, properties: { name: {value, type}, ... } }
	// Properties are set via UE reflection after creation.
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("asset.createDataAsset"), [](TSharedPtr<FJsonObject> Command, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Command.IsValid() ? Command->GetStringField(TEXT("correlationId")) : TEXT("");

		TSharedPtr<FJsonObject> Payload;
		const TSharedPtr<FJsonValue>* PayloadVal = Command->Values.Find(TEXT("payload"));
		if (PayloadVal && (*PayloadVal)->Type == EJson::Object)
		{
			Payload = (*PayloadVal)->AsObject();
		}

		FString AssetPath, ClassName;
		if (!Payload.IsValid()
			|| !Payload->TryGetStringField(TEXT("asset_path"), AssetPath)  || AssetPath.IsEmpty()
			|| !Payload->TryGetStringField(TEXT("class_name"), ClassName)  || ClassName.IsEmpty())
		{
			SendResponse(BuildErrorResponse(CorrId, TEXT("missing_asset_path_or_class")));
			return;
		}

		// Security: only allow /Game/ paths.
		if (!AssetPath.StartsWith(TEXT("/Game/")))
		{
			SendResponse(BuildErrorResponse(CorrId, TEXT("path_must_start_with_/Game/")));
			return;
		}

		// Resolve class by name.
		UClass* AssetClass = FindFirstObject<UClass>(*ClassName);
		if (!AssetClass)
		{
			AssetClass = FindFirstObject<UClass>(*(TEXT("U") + ClassName));
		}
		if (!AssetClass)
		{
			SendResponse(BuildErrorResponse(CorrId, TEXT("class_not_found")));
			return;
		}

		// Split AssetPath into package path and asset name.
		FString PackagePath, AssetName;
		AssetPath.Split(TEXT("/"), &PackagePath, &AssetName, ESearchCase::IgnoreCase, ESearchDir::FromEnd);
		if (PackagePath.IsEmpty() || AssetName.IsEmpty())
		{
			SendResponse(BuildErrorResponse(CorrId, TEXT("invalid_asset_path")));
			return;
		}

		// Check if the asset already exists (e.g. from a previous session that saved to disk).
		UObject* Existing = StaticFindObject(AssetClass, nullptr, *AssetPath);
		if (!Existing)
		{
			// Also check disk — LoadObject will find .uasset files from a prior save.
			Existing = LoadObject<UObject>(nullptr, *AssetPath);
		}
		if (Existing)
		{
			// Asset already exists — return success with existing path.
			TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
			Data->SetStringField(TEXT("path"), AssetPath);
			Data->SetStringField(TEXT("class"), ClassName);
			Data->SetBoolField(TEXT("created"), false);
			Data->SetBoolField(TEXT("already_exists"), true);
			SendResponse(BuildSuccessResponse(CorrId, Data));
			return;
		}

		UPackage* Package = CreatePackage(*AssetPath);
		if (!Package)
		{
			SendResponse(BuildErrorResponse(CorrId, TEXT("package_creation_failed")));
			return;
		}

		UObject* NewAsset = NewObject<UObject>(Package, AssetClass, FName(*AssetName), RF_Public | RF_Standalone);
		if (!NewAsset)
		{
			SendResponse(BuildErrorResponse(CorrId, TEXT("object_creation_failed")));
			return;
		}

		// Apply properties via reflection.
		const TSharedPtr<FJsonObject>* PropsObj;
		if (Payload->TryGetObjectField(TEXT("properties"), PropsObj))
		{
			for (const auto& Pair : (*PropsObj)->Values)
			{
				FProperty* Prop = AssetClass->FindPropertyByName(FName(*Pair.Key));
				if (!Prop) continue;

				void* ValPtr = Prop->ContainerPtrToValuePtr<void>(NewAsset);
				const TSharedPtr<FJsonObject>* PropDef;
				if (!Pair.Value->TryGetObject(PropDef)) continue;

				FString PropType;
				(*PropDef)->TryGetStringField(TEXT("type"), PropType);

				if (PropType == TEXT("name"))
				{
					FString Val; (*PropDef)->TryGetStringField(TEXT("value"), Val);
					if (FNameProperty* NP = CastField<FNameProperty>(Prop)) NP->SetPropertyValue(ValPtr, FName(*Val));
				}
				else if (PropType == TEXT("text"))
				{
					FString Val; (*PropDef)->TryGetStringField(TEXT("value"), Val);
					if (FTextProperty* TP = CastField<FTextProperty>(Prop)) TP->SetPropertyValue(ValPtr, FText::FromString(Val));
				}
				else if (PropType == TEXT("int"))
				{
					double Dbl = 0; (*PropDef)->TryGetNumberField(TEXT("value"), Dbl);
					if (FIntProperty* IP = CastField<FIntProperty>(Prop)) IP->SetPropertyValue(ValPtr, static_cast<int32>(Dbl));
				}
				else if (PropType == TEXT("byte"))
				{
					// For UENUM(uint8) properties — set by numeric value.
					double Dbl = 0; (*PropDef)->TryGetNumberField(TEXT("value"), Dbl);
					if (FByteProperty* BP = CastField<FByteProperty>(Prop))
					{
						BP->SetPropertyValue(ValPtr, static_cast<uint8>(Dbl));
					}
					else if (FEnumProperty* EP = CastField<FEnumProperty>(Prop))
					{
						FNumericProperty* UnderlyingProp = EP->GetUnderlyingProperty();
						if (UnderlyingProp)
						{
							UnderlyingProp->SetIntPropertyValue(ValPtr, static_cast<int64>(Dbl));
						}
					}
				}
				else if (PropType == TEXT("string"))
				{
					FString Val; (*PropDef)->TryGetStringField(TEXT("value"), Val);
					if (FStrProperty* SP = CastField<FStrProperty>(Prop)) SP->SetPropertyValue(ValPtr, Val);
				}
			}
		}

		// Notify asset registry.
		FAssetRegistryModule::AssetCreated(NewAsset);
		NewAsset->MarkPackageDirty();
		Package->SetDirtyFlag(true);

		// Save to disk — ensure parent directory exists first.
		bool bSaved = false;
		FString FilePath = FPackageName::LongPackageNameToFilename(AssetPath, FPackageName::GetAssetPackageExtension());
		FString FileDir = FPaths::GetPath(FilePath);
		IFileManager::Get().MakeDirectory(*FileDir, true);

		FSavePackageArgs SaveArgs;
		SaveArgs.TopLevelFlags = RF_Public | RF_Standalone;
		bSaved = UPackage::SavePackage(Package, NewAsset, *FilePath, SaveArgs);

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetStringField(TEXT("path"), AssetPath);
		Data->SetStringField(TEXT("class"), ClassName);
		Data->SetBoolField(TEXT("created"), true);
		Data->SetBoolField(TEXT("saved_to_disk"), bSaved);

		SendResponse(BuildSuccessResponse(CorrId, Data));
	});

	// -----------------------------------------------------------------------
	// asset.createCurve
	// Creates a UCurveFloat asset with keyframes.
	// Payload: { asset_path, keys: [ {time, value, interp?}, ... ] }
	// interp: "linear"|"cubic"|"constant" (default: "cubic" for ease-in-out)
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("asset.createCurve"), [](TSharedPtr<FJsonObject> Command, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Command.IsValid() ? Command->GetStringField(TEXT("correlationId")) : TEXT("");

		TSharedPtr<FJsonObject> Payload;
		const TSharedPtr<FJsonValue>* PayloadVal = Command->Values.Find(TEXT("payload"));
		if (PayloadVal && (*PayloadVal)->Type == EJson::Object)
		{
			Payload = (*PayloadVal)->AsObject();
		}

		FString AssetPath;
		if (!Payload.IsValid() || !Payload->TryGetStringField(TEXT("asset_path"), AssetPath) || AssetPath.IsEmpty())
		{
			SendResponse(BuildErrorResponse(CorrId, TEXT("missing_asset_path")));
			return;
		}

		if (!AssetPath.StartsWith(TEXT("/Game/")))
		{
			SendResponse(BuildErrorResponse(CorrId, TEXT("path_must_start_with_/Game/")));
			return;
		}

		// Split path.
		FString PackagePath, AssetName;
		AssetPath.Split(TEXT("/"), &PackagePath, &AssetName, ESearchCase::IgnoreCase, ESearchDir::FromEnd);

		// Check if the curve already exists.
		UObject* Existing = StaticFindObject(UCurveFloat::StaticClass(), nullptr, *AssetPath);
		if (!Existing)
		{
			Existing = LoadObject<UCurveFloat>(nullptr, *AssetPath);
		}
		if (Existing)
		{
			TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
			Data->SetStringField(TEXT("path"), AssetPath);
			Data->SetBoolField(TEXT("created"), false);
			Data->SetBoolField(TEXT("already_exists"), true);
			SendResponse(BuildSuccessResponse(CorrId, Data));
			return;
		}

		UPackage* Package = CreatePackage(*AssetPath);
		if (!Package)
		{
			SendResponse(BuildErrorResponse(CorrId, TEXT("package_creation_failed")));
			return;
		}

		UCurveFloat* Curve = NewObject<UCurveFloat>(Package, FName(*AssetName), RF_Public | RF_Standalone);
		if (!Curve)
		{
			SendResponse(BuildErrorResponse(CorrId, TEXT("curve_creation_failed")));
			return;
		}

		// Add keyframes from the "keys" array.
		const TArray<TSharedPtr<FJsonValue>>* KeysArray;
		if (Payload->TryGetArrayField(TEXT("keys"), KeysArray))
		{
			FRichCurve& RichCurve = Curve->FloatCurve;
			for (const auto& KeyVal : *KeysArray)
			{
				const TSharedPtr<FJsonObject>* KeyObj;
				if (!KeyVal->TryGetObject(KeyObj)) continue;

				double Time = 0.0, Value = 0.0;
				(*KeyObj)->TryGetNumberField(TEXT("time"), Time);
				(*KeyObj)->TryGetNumberField(TEXT("value"), Value);

				FString Interp = TEXT("cubic");
				(*KeyObj)->TryGetStringField(TEXT("interp"), Interp);

				ERichCurveInterpMode InterpMode = RCIM_Cubic;
				if (Interp == TEXT("linear"))   InterpMode = RCIM_Linear;
				else if (Interp == TEXT("constant")) InterpMode = RCIM_Constant;

				FKeyHandle Handle = RichCurve.AddKey(static_cast<float>(Time), static_cast<float>(Value));
				RichCurve.SetKeyInterpMode(Handle, InterpMode);

				if (InterpMode == RCIM_Cubic)
				{
					RichCurve.SetKeyTangentMode(Handle, RCTM_Auto);
				}
			}
			RichCurve.AutoSetTangents();
		}

		FAssetRegistryModule::AssetCreated(Curve);
		Curve->MarkPackageDirty();
		Package->SetDirtyFlag(true);

		// Save to disk.
		bool bSaved = false;
		FString FilePath = FPackageName::LongPackageNameToFilename(AssetPath, FPackageName::GetAssetPackageExtension());
		FString FileDir = FPaths::GetPath(FilePath);
		IFileManager::Get().MakeDirectory(*FileDir, true);

		FSavePackageArgs SaveArgs;
		SaveArgs.TopLevelFlags = RF_Public | RF_Standalone;
		bSaved = UPackage::SavePackage(Package, Curve, *FilePath, SaveArgs);

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetStringField(TEXT("path"), AssetPath);
		Data->SetNumberField(TEXT("key_count"), KeysArray ? KeysArray->Num() : 0);
		Data->SetBoolField(TEXT("created"), true);

		SendResponse(BuildSuccessResponse(CorrId, Data));
	});
}
