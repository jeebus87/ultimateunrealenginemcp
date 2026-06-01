// MCPLiveLinkCommands.cpp (Plan 33-02)
// Reflection-based Live Link command handlers for the MCP bridge.
// Implements four handlers:
//   livelink.sources   -- list all active Live Link sources with type, machine name, status (LL-01)
//   livelink.subjects  -- list all Live Link subjects with roles and enabled state (LL-02)
//   livelink.control   -- pause/resume individual Live Link subjects (LL-03)
//   livelink.preview   -- inspect current frame data for any Live Link subject (LL-04)
//
// All LiveLink types are accessed via UE reflection (FindObject<UClass>, FProperty, ProcessEvent)
// so no LiveLink module headers are needed at compile time.
// Handlers return module_not_available when the LiveLink plugin is not loaded.
// subject_name in livelink.control and livelink.preview is validated by exact match
// against live subject list (T-27-01).
// livelink.preview animation bone output is capped at 10 bones with total_bones count (T-27-02).

#include "MCPLiveLinkCommands.h"

// Core module -- always available
#include "Modules/ModuleManager.h"

// Editor world context
#include "Editor.h"

// UObject reflection -- always available
#include "UObject/UnrealType.h"
#include "UObject/PropertyPortFlags.h"
#include "UObject/UObjectGlobals.h"

// JSON -- always available via Json module
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Returns a JSON success response string. */
static FString BuildLiveLinkSuccessResponse(const FString& CorrId, TSharedPtr<FJsonObject> Data)
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

/** Returns a JSON error response string. */
static FString BuildLiveLinkErrorResponse(const FString& CorrId, const FString& Error)
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

/**
 * Checks that the LiveLink module is loaded.
 * Returns false and sends module_not_available if not loaded.
 */
static bool CheckLiveLinkAvailable(const FString& CorrId, FMCPResponseSender SendResponse)
{
	if (!FModuleManager::Get().IsModuleLoaded(TEXT("LiveLinkInterface")))
	{
		TSharedPtr<FJsonObject> Obj = MakeShared<FJsonObject>();
		Obj->SetBoolField(TEXT("success"), false);
		Obj->SetStringField(TEXT("correlationId"), CorrId);
		Obj->SetStringField(TEXT("error"), TEXT("module_not_available"));
		Obj->SetStringField(TEXT("module"), TEXT("LiveLinkInterface"));

		FString Output;
		TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Output);
		FJsonSerializer::Serialize(Obj.ToSharedRef(), Writer);
		SendResponse(Output);
		return false;
	}
	return true;
}

/**
 * Get the ULiveLinkSubsystem UClass by reflection path.
 * Returns nullptr if not found (plugin not enabled or not registered).
 */
static UClass* GetLiveLinkSubsystemClass()
{
	// ULiveLinkSubsystem is a UGameInstanceSubsystem in the LiveLink module.
	UClass* SubsystemClass = FindObject<UClass>(nullptr, TEXT("/Script/LiveLink.LiveLinkSubsystem"));
	return SubsystemClass;
}

/**
 * Get the ULiveLinkSubsystem instance from the editor's game instance.
 * Returns nullptr if the subsystem is not available.
 */
static UObject* GetLiveLinkSubsystem()
{
	if (!GEditor)
	{
		return nullptr;
	}

	UClass* SubsystemClass = GetLiveLinkSubsystemClass();
	if (!SubsystemClass)
	{
		return nullptr;
	}

	// Try to get the subsystem from the editor world's game instance.
	UWorld* World = GEditor->GetEditorWorldContext().World();
	if (World && World->GetGameInstance())
	{
		UObject* Subsystem = World->GetGameInstance()->GetSubsystemBase(SubsystemClass);
		if (Subsystem)
		{
			return Subsystem;
		}
	}

	// Also try from GEditor's play world.
	UWorld* PlayWorld = GEditor->PlayWorld;
	if (PlayWorld && PlayWorld->GetGameInstance())
	{
		UObject* Subsystem = PlayWorld->GetGameInstance()->GetSubsystemBase(SubsystemClass);
		if (Subsystem)
		{
			return Subsystem;
		}
	}

	return nullptr;
}

/**
 * Helper: read a string property from a UObject via FProperty reflection.
 */
static FString ReadStringProp(UObject* Obj, FName PropName)
{
	if (!Obj)
	{
		return FString();
	}
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
	return FString();
}

/**
 * Helper: read a bool property from a UStruct pointer.
 */
static bool ReadBoolPropFromContainer(FBoolProperty* BoolProp, void* Container)
{
	if (!BoolProp || !Container)
	{
		return false;
	}
	return BoolProp->GetPropertyValue_InContainer(Container);
}

/**
 * Helper: derive a role friendly name from a role class name string.
 */
static FString RoleClassNameToFriendlyName(const FString& ClassName)
{
	if (ClassName == TEXT("LiveLinkAnimationRole"))
	{
		return TEXT("Animation");
	}
	if (ClassName == TEXT("LiveLinkTransformRole"))
	{
		return TEXT("Transform");
	}
	if (ClassName == TEXT("LiveLinkCameraRole"))
	{
		return TEXT("Camera");
	}
	if (ClassName == TEXT("LiveLinkLightRole"))
	{
		return TEXT("Light");
	}
	return ClassName;
}

