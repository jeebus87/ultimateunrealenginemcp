// MCPValidationCommands.cpp
// Implements validate.asset, validate.folder, validate.project, validate.blueprint
// command handlers for the MCPBridge editor plugin.
// All handlers are registered on the FMCPCommandRouter and run on the game thread
// (enforced by FMCPCommandRouter::Dispatch via AsyncTask).
//
// Security mitigations per threat model (T-16-01 through T-16-02):
//   T-16-01: asset_path validated via FPackageName::IsValidLongPackageName()
//             before any IAssetRegistry or LoadObject call -- rejects traversal and bare paths
//   T-16-02: Named error codes returned (e.g., "asset_not_found"), never raw UE internal strings;
//             BP->ErrorMessage is user-authored content and is safe to surface

#include "MCPValidationCommands.h"

#include "MCPCommandRouter.h"

// Validation APIs
#include "EditorValidatorSubsystem.h"

// Blueprint APIs
#include "Engine/Blueprint.h"
#include "Kismet2/KismetEditorUtilities.h"

// Asset Registry APIs
#include "AssetRegistry/AssetRegistryModule.h"
#include "AssetRegistry/IAssetRegistry.h"

// Package path utilities
#include "Misc/PackageName.h"

// JSON APIs
#include "Dom/JsonObject.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"

