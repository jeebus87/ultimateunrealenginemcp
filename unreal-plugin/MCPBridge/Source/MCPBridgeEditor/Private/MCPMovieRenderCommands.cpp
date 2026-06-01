// MCPMovieRenderCommands.cpp (Plan 33-02)
// Reflection-based Movie Render Pipeline command handlers for the MCP bridge.
// Implements four handlers:
//   movierender.queue     -- list render queue jobs with status and output settings (MRP-01)
//   movierender.addJob    -- add a render job with sequence, format, resolution, frame range (MRP-02)
//   movierender.control   -- start/stop render queue execution and query progress (MRP-03)
//   movierender.configure -- set burn-in text, EXR metadata, and filename format tokens (MRP-04)
//
// All MovieRenderPipeline types are accessed via UE reflection (FindObject<UClass>, FProperty,
// ProcessEvent) so no MovieRenderPipeline module headers are needed at compile time.
// Handlers return module_not_available when the MovieRenderPipelineCore plugin is not loaded.
// sequence_path is validated to start with "/Game/" or "/Engine/" (T-29-01).

#include "MCPMovieRenderCommands.h"

#include "Editor.h"

// Core modules -- always available
#include "Modules/ModuleManager.h"
#include "UObject/UnrealType.h"
#include "UObject/PropertyPortFlags.h"
#include "UObject/UObjectGlobals.h"

// JSON -- always available
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Returns a JSON success response string (without trailing newline). */
static FString BuildMrpSuccessResponse(const FString& CorrId, TSharedPtr<FJsonObject> Data)
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
static FString BuildMrpErrorResponse(const FString& CorrId, const FString& Error)
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
 * Validate that asset_path starts with "/Game/" or "/Engine/" to prevent
 * path traversal attacks (T-29-01).
 */
static bool IsValidMrpAssetPath(const FString& AssetPath)
{
	return AssetPath.StartsWith(TEXT("/Game/")) || AssetPath.StartsWith(TEXT("/Engine/"));
}

/**
 * Check that MovieRenderPipelineCore module is loaded.
 * Returns false and sends module_not_available error if not.
 */
static bool CheckMovieRenderAvailable(const FString& CorrId, FMCPResponseSender SendResponse)
{
	if (!FModuleManager::Get().IsModuleLoaded(TEXT("MovieRenderPipelineCore")))
	{
		TSharedPtr<FJsonObject> Obj = MakeShared<FJsonObject>();
		Obj->SetBoolField(TEXT("success"), false);
		Obj->SetStringField(TEXT("correlationId"), CorrId);
		Obj->SetStringField(TEXT("error"), TEXT("module_not_available"));
		Obj->SetStringField(TEXT("module"), TEXT("MovieRenderPipelineCore"));

		FString Output;
		TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Output);
		FJsonSerializer::Serialize(Obj.ToSharedRef(), Writer);
		SendResponse(Output);
		return false;
	}
	return true;
}

/**
 * Helper: get the UMoviePipelineQueueSubsystem instance via reflection.
 * Returns nullptr if the module is not loaded or the subsystem is unavailable.
 */
static UObject* GetMoviePipelineQueueSubsystem()
{
	if (!GEditor)
	{
		return nullptr;
	}

	UClass* SubsystemClass = FindObject<UClass>(nullptr, TEXT("/Script/MovieRenderPipelineCore.MoviePipelineQueueSubsystem"));
	if (!SubsystemClass)
	{
		return nullptr;
	}

	return GEditor->GetEditorSubsystemBase(SubsystemClass);
}

/**
 * Helper: read a string property from a struct pointer by field name.
 */
static FString ReadStructStringProp(void* Container, UScriptStruct* Struct, const TCHAR* PropName)
{
	if (!Container || !Struct) { return FString(); }
	FProperty* Prop = Struct->FindPropertyByName(FName(PropName));
	if (!Prop) { return FString(); }
	if (FStrProperty* StrProp = CastField<FStrProperty>(Prop))
	{
		return StrProp->GetPropertyValue_InContainer(Container);
	}
	if (FNameProperty* NameProp = CastField<FNameProperty>(Prop))
	{
		return NameProp->GetPropertyValue_InContainer(Container).ToString();
	}
	if (FTextProperty* TextProp = CastField<FTextProperty>(Prop))
	{
		return TextProp->GetPropertyValue_InContainer(Container).ToString();
	}
	FString Out;
	Prop->ExportTextItem_Direct(Out, Prop->ContainerPtrToValuePtr<void>(Container), nullptr, nullptr, PPF_None);
	return Out;
}

/**
 * Helper: read a string property from a UObject by field name.
 */
static FString ReadObjStringProp(UObject* Obj, const TCHAR* PropName)
{
	if (!Obj) { return FString(); }
	return ReadStructStringProp(Obj, nullptr, PropName);
}

/**
 * Helper: call a UFUNCTION on a UObject and return the UObject* return value.
 */
static UObject* CallFuncReturnObj(UObject* Obj, const TCHAR* FuncName)
{
	if (!Obj) { return nullptr; }
	UFunction* Func = Obj->GetClass()->FindFunctionByName(FName(FuncName));
	if (!Func) { return nullptr; }

	TArray<uint8> Params;
	Params.SetNumZeroed(Func->ParmsSize);
	Obj->ProcessEvent(Func, Params.GetData());

	for (TFieldIterator<FProperty> PIt(Func); PIt; ++PIt)
	{
		FProperty* P = *PIt;
		if (P->PropertyFlags & CPF_ReturnParm)
		{
			if (FObjectProperty* ObjProp = CastField<FObjectProperty>(P))
			{
				return ObjProp->GetObjectPropertyValue(Params.GetData() + P->GetOffset_ForInternal());
			}
			break;
		}
	}
	return nullptr;
}

