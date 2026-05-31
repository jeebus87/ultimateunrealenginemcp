// MCPInputHandlers.cpp
// Implements input.listActions, input.createAction, input.listContexts,
// and input.addBinding command handlers.
// All handlers are registered on the FMCPCommandRouter and run on the game thread
// (enforced by FMCPCommandRouter::Dispatch via AsyncTask).
//
// INVARIANT: Every write handler calls Object->Modify() before any mutation and
// saves the package after -- never omit these.
//
// Security mitigations per threat model (T-14-01, T-14-02):
//   T-14-01: asset_path validated via FPackageName::IsValidLongPackageName()
//   T-14-02: key field validated via FKey(*KeyName).IsValid() before MapKey call

#include "MCPInputHandlers.h"

#include "MCPCommandRouter.h"

// Enhanced Input APIs
#include "InputAction.h"
#include "InputMappingContext.h"
#include "EnhancedActionKeyMapping.h"

// Asset Registry APIs
#include "AssetRegistry/AssetRegistryModule.h"

// Package saving
#include "UObject/SavePackage.h"

// UObject/Package APIs
#include "UObject/Package.h"
#include "Misc/PackageName.h"

// JSON APIs
#include "Dom/JsonObject.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"

// ---------------------------------------------------------------------------
// Internal helper: map EInputActionValueType to a display string.
// ---------------------------------------------------------------------------
static FString ValueTypeToString(EInputActionValueType ValueType)
{
	switch (ValueType)
	{
		case EInputActionValueType::Boolean: return TEXT("bool");
		case EInputActionValueType::Axis1D:  return TEXT("float");
		case EInputActionValueType::Axis2D:  return TEXT("Axis2D");
		case EInputActionValueType::Axis3D:  return TEXT("Axis3D");
		default:                             return TEXT("unknown");
	}
}

// ---------------------------------------------------------------------------
// Internal helper: map a value_type string to EInputActionValueType int.
// Returns -1 if the string is unrecognized.
// ---------------------------------------------------------------------------
static int32 StringToValueTypeInt(const FString& ValueTypeStr)
{
	if (ValueTypeStr == TEXT("bool"))   return 0;
	if (ValueTypeStr == TEXT("float"))  return 1;
	if (ValueTypeStr == TEXT("Axis2D")) return 2;
	if (ValueTypeStr == TEXT("Axis3D")) return 3;
	return -1;
}

