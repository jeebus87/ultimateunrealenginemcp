// ReflectionHelpers.h
// Header-only UE runtime reflection utilities shared by all reflection-based
// optional handler files (MCPValidationCommands, MCPNetworkingCommands,
// MCPMaterialCommands, and future handlers in this phase).
//
// All helpers are inline/static and scoped to namespace MCPReflect to avoid
// ODR violations when multiple translation units include this header.
//
// Only headers from core Build.cs modules are included here -- no optional
// plugin headers. This is a non-negotiable constraint for this phase.

#pragma once

#include "CoreMinimal.h"
#include "Modules/ModuleManager.h"
#include "UObject/UnrealType.h"
#include "UObject/PropertyPortFlags.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"

// Forward declaration of the response sender type used in MCPCommandRouter.h.
// Including the full header would pull in CoreMinimal again (harmless but noisy).
// Handlers that use SendModuleNotAvailable must also include MCPCommandRouter.h.
using FMCPResponseSender = TFunction<void(const FString& JsonResponse)>;

namespace MCPReflect
{

// ---------------------------------------------------------------------------
// 1. Module availability check
// ---------------------------------------------------------------------------

/**
 * Returns true if the named UE module is currently loaded (i.e. the
 * optional plugin that provides it is enabled in this project/editor).
 *
 * Usage:
 *   if (!MCPReflect::CheckModuleLoaded(TEXT("DataValidation"))) { ... }
 */
inline bool CheckModuleLoaded(const TCHAR* ModuleName)
{
	return FModuleManager::Get().IsModuleLoaded(ModuleName);
}

// ---------------------------------------------------------------------------
// 2. UClass lookup by script path
// ---------------------------------------------------------------------------

/**
 * Finds a UClass* by its full script object path without triggering a load.
 * Returns nullptr if the class is not registered (plugin not enabled or not
 * yet loaded).
 *
 * Example path: TEXT("/Script/DataValidation.EditorValidatorSubsystem")
 */
inline UClass* FindClassByPath(const TCHAR* ClassPath)
{
	return FindObject<UClass>(nullptr, ClassPath);
}

// ---------------------------------------------------------------------------
// 3–8. Typed property accessors (all read-only, null-safe)
// ---------------------------------------------------------------------------

/**
 * Read a string property by name.
 * Checks FStrProperty first, then FNameProperty (converts via ToString).
 * Returns an empty FString if the property is not found.
 */
inline FString GetStringProperty(UObject* Obj, FName PropName)
{
	if (!Obj)
	{
		return FString();
	}

	UClass* Class = Obj->GetClass();

	if (FStrProperty* StrProp = CastField<FStrProperty>(Class->FindPropertyByName(PropName)))
	{
		return StrProp->GetPropertyValue_InContainer(Obj);
	}

	if (FNameProperty* NameProp = CastField<FNameProperty>(Class->FindPropertyByName(PropName)))
	{
		return NameProp->GetPropertyValue_InContainer(Obj).ToString();
	}

	return FString();
}

/**
 * Read a numeric (float/double) property by name.
 * Checks FFloatProperty first, then FDoubleProperty.
 * Returns 0.0 if the property is not found.
 */
inline double GetFloatProperty(UObject* Obj, FName PropName)
{
	if (!Obj)
	{
		return 0.0;
	}

	UClass* Class = Obj->GetClass();

	if (FFloatProperty* FloatProp = CastField<FFloatProperty>(Class->FindPropertyByName(PropName)))
	{
		return static_cast<double>(FloatProp->GetPropertyValue_InContainer(Obj));
	}

	if (FDoubleProperty* DoubleProp = CastField<FDoubleProperty>(Class->FindPropertyByName(PropName)))
	{
		return DoubleProp->GetPropertyValue_InContainer(Obj);
	}

	return 0.0;
}

/**
 * Read an integer (int32/int64) property by name.
 * Checks FIntProperty first, then FInt64Property.
 * Returns 0 if the property is not found.
 */
inline int64 GetIntProperty(UObject* Obj, FName PropName)
{
	if (!Obj)
	{
		return 0;
	}

	UClass* Class = Obj->GetClass();

	if (FIntProperty* IntProp = CastField<FIntProperty>(Class->FindPropertyByName(PropName)))
	{
		return static_cast<int64>(IntProp->GetPropertyValue_InContainer(Obj));
	}

	if (FInt64Property* Int64Prop = CastField<FInt64Property>(Class->FindPropertyByName(PropName)))
	{
		return Int64Prop->GetPropertyValue_InContainer(Obj);
	}

	return 0;
}

/**
 * Read a bool property by name via FBoolProperty.
 * Sets OutValue to the property value and returns true if found.
 * Returns false (and leaves OutValue unchanged) if the property is not found.
 */
inline bool GetBoolProperty(UObject* Obj, FName PropName, bool& OutValue)
{
	if (!Obj)
	{
		return false;
	}

	UClass* Class = Obj->GetClass();

	if (FBoolProperty* BoolProp = CastField<FBoolProperty>(Class->FindPropertyByName(PropName)))
	{
		OutValue = BoolProp->GetPropertyValue_InContainer(Obj);
		return true;
	}

	return false;
}

/**
 * Read a UObject* property by name via FObjectProperty.
 * Returns nullptr if the property is not found or the value is null.
 */
inline UObject* GetObjectProperty(UObject* Obj, FName PropName)
{
	if (!Obj)
	{
		return nullptr;
	}

	UClass* Class = Obj->GetClass();

	if (FObjectProperty* ObjProp = CastField<FObjectProperty>(Class->FindPropertyByName(PropName)))
	{
		return ObjProp->GetObjectPropertyValue_InContainer(Obj);
	}

	return nullptr;
}

/**
 * Export any property to a string representation via ExportTextItem_Direct.
 * Useful for properties where the type is not known at compile time.
 * Returns an empty FString if the property is not found.
 */
inline FString ExportPropertyAsString(UObject* Obj, FName PropName)
{
	if (!Obj)
	{
		return FString();
	}

	UClass* Class = Obj->GetClass();
	FProperty* Prop = Class->FindPropertyByName(PropName);
	if (!Prop)
	{
		return FString();
	}

	FString Result;
	const void* ValuePtr = Prop->ContainerPtrToValuePtr<void>(Obj);
	Prop->ExportTextItem_Direct(Result, ValuePtr, nullptr, Obj, PPF_None);
	return Result;
}

/**
 * Set a property from its string representation via ImportText_Direct.
 * Returns true if the property was found and the import succeeded.
 */
inline bool SetPropertyFromString(UObject* Obj, FName PropName, const FString& Value)
{
	if (!Obj)
	{
		return false;
	}

	UClass* Class = Obj->GetClass();
	FProperty* Prop = Class->FindPropertyByName(PropName);
	if (!Prop)
	{
		return false;
	}

	void* ValuePtr = Prop->ContainerPtrToValuePtr<void>(Obj);
	const TCHAR* Result = Prop->ImportText_Direct(*Value, ValuePtr, Obj, PPF_None);
	return (Result != nullptr);
}

// ---------------------------------------------------------------------------
// 9–11. JSON response builders
// ---------------------------------------------------------------------------

/**
 * Build a JSON success response string (NO trailing newline).
 * Format: { "success": true, "correlationId": "...", "data": { ... } }
 */
inline FString BuildSuccessResponse(const FString& CorrId, TSharedPtr<FJsonObject> Data)
{
	TSharedPtr<FJsonObject> Obj = MakeShared<FJsonObject>();
	Obj->SetBoolField(TEXT("success"), true);
	if (!CorrId.IsEmpty())
	{
		Obj->SetStringField(TEXT("correlationId"), CorrId);
	}
	if (Data.IsValid())
	{
		Obj->SetObjectField(TEXT("data"), Data);
	}

	FString Output;
	TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Output);
	FJsonSerializer::Serialize(Obj.ToSharedRef(), Writer);
	return Output;
}