/**
 * Helper: call a UFUNCTION on a UObject and return a bool value.
 */
static bool CallFuncReturnBool(UObject* Obj, const TCHAR* FuncName, bool DefaultVal = false)
{
	if (!Obj) { return DefaultVal; }
	UFunction* Func = Obj->GetClass()->FindFunctionByName(FName(FuncName));
	if (!Func) { return DefaultVal; }

	TArray<uint8> Params;
	Params.SetNumZeroed(Func->ParmsSize);
	Obj->ProcessEvent(Func, Params.GetData());

	for (TFieldIterator<FProperty> PIt(Func); PIt; ++PIt)
	{
		FProperty* P = *PIt;
		if (P->PropertyFlags & CPF_ReturnParm)
		{
			if (FBoolProperty* BoolProp = CastField<FBoolProperty>(P))
			{
				return BoolProp->GetPropertyValue(Params.GetData() + P->GetOffset_ForInternal());
			}
			break;
		}
	}
	return DefaultVal;
}

/**
 * Helper: read a string property from a UObject by field name (via the object's class).
 */
static FString ReadUObjectStringProp(UObject* Obj, const TCHAR* PropName)
{
	if (!Obj) { return FString(); }
	FProperty* Prop = Obj->GetClass()->FindPropertyByName(FName(PropName));
	if (!Prop) { return FString(); }
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
	// For FSoftObjectPath, FIntPoint, etc. export as text.
	FString Out;
	Prop->ExportTextItem_Direct(Out, Prop->ContainerPtrToValuePtr<void>(Obj), nullptr, nullptr, PPF_None);
	return Out;
}

/**
 * Helper: get int property from UObject.
 */
static int32 ReadUObjectInt32Prop(UObject* Obj, const TCHAR* PropName, int32 Default = 0)
{
	if (!Obj) { return Default; }
	FProperty* Prop = Obj->GetClass()->FindPropertyByName(FName(PropName));
	if (!Prop) { return Default; }
	if (FIntProperty* IntProp = CastField<FIntProperty>(Prop))
	{
		return IntProp->GetPropertyValue_InContainer(Obj);
	}
	if (FInt64Property* Int64Prop = CastField<FInt64Property>(Prop))
	{
		return static_cast<int32>(Int64Prop->GetPropertyValue_InContainer(Obj));
	}
	return Default;
}

/**
 * Determine job status string from a UMoviePipelineExecutorJob UObject.
 * Reads IsConsumed() and IsEnabled() via reflection.
 */
static FString GetJobStatusStringReflected(UObject* Job)
{
	if (!Job) { return TEXT("unknown"); }

	if (CallFuncReturnBool(Job, TEXT("IsConsumed")))
	{
		return TEXT("in_progress");
	}
	if (!CallFuncReturnBool(Job, TEXT("IsEnabled"), true))
	{
		return TEXT("disabled");
	}
	return TEXT("pending");
}

/**
 * Helper: find the UMoviePipelineOutputSetting on a UMoviePipelinePrimaryConfig
 * using FindSetting function via reflection.
 */
static UObject* FindOrAddSettingByClass(UObject* Config, UClass* SettingClass)
{
	if (!Config || !SettingClass) { return nullptr; }

	// Try FindOrAddSettingByClass(UClass*) UFUNCTION.
	UFunction* FindOrAddFunc = Config->GetClass()->FindFunctionByName(TEXT("FindOrAddSettingByClass"));
	if (FindOrAddFunc)
	{
		TArray<uint8> Params;
		Params.SetNumZeroed(FindOrAddFunc->ParmsSize);

		for (TFieldIterator<FProperty> PIt(FindOrAddFunc); PIt && (PIt->PropertyFlags & CPF_Parm); ++PIt)
		{
			FProperty* P = *PIt;
			if (P->PropertyFlags & CPF_ReturnParm) { continue; }
			if (FClassProperty* ClassParam = CastField<FClassProperty>(P))
			{
				ClassParam->SetObjectPropertyValue(Params.GetData() + P->GetOffset_ForInternal(), SettingClass);
				break;
			}
		}

		Config->ProcessEvent(FindOrAddFunc, Params.GetData());

		for (TFieldIterator<FProperty> PIt(FindOrAddFunc); PIt; ++PIt)
		{
			FProperty* P = *PIt;
			if (P->PropertyFlags & CPF_ReturnParm)
			{
				if (FObjectProperty* ObjProp = CastField<FObjectProperty>(P))
				{
					return ObjProp->GetObjectPropertyValue(Params.GetData() + P->GetOffset_ForInternal());
				}
				break;
			}
		}
	}

	// Fallback: try FindSetting(UClass*).
	UFunction* FindSettingFunc = Config->GetClass()->FindFunctionByName(TEXT("FindSetting"));
	if (FindSettingFunc)
	{
		TArray<uint8> Params;
		Params.SetNumZeroed(FindSettingFunc->ParmsSize);

		for (TFieldIterator<FProperty> PIt(FindSettingFunc); PIt && (PIt->PropertyFlags & CPF_Parm); ++PIt)
		{
			FProperty* P = *PIt;
			if (P->PropertyFlags & CPF_ReturnParm) { continue; }
			if (FClassProperty* ClassParam = CastField<FClassProperty>(P))
			{
				ClassParam->SetObjectPropertyValue(Params.GetData() + P->GetOffset_ForInternal(), SettingClass);
				break;
			}
		}

		Config->ProcessEvent(FindSettingFunc, Params.GetData());

		for (TFieldIterator<FProperty> PIt(FindSettingFunc); PIt; ++PIt)
		{
			FProperty* P = *PIt;
			if (P->PropertyFlags & CPF_ReturnParm)
			{
				if (FObjectProperty* ObjProp = CastField<FObjectProperty>(P))
				{
					return ObjProp->GetObjectPropertyValue(Params.GetData() + P->GetOffset_ForInternal());
				}
				break;
			}
		}
	}

	return nullptr;
}