/** Serialize a FVector as a JSON object with x, y, z fields (reading from raw memory via FProperty). */
static TSharedPtr<FJsonObject> StructToJsonXYZ(void* StructPtr, UScriptStruct* Struct)
{
	TSharedPtr<FJsonObject> Obj = MakeShared<FJsonObject>();
	if (!StructPtr || !Struct)
	{
		return Obj;
	}
	static const TCHAR* Fields[] = { TEXT("X"), TEXT("Y"), TEXT("Z") };
	static const TCHAR* JsonNames[] = { TEXT("x"), TEXT("y"), TEXT("z") };
	for (int32 i = 0; i < 3; ++i)
	{
		FProperty* Prop = Struct->FindPropertyByName(FName(Fields[i]));
		if (FFloatProperty* FloatProp = CastField<FFloatProperty>(Prop))
		{
			Obj->SetNumberField(JsonNames[i], static_cast<double>(FloatProp->GetPropertyValue_InContainer(StructPtr)));
		}
		else if (FDoubleProperty* DoubleProp = CastField<FDoubleProperty>(Prop))
		{
			Obj->SetNumberField(JsonNames[i], DoubleProp->GetPropertyValue_InContainer(StructPtr));
		}
	}
	return Obj;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

void RegisterLiveLinkCommands(FMCPCommandRouter& Router)
{
	// -------------------------------------------------------------------------
	// livelink.sources (LL-01)
	// List all active Live Link sources with connection status, type, and machine name.
	// Payload: none (no required fields)
	// -------------------------------------------------------------------------
	Router.RegisterHandler(TEXT("livelink.sources"),
		[](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

		// Graceful degradation: check if Live Link plugin is enabled.
		if (!CheckLiveLinkAvailable(CorrId, SendResponse))
		{
			return;
		}

		// Try to get ULiveLinkSubsystem via reflection.
		UObject* Subsystem = GetLiveLinkSubsystem();

		TArray<TSharedPtr<FJsonValue>> SourceArray;

		if (Subsystem)
		{
			// Call GetSources() via reflection.
			// ULiveLinkSubsystem::GetSources returns TArray<FLiveLinkSourceInfo> or TArray<FGuid>.
			// We look for a UFUNCTION named GetSources.
			UFunction* GetSourcesFunc = Subsystem->GetClass()->FindFunctionByName(TEXT("GetSources"));
			if (GetSourcesFunc)
			{
				// Prepare output buffer.
				TArray<uint8> Params;
				Params.SetNumZeroed(GetSourcesFunc->ParmsSize);

				Subsystem->ProcessEvent(GetSourcesFunc, Params.GetData());

				// Extract the return value -- find the array return property.
				for (TFieldIterator<FProperty> ParamIt(GetSourcesFunc); ParamIt; ++ParamIt)
				{
					FProperty* Param = *ParamIt;
					if (!(Param->PropertyFlags & CPF_ReturnParm) && !(Param->PropertyFlags & CPF_OutParm))
					{
						continue;
					}

					FArrayProperty* ArrayProp = CastField<FArrayProperty>(Param);
					if (!ArrayProp)
					{
						continue;
					}

					void* ArrayAddr = Param->ContainerPtrToValuePtr<void>(Params.GetData());
					FScriptArrayHelper ArrayHelper(ArrayProp, ArrayAddr);

					FStructProperty* ElemStructProp = CastField<FStructProperty>(ArrayProp->Inner);

					for (int32 i = 0; i < ArrayHelper.Num(); ++i)
					{
						void* ElemPtr = ArrayHelper.GetRawPtr(i);
						TSharedPtr<FJsonObject> SourceObj = MakeShared<FJsonObject>();

						FString SourceId = TEXT("");
						FString SourceType = TEXT("");
						FString MachineName = TEXT("");
						FString Status = TEXT("active");

						if (ElemStructProp && ElemStructProp->Struct)
						{
							UScriptStruct* ElemStruct = ElemStructProp->Struct;

							// Try common property names for source info structs.
							auto ReadElemStr = [&](const TCHAR* Name) -> FString
							{
								FProperty* P = ElemStruct->FindPropertyByName(FName(Name));
								if (FStrProperty* SP = CastField<FStrProperty>(P))
								{
									return SP->GetPropertyValue_InContainer(ElemPtr);
								}
								if (FNameProperty* NP = CastField<FNameProperty>(P))
								{
									return NP->GetPropertyValue_InContainer(ElemPtr).ToString();
								}
								if (FTextProperty* TP = CastField<FTextProperty>(P))
								{
									return TP->GetPropertyValue_InContainer(ElemPtr).ToString();
								}
								return FString();
							};

							SourceId   = ReadElemStr(TEXT("SourceGuid"));
							if (SourceId.IsEmpty())
							{
								// FLiveLinkSourceInfo has a Guid field or similar.
								FProperty* GuidProp = ElemStruct->FindPropertyByName(TEXT("Guid"));
								if (!GuidProp) { GuidProp = ElemStruct->FindPropertyByName(TEXT("Id")); }
								if (!GuidProp) { GuidProp = ElemStruct->FindPropertyByName(TEXT("SourceGuid")); }
								if (GuidProp)
								{
									FString GuidStr;
									GuidProp->ExportTextItem_Direct(GuidStr, GuidProp->ContainerPtrToValuePtr<void>(ElemPtr), nullptr, nullptr, PPF_None);
									SourceId = GuidStr;
								}
							}

							SourceType  = ReadElemStr(TEXT("SourceType"));
							if (SourceType.IsEmpty()) { SourceType = ReadElemStr(TEXT("Type")); }

							MachineName = ReadElemStr(TEXT("MachineName"));
							if (MachineName.IsEmpty()) { MachineName = ReadElemStr(TEXT("SourceMachineName")); }

							Status = ReadElemStr(TEXT("Status"));
							if (Status.IsEmpty()) { Status = TEXT("active"); }
						}

						SourceObj->SetStringField(TEXT("source_id"),    SourceId);
						SourceObj->SetStringField(TEXT("source_type"),  SourceType);
						SourceObj->SetStringField(TEXT("machine_name"), MachineName);
						SourceObj->SetStringField(TEXT("status"),       Status);
						SourceArray.Add(MakeShared<FJsonValueObject>(SourceObj));
					}
					break; // Only process first matching array return param.
				}
			}
		}

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetArrayField(TEXT("sources"), SourceArray);
		Data->SetNumberField(TEXT("count"), static_cast<double>(SourceArray.Num()));

		if (SourceArray.Num() == 0 && !Subsystem)
		{
			Data->SetStringField(TEXT("message"),
				TEXT("Live Link plugin is enabled but subsystem is not active. Open a level or start PIE to activate Live Link."));
		}

		SendResponse(BuildLiveLinkSuccessResponse(CorrId, Data));
	});

	// -------------------------------------------------------------------------
	// livelink.subjects (LL-02)
	// List all Live Link subjects with their roles and enabled state.
	// Payload: none (no required fields)
	// -------------------------------------------------------------------------
	Router.RegisterHandler(TEXT("livelink.subjects"),
		[](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

		// Graceful degradation: check if Live Link plugin is enabled.
		if (!CheckLiveLinkAvailable(CorrId, SendResponse))
		{
			return;
		}

		UObject* Subsystem = GetLiveLinkSubsystem();

		TArray<TSharedPtr<FJsonValue>> SubjectArray;

		if (Subsystem)
		{
			// Call GetSubjects() via reflection.
			UFunction* GetSubjectsFunc = Subsystem->GetClass()->FindFunctionByName(TEXT("GetSubjects"));
			if (GetSubjectsFunc)
			{
				TArray<uint8> Params;
				Params.SetNumZeroed(GetSubjectsFunc->ParmsSize);

				// Set bIncludeDisabledSubjects = true if function has such a param.
				for (TFieldIterator<FProperty> ParamIt(GetSubjectsFunc); ParamIt && (ParamIt->PropertyFlags & CPF_Parm); ++ParamIt)
				{
					FProperty* Param = *ParamIt;
					if (Param->PropertyFlags & CPF_ReturnParm) { continue; }
					FString ParamName = Param->GetName();
					if (ParamName.Contains(TEXT("Disabled")) || ParamName.Contains(TEXT("IncludeDisabled")))
					{
						FBoolProperty* BoolParam = CastField<FBoolProperty>(Param);
						if (BoolParam)
						{
							BoolParam->SetPropertyValue(Params.GetData() + Param->GetOffset_ForInternal(), true);
						}
					}
					if (ParamName.Contains(TEXT("Virtual")) || ParamName.Contains(TEXT("IncludeVirtual")))
					{
						FBoolProperty* BoolParam = CastField<FBoolProperty>(Param);
						if (BoolParam)
						{
							BoolParam->SetPropertyValue(Params.GetData() + Param->GetOffset_ForInternal(), true);
						}
					}
				}

				Subsystem->ProcessEvent(GetSubjectsFunc, Params.GetData());

				// Extract returned array of subject keys / subject info.
				for (TFieldIterator<FProperty> ParamIt(GetSubjectsFunc); ParamIt; ++ParamIt)
				{
					FProperty* Param = *ParamIt;
					if (!(Param->PropertyFlags & CPF_ReturnParm) && !(Param->PropertyFlags & CPF_OutParm))
					{
						continue;
					}

					FArrayProperty* ArrayProp = CastField<FArrayProperty>(Param);
					if (!ArrayProp)
					{
						continue;
					}

					void* ArrayAddr = Param->ContainerPtrToValuePtr<void>(Params.GetData());
					FScriptArrayHelper ArrayHelper(ArrayProp, ArrayAddr);
					FStructProperty* ElemStructProp = CastField<FStructProperty>(ArrayProp->Inner);

					for (int32 i = 0; i < ArrayHelper.Num(); ++i)
					{
						void* ElemPtr = ArrayHelper.GetRawPtr(i);
						TSharedPtr<FJsonObject> SubjectObj = MakeShared<FJsonObject>();

						FString SubjectName = TEXT("");
						FString SourceId = TEXT("");
						FString RoleName = TEXT("Unknown");
						bool bEnabled = true;

						if (ElemStructProp && ElemStructProp->Struct)
						{
							UScriptStruct* ElemStruct = ElemStructProp->Struct;

							// Read subject name -- FLiveLinkSubjectKey has SubjectName (FLiveLinkSubjectName).
							FProperty* SubjectNameProp = ElemStruct->FindPropertyByName(TEXT("SubjectName"));
							if (SubjectNameProp)
							{
								// FLiveLinkSubjectName has a nested Name (FName).
								FStructProperty* SubjectNameStructProp = CastField<FStructProperty>(SubjectNameProp);
								if (SubjectNameStructProp && SubjectNameStructProp->Struct)
								{
									void* SubjectNamePtr = SubjectNameProp->ContainerPtrToValuePtr<void>(ElemPtr);
									FProperty* NameProp = SubjectNameStructProp->Struct->FindPropertyByName(TEXT("Name"));
									if (FNameProperty* NameNameProp = CastField<FNameProperty>(NameProp))
									{
										SubjectName = NameNameProp->GetPropertyValue_InContainer(SubjectNamePtr).ToString();
									}
									else if (FStrProperty* NameStrProp = CastField<FStrProperty>(NameProp))
									{
										SubjectName = NameStrProp->GetPropertyValue_InContainer(SubjectNamePtr);
									}
								}
								else if (FNameProperty* NameProp2 = CastField<FNameProperty>(SubjectNameProp))
								{
									SubjectName = NameProp2->GetPropertyValue_InContainer(ElemPtr).ToString();
								}
								else if (FStrProperty* StrProp = CastField<FStrProperty>(SubjectNameProp))
								{
									SubjectName = StrProp->GetPropertyValue_InContainer(ElemPtr);
								}
							}

							// Source GUID.
							FProperty* SourceProp = ElemStruct->FindPropertyByName(TEXT("Source"));
							if (SourceProp)
							{
								FString SourceStr;
								SourceProp->ExportTextItem_Direct(SourceStr, SourceProp->ContainerPtrToValuePtr<void>(ElemPtr), nullptr, nullptr, PPF_None);
								SourceId = SourceStr;
							}
						}

						// Query the subsystem for the subject settings to get the role.
						// Call GetSubjectSettings(SubjectKey) via reflection.
						UFunction* GetSettingsFunc = Subsystem->GetClass()->FindFunctionByName(TEXT("GetSubjectSettings"));
						if (GetSettingsFunc && ElemStructProp)
						{
							TArray<uint8> SettingsParams;
							SettingsParams.SetNumZeroed(GetSettingsFunc->ParmsSize);

							// Set the SubjectKey parameter.
							for (TFieldIterator<FProperty> PIt(GetSettingsFunc); PIt && (PIt->PropertyFlags & CPF_Parm); ++PIt)
							{
								FProperty* P = *PIt;
								if (P->PropertyFlags & CPF_ReturnParm) { continue; }
								FStructProperty* StructParam = CastField<FStructProperty>(P);
								if (StructParam && ElemStructProp->Struct == StructParam->Struct)
								{
									StructParam->CopyCompleteValue(SettingsParams.GetData() + P->GetOffset_ForInternal(), ElemPtr);
									break;
								}
							}

							Subsystem->ProcessEvent(GetSettingsFunc, SettingsParams.GetData());

							// Extract the returned UObject* (settings).
							for (TFieldIterator<FProperty> PIt(GetSettingsFunc); PIt; ++PIt)
							{
								FProperty* P = *PIt;
								if (!(P->PropertyFlags & CPF_ReturnParm) && !(P->PropertyFlags & CPF_OutParm))
								{
									continue;
								}
								FObjectProperty* ObjProp = CastField<FObjectProperty>(P);
								if (ObjProp)
								{
									UObject* Settings = ObjProp->GetObjectPropertyValue(SettingsParams.GetData() + P->GetOffset_ForInternal());
									if (Settings)
									{
										// Read Role property from ULiveLinkSubjectSettings.
										FProperty* RoleProp = Settings->GetClass()->FindPropertyByName(TEXT("Role"));
										if (FClassProperty* ClassProp = CastField<FClassProperty>(RoleProp))
										{
											UClass* RoleClass = Cast<UClass>(ClassProp->GetObjectPropertyValue_InContainer(Settings));
											if (RoleClass)
											{
												RoleName = RoleClassNameToFriendlyName(RoleClass->GetName());
											}
										}
										else if (FSoftClassProperty* SoftClassProp = CastField<FSoftClassProperty>(RoleProp))
										{
											// FSoftClassProperty inherits from FSoftObjectProperty whose
											// GetPropertyValue_InContainer returns FSoftObjectPtr (not
											// TSoftClassPtr<UObject>).  Use the FSoftObjectProperty API
											// to obtain the soft object path directly.
											const FSoftObjectPtr& SoftPtr = SoftClassProp->GetPropertyValue_InContainer(Settings);
											FString RoleClassName = SoftPtr.ToSoftObjectPath().GetAssetName();
											if (!RoleClassName.IsEmpty())
											{
												RoleName = RoleClassNameToFriendlyName(RoleClassName);
											}
										}
									}
									break;
								}
							}
						}

						// Check IsSubjectEnabled via reflection.
						UFunction* IsEnabledFunc = Subsystem->GetClass()->FindFunctionByName(TEXT("IsSubjectEnabled"));
						if (IsEnabledFunc && ElemStructProp)
						{
							TArray<uint8> EnabledParams;
							EnabledParams.SetNumZeroed(IsEnabledFunc->ParmsSize);

							// Set SubjectKey param.
							for (TFieldIterator<FProperty> PIt(IsEnabledFunc); PIt && (PIt->PropertyFlags & CPF_Parm); ++PIt)
							{
								FProperty* P = *PIt;
								if (P->PropertyFlags & CPF_ReturnParm) { continue; }
								FStructProperty* StructParam = CastField<FStructProperty>(P);
								if (StructParam && ElemStructProp->Struct == StructParam->Struct)
								{
									StructParam->CopyCompleteValue(EnabledParams.GetData() + P->GetOffset_ForInternal(), ElemPtr);
									break;
								}
							}

							Subsystem->ProcessEvent(IsEnabledFunc, EnabledParams.GetData());

							// Read bool return.
							for (TFieldIterator<FProperty> PIt(IsEnabledFunc); PIt; ++PIt)
							{
								FProperty* P = *PIt;
								if (P->PropertyFlags & CPF_ReturnParm)
								{
									if (FBoolProperty* BoolProp = CastField<FBoolProperty>(P))
									{
										bEnabled = BoolProp->GetPropertyValue(EnabledParams.GetData() + P->GetOffset_ForInternal());
									}
									break;
								}
							}
						}

						SubjectObj->SetStringField(TEXT("subject_name"), SubjectName);
						SubjectObj->SetStringField(TEXT("source_id"),    SourceId);
						SubjectObj->SetStringField(TEXT("role"),         RoleName);
						SubjectObj->SetBoolField  (TEXT("enabled"),      bEnabled);
						SubjectArray.Add(MakeShared<FJsonValueObject>(SubjectObj));
					}
					break;
				}
			}
		}

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetArrayField(TEXT("subjects"), SubjectArray);
		Data->SetNumberField(TEXT("count"), static_cast<double>(SubjectArray.Num()));

		if (SubjectArray.Num() == 0 && !Subsystem)
		{
			Data->SetStringField(TEXT("message"),
				TEXT("Live Link plugin is enabled but subsystem is not active. Open a level or start PIE to activate Live Link."));
		}

		SendResponse(BuildLiveLinkSuccessResponse(CorrId, Data));
	});

	// -------------------------------------------------------------------------
	// livelink.control (LL-03)
	// Pause/resume an individual Live Link subject by toggling its enabled state.
	// Payload: subject_name (string, required), enabled (bool, required)
	// T-27-01: subject_name is validated against GetSubjects() result before use.
	// -------------------------------------------------------------------------
	Router.RegisterHandler(TEXT("livelink.control"),
		[](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

		// Validate required fields.
		FString SubjectName;
		if (!Cmd->TryGetStringField(TEXT("subject_name"), SubjectName) || SubjectName.IsEmpty())
		{
			SendResponse(BuildLiveLinkErrorResponse(CorrId, TEXT("Missing required field: subject_name")));
			return;
		}

		bool bEnabled = true;
		if (!Cmd->TryGetBoolField(TEXT("enabled"), bEnabled))
		{
			SendResponse(BuildLiveLinkErrorResponse(CorrId, TEXT("Missing required field: enabled")));
			return;
		}

		// Graceful degradation: check if Live Link plugin is enabled.
		if (!CheckLiveLinkAvailable(CorrId, SendResponse))
		{
			return;
		}

		UObject* Subsystem = GetLiveLinkSubsystem();
		if (!Subsystem)
		{
			SendResponse(BuildLiveLinkErrorResponse(CorrId,
				TEXT("Live Link subsystem is not active. Open a level or start PIE to activate Live Link.")));
			return;
		}

		// T-27-01: Find subject by exact name match from GetSubjects() -- never use raw input as key.
		UFunction* GetSubjectsFunc = Subsystem->GetClass()->FindFunctionByName(TEXT("GetSubjects"));
		if (!GetSubjectsFunc)
		{
			SendResponse(BuildLiveLinkErrorResponse(CorrId, TEXT("GetSubjects function not found on LiveLink subsystem")));
			return;
		}

		TArray<uint8> SubjectsParams;
		SubjectsParams.SetNumZeroed(GetSubjectsFunc->ParmsSize);

		// Set bIncludeDisabledSubjects = true.
		for (TFieldIterator<FProperty> ParamIt(GetSubjectsFunc); ParamIt && (ParamIt->PropertyFlags & CPF_Parm); ++ParamIt)
		{
			FProperty* Param = *ParamIt;
			if (Param->PropertyFlags & CPF_ReturnParm) { continue; }
			FString ParamName = Param->GetName();
			if (ParamName.Contains(TEXT("Disabled")) || ParamName.Contains(TEXT("IncludeDisabled")))
			{
				if (FBoolProperty* BoolParam = CastField<FBoolProperty>(Param))
				{
					BoolParam->SetPropertyValue(SubjectsParams.GetData() + Param->GetOffset_ForInternal(), true);
				}
			}
			if (ParamName.Contains(TEXT("Virtual")) || ParamName.Contains(TEXT("IncludeVirtual")))
			{
				if (FBoolProperty* BoolParam = CastField<FBoolProperty>(Param))
				{
					BoolParam->SetPropertyValue(SubjectsParams.GetData() + Param->GetOffset_ForInternal(), true);
				}
			}
		}

		Subsystem->ProcessEvent(GetSubjectsFunc, SubjectsParams.GetData());

		// Find the subject key matching SubjectName.
		bool bFound = false;
		for (TFieldIterator<FProperty> ParamIt(GetSubjectsFunc); ParamIt; ++ParamIt)
		{
			FProperty* Param = *ParamIt;
			if (!(Param->PropertyFlags & CPF_ReturnParm) && !(Param->PropertyFlags & CPF_OutParm))
			{
				continue;
			}

			FArrayProperty* ArrayProp = CastField<FArrayProperty>(Param);
			if (!ArrayProp) { continue; }

			void* ArrayAddr = Param->ContainerPtrToValuePtr<void>(SubjectsParams.GetData());
			FScriptArrayHelper ArrayHelper(ArrayProp, ArrayAddr);
			FStructProperty* ElemStructProp = CastField<FStructProperty>(ArrayProp->Inner);
			if (!ElemStructProp) { break; }

			for (int32 i = 0; i < ArrayHelper.Num(); ++i)
			{
				void* ElemPtr = ArrayHelper.GetRawPtr(i);

				// Extract the subject name from this key.
				FString ThisSubjectName;
				FProperty* SubjectNameProp = ElemStructProp->Struct->FindPropertyByName(TEXT("SubjectName"));
				if (SubjectNameProp)
				{
					FStructProperty* SubjectNameStructProp = CastField<FStructProperty>(SubjectNameProp);
					if (SubjectNameStructProp && SubjectNameStructProp->Struct)
					{
						void* SubjectNamePtr = SubjectNameProp->ContainerPtrToValuePtr<void>(ElemPtr);
						FProperty* NameProp = SubjectNameStructProp->Struct->FindPropertyByName(TEXT("Name"));
						if (FNameProperty* NameNameProp = CastField<FNameProperty>(NameProp))
						{
							ThisSubjectName = NameNameProp->GetPropertyValue_InContainer(SubjectNamePtr).ToString();
						}
					}
					else if (FNameProperty* NameProp2 = CastField<FNameProperty>(SubjectNameProp))
					{
						ThisSubjectName = NameProp2->GetPropertyValue_InContainer(ElemPtr).ToString();
					}
				}

				if (ThisSubjectName != SubjectName)
				{
					continue;
				}

				// Found the subject. Call SetSubjectEnabled via reflection.
				UFunction* SetEnabledFunc = Subsystem->GetClass()->FindFunctionByName(TEXT("SetSubjectEnabled"));
				if (!SetEnabledFunc)
				{
					SendResponse(BuildLiveLinkErrorResponse(CorrId,
						FString::Printf(TEXT("SetSubjectEnabled function not found for subject: %s"), *SubjectName)));
					return;
				}

				TArray<uint8> EnableParams;
				EnableParams.SetNumZeroed(SetEnabledFunc->ParmsSize);

				// Set SubjectKey and bEnabled parameters.
				for (TFieldIterator<FProperty> PIt(SetEnabledFunc); PIt && (PIt->PropertyFlags & CPF_Parm); ++PIt)
				{
					FProperty* P = *PIt;
					if (P->PropertyFlags & CPF_ReturnParm) { continue; }
					FStructProperty* StructParam = CastField<FStructProperty>(P);
					if (StructParam && StructParam->Struct == ElemStructProp->Struct)
					{
						StructParam->CopyCompleteValue(EnableParams.GetData() + P->GetOffset_ForInternal(), ElemPtr);
					}
					else if (FBoolProperty* BoolParam = CastField<FBoolProperty>(P))
					{
						BoolParam->SetPropertyValue(EnableParams.GetData() + P->GetOffset_ForInternal(), bEnabled);
					}
				}

				Subsystem->ProcessEvent(SetEnabledFunc, EnableParams.GetData());

				const FString StateMessage = bEnabled
					? TEXT("Subject resumed")
					: TEXT("Subject paused");

				TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
				Data->SetStringField(TEXT("subject_name"), SubjectName);
				Data->SetBoolField  (TEXT("enabled"),      bEnabled);
				Data->SetStringField(TEXT("message"),      StateMessage);

				SendResponse(BuildLiveLinkSuccessResponse(CorrId, Data));
				bFound = true;
				break;
			}
			break;
		}

		if (!bFound)
		{
			SendResponse(BuildLiveLinkErrorResponse(CorrId,
				FString::Printf(TEXT("Subject not found: %s"), *SubjectName)));
		}
	});

	// -------------------------------------------------------------------------
	// livelink.preview (LL-04)
	// Inspect the current frame data for any Live Link subject.
	// Payload: subject_name (string, required)
	// T-27-01: subject_name validated against GetSubjects() result.
	// T-27-02: Animation bone output capped at 10 bones; total_bones count always included.
	// -------------------------------------------------------------------------
	Router.RegisterHandler(TEXT("livelink.preview"),
		[](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

		// Validate required field.
		FString SubjectName;
		if (!Cmd->TryGetStringField(TEXT("subject_name"), SubjectName) || SubjectName.IsEmpty())
		{
			SendResponse(BuildLiveLinkErrorResponse(CorrId, TEXT("Missing required field: subject_name")));
			return;
		}

		// Graceful degradation: check if Live Link plugin is enabled.
		if (!CheckLiveLinkAvailable(CorrId, SendResponse))
		{
			return;
		}

		UObject* Subsystem = GetLiveLinkSubsystem();
		if (!Subsystem)
		{
			SendResponse(BuildLiveLinkErrorResponse(CorrId,
				TEXT("Live Link subsystem is not active. Open a level or start PIE to activate Live Link.")));
			return;
		}

		// T-27-01: Find subject by exact name match from GetSubjects() -- never use raw input as key.
		UFunction* GetSubjectsFunc = Subsystem->GetClass()->FindFunctionByName(TEXT("GetSubjects"));
		if (!GetSubjectsFunc)
		{
			SendResponse(BuildLiveLinkErrorResponse(CorrId, TEXT("GetSubjects function not found on LiveLink subsystem")));
			return;
		}

		TArray<uint8> SubjectsParams;
		SubjectsParams.SetNumZeroed(GetSubjectsFunc->ParmsSize);

		// Include disabled/virtual subjects.
		for (TFieldIterator<FProperty> ParamIt(GetSubjectsFunc); ParamIt && (ParamIt->PropertyFlags & CPF_Parm); ++ParamIt)
		{
			FProperty* Param = *ParamIt;
			if (Param->PropertyFlags & CPF_ReturnParm) { continue; }
			FString ParamName = Param->GetName();
			if (ParamName.Contains(TEXT("Disabled")) || ParamName.Contains(TEXT("Virtual")))
			{
				if (FBoolProperty* BoolParam = CastField<FBoolProperty>(Param))
				{
					BoolParam->SetPropertyValue(SubjectsParams.GetData() + Param->GetOffset_ForInternal(), true);
				}
			}
		}

		Subsystem->ProcessEvent(GetSubjectsFunc, SubjectsParams.GetData());

		bool bFound = false;
		for (TFieldIterator<FProperty> ParamIt(GetSubjectsFunc); ParamIt; ++ParamIt)
		{
			FProperty* Param = *ParamIt;
			if (!(Param->PropertyFlags & CPF_ReturnParm) && !(Param->PropertyFlags & CPF_OutParm))
			{
				continue;
			}

			FArrayProperty* ArrayProp = CastField<FArrayProperty>(Param);
			if (!ArrayProp) { continue; }

			void* ArrayAddr = Param->ContainerPtrToValuePtr<void>(SubjectsParams.GetData());
			FScriptArrayHelper ArrayHelper(ArrayProp, ArrayAddr);
			FStructProperty* ElemStructProp = CastField<FStructProperty>(ArrayProp->Inner);
			if (!ElemStructProp) { break; }

			for (int32 i = 0; i < ArrayHelper.Num(); ++i)
			{
				void* ElemPtr = ArrayHelper.GetRawPtr(i);

				// Extract this element's subject name.
				FString ThisSubjectName;
				FProperty* SubjectNameProp = ElemStructProp->Struct->FindPropertyByName(TEXT("SubjectName"));
				if (SubjectNameProp)
				{
					FStructProperty* SubjectNameStructProp = CastField<FStructProperty>(SubjectNameProp);
					if (SubjectNameStructProp && SubjectNameStructProp->Struct)
					{
						void* SubjectNamePtr = SubjectNameProp->ContainerPtrToValuePtr<void>(ElemPtr);
						FProperty* NameProp = SubjectNameStructProp->Struct->FindPropertyByName(TEXT("Name"));
						if (FNameProperty* NameNameProp = CastField<FNameProperty>(NameProp))
						{
							ThisSubjectName = NameNameProp->GetPropertyValue_InContainer(SubjectNamePtr).ToString();
						}
					}
					else if (FNameProperty* NameProp2 = CastField<FNameProperty>(SubjectNameProp))
					{
						ThisSubjectName = NameProp2->GetPropertyValue_InContainer(ElemPtr).ToString();
					}
				}

				if (ThisSubjectName != SubjectName)
				{
					continue;
				}

				bFound = true;

				// Determine role from settings.
				FString RoleName = TEXT("Unknown");
				UFunction* GetSettingsFunc = Subsystem->GetClass()->FindFunctionByName(TEXT("GetSubjectSettings"));
				if (GetSettingsFunc)
				{
					TArray<uint8> SettingsParams;
					SettingsParams.SetNumZeroed(GetSettingsFunc->ParmsSize);

					for (TFieldIterator<FProperty> PIt(GetSettingsFunc); PIt && (PIt->PropertyFlags & CPF_Parm); ++PIt)
					{
						FProperty* P = *PIt;
						if (P->PropertyFlags & CPF_ReturnParm) { continue; }
						FStructProperty* StructParam = CastField<FStructProperty>(P);
						if (StructParam && ElemStructProp->Struct == StructParam->Struct)
						{
							StructParam->CopyCompleteValue(SettingsParams.GetData() + P->GetOffset_ForInternal(), ElemPtr);
							break;
						}
					}

					Subsystem->ProcessEvent(GetSettingsFunc, SettingsParams.GetData());

					for (TFieldIterator<FProperty> PIt(GetSettingsFunc); PIt; ++PIt)
					{
						FProperty* P = *PIt;
						if (!(P->PropertyFlags & CPF_ReturnParm) && !(P->PropertyFlags & CPF_OutParm)) { continue; }
						FObjectProperty* ObjProp = CastField<FObjectProperty>(P);
						if (ObjProp)
						{
							UObject* Settings = ObjProp->GetObjectPropertyValue(SettingsParams.GetData() + P->GetOffset_ForInternal());
							if (Settings)
							{
								FProperty* RoleProp = Settings->GetClass()->FindPropertyByName(TEXT("Role"));
								if (FClassProperty* ClassProp = CastField<FClassProperty>(RoleProp))
								{
									UClass* RoleClass = Cast<UClass>(ClassProp->GetObjectPropertyValue_InContainer(Settings));
									if (RoleClass)
									{
										RoleName = RoleClassNameToFriendlyName(RoleClass->GetName());
									}
								}
							}
							break;
						}
					}
				}

				// Call EvaluateFrame or GetSubjectStaticData/FrameData via reflection.
				// ULiveLinkSubsystem exposes EvaluateFrame(SubjectName, RoleClass) -> FLiveLinkSubjectFrameData.
				// We'll call a simpler function if available: GetSubjectData or similar.
				TSharedPtr<FJsonObject> FrameDataObj = MakeShared<FJsonObject>();

				// Try EvaluateFrameAtWorldTime or GetSubjectData via reflection.
				// Since we can't parse the struct without knowing its layout precisely,
				// we try to call EvaluateFrame with the SubjectName (FLiveLinkSubjectName) parameter.
				UFunction* EvaluateFunc = Subsystem->GetClass()->FindFunctionByName(TEXT("EvaluateFrame"));
				if (!EvaluateFunc)
				{
					EvaluateFunc = Subsystem->GetClass()->FindFunctionByName(TEXT("GetSubjectData"));
				}

				if (EvaluateFunc)
				{
					TArray<uint8> EvalParams;
					EvalParams.SetNumZeroed(EvaluateFunc->ParmsSize);

					// Set SubjectName param -- find FLiveLinkSubjectName or FName param.
					for (TFieldIterator<FProperty> PIt(EvaluateFunc); PIt && (PIt->PropertyFlags & CPF_Parm); ++PIt)
					{
						FProperty* P = *PIt;
						if (P->PropertyFlags & CPF_ReturnParm) { continue; }
						FStructProperty* StructParam = CastField<FStructProperty>(P);
						if (StructParam && ElemStructProp->Struct == StructParam->Struct)
						{
							// Pass the full SubjectKey.
							StructParam->CopyCompleteValue(EvalParams.GetData() + P->GetOffset_ForInternal(), ElemPtr);
						}
						else if (FNameProperty* NameParam = CastField<FNameProperty>(P))
						{
							NameParam->SetPropertyValue(EvalParams.GetData() + P->GetOffset_ForInternal(), FName(*SubjectName));
						}
					}

					Subsystem->ProcessEvent(EvaluateFunc, EvalParams.GetData());

					// Extract the output frame data struct.
					for (TFieldIterator<FProperty> PIt(EvaluateFunc); PIt; ++PIt)
					{
						FProperty* P = *PIt;
						if (!(P->PropertyFlags & CPF_ReturnParm) && !(P->PropertyFlags & CPF_OutParm)) { continue; }

						FStructProperty* StructReturn = CastField<FStructProperty>(P);
						if (StructReturn && StructReturn->Struct)
						{
							void* FramePtr = EvalParams.GetData() + P->GetOffset_ForInternal();
							UScriptStruct* FrameStruct = StructReturn->Struct;

							FrameDataObj->SetBoolField(TEXT("available"), true);

							// Try to extract transform from frame data.
							// Look for a Transforms array or Transform property.
							FArrayProperty* TransformsArrayProp = CastField<FArrayProperty>(FrameStruct->FindPropertyByName(TEXT("Transforms")));
							if (TransformsArrayProp)
							{
								// T-27-02: Cap at 10 bone transforms.
								void* TransformsAddr = TransformsArrayProp->ContainerPtrToValuePtr<void>(FramePtr);
								FScriptArrayHelper TransformsHelper(TransformsArrayProp, TransformsAddr);

								FrameDataObj->SetNumberField(TEXT("total_bones"), static_cast<double>(TransformsHelper.Num()));

								FStructProperty* TransformElemProp = CastField<FStructProperty>(TransformsArrayProp->Inner);
								if (TransformElemProp && TransformElemProp->Struct)
								{
									const int32 PreviewCount = FMath::Min(TransformsHelper.Num(), 10);
									TArray<TSharedPtr<FJsonValue>> BoneTransforms;
									for (int32 BoneIdx = 0; BoneIdx < PreviewCount; ++BoneIdx)
									{
										void* TransformPtr = TransformsHelper.GetRawPtr(BoneIdx);
										TSharedPtr<FJsonObject> BoneObj = MakeShared<FJsonObject>();
										BoneObj->SetStringField(TEXT("bone_name"),
											FString::Printf(TEXT("Bone_%d"), BoneIdx));

										// Extract translation/location from FTransform.
										FProperty* TranslationProp = TransformElemProp->Struct->FindPropertyByName(TEXT("Translation"));
										if (!TranslationProp) { TranslationProp = TransformElemProp->Struct->FindPropertyByName(TEXT("Location")); }
										FStructProperty* TranslationStructProp = CastField<FStructProperty>(TranslationProp);
										if (TranslationStructProp)
										{
											void* TranslationPtr = TranslationStructProp->ContainerPtrToValuePtr<void>(TransformPtr);
											BoneObj->SetObjectField(TEXT("location"), StructToJsonXYZ(TranslationPtr, TranslationStructProp->Struct));
										}
										BoneTransforms.Add(MakeShared<FJsonValueObject>(BoneObj));
									}
									FrameDataObj->SetArrayField(TEXT("bone_transforms"), BoneTransforms);
									FrameDataObj->SetNumberField(TEXT("preview_bone_count"), static_cast<double>(PreviewCount));
								}
							}
							else
							{
								// Single transform (e.g. FLiveLinkTransformFrameData).
								FStructProperty* TransformStructProp = CastField<FStructProperty>(FrameStruct->FindPropertyByName(TEXT("Transform")));
								if (TransformStructProp)
								{
									void* TransformPtr = TransformStructProp->ContainerPtrToValuePtr<void>(FramePtr);
									UScriptStruct* TransformStruct = TransformStructProp->Struct;

									TSharedPtr<FJsonObject> TransformObj = MakeShared<FJsonObject>();
									FProperty* TranslProp = TransformStruct->FindPropertyByName(TEXT("Translation"));
									if (!TranslProp) { TranslProp = TransformStruct->FindPropertyByName(TEXT("Location")); }
									if (FStructProperty* TranslStructProp = CastField<FStructProperty>(TranslProp))
									{
										TransformObj->SetObjectField(TEXT("location"),
											StructToJsonXYZ(TranslStructProp->ContainerPtrToValuePtr<void>(TransformPtr), TranslStructProp->Struct));
									}
									FrameDataObj->SetObjectField(TEXT("transform"), TransformObj);
								}
							}

							// Read FoV, aspect ratio for camera frames.
							auto TryReadDouble = [&](const TCHAR* FieldName) -> double
							{
								FProperty* FP = FrameStruct->FindPropertyByName(FName(FieldName));
								if (FFloatProperty* FloatP = CastField<FFloatProperty>(FP))
								{
									return static_cast<double>(FloatP->GetPropertyValue_InContainer(FramePtr));
								}
								if (FDoubleProperty* DoubleP = CastField<FDoubleProperty>(FP))
								{
									return DoubleP->GetPropertyValue_InContainer(FramePtr);
								}
								return -1.0;
							};

							double FieldOfView = TryReadDouble(TEXT("FieldOfView"));
							if (FieldOfView >= 0.0) { FrameDataObj->SetNumberField(TEXT("field_of_view"), FieldOfView); }

							double AspectRatio = TryReadDouble(TEXT("AspectRatio"));
							if (AspectRatio >= 0.0) { FrameDataObj->SetNumberField(TEXT("aspect_ratio"), AspectRatio); }

							double FocalLength = TryReadDouble(TEXT("FocalLength"));
							if (FocalLength >= 0.0) { FrameDataObj->SetNumberField(TEXT("focal_length"), FocalLength); }
						}
						break;
					}
				}
				else
				{
					// EvaluateFrame not found -- report limited info.
					FrameDataObj->SetBoolField(TEXT("available"), false);
					FrameDataObj->SetStringField(TEXT("message"),
						TEXT("No frame evaluation function found on LiveLink subsystem."));
				}

				TSharedPtr<FJsonObject> ResponseData = MakeShared<FJsonObject>();
				ResponseData->SetStringField(TEXT("subject_name"), SubjectName);
				ResponseData->SetStringField(TEXT("role"),         RoleName);
				ResponseData->SetObjectField(TEXT("frame_data"),   FrameDataObj);

				SendResponse(BuildLiveLinkSuccessResponse(CorrId, ResponseData));
				break;
			}
			break;
		}

		if (!bFound)
		{
			SendResponse(BuildLiveLinkErrorResponse(CorrId,
				FString::Printf(TEXT("Subject not found: %s"), *SubjectName)));
		}
	});
}