/**
 * Build a JSON error response string (NO trailing newline).
 * Format: { "success": false, "correlationId": "...", "error": "..." }
 */
inline FString BuildErrorResponse(const FString& CorrId, const FString& Error)
{
	TSharedPtr<FJsonObject> Obj = MakeShared<FJsonObject>();
	Obj->SetBoolField(TEXT("success"), false);
	if (!CorrId.IsEmpty())
	{
		Obj->SetStringField(TEXT("correlationId"), CorrId);
	}
	Obj->SetStringField(TEXT("error"), Error);

	FString Output;
	TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Output);
	FJsonSerializer::Serialize(Obj.ToSharedRef(), Writer);
	return Output;
}

/**
 * Send a "module_not_available" error response (WITH trailing newline, as
 * expected by the TCP framing protocol).
 *
 * Error code format: "<lowercase_module_name>_not_available"
 * e.g. ModuleName="DataValidation" -> error="datavalidation_not_available"
 */
inline void SendModuleNotAvailable(FMCPResponseSender SendResponse,
                                   const FString& CorrId,
                                   const FString& ModuleName)
{
	const FString ErrorCode = ModuleName.ToLower() + TEXT("_not_available");
	SendResponse(BuildErrorResponse(CorrId, ErrorCode) + TEXT("\n"));
}

} // namespace MCPReflect
