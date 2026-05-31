// MCPMaterialCommands.cpp
// Implements four material command handlers for the MCP bridge:
//   material.params         -- list scalar/vector/texture parameters of a UMaterialInterface (MAT-01)
//   material.createInstance -- create a UMaterialInstanceConstant from a parent material (MAT-02)
//   material.setParam       -- apply a parameter override to a MIC (MAT-03)
//   material.actorMaterials -- list material paths used by an actor or static mesh asset (MAT-04)
//
// All handlers run on the game thread (guaranteed by FMCPCommandRouter::Dispatch).
// Threat mitigations applied:
//   T-15-01: param_type uses explicit allowlist; only "scalar"/"vector"/"texture" accepted.
//   T-15-02: instance_path validated to start with "/Game/"; engine asset overwrite prevented.
//   T-15-04: texture StaticLoadObject null-checked before SetTextureParameterValue.

#include "MCPMaterialCommands.h"

#include "Editor.h"
#include "Engine/World.h"
#include "GameFramework/Actor.h"
#include "EngineUtils.h"
#include "Materials/MaterialInterface.h"
#include "Materials/MaterialInstanceConstant.h"
#include "MaterialEditingLibrary.h"
#include "Components/PrimitiveComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/StaticMesh.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Returns a JSON success response string (without trailing newline). */
static FString BuildMatSuccessResponse(const FString& CorrId, TSharedPtr<FJsonObject> Data)
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
static FString BuildMatErrorResponse(const FString& CorrId, const FString& Error)
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

// ---------------------------------------------------------------------------
// RegisterMaterialCommands
// ---------------------------------------------------------------------------

