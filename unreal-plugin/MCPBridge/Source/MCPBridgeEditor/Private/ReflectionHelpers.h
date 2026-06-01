// ReflectionHelpers.h (Plan 33-01)
// Shared UE reflection utility functions for optional-plugin handlers.
// These helpers allow handlers to access UE types without compile-time
// dependencies on optional module headers.
//
// All functions in MCPReflect namespace are safe to call when the relevant
// modules are not loaded; they return empty strings, 0.0, false, or nullptr.

#pragma once

#include "CoreMinimal.h"
#include "Modules/ModuleManager.h"
#include "UObject/Class.h"
#include "UObject/UnrealType.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "MCPCommandRouter.h"

namespace MCPReflect
{
	/**
	 * Check whether an optional module is currently loaded.
	 * Returns true if the module is loaded and available.
	 */
	inline bool CheckModuleLoaded(const TCHAR* ModuleName)
	{
		return FModuleManager::Get().IsModuleLoaded(ModuleName);
	}

	/**
	 * Find a UClass by its full script path (e.g. "/Script/GameplayAbilities.GameplayAbility").
	 * Returns nullptr if the class is not found (module not loaded).
	 */
	inline UClass* FindClassByPath(const TCHAR* ClassPath)
	{
		return FindObject<UClass>(nullptr, ClassPath);
	}

	/**
	 * Read a FString property from a UObject by property name.
	 * Returns empty string if the property does not exist or is not a string type.
	 */
	inline FString GetStringProperty(UObject* Obj, FName PropName)
	{
		if (!Obj) return TEXT("");
		FProperty* Prop = Obj->GetClass()->FindPropertyByName(PropName);
		if (FStrProperty* StrProp = CastField<FStrProperty>(Prop))
		{
			return StrProp->GetPropertyValue_InContainer(Obj);
		}
		if (FNameProperty* NameProp = CastField<FNameProperty>(Prop))
		{
			return NameProp->GetPropertyValue_InContainer(Obj).ToString();
		}
		if (FTextProperty* TextProp = CastField<FTextProperty>(Prop))
		{
			return TextProp->GetPropertyValue_InContainer(Obj).ToString();
		}
		return TEXT("");
	}

	/**
	 * Read a double (float or double) property from a UObject by property name.
	 * Returns 0.0 if not found.
	 */
	inline double GetFloatProperty(UObject* Obj, FName PropName)
	{
		if (!Obj) return 0.0;
		FProperty* Prop = Obj->GetClass()->FindPropertyByName(PropName);
		if (FDoubleProperty* DoubleProp = CastField<FDoubleProperty>(Prop))
		{
			return DoubleProp->GetPropertyValue_InContainer(Obj);
		}
		if (FFloatProperty* FloatProp = CastField<FFloatProperty>(Prop))
		{
			return static_cast<double>(FloatProp->GetPropertyValue_InContainer(Obj));
		}
		return 0.0;
	}

	/**
	 * Read an integer property from a UObject by property name.
	 * Returns 0 if not found.
	 */
	inline int64 GetIntProperty(UObject* Obj, FName PropName)
	{
		if (!Obj) return 0;
		FProperty* Prop = Obj->GetClass()->FindPropertyByName(PropName);
		if (FNumericProperty* NumProp = CastField<FNumericProperty>(Prop))
		{
			if (NumProp->IsInteger())
			{
				const void* ValuePtr = NumProp->ContainerPtrToValuePtr<void>(Obj);
				return NumProp->GetSignedIntPropertyValue(ValuePtr);
			}
		}
		return 0;
	}

	/**
	 * Read a bool property from a UObject by property name.
	 * Returns false and sets OutValue=false if not found.
	 */
	inline bool GetBoolProperty(UObject* Obj, FName PropName, bool& OutValue)
	{
		if (!Obj) { OutValue = false; return false; }
		FProperty* Prop = Obj->GetClass()->FindPropertyByName(PropName);
		if (FBoolProperty* BoolProp = CastField<FBoolProperty>(Prop))
		{
			OutValue = BoolProp->GetPropertyValue_InContainer(Obj);
			return true;
		}
		OutValue = false;
		return false;
	}

	/**
	 * Read an object reference property from a UObject by property name.
	 * Returns nullptr if not found.
	 */
	inline UObject* GetObjectProperty(UObject* Obj, FName PropName)
	{
		if (!Obj) return nullptr;
		FProperty* Prop = Obj->GetClass()->FindPropertyByName(PropName);
		if (FObjectProperty* ObjProp = CastField<FObjectProperty>(Prop))
		{
			return ObjProp->GetObjectPropertyValue_InContainer(Obj);
		}
		return nullptr;
	}

	/**
	 * Export any property value as a text string using ExportTextItem_Direct.
	 * Returns empty string if property not found.
	 */
	inline FString ExportPropertyAsString(UObject* Obj, FName PropName)
	{
		if (!Obj) return TEXT("");
		FProperty* Prop = Obj->GetClass()->FindPropertyByName(PropName);
		if (!Prop) return TEXT("");
		FString OutStr;
		const void* ValuePtr = Prop->ContainerPtrToValuePtr<void>(Obj);
		Prop->ExportTextItem_Direct(OutStr, ValuePtr, nullptr, Obj, PPF_None);
		return OutStr;
	}

	/**
	 * Set a property on a UObject from a string value using ImportText_Direct.
	 * Returns true if successful, false if property not found.
	 */
	inline bool SetPropertyFromString(UObject* Obj, FName PropName, const FString& Value)
	{
		if (!Obj) return false;
		FProperty* Prop = Obj->GetClass()->FindPropertyByName(PropName);
		if (!Prop) return false;
		void* ValuePtr = Prop->ContainerPtrToValuePtr<void>(Obj);
		Prop->ImportText_Direct(*Value, ValuePtr, Obj, PPF_None);
		return true;
	}

	/** Build a standard MCP success JSON response. */
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

	/** Build a standard MCP error JSON response. */
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

	/** Send a module_not_available response for an optional module that is not loaded. */
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