void RegisterInputHandlers(FMCPCommandRouter& Router)
{
	// ---------------------------------------------------------------------------
	// Shared response helpers -- verbatim pattern from MCPBlueprintWriteHandlers.cpp.
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
	// input.listActions (INP-01)
	// Returns: { "actions": [{ "name": string, "path": string, "valueType": string }] }
	// Returns empty array (not error) when no assets found.
	// ---------------------------------------------------------------------------
	Router.RegisterHandler(TEXT("input.listActions"),
		[SendSuccess, SendError](TSharedPtr<FJsonObject> Command, FMCPResponseSender SendResponse)
	{
		FString CorrelationId;
		Command->TryGetStringField(TEXT("correlationId"), CorrelationId);

		IAssetRegistry& AR = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry")).Get();

		TArray<FAssetData> Assets;
		AR.GetAssetsByClass(UInputAction::StaticClass()->GetClassPathName(), Assets);

		TArray<TSharedPtr<FJsonValue>> ActionsArray;
		for (const FAssetData& AssetData : Assets)
		{
			UInputAction* Action = Cast<UInputAction>(AssetData.GetAsset());
			if (!Action)
			{
				continue;
			}

			TSharedPtr<FJsonObject> ActionObj = MakeShared<FJsonObject>();
			ActionObj->SetStringField(TEXT("name"), AssetData.AssetName.ToString());
			ActionObj->SetStringField(TEXT("path"), AssetData.PackageName.ToString());
			ActionObj->SetStringField(TEXT("valueType"), ValueTypeToString(Action->ValueType));
			ActionsArray.Add(MakeShared<FJsonValueObject>(ActionObj));
		}

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetArrayField(TEXT("actions"), ActionsArray);
		SendSuccess(SendResponse, CorrelationId, Data);
	});

	// ---------------------------------------------------------------------------
	// input.createAction (INP-02)
	// Payload: { "asset_path": string, "value_type": "bool"|"float"|"Axis2D"|"Axis3D" }
	// Returns: { "assetPath": string, "valueType": string }
	//
	// Security: T-14-01 (path validation via IsValidLongPackageName)
	// ---------------------------------------------------------------------------
	Router.RegisterHandler(TEXT("input.createAction"),
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

		FString ValueTypeStr;
		if (!(*PayloadObj)->TryGetStringField(TEXT("value_type"), ValueTypeStr) || ValueTypeStr.IsEmpty())
		{
			SendError(SendResponse, CorrelationId, TEXT("missing_value_type"));
			return;
		}

		// T-14-01: Validate the asset path is a well-formed long package name.
		// Rejects path traversal ("../") and bare filenames.
		FText ValidationError;
		if (!FPackageName::IsValidLongPackageName(AssetPath, /*bIncludeReadOnlyRoots=*/false, &ValidationError))
		{
			UE_LOG(LogTemp, Warning, TEXT("[MCPBridge] input.createAction: Invalid asset path '%s': %s"),
				*AssetPath, *ValidationError.ToString());
			SendError(SendResponse, CorrelationId, TEXT("invalid_asset_path"));
			return;
		}

		// Map value_type string to EInputActionValueType int.
		const int32 ValueTypeInt = StringToValueTypeInt(ValueTypeStr);
		if (ValueTypeInt < 0)
		{
			UE_LOG(LogTemp, Warning, TEXT("[MCPBridge] input.createAction: Unrecognized value_type '%s'"),
				*ValueTypeStr);
			SendError(SendResponse, CorrelationId, TEXT("invalid_value_type"));
			return;
		}

		// Extract the asset name from the full package path.
		FString AssetName = FPackageName::GetLongPackageAssetName(AssetPath);

		// Create (or retrieve) the package for this asset.
		UPackage* Pkg = CreatePackage(*AssetPath);
		if (!Pkg)
		{
			UE_LOG(LogTemp, Error, TEXT("[MCPBridge] input.createAction: Failed to create package for '%s'"),
				*AssetPath);
			SendError(SendResponse, CorrelationId, TEXT("package_create_failed"));
			return;
		}
		Pkg->FullyLoad();

		// Create the UInputAction asset.
		UInputAction* Action = NewObject<UInputAction>(Pkg, FName(*AssetName), RF_Public | RF_Standalone);
		if (!Action)
		{
			UE_LOG(LogTemp, Error, TEXT("[MCPBridge] input.createAction: NewObject<UInputAction> failed for '%s'"),
				*AssetPath);
			SendError(SendResponse, CorrelationId, TEXT("create_failed"));
			return;
		}

		// MANDATORY: Modify() before mutation.
		Action->Modify();
		Action->ValueType = static_cast<EInputActionValueType>(ValueTypeInt);

		// Save the package to disk so the asset persists.
		FString FilePath = FPackageName::LongPackageNameToFilename(
			AssetPath, FPackageName::GetAssetPackageExtension());
		FSavePackageArgs SaveArgs;
		SaveArgs.TopLevelFlags = RF_Standalone;
		SaveArgs.SaveFlags = SAVE_NoError;
		UPackage::SavePackage(Pkg, Action, *FilePath, SaveArgs);

		// Notify the Asset Registry so the asset appears in the Content Browser.
		FAssetRegistryModule::AssetCreated(Action);

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetStringField(TEXT("assetPath"), AssetPath);
		Data->SetStringField(TEXT("valueType"), ValueTypeStr);
		SendSuccess(SendResponse, CorrelationId, Data);
	});

	// ---------------------------------------------------------------------------
	// input.listContexts (INP-03)
	// Returns: { "contexts": [{ "name": string, "path": string, "bindings": [...] }] }
	// Each binding: { "action": string, "key": string }
	// ---------------------------------------------------------------------------
	Router.RegisterHandler(TEXT("input.listContexts"),
		[SendSuccess, SendError](TSharedPtr<FJsonObject> Command, FMCPResponseSender SendResponse)
	{
		FString CorrelationId;
		Command->TryGetStringField(TEXT("correlationId"), CorrelationId);

		IAssetRegistry& AR = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry")).Get();

		TArray<FAssetData> Assets;
		AR.GetAssetsByClass(UInputMappingContext::StaticClass()->GetClassPathName(), Assets);

		TArray<TSharedPtr<FJsonValue>> ContextsArray;
		for (const FAssetData& AssetData : Assets)
		{
			UInputMappingContext* IMC = Cast<UInputMappingContext>(AssetData.GetAsset());
			if (!IMC)
			{
				continue;
			}

			TArray<TSharedPtr<FJsonValue>> BindingsArray;
			const TArray<FEnhancedActionKeyMapping>& Mappings = IMC->GetMappings();
			for (const FEnhancedActionKeyMapping& Mapping : Mappings)
			{
				TSharedPtr<FJsonObject> BindingObj = MakeShared<FJsonObject>();
				BindingObj->SetStringField(TEXT("action"),
					Mapping.Action ? Mapping.Action->GetName() : TEXT(""));
				BindingObj->SetStringField(TEXT("key"),
					Mapping.Key.GetFName().ToString());
				BindingsArray.Add(MakeShared<FJsonValueObject>(BindingObj));
			}

			TSharedPtr<FJsonObject> ContextObj = MakeShared<FJsonObject>();
			ContextObj->SetStringField(TEXT("name"), AssetData.AssetName.ToString());
			ContextObj->SetStringField(TEXT("path"), AssetData.PackageName.ToString());
			ContextObj->SetArrayField(TEXT("bindings"), BindingsArray);
			ContextsArray.Add(MakeShared<FJsonValueObject>(ContextObj));
		}

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetArrayField(TEXT("contexts"), ContextsArray);
		SendSuccess(SendResponse, CorrelationId, Data);
	});

	// ---------------------------------------------------------------------------
	// input.addBinding (INP-04)
	// Payload: { "asset_path": string, "action_path": string, "key": string }
	// Returns: { "bound": true, "action": string, "key": string }
	//
	// Security: T-14-02 (key validated via FKey::IsValid() before MapKey call)
	// ---------------------------------------------------------------------------
	Router.RegisterHandler(TEXT("input.addBinding"),
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

		FString ActionPath;
		if (!(*PayloadObj)->TryGetStringField(TEXT("action_path"), ActionPath) || ActionPath.IsEmpty())
		{
			SendError(SendResponse, CorrelationId, TEXT("missing_action_path"));
			return;
		}

		FString KeyName;
		if (!(*PayloadObj)->TryGetStringField(TEXT("key"), KeyName) || KeyName.IsEmpty())
		{
			SendError(SendResponse, CorrelationId, TEXT("missing_key"));
			return;
		}

		// T-14-02: Validate that the key name resolves to a known FKey before calling MapKey.
		// FKey constructor accepts any FName; IsValid() checks whether it is a registered key.
		const FKey ResolvedKey = FKey(FName(*KeyName));
		if (!ResolvedKey.IsValid())
		{
			UE_LOG(LogTemp, Warning, TEXT("[MCPBridge] input.addBinding: Key '%s' is not a valid FKey"), *KeyName);
			SendError(SendResponse, CorrelationId, TEXT("invalid_key"));
			return;
		}

		// Load the UInputMappingContext.
		UInputMappingContext* IMC = LoadObject<UInputMappingContext>(nullptr, *AssetPath);
		if (!IMC)
		{
			UE_LOG(LogTemp, Warning, TEXT("[MCPBridge] input.addBinding: UInputMappingContext not found at '%s'"),
				*AssetPath);
			SendError(SendResponse, CorrelationId, TEXT("context_not_found"));
			return;
		}

		// Load the UInputAction.
		UInputAction* TargetAction = LoadObject<UInputAction>(nullptr, *ActionPath);
		if (!TargetAction)
		{
			UE_LOG(LogTemp, Warning, TEXT("[MCPBridge] input.addBinding: UInputAction not found at '%s'"),
				*ActionPath);
			SendError(SendResponse, CorrelationId, TEXT("action_not_found"));
			return;
		}

		// MANDATORY: Modify() before any mutation (per constraint from CONTEXT.md and threat model).
		IMC->Modify();

		// MapKey adds (or replaces) the binding for this action+key pair.
		IMC->MapKey(TargetAction, ResolvedKey);

		// Save the package to persist the binding change.
		UPackage* Pkg = IMC->GetPackage();
		FString FilePath = FPackageName::LongPackageNameToFilename(
			AssetPath, FPackageName::GetAssetPackageExtension());
		FSavePackageArgs SaveArgs2;
		SaveArgs2.TopLevelFlags = RF_Standalone;
		SaveArgs2.SaveFlags = SAVE_NoError;
		UPackage::SavePackage(Pkg, IMC, *FilePath, SaveArgs2);

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetBoolField(TEXT("bound"), true);
		Data->SetStringField(TEXT("action"), TargetAction->GetName());
		Data->SetStringField(TEXT("key"), KeyName);
		SendSuccess(SendResponse, CorrelationId, Data);
	});
}