void RegisterValidationCommands(FMCPCommandRouter& Router)
{
	// ---------------------------------------------------------------------------
	// Shared response helpers -- identical pattern to MCPBlueprintWriteHandlers.cpp.
	// ---------------------------------------------------------------------------

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

	// ---------------------------------------------------------------------------
	// validate.asset (VAL-01)
	// Input payload: { "asset_path": "/Game/MyAsset" }
	// Returns: { "assetPath": string, "valid": bool, "numErrors": int, "numWarnings": int }
	//
	// Security: T-16-01 (path validation before IAssetRegistry call)
	// ---------------------------------------------------------------------------
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

		// T-16-01: Validate the asset path is a well-formed long package name.
		// Rejects path traversal ("../") and bare filenames.
		FText ValidationError;
		if (!FPackageName::IsValidLongPackageName(AssetPath, /*bIncludeReadOnlyRoots=*/false, &ValidationError))
		{
			UE_LOG(LogTemp, Warning, TEXT("[MCPBridge] validate.asset: Invalid asset path '%s': %s"),
				*AssetPath, *ValidationError.ToString());
			SendError(SendResponse, CorrelationId, TEXT("invalid_asset_path"));
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

		UEditorValidatorSubsystem* ValidatorSubsystem = GEditor->GetEditorSubsystem<UEditorValidatorSubsystem>();
		if (!ValidatorSubsystem)
		{
			UE_LOG(LogTemp, Error, TEXT("[MCPBridge] validate.asset: UEditorValidatorSubsystem not available"));
			SendError(SendResponse, CorrelationId, TEXT("validator_not_available"));
			return;
		}

		TArray<FAssetData> AssetsToValidate;
		AssetsToValidate.Add(AssetData);

		FValidateAssetsSettings Settings;
		Settings.bSkipExcludedDirectories = true;
		Settings.bShowIfNoFailures = false;
		Settings.ValidationUsecase = EDataValidationUsecase::Script;

		FValidateAssetsResults Results;
		ValidatorSubsystem->ValidateAssetsWithSettings(AssetsToValidate, Settings, Results);

		const bool bValid = (Results.NumInvalid == 0);

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetStringField(TEXT("assetPath"), AssetPath);
		Data->SetBoolField(TEXT("valid"), bValid);
		Data->SetNumberField(TEXT("numErrors"), Results.NumInvalid);
		Data->SetNumberField(TEXT("numWarnings"), Results.NumWarnings);
		SendSuccess(SendResponse, CorrelationId, Data);
	});

	// ---------------------------------------------------------------------------
	// validate.folder (VAL-02)
	// Input payload: { "folder_path": "/Game/MyFolder" }
	// Returns: { "folderPath": string, "numAssets": int, "numValid": int,
	//            "numInvalid": int, "numWarnings": int }
	//
	// Security: T-16-01 (path validation before IAssetRegistry scan)
	// ---------------------------------------------------------------------------
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

		// T-16-01: Validate the folder path. IsValidLongPackageName rejects traversal paths.
		// Note: folder paths (no asset name suffix) may fail the standard check, so we verify
		// the path starts with a valid mount point prefix instead.
		if (!FolderPath.StartsWith(TEXT("/")))
		{
			UE_LOG(LogTemp, Warning, TEXT("[MCPBridge] validate.folder: Invalid folder path '%s' (must start with '/')"),
				*FolderPath);
			SendError(SendResponse, CorrelationId, TEXT("invalid_folder_path"));
			return;
		}

		// Additional check: ensure no path traversal sequences.
		if (FolderPath.Contains(TEXT("..")) || FolderPath.Contains(TEXT("\\")))
		{
			UE_LOG(LogTemp, Warning, TEXT("[MCPBridge] validate.folder: Suspicious folder path '%s'"), *FolderPath);
			SendError(SendResponse, CorrelationId, TEXT("invalid_folder_path"));
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

		UEditorValidatorSubsystem* ValidatorSubsystem = GEditor->GetEditorSubsystem<UEditorValidatorSubsystem>();
		if (!ValidatorSubsystem)
		{
			UE_LOG(LogTemp, Error, TEXT("[MCPBridge] validate.folder: UEditorValidatorSubsystem not available"));
			SendError(SendResponse, CorrelationId, TEXT("validator_not_available"));
			return;
		}

		FValidateAssetsSettings Settings;
		Settings.bSkipExcludedDirectories = true;
		Settings.bShowIfNoFailures = false;
		Settings.ValidationUsecase = EDataValidationUsecase::Script;

		FValidateAssetsResults Results;
		ValidatorSubsystem->ValidateAssetsWithSettings(OutAssets, Settings, Results);

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetStringField(TEXT("folderPath"), FolderPath);
		Data->SetNumberField(TEXT("numAssets"), Results.NumRequested);
		Data->SetNumberField(TEXT("numValid"), Results.NumValid);
		Data->SetNumberField(TEXT("numInvalid"), Results.NumInvalid);
		Data->SetNumberField(TEXT("numWarnings"), Results.NumWarnings);
		SendSuccess(SendResponse, CorrelationId, Data);
	});

	// ---------------------------------------------------------------------------
	// validate.project (VAL-03)
	// No required payload fields.
	// Returns: { "numRequested": int, "numValid": int, "numInvalid": int,
	//            "numWarnings": int, "numUnableToValidate": int }
	// ---------------------------------------------------------------------------
	Router.RegisterHandler(TEXT("validate.project"),
		[SendSuccess, SendError](TSharedPtr<FJsonObject> Command, FMCPResponseSender SendResponse)
	{
		FString CorrelationId;
		Command->TryGetStringField(TEXT("correlationId"), CorrelationId);

		IAssetRegistry& AssetRegistry = FAssetRegistryModule::GetRegistry();
		TArray<FAssetData> OutAssets;
		AssetRegistry.GetAssetsByPath(FName(TEXT("/Game")), OutAssets, /*bRecursive=*/true);

		UEditorValidatorSubsystem* ValidatorSubsystem = GEditor->GetEditorSubsystem<UEditorValidatorSubsystem>();
		if (!ValidatorSubsystem)
		{
			UE_LOG(LogTemp, Error, TEXT("[MCPBridge] validate.project: UEditorValidatorSubsystem not available"));
			SendError(SendResponse, CorrelationId, TEXT("validator_not_available"));
			return;
		}

		FValidateAssetsSettings Settings;
		Settings.bSkipExcludedDirectories = true;
		Settings.bShowIfNoFailures = false;
		Settings.ValidationUsecase = EDataValidationUsecase::Script;

		FValidateAssetsResults Results;
		ValidatorSubsystem->ValidateAssetsWithSettings(OutAssets, Settings, Results);

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetNumberField(TEXT("numRequested"), Results.NumRequested);
		Data->SetNumberField(TEXT("numValid"), Results.NumValid);
		Data->SetNumberField(TEXT("numInvalid"), Results.NumInvalid);
		Data->SetNumberField(TEXT("numWarnings"), Results.NumWarnings);
		Data->SetNumberField(TEXT("numUnableToValidate"), Results.NumUnableToValidate);
		SendSuccess(SendResponse, CorrelationId, Data);
	});

	// ---------------------------------------------------------------------------
	// validate.blueprint (VAL-04)
	// Input payload: { "asset_path": "/Game/Blueprints/BP_MyActor" }
	// Returns: { "assetPath": string, "compiled": bool, "status": string, "errorMessage": string }
	//
	// status values: "up_to_date", "dirty", "error", "unknown"
	// compiled = true only when status is "up_to_date"
	//
	// Security: T-16-01 (path validation before LoadObject)
	//           T-16-02 (BP->ErrorMessage is user-authored content, safe to surface)
	// ---------------------------------------------------------------------------
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

		// T-16-01: Validate the asset path before passing to LoadObject.
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
		// T-16-02: We return named status strings, not raw enum values.
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
		FString ErrorMessage = bCompiled ? TEXT("") : TEXT("Blueprint has compilation errors. Check the Blueprint editor for details.");

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetStringField(TEXT("assetPath"), AssetPath);
		Data->SetBoolField(TEXT("compiled"), bCompiled);
		Data->SetStringField(TEXT("status"), StatusString);
		Data->SetStringField(TEXT("errorMessage"), ErrorMessage);
		SendSuccess(SendResponse, CorrelationId, Data);
	});
}
