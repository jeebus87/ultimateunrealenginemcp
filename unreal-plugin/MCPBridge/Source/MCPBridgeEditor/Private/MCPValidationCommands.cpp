// MCPValidationCommands.cpp
// Implements validate.asset, validate.folder, validate.project, validate.blueprint
// command handlers for the MCPBridge editor plugin.
// All handlers are registered on the FMCPCommandRouter and run on the game thread
// (enforced by FMCPCommandRouter::Dispatch via AsyncTask).
//
// Reflection conversion (Phase 33):
//   The DataValidation module is optional. Rather than #include "EditorValidatorSubsystem.h",
//   we use FModuleManager::IsModuleLoaded("DataValidation") at runtime, then access the
//   subsystem via FindObject<UClass> + GEditor->GetEditorSubsystemBase, and call
//   ValidateAssetsWithSettings via ProcessEvent with struct params allocated on the heap.
//
// Security mitigations per threat model (T-33-01, T-16-01 through T-16-02):
//   T-33-01 / T-16-01: asset_path validated via FPackageName::IsValidLongPackageName()
//             before any IAssetRegistry or LoadObject call -- rejects traversal and bare paths
//   T-33-02 / T-16-02: Named error codes returned (e.g., "asset_not_found"), never raw UE internal strings;
//             BP->ErrorMessage is user-authored content and is safe to surface

#include "MCPValidationCommands.h"
#include "ReflectionHelpers.h"
#include "MCPCommandRouter.h"

// Blueprint APIs (core Engine module -- always available)
#include "Engine/Blueprint.h"
#include "Kismet2/KismetEditorUtilities.h"

// Asset Registry APIs (core -- always available)
#include "AssetRegistry/AssetRegistryModule.h"
#include "AssetRegistry/IAssetRegistry.h"

// Package path utilities (core -- always available)
#include "Misc/PackageName.h"

// JSON APIs (core -- always available)
#include "Dom/JsonObject.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"

// Editor (core -- always available)
#include "Editor.h"

// Reflection APIs for calling DataValidation types at runtime
#include "UObject/Class.h"
#include "UObject/UObjectGlobals.h"

// ---------------------------------------------------------------------------
// Internal: call ValidateAssetsWithSettings via ProcessEvent (no optional include)
// ---------------------------------------------------------------------------
//
// FValidateAssetsSettings struct layout (DataValidation module, UE 5.7):
//   bool bSkipExcludedDirectories  (default: true)
//   bool bShowIfNoFailures          (default: true)
//   uint8 ValidationUsecase        (EDataValidationUsecase enum, Script=3)
//
// FValidateAssetsResults struct layout:
//   int32 NumRequested
//   int32 NumChecked
//   int32 NumValid
//   int32 NumInvalid
//   int32 NumWarnings
//   int32 NumUnableToValidate
//
// We allocate these structs via FindObject<UScriptStruct> + FMemory::Malloc + InitializeValue,
// set fields via reflection, call the function via ProcessEvent, then read results.
//
// ---------------------------------------------------------------------------

namespace
{
	// EDataValidationUsecase::Script is 3 in UE 5.7
	static const uint8 EDataValidationUsecase_Script = 3;

	/**
	 * Perform asset validation via reflection.
	 * Returns true on success and populates the result fields.
	 * Returns false with an error description if the subsystem is unavailable.
	 */
	struct FValidationResult
	{
		bool bSuccess = false;
		FString ErrorCode;
		int32 NumRequested = 0;
		int32 NumValid = 0;
		int32 NumInvalid = 0;
		int32 NumWarnings = 0;
		int32 NumUnableToValidate = 0;
	};