void RegisterMaterialCommands(FMCPCommandRouter& Router)
{
	// -----------------------------------------------------------------------
	// material.params (MAT-01)
	// Reads all scalar, vector, and texture parameters from a UMaterialInterface.
	// Works on base materials and any instance type.
	//
	// Payload field:
	//   asset_path  string (required) -- e.g., "/Game/Materials/M_Rock"
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("material.params"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
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
			SendResponse(BuildMatErrorResponse(CorrId, TEXT("missing_asset_path")) + TEXT("\n"));
			return;
		}

		// Load the material interface asset.
		UMaterialInterface* MatIface = Cast<UMaterialInterface>(
			StaticLoadObject(UMaterialInterface::StaticClass(), nullptr, *AssetPath));
		if (!MatIface)
		{
			SendResponse(BuildMatErrorResponse(CorrId, TEXT("material_not_found")) + TEXT("\n"));
			return;
		}

		// Collect parameter names by type.
		TArray<FName> ScalarNames;
		TArray<FName> VectorNames;
		TArray<FName> TextureNames;
		UMaterialEditingLibrary::GetScalarParameterNames(MatIface, ScalarNames);
		UMaterialEditingLibrary::GetVectorParameterNames(MatIface, VectorNames);
		UMaterialEditingLibrary::GetTextureParameterNames(MatIface, TextureNames);

		// Build the parameters JSON array.
		TArray<TSharedPtr<FJsonValue>> ParamsArray;

		// Scalar parameters.
		for (const FName& Name : ScalarNames)
		{
			float OutFloat = 0.0f;
			UMaterialEditingLibrary::GetScalarParameterValue(MatIface, Name, OutFloat);

			TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
			Entry->SetStringField(TEXT("name"), Name.ToString());
			Entry->SetStringField(TEXT("type"), TEXT("scalar"));
			Entry->SetNumberField(TEXT("value"), static_cast<double>(OutFloat));
			Entry->SetNumberField(TEXT("default_value"), static_cast<double>(OutFloat));
			ParamsArray.Add(MakeShared<FJsonValueObject>(Entry));
		}

		// Vector parameters.
		for (const FName& Name : VectorNames)
		{
			FLinearColor OutColor(ForceInitToZero);
			UMaterialEditingLibrary::GetVectorParameterValue(MatIface, Name, OutColor);

			TSharedPtr<FJsonObject> ColorObj = MakeShared<FJsonObject>();
			ColorObj->SetNumberField(TEXT("r"), static_cast<double>(OutColor.R));
			ColorObj->SetNumberField(TEXT("g"), static_cast<double>(OutColor.G));
			ColorObj->SetNumberField(TEXT("b"), static_cast<double>(OutColor.B));
			ColorObj->SetNumberField(TEXT("a"), static_cast<double>(OutColor.A));

			// Clone for default_value (same effective value for both).
			TSharedPtr<FJsonObject> DefaultColorObj = MakeShared<FJsonObject>();
			DefaultColorObj->SetNumberField(TEXT("r"), static_cast<double>(OutColor.R));
			DefaultColorObj->SetNumberField(TEXT("g"), static_cast<double>(OutColor.G));
			DefaultColorObj->SetNumberField(TEXT("b"), static_cast<double>(OutColor.B));
			DefaultColorObj->SetNumberField(TEXT("a"), static_cast<double>(OutColor.A));

			TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
			Entry->SetStringField(TEXT("name"), Name.ToString());
			Entry->SetStringField(TEXT("type"), TEXT("vector"));
			Entry->SetObjectField(TEXT("value"), ColorObj);
			Entry->SetObjectField(TEXT("default_value"), DefaultColorObj);
			ParamsArray.Add(MakeShared<FJsonValueObject>(Entry));
		}

		// Texture parameters.
		for (const FName& Name : TextureNames)
		{
			UTexture* OutTexture = nullptr;
			UMaterialEditingLibrary::GetTextureParameterValue(MatIface, Name, OutTexture);

			const FString TexPath = OutTexture ? OutTexture->GetPathName() : FString(TEXT(""));

			TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
			Entry->SetStringField(TEXT("name"), Name.ToString());
			Entry->SetStringField(TEXT("type"), TEXT("texture"));
			Entry->SetStringField(TEXT("value"), TexPath);
			Entry->SetStringField(TEXT("default_value"), TexPath);
			ParamsArray.Add(MakeShared<FJsonValueObject>(Entry));
		}

		// Build response data.
		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetStringField(TEXT("asset_path"), AssetPath);
		Data->SetArrayField(TEXT("parameters"), ParamsArray);

		SendResponse(BuildMatSuccessResponse(CorrId, Data) + TEXT("\n"));
	});

	// -----------------------------------------------------------------------
	// material.createInstance (MAT-02)
	// Creates a new Material Instance Constant asset from a parent material.
	// Persistent asset (saved to disk), not a runtime dynamic instance.
	//
	// Payload fields:
	//   parent_path    string (required) -- asset path of parent UMaterialInterface
	//   instance_path  string (required) -- package directory for the new instance (must start with /Game/)
	//   instance_name  string (required) -- asset name portion, e.g. "MI_Rock_Red"
	//
	// Threat T-15-02: instance_path validated to start with "/Game/".
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("material.createInstance"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

		// Extract payload.
		TSharedPtr<FJsonObject> Payload;
		const TSharedPtr<FJsonValue>* PayloadVal = Cmd->Values.Find(TEXT("payload"));
		if (PayloadVal && (*PayloadVal)->Type == EJson::Object)
		{
			Payload = (*PayloadVal)->AsObject();
		}

		// Require all three fields.
		FString ParentPath;
		FString InstancePath;
		FString InstanceName;

		const bool bHasParent   = Payload.IsValid() && Payload->TryGetStringField(TEXT("parent_path"),   ParentPath)   && !ParentPath.IsEmpty();
		const bool bHasInstPath = Payload.IsValid() && Payload->TryGetStringField(TEXT("instance_path"), InstancePath) && !InstancePath.IsEmpty();
		const bool bHasInstName = Payload.IsValid() && Payload->TryGetStringField(TEXT("instance_name"), InstanceName) && !InstanceName.IsEmpty();

		if (!bHasParent || !bHasInstPath || !bHasInstName)
		{
			SendResponse(BuildMatErrorResponse(CorrId, TEXT("missing_required_fields")) + TEXT("\n"));
			return;
		}

		// Threat T-15-02: Validate instance_path starts with "/Game/" to prevent overwriting engine assets.
		if (!InstancePath.StartsWith(TEXT("/Game/")))
		{
			SendResponse(BuildMatErrorResponse(CorrId, TEXT("invalid_instance_path: must start with /Game/")) + TEXT("\n"));
			return;
		}

		// Load parent material.
		UMaterialInterface* Parent = Cast<UMaterialInterface>(
			StaticLoadObject(UMaterialInterface::StaticClass(), nullptr, *ParentPath));
		if (!Parent)
		{
			SendResponse(BuildMatErrorResponse(CorrId, TEXT("parent_material_not_found")) + TEXT("\n"));
			return;
		}

		// Create the material instance asset.
		// UMaterialEditingLibrary::CreateMaterialInstanceAsset(ParentMaterial, Name, PackagePath)
		// PackagePath is the directory (e.g., "/Game/Materials"), Name is the asset name.
		UMaterialInstanceConstant* NewInst = Cast<UMaterialInstanceConstant>(
			UMaterialEditingLibrary::CreateMaterialInstanceAsset(Parent, InstanceName, InstancePath));

		if (!NewInst)
		{
			SendResponse(BuildMatErrorResponse(CorrId, TEXT("create_instance_failed")) + TEXT("\n"));
			return;
		}

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetStringField(TEXT("instance_path"), NewInst->GetPathName());
		Data->SetStringField(TEXT("parent_path"), ParentPath);
		Data->SetBoolField(TEXT("success"), true);

		SendResponse(BuildMatSuccessResponse(CorrId, Data) + TEXT("\n"));
	});

	// -----------------------------------------------------------------------
	// material.setParam (MAT-03)
	// Sets a single parameter override (scalar, vector, or texture) on a
	// Material Instance Constant. Calls Modify() before any change so UE undo
	// history is preserved, and PostEditChange() after to notify the editor.
	//
	// Payload fields:
	//   asset_path   string (required) -- path to UMaterialInstanceConstant
	//   param_name   string (required) -- parameter name
	//   param_type   string (required) -- "scalar", "vector", or "texture"
	//   value        varies            -- float for scalar; {r,g,b,a} for vector; string path for texture
	//
	// Threat T-15-01: param_type uses explicit allowlist.
	// Threat T-15-04: texture null-checked before SetTextureParameterValue.
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("material.setParam"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

		// Extract payload.
		TSharedPtr<FJsonObject> Payload;
		const TSharedPtr<FJsonValue>* PayloadVal = Cmd->Values.Find(TEXT("payload"));
		if (PayloadVal && (*PayloadVal)->Type == EJson::Object)
		{
			Payload = (*PayloadVal)->AsObject();
		}

		// Require asset_path, param_name, param_type.
		FString AssetPath;
		FString ParamName;
		FString ParamType;

		const bool bHasAsset     = Payload.IsValid() && Payload->TryGetStringField(TEXT("asset_path"),  AssetPath)  && !AssetPath.IsEmpty();
		const bool bHasParamName = Payload.IsValid() && Payload->TryGetStringField(TEXT("param_name"),  ParamName)  && !ParamName.IsEmpty();
		const bool bHasParamType = Payload.IsValid() && Payload->TryGetStringField(TEXT("param_type"),  ParamType)  && !ParamType.IsEmpty();

		if (!bHasAsset || !bHasParamName || !bHasParamType)
		{
			SendResponse(BuildMatErrorResponse(CorrId, TEXT("missing_required_fields")) + TEXT("\n"));
			return;
		}

		// Threat T-15-01: Explicit allowlist for param_type.
		const bool bIsScalar  = (ParamType == TEXT("scalar"));
		const bool bIsVector  = (ParamType == TEXT("vector"));
		const bool bIsTexture = (ParamType == TEXT("texture"));

		if (!bIsScalar && !bIsVector && !bIsTexture)
		{
			SendResponse(BuildMatErrorResponse(CorrId, TEXT("invalid_param_type")) + TEXT("\n"));
			return;
		}

		// Load the material instance constant.
		UMaterialInstanceConstant* MIC = Cast<UMaterialInstanceConstant>(
			StaticLoadObject(UMaterialInstanceConstant::StaticClass(), nullptr, *AssetPath));
		if (!MIC)
		{
			SendResponse(BuildMatErrorResponse(CorrId, TEXT("material_instance_not_found")) + TEXT("\n"));
			return;
		}

		// Modify() before any state change -- preserves UE undo history (non-negotiable).
		MIC->Modify();

		if (bIsScalar)
		{
			double Val = 0.0;
			if (Payload->TryGetNumberField(TEXT("value"), Val))
			{
				UMaterialEditingLibrary::SetScalarParameterValue(MIC, FName(*ParamName), static_cast<float>(Val));
			}
		}
		else if (bIsVector)
		{
			const TSharedPtr<FJsonObject>* ValObj;
			if (Payload->TryGetObjectField(TEXT("value"), ValObj))
			{
				double R = 0.0, G = 0.0, B = 0.0, A = 1.0;
				(*ValObj)->TryGetNumberField(TEXT("r"), R);
				(*ValObj)->TryGetNumberField(TEXT("g"), G);
				(*ValObj)->TryGetNumberField(TEXT("b"), B);
				(*ValObj)->TryGetNumberField(TEXT("a"), A);
				UMaterialEditingLibrary::SetVectorParameterValue(
					MIC, FName(*ParamName), FLinearColor(
						static_cast<float>(R),
						static_cast<float>(G),
						static_cast<float>(B),
						static_cast<float>(A)));
			}
		}
		else // bIsTexture
		{
			FString TexPath;
			if (Payload->TryGetStringField(TEXT("value"), TexPath) && !TexPath.IsEmpty())
			{
				// Threat T-15-04: null-check before calling SetTextureParameterValue.
				UTexture* Tex = Cast<UTexture>(
					StaticLoadObject(UTexture::StaticClass(), nullptr, *TexPath));
				if (!Tex)
				{
					SendResponse(BuildMatErrorResponse(CorrId, TEXT("texture_not_found")) + TEXT("\n"));
					return;
				}
				UMaterialEditingLibrary::SetTextureParameterValue(MIC, FName(*ParamName), Tex);
			}
		}

		// Notify the editor of the change.
		MIC->PostEditChange();

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetStringField(TEXT("asset_path"),  AssetPath);
		Data->SetStringField(TEXT("param_name"),  ParamName);
		Data->SetStringField(TEXT("param_type"),  ParamType);
		Data->SetBoolField(TEXT("applied"), true);

		SendResponse(BuildMatSuccessResponse(CorrId, Data) + TEXT("\n"));
	});

	// -----------------------------------------------------------------------
	// material.actorMaterials (MAT-04)
	// Lists all material asset paths used by an actor (via primitive components)
	// or a static mesh asset. Returns unique paths with a count.
	//
	// Payload fields (at least one required):
	//   actor_label  string (optional) -- name of actor in the open level
	//   asset_path   string (optional) -- path to a UStaticMesh asset
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("material.actorMaterials"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
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
		FString AssetPathStr;

		const bool bHasActorLabel = Payload.IsValid() && Payload->TryGetStringField(TEXT("actor_label"), ActorLabel) && !ActorLabel.IsEmpty();
		const bool bHasAssetPath  = Payload.IsValid() && Payload->TryGetStringField(TEXT("asset_path"),  AssetPathStr) && !AssetPathStr.IsEmpty();

		if (!bHasActorLabel && !bHasAssetPath)
		{
			SendResponse(BuildMatErrorResponse(CorrId, TEXT("missing_actor_label_or_asset_path")) + TEXT("\n"));
			return;
		}

		TArray<FString> MaterialPaths;

		if (bHasActorLabel)
		{
			// Actor path: find actor by label in the open world.
			if (!GEditor)
			{
				SendResponse(BuildMatErrorResponse(CorrId, TEXT("no_world_open")) + TEXT("\n"));
				return;
			}

			UWorld* World = GEditor->GetEditorWorldContext().World();
			if (!World)
			{
				SendResponse(BuildMatErrorResponse(CorrId, TEXT("no_world_open")) + TEXT("\n"));
				return;
			}

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
				SendResponse(BuildMatErrorResponse(CorrId, TEXT("actor_not_found")) + TEXT("\n"));
				return;
			}

			// Collect materials from all primitive components.
			TArray<UPrimitiveComponent*> Components;
			FoundActor->GetComponents<UPrimitiveComponent>(Components);

			TSet<FString> Unique;
			for (UPrimitiveComponent* Comp : Components)
			{
				if (!Comp)
				{
					continue;
				}
				TArray<UMaterialInterface*> Mats = Comp->GetMaterials();
				for (UMaterialInterface* Mat : Mats)
				{
					if (Mat)
					{
						Unique.Add(Mat->GetPathName());
					}
				}
			}

			MaterialPaths = Unique.Array();
		}
		else
		{
			// Static mesh asset path.
			UStaticMesh* Mesh = Cast<UStaticMesh>(
				StaticLoadObject(UStaticMesh::StaticClass(), nullptr, *AssetPathStr));
			if (!Mesh)
			{
				SendResponse(BuildMatErrorResponse(CorrId, TEXT("static_mesh_not_found")) + TEXT("\n"));
				return;
			}

			const TArray<FStaticMaterial>& StaticMats = Mesh->GetStaticMaterials();
			TSet<FString> Unique;
			for (const FStaticMaterial& Entry : StaticMats)
			{
				if (Entry.MaterialInterface)
				{
					Unique.Add(Entry.MaterialInterface->GetPathName());
				}
				else
				{
					Unique.Add(FString(TEXT("")));
				}
			}
			MaterialPaths = Unique.Array();
		}

		// Build response data.
		TArray<TSharedPtr<FJsonValue>> MatArray;
		for (const FString& Path : MaterialPaths)
		{
			MatArray.Add(MakeShared<FJsonValueString>(Path));
		}

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetArrayField(TEXT("materials"), MatArray);
		Data->SetNumberField(TEXT("count"), static_cast<double>(MaterialPaths.Num()));

		SendResponse(BuildMatSuccessResponse(CorrId, Data) + TEXT("\n"));
	});
}