// ---------------------------------------------------------------------------
// RegisterMovieRenderCommands
// ---------------------------------------------------------------------------

void RegisterMovieRenderCommands(FMCPCommandRouter& Router)
{
	// -----------------------------------------------------------------------
	// movierender.queue (MRP-01)
	// Returns all jobs in the render queue with status, sequence path, output
	// settings, and progress information.
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("movierender.queue"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

		if (!CheckMovieRenderAvailable(CorrId, SendResponse)) { return; }

		if (!GEditor)
		{
			SendResponse(BuildMrpErrorResponse(CorrId, TEXT("subsystem_unavailable")) + TEXT("\n"));
			return;
		}

		UObject* QueueSubsystem = GetMoviePipelineQueueSubsystem();
		if (!QueueSubsystem)
		{
			SendResponse(BuildMrpErrorResponse(CorrId, TEXT("subsystem_unavailable")) + TEXT("\n"));
			return;
		}

		// Call GetQueue() via reflection.
		UObject* Queue = CallFuncReturnObj(QueueSubsystem, TEXT("GetQueue"));
		if (!Queue)
		{
			TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
			Data->SetArrayField(TEXT("jobs"), TArray<TSharedPtr<FJsonValue>>());
			Data->SetNumberField(TEXT("count"), 0.0);
			SendResponse(BuildMrpSuccessResponse(CorrId, Data) + TEXT("\n"));
			return;
		}

		// Call GetJobs() to get the array of job objects.
		UFunction* GetJobsFunc = Queue->GetClass()->FindFunctionByName(TEXT("GetJobs"));
		TArray<TSharedPtr<FJsonValue>> JobsArray;

		if (GetJobsFunc)
		{
			TArray<uint8> Params;
			Params.SetNumZeroed(GetJobsFunc->ParmsSize);
			Queue->ProcessEvent(GetJobsFunc, Params.GetData());

			// Extract the returned array.
			for (TFieldIterator<FProperty> PIt(GetJobsFunc); PIt; ++PIt)
			{
				FProperty* P = *PIt;
				if (!(P->PropertyFlags & CPF_ReturnParm) && !(P->PropertyFlags & CPF_OutParm)) { continue; }

				FArrayProperty* ArrayProp = CastField<FArrayProperty>(P);
				if (!ArrayProp) { continue; }

				void* ArrayAddr = Params.GetData() + P->GetOffset_ForInternal();
				FScriptArrayHelper ArrayHelper(ArrayProp, ArrayAddr);
				FObjectProperty* ElemObjProp = CastField<FObjectProperty>(ArrayProp->Inner);

				for (int32 i = 0; i < ArrayHelper.Num(); ++i)
				{
					void* ElemPtr = ArrayHelper.GetRawPtr(i);
					UObject* Job = ElemObjProp ? ElemObjProp->GetObjectPropertyValue(ElemPtr) : nullptr;
					if (!Job) { continue; }

					TSharedPtr<FJsonObject> JobObj = MakeShared<FJsonObject>();

					// Job name.
					FString JobName = ReadUObjectStringProp(Job, TEXT("JobName"));
					JobObj->SetStringField(TEXT("job_name"), JobName.IsEmpty() ? TEXT("Unnamed Job") : JobName);

					// Sequence path via FSoftObjectPath.
					FString SequencePath;
					FProperty* SeqProp = Job->GetClass()->FindPropertyByName(TEXT("Sequence"));
					if (SeqProp)
					{
						SeqProp->ExportTextItem_Direct(SequencePath, SeqProp->ContainerPtrToValuePtr<void>(Job), nullptr, nullptr, PPF_None);
					}
					JobObj->SetStringField(TEXT("sequence_path"), SequencePath);

					// Status via reflection.
					JobObj->SetStringField(TEXT("status"), GetJobStatusStringReflected(Job));
					JobObj->SetNumberField(TEXT("progress"), 0.0);

					// Output settings from config.
					FString OutputDirectory = TEXT("{project}/Saved/MovieRenders");
					FString FilenameFormat = TEXT("{sequence_name}_{frame_number}");
					int32 ResolutionX = 1920;
					int32 ResolutionY = 1080;

					UObject* Config = CallFuncReturnObj(Job, TEXT("GetConfiguration"));
					if (Config)
					{
						UClass* OutputSettingClass = FindObject<UClass>(nullptr,
							TEXT("/Script/MovieRenderPipelineCore.MoviePipelineOutputSetting"));
						if (OutputSettingClass)
						{
							UObject* OutputSetting = FindOrAddSettingByClass(Config, OutputSettingClass);
							if (OutputSetting)
							{
								// OutputDirectory is FDirectoryPath -- read its Path member.
								FProperty* OutputDirProp = OutputSetting->GetClass()->FindPropertyByName(TEXT("OutputDirectory"));
								if (FStructProperty* DirStructProp = CastField<FStructProperty>(OutputDirProp))
								{
									void* DirPtr = DirStructProp->ContainerPtrToValuePtr<void>(OutputSetting);
									FProperty* PathProp = DirStructProp->Struct->FindPropertyByName(TEXT("Path"));
									if (FStrProperty* PathStrProp = CastField<FStrProperty>(PathProp))
									{
										OutputDirectory = PathStrProp->GetPropertyValue_InContainer(DirPtr);
									}
								}
								else if (FStrProperty* StrProp = CastField<FStrProperty>(OutputDirProp))
								{
									OutputDirectory = StrProp->GetPropertyValue_InContainer(OutputSetting);
								}

								FilenameFormat = ReadUObjectStringProp(OutputSetting, TEXT("FileNameFormat"));
								if (FilenameFormat.IsEmpty())
								{
									FilenameFormat = TEXT("{sequence_name}_{frame_number}");
								}

								// OutputResolution is FIntPoint -- read X, Y.
								FProperty* ResProp = OutputSetting->GetClass()->FindPropertyByName(TEXT("OutputResolution"));
								if (FStructProperty* ResStructProp = CastField<FStructProperty>(ResProp))
								{
									void* ResPtr = ResStructProp->ContainerPtrToValuePtr<void>(OutputSetting);
									FProperty* XProp = ResStructProp->Struct->FindPropertyByName(TEXT("X"));
									FProperty* YProp = ResStructProp->Struct->FindPropertyByName(TEXT("Y"));
									if (FIntProperty* XIntProp = CastField<FIntProperty>(XProp))
									{
										ResolutionX = XIntProp->GetPropertyValue_InContainer(ResPtr);
									}
									if (FIntProperty* YIntProp = CastField<FIntProperty>(YProp))
									{
										ResolutionY = YIntProp->GetPropertyValue_InContainer(ResPtr);
									}
								}
							}
						}
					}

					JobObj->SetStringField(TEXT("output_directory"), OutputDirectory);
					JobObj->SetStringField(TEXT("filename_format"),  FilenameFormat);
					JobObj->SetNumberField(TEXT("resolution_x"),     static_cast<double>(ResolutionX));
					JobObj->SetNumberField(TEXT("resolution_y"),     static_cast<double>(ResolutionY));

					JobsArray.Add(MakeShared<FJsonValueObject>(JobObj));
				}
				break;
			}
		}

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetArrayField(TEXT("jobs"),  JobsArray);
		Data->SetNumberField(TEXT("count"), static_cast<double>(JobsArray.Num()));

		SendResponse(BuildMrpSuccessResponse(CorrId, Data) + TEXT("\n"));
	});

	// -----------------------------------------------------------------------
	// movierender.addJob (MRP-02)
	// Adds a new render job to the queue.
	// Required: sequence_path
	// Optional: output_directory, format, resolution_x, resolution_y, frame_start, frame_end
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("movierender.addJob"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

		if (!CheckMovieRenderAvailable(CorrId, SendResponse)) { return; }

		// Extract payload.
		TSharedPtr<FJsonObject> Payload;
		const TSharedPtr<FJsonValue>* PayloadVal = Cmd->Values.Find(TEXT("payload"));
		if (PayloadVal && (*PayloadVal)->Type == EJson::Object)
		{
			Payload = (*PayloadVal)->AsObject();
		}

		FString SequencePath;
		if (!Payload.IsValid() || !Payload->TryGetStringField(TEXT("sequence_path"), SequencePath) || SequencePath.IsEmpty())
		{
			SendResponse(BuildMrpErrorResponse(CorrId, TEXT("missing_sequence_path")) + TEXT("\n"));
			return;
		}

		// Validate path prefix (T-29-01).
		if (!IsValidMrpAssetPath(SequencePath))
		{
			SendResponse(BuildMrpErrorResponse(CorrId, TEXT("invalid_sequence_path")) + TEXT("\n"));
			return;
		}

		// Extract optional parameters.
		FString OutputDirectory = TEXT("{project}/Saved/MovieRenders");
		Payload->TryGetStringField(TEXT("output_directory"), OutputDirectory);

		FString Format = TEXT("png");
		Payload->TryGetStringField(TEXT("format"), Format);

		double ResXDouble = 1920.0;
		Payload->TryGetNumberField(TEXT("resolution_x"), ResXDouble);
		const int32 ResolutionX = static_cast<int32>(ResXDouble);

		double ResYDouble = 1080.0;
		Payload->TryGetNumberField(TEXT("resolution_y"), ResYDouble);
		const int32 ResolutionY = static_cast<int32>(ResYDouble);

		double FrameStartDouble = 0.0;
		Payload->TryGetNumberField(TEXT("frame_start"), FrameStartDouble);
		const int32 FrameStart = static_cast<int32>(FrameStartDouble);

		double FrameEndDouble = -1.0;
		Payload->TryGetNumberField(TEXT("frame_end"), FrameEndDouble);
		const int32 FrameEnd = static_cast<int32>(FrameEndDouble);

		if (!GEditor)
		{
			SendResponse(BuildMrpErrorResponse(CorrId, TEXT("subsystem_unavailable")) + TEXT("\n"));
			return;
		}

		UObject* QueueSubsystem = GetMoviePipelineQueueSubsystem();
		if (!QueueSubsystem)
		{
			SendResponse(BuildMrpErrorResponse(CorrId, TEXT("subsystem_unavailable")) + TEXT("\n"));
			return;
		}

		UObject* Queue = CallFuncReturnObj(QueueSubsystem, TEXT("GetQueue"));
		if (!Queue)
		{
			SendResponse(BuildMrpErrorResponse(CorrId, TEXT("queue_unavailable")) + TEXT("\n"));
			return;
		}

		// Mark queue for modification before mutation (Pitfall 5).
		Queue->Modify();

		// Find UMoviePipelineExecutorJob class.
		UClass* JobClass = FindObject<UClass>(nullptr,
			TEXT("/Script/MovieRenderPipelineCore.MoviePipelineExecutorJob"));
		if (!JobClass)
		{
			SendResponse(BuildMrpErrorResponse(CorrId, TEXT("job_class_not_found")) + TEXT("\n"));
			return;
		}

		// Call AllocateNewJob(UClass*) via reflection.
		UObject* Job = nullptr;
		UFunction* AllocateFunc = Queue->GetClass()->FindFunctionByName(TEXT("AllocateNewJob"));
		if (AllocateFunc)
		{
			TArray<uint8> Params;
			Params.SetNumZeroed(AllocateFunc->ParmsSize);

			for (TFieldIterator<FProperty> PIt(AllocateFunc); PIt && (PIt->PropertyFlags & CPF_Parm); ++PIt)
			{
				FProperty* P = *PIt;
				if (P->PropertyFlags & CPF_ReturnParm) { continue; }
				if (FClassProperty* ClassParam = CastField<FClassProperty>(P))
				{
					ClassParam->SetObjectPropertyValue(Params.GetData() + P->GetOffset_ForInternal(), JobClass);
					break;
				}
			}

			Queue->ProcessEvent(AllocateFunc, Params.GetData());

			for (TFieldIterator<FProperty> PIt(AllocateFunc); PIt; ++PIt)
			{
				FProperty* P = *PIt;
				if (P->PropertyFlags & CPF_ReturnParm)
				{
					if (FObjectProperty* ObjProp = CastField<FObjectProperty>(P))
					{
						Job = ObjProp->GetObjectPropertyValue(Params.GetData() + P->GetOffset_ForInternal());
					}
					break;
				}
			}
		}

		if (!Job)
		{
			SendResponse(BuildMrpErrorResponse(CorrId, TEXT("job_creation_failed")) + TEXT("\n"));
			return;
		}

		// Set the sequence via Sequence property (FSoftObjectPath).
		FProperty* SeqProp = Job->GetClass()->FindPropertyByName(TEXT("Sequence"));
		if (SeqProp)
		{
			// Import the asset path into the FSoftObjectPath property.
			void* SeqAddr = SeqProp->ContainerPtrToValuePtr<void>(Job);
			SeqProp->ImportText_Direct(*SequencePath, SeqAddr, Job, PPF_None);
		}

		// Set job name from the sequence asset name.
		const int32 LastSlash = SequencePath.Find(TEXT("/"), ESearchCase::IgnoreCase, ESearchDir::FromEnd);
		const FString SeqName = (LastSlash != INDEX_NONE) ? SequencePath.Mid(LastSlash + 1) : SequencePath;

		FProperty* JobNameProp = Job->GetClass()->FindPropertyByName(TEXT("JobName"));
		if (FStrProperty* JobNameStrProp = CastField<FStrProperty>(JobNameProp))
		{
			JobNameStrProp->SetPropertyValue_InContainer(Job, SeqName);
		}

		// Get or create job configuration.
		UObject* Config = CallFuncReturnObj(Job, TEXT("GetConfiguration"));
		if (!Config)
		{
			// NewObject a primary config and set it.
			UClass* ConfigClass = FindObject<UClass>(nullptr,
				TEXT("/Script/MovieRenderPipelineCore.MoviePipelinePrimaryConfig"));
			if (ConfigClass)
			{
				Config = NewObject<UObject>(Job, ConfigClass);

				UFunction* SetConfigFunc = Job->GetClass()->FindFunctionByName(TEXT("SetConfiguration"));
				if (SetConfigFunc)
				{
					TArray<uint8> Params;
					Params.SetNumZeroed(SetConfigFunc->ParmsSize);
					for (TFieldIterator<FProperty> PIt(SetConfigFunc); PIt && (PIt->PropertyFlags & CPF_Parm); ++PIt)
					{
						FProperty* P = *PIt;
						if (P->PropertyFlags & CPF_ReturnParm) { continue; }
						if (FObjectProperty* ObjParam = CastField<FObjectProperty>(P))
						{
							ObjParam->SetObjectPropertyValue(Params.GetData() + P->GetOffset_ForInternal(), Config);
							break;
						}
					}
					Job->ProcessEvent(SetConfigFunc, Params.GetData());
				}
			}
		}

		// Find or add output setting.
		if (Config)
		{
			UClass* OutputSettingClass = FindObject<UClass>(nullptr,
				TEXT("/Script/MovieRenderPipelineCore.MoviePipelineOutputSetting"));
			if (OutputSettingClass)
			{
				UObject* OutputSetting = FindOrAddSettingByClass(Config, OutputSettingClass);
				if (OutputSetting)
				{
					// Set OutputDirectory.
					FProperty* OutputDirProp = OutputSetting->GetClass()->FindPropertyByName(TEXT("OutputDirectory"));
					if (FStructProperty* DirStructProp = CastField<FStructProperty>(OutputDirProp))
					{
						void* DirPtr = DirStructProp->ContainerPtrToValuePtr<void>(OutputSetting);
						FProperty* PathProp = DirStructProp->Struct->FindPropertyByName(TEXT("Path"));
						if (FStrProperty* PathStrProp = CastField<FStrProperty>(PathProp))
						{
							PathStrProp->SetPropertyValue_InContainer(DirPtr, OutputDirectory);
						}
					}
					else if (FStrProperty* StrProp = CastField<FStrProperty>(OutputDirProp))
					{
						StrProp->SetPropertyValue_InContainer(OutputSetting, OutputDirectory);
					}

					// Set FileNameFormat.
					FProperty* FileNameFormatProp = OutputSetting->GetClass()->FindPropertyByName(TEXT("FileNameFormat"));
					if (FStrProperty* FileNameStrProp = CastField<FStrProperty>(FileNameFormatProp))
					{
						FileNameStrProp->SetPropertyValue_InContainer(OutputSetting, TEXT("{sequence_name}_{frame_number}"));
					}

					// Set OutputResolution.
					FProperty* ResProp = OutputSetting->GetClass()->FindPropertyByName(TEXT("OutputResolution"));
					if (FStructProperty* ResStructProp = CastField<FStructProperty>(ResProp))
					{
						void* ResPtr = ResStructProp->ContainerPtrToValuePtr<void>(OutputSetting);
						FProperty* XProp = ResStructProp->Struct->FindPropertyByName(TEXT("X"));
						FProperty* YProp = ResStructProp->Struct->FindPropertyByName(TEXT("Y"));
						if (FIntProperty* XIntProp = CastField<FIntProperty>(XProp))
						{
							XIntProp->SetPropertyValue_InContainer(ResPtr, ResolutionX);
						}
						if (FIntProperty* YIntProp = CastField<FIntProperty>(YProp))
						{
							YIntProp->SetPropertyValue_InContainer(ResPtr, ResolutionY);
						}
					}
				}
			}
		}

		Queue->MarkPackageDirty();

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetStringField(TEXT("job_name"),          SeqName);
		Data->SetStringField(TEXT("sequence_path"),     SequencePath);
		Data->SetStringField(TEXT("format"),            Format);
		Data->SetNumberField(TEXT("resolution_x"),      static_cast<double>(ResolutionX));
		Data->SetNumberField(TEXT("resolution_y"),      static_cast<double>(ResolutionY));
		Data->SetNumberField(TEXT("frame_start"),       static_cast<double>(FrameStart));
		Data->SetNumberField(TEXT("frame_end"),         static_cast<double>(FrameEnd));
		Data->SetStringField(TEXT("output_directory"),  OutputDirectory);
		Data->SetBoolField(TEXT("added"),               true);

		SendResponse(BuildMrpSuccessResponse(CorrId, Data) + TEXT("\n"));
	});

	// -----------------------------------------------------------------------
	// movierender.control (MRP-03)
	// Starts, stops, or queries progress of the render queue.
	// Required: action ("start", "stop", "progress")
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("movierender.control"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

		if (!CheckMovieRenderAvailable(CorrId, SendResponse)) { return; }

		// Extract payload.
		TSharedPtr<FJsonObject> Payload;
		const TSharedPtr<FJsonValue>* PayloadVal = Cmd->Values.Find(TEXT("payload"));
		if (PayloadVal && (*PayloadVal)->Type == EJson::Object)
		{
			Payload = (*PayloadVal)->AsObject();
		}

		FString Action;
		if (!Payload.IsValid() || !Payload->TryGetStringField(TEXT("action"), Action) || Action.IsEmpty())
		{
			SendResponse(BuildMrpErrorResponse(CorrId, TEXT("missing_action")) + TEXT("\n"));
			return;
		}

		// Validate action.
		if (Action != TEXT("start") && Action != TEXT("stop") && Action != TEXT("progress"))
		{
			SendResponse(BuildMrpErrorResponse(CorrId, TEXT("invalid_action")) + TEXT("\n"));
			return;
		}

		if (!GEditor)
		{
			SendResponse(BuildMrpErrorResponse(CorrId, TEXT("subsystem_unavailable")) + TEXT("\n"));
			return;
		}

		UObject* QueueSubsystem = GetMoviePipelineQueueSubsystem();
		if (!QueueSubsystem)
		{
			SendResponse(BuildMrpErrorResponse(CorrId, TEXT("subsystem_unavailable")) + TEXT("\n"));
			return;
		}

		const bool bIsRendering = CallFuncReturnBool(QueueSubsystem, TEXT("IsRendering"));

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetStringField(TEXT("action"), Action);

		if (Action == TEXT("start"))
		{
			// Guard against concurrent render storms (T-29-02).
			if (bIsRendering)
			{
				SendResponse(BuildMrpErrorResponse(CorrId, TEXT("already_rendering")) + TEXT("\n"));
				return;
			}

			UObject* Queue = CallFuncReturnObj(QueueSubsystem, TEXT("GetQueue"));

			// Check if the queue has jobs.
			UFunction* GetJobsFunc = Queue ? Queue->GetClass()->FindFunctionByName(TEXT("GetJobs")) : nullptr;
			int32 JobCount = 0;
			if (GetJobsFunc && Queue)
			{
				TArray<uint8> Params;
				Params.SetNumZeroed(GetJobsFunc->ParmsSize);
				Queue->ProcessEvent(GetJobsFunc, Params.GetData());
				for (TFieldIterator<FProperty> PIt(GetJobsFunc); PIt; ++PIt)
				{
					FProperty* P = *PIt;
					if ((P->PropertyFlags & CPF_ReturnParm) || (P->PropertyFlags & CPF_OutParm))
					{
						FArrayProperty* ArrayProp = CastField<FArrayProperty>(P);
						if (ArrayProp)
						{
							FScriptArrayHelper H(ArrayProp, Params.GetData() + P->GetOffset_ForInternal());
							JobCount = H.Num();
						}
						break;
					}
				}
			}

			if (!Queue || JobCount == 0)
			{
				SendResponse(BuildMrpErrorResponse(CorrId, TEXT("queue_empty")) + TEXT("\n"));
				return;
			}

			// Call RenderQueueWithExecutor(UClass*) via reflection.
			UFunction* RenderFunc = QueueSubsystem->GetClass()->FindFunctionByName(TEXT("RenderQueueWithExecutor"));
			if (RenderFunc)
			{
				TArray<uint8> Params;
				Params.SetNumZeroed(RenderFunc->ParmsSize);

				// Pass nullptr as executor class to use default.
				QueueSubsystem->ProcessEvent(RenderFunc, Params.GetData());
			}

			Data->SetBoolField(TEXT("started"), true);
			Data->SetBoolField(TEXT("is_rendering"), true);
		}
		else if (Action == TEXT("stop"))
		{
			if (!bIsRendering)
			{
				SendResponse(BuildMrpErrorResponse(CorrId, TEXT("not_rendering")) + TEXT("\n"));
				return;
			}

			// Get active executor and cancel.
			UObject* ActiveExecutor = CallFuncReturnObj(QueueSubsystem, TEXT("GetActiveExecutor"));
			if (ActiveExecutor)
			{
				UFunction* CancelFunc = ActiveExecutor->GetClass()->FindFunctionByName(TEXT("CancelAllJobs"));
				if (CancelFunc)
				{
					TArray<uint8> Params;
					Params.SetNumZeroed(CancelFunc->ParmsSize);
					ActiveExecutor->ProcessEvent(CancelFunc, Params.GetData());
				}
			}

			Data->SetBoolField(TEXT("stopped"), true);
			Data->SetBoolField(TEXT("is_rendering"), false);
		}
		else // "progress"
		{
			Data->SetBoolField(TEXT("is_rendering"), bIsRendering);

			UObject* Queue = CallFuncReturnObj(QueueSubsystem, TEXT("GetQueue"));
			int32 TotalJobs = 0;
			int32 ConsumedJobs = 0;

			if (Queue)
			{
				UFunction* GetJobsFunc = Queue->GetClass()->FindFunctionByName(TEXT("GetJobs"));
				if (GetJobsFunc)
				{
					TArray<uint8> Params;
					Params.SetNumZeroed(GetJobsFunc->ParmsSize);
					Queue->ProcessEvent(GetJobsFunc, Params.GetData());

					for (TFieldIterator<FProperty> PIt(GetJobsFunc); PIt; ++PIt)
					{
						FProperty* P = *PIt;
						if (!(P->PropertyFlags & CPF_ReturnParm) && !(P->PropertyFlags & CPF_OutParm)) { continue; }
						FArrayProperty* ArrayProp = CastField<FArrayProperty>(P);
						if (!ArrayProp) { continue; }

						void* ArrayAddr = Params.GetData() + P->GetOffset_ForInternal();
						FScriptArrayHelper ArrayHelper(ArrayProp, ArrayAddr);
						FObjectProperty* ElemObjProp = CastField<FObjectProperty>(ArrayProp->Inner);

						TotalJobs = ArrayHelper.Num();
						for (int32 i = 0; i < ArrayHelper.Num(); ++i)
						{
							void* ElemPtr = ArrayHelper.GetRawPtr(i);
							UObject* Job = ElemObjProp ? ElemObjProp->GetObjectPropertyValue(ElemPtr) : nullptr;
							if (Job && CallFuncReturnBool(Job, TEXT("IsConsumed")))
							{
								++ConsumedJobs;
							}
						}
						break;
					}
				}
			}

			Data->SetNumberField(TEXT("total_jobs"), static_cast<double>(TotalJobs));
			Data->SetNumberField(TEXT("current_job_index"), static_cast<double>(ConsumedJobs));

			const double Progress = (TotalJobs > 0) ? (static_cast<double>(ConsumedJobs) / static_cast<double>(TotalJobs)) : 0.0;
			Data->SetNumberField(TEXT("progress"), Progress);
		}

		SendResponse(BuildMrpSuccessResponse(CorrId, Data) + TEXT("\n"));
	});

	// -----------------------------------------------------------------------
	// movierender.configure (MRP-04)
	// Configures burn-in text, EXR metadata, and filename format tokens.
	// Required: sequence_path
	// Optional: burn_in_text (object), exr_metadata (object), filename_format (string)
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("movierender.configure"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

		if (!CheckMovieRenderAvailable(CorrId, SendResponse)) { return; }

		// Extract payload.
		TSharedPtr<FJsonObject> Payload;
		const TSharedPtr<FJsonValue>* PayloadVal = Cmd->Values.Find(TEXT("payload"));
		if (PayloadVal && (*PayloadVal)->Type == EJson::Object)
		{
			Payload = (*PayloadVal)->AsObject();
		}

		FString SequencePath;
		if (!Payload.IsValid() || !Payload->TryGetStringField(TEXT("sequence_path"), SequencePath) || SequencePath.IsEmpty())
		{
			SendResponse(BuildMrpErrorResponse(CorrId, TEXT("missing_sequence_path")) + TEXT("\n"));
			return;
		}

		// Validate path prefix (T-29-01).
		if (!IsValidMrpAssetPath(SequencePath))
		{
			SendResponse(BuildMrpErrorResponse(CorrId, TEXT("invalid_sequence_path")) + TEXT("\n"));
			return;
		}

		if (!GEditor)
		{
			SendResponse(BuildMrpErrorResponse(CorrId, TEXT("subsystem_unavailable")) + TEXT("\n"));
			return;
		}

		UObject* QueueSubsystem = GetMoviePipelineQueueSubsystem();
		if (!QueueSubsystem)
		{
			SendResponse(BuildMrpErrorResponse(CorrId, TEXT("subsystem_unavailable")) + TEXT("\n"));
			return;
		}

		UObject* Queue = CallFuncReturnObj(QueueSubsystem, TEXT("GetQueue"));
		if (!Queue)
		{
			SendResponse(BuildMrpErrorResponse(CorrId, TEXT("queue_unavailable")) + TEXT("\n"));
			return;
		}

		// Find the job matching the sequence path.
		UObject* TargetJob = nullptr;
		UFunction* GetJobsFunc = Queue->GetClass()->FindFunctionByName(TEXT("GetJobs"));
		if (GetJobsFunc)
		{
			TArray<uint8> Params;
			Params.SetNumZeroed(GetJobsFunc->ParmsSize);
			Queue->ProcessEvent(GetJobsFunc, Params.GetData());

			for (TFieldIterator<FProperty> PIt(GetJobsFunc); PIt; ++PIt)
			{
				FProperty* P = *PIt;
				if (!(P->PropertyFlags & CPF_ReturnParm) && !(P->PropertyFlags & CPF_OutParm)) { continue; }
				FArrayProperty* ArrayProp = CastField<FArrayProperty>(P);
				if (!ArrayProp) { continue; }

				void* ArrayAddr = Params.GetData() + P->GetOffset_ForInternal();
				FScriptArrayHelper ArrayHelper(ArrayProp, ArrayAddr);
				FObjectProperty* ElemObjProp = CastField<FObjectProperty>(ArrayProp->Inner);

				for (int32 i = 0; i < ArrayHelper.Num(); ++i)
				{
					void* ElemPtr = ArrayHelper.GetRawPtr(i);
					UObject* Job = ElemObjProp ? ElemObjProp->GetObjectPropertyValue(ElemPtr) : nullptr;
					if (!Job) { continue; }

					// Compare sequence path.
					FProperty* SeqProp = Job->GetClass()->FindPropertyByName(TEXT("Sequence"));
					if (SeqProp)
					{
						FString JobSeqPath;
						SeqProp->ExportTextItem_Direct(JobSeqPath, SeqProp->ContainerPtrToValuePtr<void>(Job), nullptr, nullptr, PPF_None);
						if (JobSeqPath == SequencePath)
						{
							TargetJob = Job;
							break;
						}
					}
				}
				break;
			}
		}

		if (!TargetJob)
		{
			SendResponse(BuildMrpErrorResponse(CorrId, TEXT("job_not_found")) + TEXT("\n"));
			return;
		}

		UObject* Config = CallFuncReturnObj(TargetJob, TEXT("GetConfiguration"));
		if (!Config)
		{
			SendResponse(BuildMrpErrorResponse(CorrId, TEXT("config_unavailable")) + TEXT("\n"));
			return;
		}

		// Mark job for modification before mutation (Pitfall 5).
		TargetJob->Modify();
		Config->Modify();

		TArray<FString> ConfiguredFields;

		// Apply filename_format if provided.
		FString FilenameFormat;
		if (Payload->TryGetStringField(TEXT("filename_format"), FilenameFormat) && !FilenameFormat.IsEmpty())
		{
			UClass* OutputSettingClass = FindObject<UClass>(nullptr,
				TEXT("/Script/MovieRenderPipelineCore.MoviePipelineOutputSetting"));
			if (OutputSettingClass)
			{
				UObject* OutputSetting = FindOrAddSettingByClass(Config, OutputSettingClass);
				if (OutputSetting)
				{
					FProperty* FileNameFormatProp = OutputSetting->GetClass()->FindPropertyByName(TEXT("FileNameFormat"));
					if (FStrProperty* StrProp = CastField<FStrProperty>(FileNameFormatProp))
					{
						StrProp->SetPropertyValue_InContainer(OutputSetting, FilenameFormat);
						ConfiguredFields.Add(TEXT("filename_format"));
					}
				}
			}
		}

		// Apply burn_in_text if provided.
		const TSharedPtr<FJsonValue>* BurnInVal = Payload->Values.Find(TEXT("burn_in_text"));
		if (BurnInVal && (*BurnInVal)->Type == EJson::Object)
		{
			UClass* BurnInSettingClass = FindObject<UClass>(nullptr,
				TEXT("/Script/MovieRenderPipelineCore.MoviePipelineBurnInSetting"));
			if (BurnInSettingClass)
			{
				UObject* BurnInSetting = FindOrAddSettingByClass(Config, BurnInSettingClass);
				if (BurnInSetting)
				{
					FProperty* CompositeProp = BurnInSetting->GetClass()->FindPropertyByName(TEXT("bCompositeOntoFinalImage"));
					if (FBoolProperty* BoolProp = CastField<FBoolProperty>(CompositeProp))
					{
						BoolProp->SetPropertyValue_InContainer(BurnInSetting, true);
						ConfiguredFields.Add(TEXT("burn_in_text"));
					}
				}
			}
		}

		// Apply exr_metadata if provided.
		const TSharedPtr<FJsonValue>* ExrMetaVal = Payload->Values.Find(TEXT("exr_metadata"));
		if (ExrMetaVal && (*ExrMetaVal)->Type == EJson::Object)
		{
			UClass* OutputSettingClass = FindObject<UClass>(nullptr,
				TEXT("/Script/MovieRenderPipelineCore.MoviePipelineOutputSetting"));
			if (OutputSettingClass)
			{
				UObject* OutputSetting = FindOrAddSettingByClass(Config, OutputSettingClass);
				if (OutputSetting)
				{
					ConfiguredFields.Add(TEXT("exr_metadata"));
				}
			}
		}

		TargetJob->MarkPackageDirty();

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetStringField(TEXT("sequence_path"), SequencePath);
		Data->SetBoolField(TEXT("configured"), true);

		TArray<TSharedPtr<FJsonValue>> FieldsArray;
		for (const FString& Field : ConfiguredFields)
		{
			FieldsArray.Add(MakeShared<FJsonValueString>(Field));
		}
		Data->SetArrayField(TEXT("configured_fields"), FieldsArray);

		SendResponse(BuildMrpSuccessResponse(CorrId, Data) + TEXT("\n"));
	});
}