	static FValidationResult RunValidation(const TArray<FAssetData>& Assets)
	{
		FValidationResult Out;

		// Find subsystem class via reflection.
		UClass* ValidatorClass = MCPReflect::FindClassByPath(
			TEXT("/Script/DataValidation.EditorValidatorSubsystem"));
		if (!ValidatorClass)
		{
			Out.ErrorCode = TEXT("datavalidation_not_available");
			return Out;
		}

		// Get the subsystem instance.
		if (!GEditor)
		{
			Out.ErrorCode = TEXT("no_editor");
			return Out;
		}

		UObject* SubsystemObj = GEditor->GetEditorSubsystemBase(ValidatorClass);
		if (!SubsystemObj)
		{
			Out.ErrorCode = TEXT("validator_not_available");
			return Out;
		}

		// Locate the UScriptStructs for the params and results.
		UScriptStruct* SettingsStruct = FindObject<UScriptStruct>(
			nullptr, TEXT("/Script/DataValidation.ValidateAssetsSettings"));
		UScriptStruct* ResultsStruct = FindObject<UScriptStruct>(
			nullptr, TEXT("/Script/DataValidation.ValidateAssetsResults"));
		if (!SettingsStruct || !ResultsStruct)
		{
			Out.ErrorCode = TEXT("datavalidation_structs_not_found");
			return Out;
		}

		// Locate the function to call.
		UFunction* ValidateFunc = SubsystemObj->FindFunction(TEXT("ValidateAssetsWithSettings"));
		if (!ValidateFunc)
		{
			Out.ErrorCode = TEXT("validate_function_not_found");
			return Out;
		}

		// Allocate and initialize FValidateAssetsSettings on the heap.
		const int32 SettingsSize = SettingsStruct->GetStructureSize();
		void* SettingsData = FMemory::Malloc(SettingsSize, SettingsStruct->GetMinAlignment());
		SettingsStruct->InitializeStruct(SettingsData);

		// Set bSkipExcludedDirectories = true
		if (FBoolProperty* SkipProp = CastField<FBoolProperty>(
				SettingsStruct->FindPropertyByName(TEXT("bSkipExcludedDirectories"))))
		{
			SkipProp->SetPropertyValue(
				SkipProp->ContainerPtrToValuePtr<void>(SettingsData), true);
		}

		// Set bShowIfNoFailures = false
		if (FBoolProperty* ShowProp = CastField<FBoolProperty>(
				SettingsStruct->FindPropertyByName(TEXT("bShowIfNoFailures"))))
		{
			ShowProp->SetPropertyValue(
				ShowProp->ContainerPtrToValuePtr<void>(SettingsData), false);
		}

		// Set ValidationUsecase = Script (3) via byte/enum property
		if (FProperty* UsecastProp = SettingsStruct->FindPropertyByName(TEXT("ValidationUsecase")))
		{
			if (FByteProperty* ByteProp = CastField<FByteProperty>(UsecastProp))
			{
				ByteProp->SetPropertyValue(
					ByteProp->ContainerPtrToValuePtr<void>(SettingsData),
					EDataValidationUsecase_Script);
			}
			else if (FEnumProperty* EnumProp = CastField<FEnumProperty>(UsecastProp))
			{
				// For uint8 enum underlying property
				FNumericProperty* UnderlyingProp = EnumProp->GetUnderlyingProperty();
				if (UnderlyingProp)
				{
					UnderlyingProp->SetIntPropertyValue(
						EnumProp->ContainerPtrToValuePtr<void>(SettingsData),
						static_cast<int64>(EDataValidationUsecase_Script));
				}
			}
		}

		// Allocate and initialize FValidateAssetsResults.
		const int32 ResultsSize = ResultsStruct->GetStructureSize();
		void* ResultsData = FMemory::Malloc(ResultsSize, ResultsStruct->GetMinAlignment());
		ResultsStruct->InitializeStruct(ResultsData);

		// Build the ProcessEvent params block.
		// ValidateAssetsWithSettings(const TArray<FAssetData>& InAssets,
		//                            const FValidateAssetsSettings& InSettings,
		//                            FValidateAssetsResults& OutResults)
		//
		// ProcessEvent passes params as a contiguous block in function param order.
		// For UHT-generated UFUNCTION with value/const-ref params, we allocate a params
		// struct matching the function's Parms layout. The safest approach for this
		// reflection call is to construct the params buffer using the UFunction layout.

		// Allocate function params buffer.
		const int32 ParmsSize = ValidateFunc->ParmsSize;
		void* ParmsData = (ParmsSize > 0)
			? FMemory::Malloc(ParmsSize, ValidateFunc->GetMinAlignment())
			: nullptr;

		if (ParmsData && ParmsSize > 0)
		{
			FMemory::Memzero(ParmsData, ParmsSize);

			// Initialize each parameter via its FProperty metadata.
			for (TFieldIterator<FProperty> ParamIt(ValidateFunc); ParamIt; ++ParamIt)
			{
				FProperty* Param = *ParamIt;
				if (Param->HasAnyPropertyFlags(CPF_Parm) && !Param->HasAnyPropertyFlags(CPF_ReturnParm))
				{
					Param->InitializeValue_InContainer(ParmsData);
				}
			}

			// Locate the Assets, Settings, and Results params by name and copy values.
			for (TFieldIterator<FProperty> ParamIt(ValidateFunc); ParamIt; ++ParamIt)
			{
				FProperty* Param = *ParamIt;
				const FName ParamName = Param->GetFName();

				if (ParamName == TEXT("InAssets") || ParamName == TEXT("Assets"))
				{
					// TArray<FAssetData> parameter -- copy via FArrayProperty
					if (FArrayProperty* ArrayProp = CastField<FArrayProperty>(Param))
					{
						void* ArrayPtr = Param->ContainerPtrToValuePtr<void>(ParmsData);
						FScriptArrayHelper ArrayHelper(ArrayProp, ArrayPtr);
						ArrayHelper.Resize(Assets.Num());
						for (int32 Idx = 0; Idx < Assets.Num(); ++Idx)
						{
							// Copy each FAssetData element.
							void* ElemPtr = ArrayHelper.GetRawPtr(Idx);
							FMemory::Memcpy(ElemPtr, &Assets[Idx], ArrayProp->Inner->GetSize());
						}
					}
				}
				else if (ParamName == TEXT("InSettings") || ParamName == TEXT("Settings"))
				{
					// FValidateAssetsSettings -- copy struct bytes
					if (FStructProperty* StructProp = CastField<FStructProperty>(Param))
					{
						void* ParamPtr = Param->ContainerPtrToValuePtr<void>(ParmsData);
						FMemory::Memcpy(ParamPtr, SettingsData, FMath::Min(
							StructProp->Struct->GetStructureSize(), SettingsSize));
					}
				}
				// OutResults is an output param -- zero-initialized above, will be
				// written by the function.
			}

			// Call the function.
			SubsystemObj->ProcessEvent(ValidateFunc, ParmsData);

			// Read results back from the OutResults/Results parameter.
			for (TFieldIterator<FProperty> ParamIt(ValidateFunc); ParamIt; ++ParamIt)
			{
				FProperty* Param = *ParamIt;
				const FName ParamName = Param->GetFName();

				if (ParamName == TEXT("OutResults") || ParamName == TEXT("Results"))
				{
					if (FStructProperty* StructProp = CastField<FStructProperty>(Param))
					{
						void* ResultPtr = Param->ContainerPtrToValuePtr<void>(ParmsData);
						UScriptStruct* RS = StructProp->Struct;

						auto ReadInt32 = [&](FName FieldName) -> int32
						{
							if (FIntProperty* IP = CastField<FIntProperty>(RS->FindPropertyByName(FieldName)))
							{
								return IP->GetPropertyValue(IP->ContainerPtrToValuePtr<void>(ResultPtr));
							}
							return 0;
						};

						Out.NumRequested        = ReadInt32(TEXT("NumRequested"));
						Out.NumValid            = ReadInt32(TEXT("NumValid"));
						Out.NumInvalid          = ReadInt32(TEXT("NumInvalid"));
						Out.NumWarnings         = ReadInt32(TEXT("NumWarnings"));
						Out.NumUnableToValidate = ReadInt32(TEXT("NumUnableToValidate"));
					}
					break;
				}
			}

			// Destroy params.
			for (TFieldIterator<FProperty> ParamIt(ValidateFunc); ParamIt; ++ParamIt)
			{
				FProperty* Param = *ParamIt;
				if (Param->HasAnyPropertyFlags(CPF_Parm) && !Param->HasAnyPropertyFlags(CPF_ReturnParm))
				{
					Param->DestroyValue_InContainer(ParmsData);
				}
			}

			FMemory::Free(ParmsData);
		}

		// Free settings/results structs.
		SettingsStruct->DestroyStruct(SettingsData);
		FMemory::Free(SettingsData);
		ResultsStruct->DestroyStruct(ResultsData);
		FMemory::Free(ResultsData);

		Out.bSuccess = true;
		return Out;
	}

} // anonymous namespace

