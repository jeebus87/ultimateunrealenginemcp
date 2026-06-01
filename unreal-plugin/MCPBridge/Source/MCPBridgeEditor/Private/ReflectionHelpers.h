// ReflectionHelpers.h (Plan 33-01)
// Shared UE reflection utility functions used by all reflection-based optional handlers.
// All functions live in the MCPReflect namespace to avoid symbol collisions.
//
// This header provides type-safe wrappers around UE FProperty reflection APIs
// so handlers can access plugin types without compile-time #include dependencies.
//
// Usage pattern:
//   UClass* MyClass = FindObject<UClass>(nullptr, TEXT("/Script/MyPlugin.MyClass"));
//   if (!MyClass) { MCPReflect::SendModuleNotAvailable(SendResponse, CorrId, TEXT("MyPlugin")); return; }
//   UObject* Asset = StaticLoadObject(MyClass, nullptr, *AssetPath);
//   FString Value = MCPReflect::GetStringProperty(Asset, FName(TEXT("MyProp")));

#pragma once

#include "CoreMinimal.h"
#include "MCPCommandRouter.h"

// JSON
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"

// UE reflection
#include "UObject/UnrealType.h"
#include "UObject/PropertyPortFlags.h"

namespace MCPReflect
{

/** Check whether a named module is currently loaded (does NOT attempt to load it). */
inline bool CheckModuleLoaded(const TCHAR* ModuleName)
{
	return FModuleManager::Get().IsModuleLoaded(ModuleName);
}

/** Find a UClass by its full scripted class path, e.g. "/Script/MetasoundEngine.MetaSoundSource". */
inline UClass* FindClassByPath(const TCHAR* ClassPath)
{
	return FindObject<UClass>(nullptr, ClassPath);
}

/** Read a string property from an object by name. Returns empty string if not found. */
inline FString GetStringProperty(UObject* Obj, FName PropName)
{
	if (!Obj)
	{
		return FString();
	}
	FStrProperty* Prop = FindFProperty<FStrProperty>(Obj->GetClass(), PropName);
	if (Prop)
	{
		return Prop->GetPropertyValue_InContainer(Obj);
	}
	// Also try FNameProperty (convert to string)
	FNameProperty* NameProp = FindFProperty<FNameProperty>(Obj->GetClass(), PropName);
	if (NameProp)
	{
		return NameProp->GetPropertyValue_InContainer(Obj).ToString();
	}
	return FString();
}

/** Read a float/double property from an object by name. Returns 0.0 if not found. */
inline double GetFloatProperty(UObject* Obj, FName PropName)
{
	if (!Obj)
	{
		return 0.0;
	}
	FDoubleProperty* DoubleProp = FindFProperty<FDoubleProperty>(Obj->GetClass(), PropName);
	if (DoubleProp)
	{
		return DoubleProp->GetPropertyValue_InContainer(Obj);
	}
	FFloatProperty* FloatProp = FindFProperty<FFloatProperty>(Obj->GetClass(), PropName);
	if (FloatProp)
	{
		return static_cast<double>(FloatProp->GetPropertyValue_InContainer(Obj));
	}
	return 0.0;
}

/** Read an integer property from an object by name. Returns 0 if not found. */
inline int64 GetIntProperty(UObject* Obj, FName PropName)
{
	if (!Obj)
	{
		return 0;
	}
	FInt64Property* Int64Prop = FindFProperty<FInt64Property>(Obj->GetClass(), PropName);
	if (Int64Prop)
	{
		return Int64Prop->GetPropertyValue_InContainer(Obj);
	}
	FIntProperty* IntProp = FindFProperty<FIntProperty>(Obj->GetClass(), PropName);
	if (IntProp)
	{
		return static_cast<int64>(IntProp->GetPropertyValue_InContainer(Obj));
	}
	return 0;
}

/** Read a bool property from an object by name. Returns false and sets OutValue accordingly. */
inline bool GetBoolProperty(UObject* Obj, FName PropName, bool& OutValue)
{
	if (!Obj)
	{
		OutValue = false;
		return false;
	}
	FBoolProperty* BoolProp = FindFProperty<FBoolProperty>(Obj->GetClass(), PropName);
	if (BoolProp)
	{
		OutValue = BoolProp->GetPropertyValue_InContainer(Obj);
		return true;
	}
	OutValue = false;
	return false;
}

/** Read an object property from an object by name. Returns nullptr if not found. */
inline UObject* GetObjectProperty(UObject* Obj, FName PropName)
{
	if (!Obj)
	{
		return nullptr;
	}
	FObjectProperty* ObjProp = FindFProperty<FObjectProperty>(Obj->GetClass(), PropName);
	if (ObjProp)
	{
		return ObjProp->GetObjectPropertyValue_InContainer(Obj);
	}
	return nullptr;
}

/** Export any property to string using UE's built-in export logic. Returns empty string if not found. */
inline FString ExportPropertyAsString(UObject* Obj, FName PropName)
{
	if (!Obj)
	{
		return FString();
	}
	FProperty* Prop = Obj->GetClass()->FindPropertyByName(PropName);
	if (!Prop)
	{
		return FString();
	}
	FString Value;
	const void* ValuePtr = Prop->ContainerPtrToValuePtr<void>(Obj);
	Prop->ExportTextItem_Direct(Value, ValuePtr, nullptr, Obj, PPF_None);
	return Value;
}

/** Set a property from a string using UE's import-text logic. Returns true on success. */
inline bool SetPropertyFromString(UObject* Obj, FName PropName, const FString& Value)
{
	if (!Obj)
	{
		return false;
	}
	FProperty* Prop = Obj->GetClass()->FindPropertyByName(PropName);
	if (!Prop)
	{
		return false;
	}
	void* ValuePtr = Prop->ContainerPtrToValuePtr<void>(Obj);
	return Prop->ImportText_Direct(*Value, ValuePtr, Obj, PPF_None) != nullptr;
}

/** Build a standard JSON success response. */
inline FString BuildSuccessResponse(const FString& CorrId, TSharedPtr<FJsonObject> Data)
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

/** Build a standard JSON error response. */
inline FString BuildErrorResponse(const FString& CorrId, const FString& Error)
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

/** Send a module_not_available error response for a named module. */
inline void SendModuleNotAvailable(FMCPResponseSender SendResponse, const FString& CorrId, const FString& ModuleName)
{
	TSharedPtr<FJsonObject> Obj = MakeShared<FJsonObject>();
	Obj->SetBoolField(TEXT("success"), false);
	Obj->SetStringField(TEXT("correlationId"), CorrId);
	Obj->SetStringField(TEXT("error"), TEXT("module_not_available"));
	Obj->SetStringField(TEXT("module"), ModuleName);

	FString Output;
	TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Output);
	FJsonSerializer::Serialize(Obj.ToSharedRef(), Writer);
	SendResponse(Output + TEXT("\n"));
}

} // namespace MCPReflect