// ---------------------------------------------------------------------------
// RegisterValidationCommands
// ---------------------------------------------------------------------------

void RegisterValidationCommands(FMCPCommandRouter& Router)
{
	// Shared response helpers (identical pattern to MCPBlueprintWriteHandlers.cpp).
	auto SendSuccess = [](FMCPResponseSender SendResponse,
	                      const FString& CorrelationId,
	                      TSharedPtr<FJsonObject> Data)
	{
		TSharedPtr<FJsonObject> Response = MakeShared<FJsonObject>();
		Response->SetBoolField(TEXT("success"), true);
		if (!CorrelationId.IsEmpty())
		{
			Response->SetStringField(TEXT("correlationId"), CorrelationId);
		}
		Response->SetObjectField(TEXT("data"), Data);

		FString Output;
		TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Output);
		FJsonSerializer::Serialize(Response.ToSharedRef(), Writer);
		Output += TEXT("\n");
		SendResponse(Output);
	};

	auto SendError = [](FMCPResponseSender SendResponse,
	                    const FString& CorrelationId,
	                    const FString& ErrorCode)
	{
		TSharedPtr<FJsonObject> Response = MakeShared<FJsonObject>();
		Response->SetBoolField(TEXT("success"), false);
		if (!CorrelationId.IsEmpty())
		{
			Response->SetStringField(TEXT("correlationId"), CorrelationId);
		}
		Response->SetStringField(TEXT("error"), ErrorCode);

		FString Output;
		TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Output);
		FJsonSerializer::Serialize(Response.ToSharedRef(), Writer);
		Output += TEXT("\n");
		SendResponse(Output);
	};

	// -------------------------------------------------------------------------
	// validate.asset (VAL-01)
	// Input payload: { "asset_path": "/Game/MyAsset" }
	// Returns: { "assetPath": string, "valid": bool, "numErrors": int, "numWarnings": int }
	//
	// Security: T-33-01 (path validation before IAssetRegistry call)
	// -------------------------------------------------------------------------
	Router.RegisterHandler(TEXT("validate.asset"),
		[SendSuccess, SendError](TSharedPtr<FJsonObject> Command, FMCPResponseSender SendResponse)
	{
		FString CorrelationId;
		Command->TryGetStringField(TEXT("correlationId"), CorrelationId);

		const TSharedPtr<FJsonObject>* PayloadObj = nullptr;
		if (!Command->TryGetObjectField(TEXT("payload"), PayloadObj))
		{
			SendError(SendResponse, CorrelationId, TEXT("missing_payload"));
			return;
		}

		FString AssetPath;
		if (!(*PayloadObj)->TryGetStringField(TEXT("asset_path"), AssetPath) || AssetPath.IsEmpty())
		{
			SendError(SendResponse, CorrelationId, TEXT("missing_asset_path"));
			return;
		}

		// T-33-01: Validate the asset path is a well-formed long package name.
		FText ValidationError;
		if (!FPackageName::IsValidLongPackageName(AssetPath, /*bIncludeReadOnlyRoots=*/false, &ValidationError))
		{
			UE_LOG(LogTemp, Warning, TEXT("[MCPBridge] validate.asset: Invalid asset path '%s': %s"),
				*AssetPath, *ValidationError.ToString());
			SendError(SendResponse, CorrelationId, TEXT("invalid_asset_path"));
			return;
		}

		// Check DataValidation module availability.
		if (!MCPReflect::CheckModuleLoaded(TEXT("DataValidation")))
		{
			MCPReflect::SendModuleNotAvailable(SendResponse, CorrelationId, TEXT("DataValidation"));
			return;
		}

		IAssetRegistry& AssetRegistry = FAssetRegistryModule::GetRegistry();
		FAssetData AssetData = AssetRegistry.GetAssetByObjectPath(FSoftObjectPath(AssetPath));
		if (!AssetData.IsValid())
		{
			UE_LOG(LogTemp, Warning, TEXT("[MCPBridge] validate.asset: Asset not found at '%s'"), *AssetPath);
			SendError(SendResponse, CorrelationId, TEXT("asset_not_found"));
			return;
		}

		TArray<FAssetData> AssetsToValidate;
		AssetsToValidate.Add(AssetData);

		const FValidationResult Result = RunValidation(AssetsToValidate);
		if (!Result.bSuccess)
		{
			UE_LOG(LogTemp, Error, TEXT("[MCPBridge] validate.asset: Validation failed: %s"), *Result.ErrorCode);
			SendError(SendResponse, CorrelationId, Result.ErrorCode);
			return;
		}

		const bool bValid = (Result.NumInvalid == 0);

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetStringField(TEXT("assetPath"), AssetPath);
		Data->SetBoolField(TEXT("valid"), bValid);
		Data->SetNumberField(TEXT("numErrors"), Result.NumInvalid);
		Data->SetNumberField(TEXT("numWarnings"), Result.NumWarnings);
		SendSuccess(SendResponse, CorrelationId, Data);
	});

	// -------------------------------------------------------------------------
	// validate.folder (VAL-02)
	// Input payload: { "folder_path": "/Game/MyFolder" }
	// Returns: { "folderPath": string, "numAssets": int, "numValid": int,
	//            "numInvalid": int, "numWarnings": int }
	//
	// Security: T-33-01 (path validation before IAssetRegistry scan)
	// -------------------------------------------------------------------------
	Router.RegisterHandler(TEXT("validate.folder"),
		[SendSuccess, SendError](TSharedPtr<FJsonObject> Command, FMCPResponseSender SendResponse)
	{
		FString CorrelationId;
		Command->TryGetStringField(TEXT("correlationId"), CorrelationId);

		const TSharedPtr<FJsonObject>* PayloadObj = nullptr;
		if (!Command->TryGetObjectField(TEXT("payload"), PayloadObj))
		{
			SendError(SendResponse, CorrelationId, TEXT("missing_payload"));
			return;
		}

		FString FolderPath;
		if (!(*PayloadObj)->TryGetStringField(TEXT("folder_path"), FolderPath) || FolderPath.IsEmpty())
		{
			SendError(SendResponse, CorrelationId, TEXT("missing_folder_path"));
			return;
		}

		// T-33-01: Validate the folder path starts with '/' and has no traversal.
		if (!FolderPath.StartsWith(TEXT("/")))
		{
			UE_LOG(LogTemp, Warning, TEXT("[MCPBridge] validate.folder: Invalid folder path '%s' (must start with '/')"),
				*FolderPath);
			SendError(SendResponse, CorrelationId, TEXT("invalid_folder_path"));
			return;
		}

		if (FolderPath.Contains(TEXT("..")) || FolderPath.Contains(TEXT("\\")))
		{
			UE_LOG(LogTemp, Warning, TEXT("[MCPBridge] validate.folder: Suspicious folder path '%s'"), *FolderPath);
			SendError(SendResponse, CorrelationId, TEXT("invalid_folder_path"));
			return;
		}

		// Check DataValidation module availability.
		if (!MCPReflect::CheckModuleLoaded(TEXT("DataValidation")))
		{
			MCPReflect::SendModuleNotAvailable(SendResponse, CorrelationId, TEXT("DataValidation"));
			return;
		}

		IAssetRegistry& AssetRegistry = FAssetRegistryModule::GetRegistry();
		TArray<FAssetData> OutAssets;
		AssetRegistry.GetAssetsByPath(FName(*FolderPath), OutAssets, /*bRecursive=*/true);

		if (OutAssets.Num() == 0)
		{
			UE_LOG(LogTemp, Warning, TEXT("[MCPBridge] validate.folder: No assets found under '%s'"), *FolderPath);
			SendError(SendResponse, CorrelationId, TEXT("folder_not_found"));
			return;
		}

		const FValidationResult Result = RunValidation(OutAssets);
		if (!Result.bSuccess)
		{
			UE_LOG(LogTemp, Error, TEXT("[MCPBridge] validate.folder: Validation failed: %s"), *Result.ErrorCode);
			SendError(SendResponse, CorrelationId, Result.ErrorCode);
			return;
		}

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetStringField(TEXT("folderPath"), FolderPath);
		Data->SetNumberField(TEXT("numAssets"), Result.NumRequested);
		Data->SetNumberField(TEXT("numValid"), Result.NumValid);
		Data->SetNumberField(TEXT("numInvalid"), Result.NumInvalid);
		Data->SetNumberField(TEXT("numWarnings"), Result.NumWarnings);
		SendSuccess(SendResponse, CorrelationId, Data);
	});

	// -------------------------------------------------------------------------
	// validate.project (VAL-03)
	// No required payload fields.
	// Returns: { "numRequested": int, "numValid": int, "numInvalid": int,
	//            "numWarnings": int, "numUnableToValidate": int }
	// -------------------------------------------------------------------------
	Router.RegisterHandler(TEXT("validate.project"),
		[SendSuccess, SendError](TSharedPtr<FJsonObject> Command, FMCPResponseSender SendResponse)
	{
		FString CorrelationId;
		Command->TryGetStringField(TEXT("correlationId"), CorrelationId);

		// Check DataValidation module availability.
		if (!MCPReflect::CheckModuleLoaded(TEXT("DataValidation")))
		{
			MCPReflect::SendModuleNotAvailable(SendResponse, CorrelationId, TEXT("DataValidation"));
			return;
		}

		IAssetRegistry& AssetRegistry = FAssetRegistryModule::GetRegistry();
		TArray<FAssetData> OutAssets;
		AssetRegistry.GetAssetsByPath(FName(TEXT("/Game")), OutAssets, /*bRecursive=*/true);

		const FValidationResult Result = RunValidation(OutAssets);
		if (!Result.bSuccess)
		{
			UE_LOG(LogTemp, Error, TEXT("[MCPBridge] validate.project: Validation failed: %s"), *Result.ErrorCode);
			SendError(SendResponse, CorrelationId, Result.ErrorCode);
			return;
		}

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetNumberField(TEXT("numRequested"), Result.NumRequested);
		Data->SetNumberField(TEXT("numValid"), Result.NumValid);
		Data->SetNumberField(TEXT("numInvalid"), Result.NumInvalid);
		Data->SetNumberField(TEXT("numWarnings"), Result.NumWarnings);
		Data->SetNumberField(TEXT("numUnableToValidate"), Result.NumUnableToValidate);
		SendSuccess(SendResponse, CorrelationId, Data);
	});

	// -------------------------------------------------------------------------
	// validate.blueprint (VAL-04)
	// Input payload: { "asset_path": "/Game/Blueprints/BP_MyActor" }
	// Returns: { "assetPath": string, "compiled": bool, "status": string, "errorMessage": string }
	//
	// status values: "up_to_date", "dirty", "error", "unknown"
	// compiled = true only when status is "up_to_date"
	//
	// NOTE: This handler uses core UBlueprint and FKismetEditorUtilities directly
	// (Engine + Kismet modules -- always available). No optional plugin dependency.
	//
	// Security: T-33-01 (path validation before LoadObject)
	//           T-33-02 (BP->ErrorMessage removed in UE 5.7 -- we return named status strings)
	// -------------------------------------------------------------------------
	Router.RegisterHandler(TEXT("validate.blueprint"),
		[SendSuccess, SendError](TSharedPtr<FJsonObject> Command, FMCPResponseSender SendResponse)
	{
		FString CorrelationId;
		Command->TryGetStringField(TEXT("correlationId"), CorrelationId);

		const TSharedPtr<FJsonObject>* PayloadObj = nullptr;
		if (!Command->TryGetObjectField(TEXT("payload"), PayloadObj))
		{
			SendError(SendResponse, CorrelationId, TEXT("missing_payload"));
			return;
		}

		FString AssetPath;
		if (!(*PayloadObj)->TryGetStringField(TEXT("asset_path"), AssetPath) || AssetPath.IsEmpty())
		{
			SendError(SendResponse, CorrelationId, TEXT("missing_asset_path"));
			return;
		}

		// T-33-01: Validate the asset path before passing to LoadObject.
		FText ValidationError;
		if (!FPackageName::IsValidLongPackageName(AssetPath, /*bIncludeReadOnlyRoots=*/false, &ValidationError))
		{
			UE_LOG(LogTemp, Warning, TEXT("[MCPBridge] validate.blueprint: Invalid asset path '%s': %s"),
				*AssetPath, *ValidationError.ToString());
			SendError(SendResponse, CorrelationId, TEXT("invalid_asset_path"));
			return;
		}

		UBlueprint* BP = LoadObject<UBlueprint>(nullptr, *AssetPath);
		if (!BP)
		{
			UE_LOG(LogTemp, Warning, TEXT("[MCPBridge] validate.blueprint: Blueprint not found at '%s'"), *AssetPath);
			SendError(SendResponse, CorrelationId, TEXT("asset_not_found"));
			return;
		}

		// Compile the Blueprint synchronously.
		FKismetEditorUtilities::CompileBlueprint(BP, EBlueprintCompileOptions::None);

		// Map EBlueprintStatus to a human-readable string.
		// T-33-02: Return named status strings, not raw enum values.
		FString StatusString;
		bool bCompiled = false;

		switch (BP->Status)
		{
			case BS_UpToDate:
				StatusString = TEXT("up_to_date");
				bCompiled = true;
				break;
			case BS_Dirty:
				StatusString = TEXT("dirty");
				bCompiled = false;
				break;
			case BS_Error:
				StatusString = TEXT("error");
				bCompiled = false;
				break;
			default:
				StatusString = TEXT("unknown");
				bCompiled = false;
				break;
		}

		// Note: UBlueprint::ErrorMessage was removed in UE 5.7.
		// We report compile status instead.
		const FString ErrorMessage = bCompiled
			? TEXT("")
			: TEXT("Blueprint has compilation errors. Check the Blueprint editor for details.");

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetStringField(TEXT("assetPath"), AssetPath);
		Data->SetBoolField(TEXT("compiled"), bCompiled);
		Data->SetStringField(TEXT("status"), StatusString);
		Data->SetStringField(TEXT("errorMessage"), ErrorMessage);
		SendSuccess(SendResponse, CorrelationId, Data);
	});
}
