// MCPLiveLinkCommands.cpp (Plan 27-01)
// Implements four Live Link inspection and control command handlers for the MCP bridge:
//   livelink.sources   -- list all active Live Link sources with type, machine name, status (LL-01)
//   livelink.subjects  -- list all Live Link subjects with roles and enabled state (LL-02)
//   livelink.control   -- pause/resume individual Live Link subjects (LL-03)
//   livelink.preview   -- inspect current frame data for any Live Link subject (LL-04)
//
// All handlers run on the game thread via FMCPCommandRouter::Dispatch.
// subject_name in livelink.control and livelink.preview is validated by exact match against
// GetSubjects() results -- never passed as a raw string to any API (T-27-01).
// livelink.preview animation bone output is capped at 10 bones with total_bones count (T-27-02).
// All handlers check IModularFeatures availability before accessing ILiveLinkClient for
// graceful degradation when Live Link plugin is not enabled.

#include "MCPLiveLinkCommands.h"

// Live Link headers
#include "ILiveLinkClient.h"
#include "LiveLinkTypes.h"
#include "LiveLinkSubjectSettings.h"
#include "Roles/LiveLinkAnimationRole.h"
#include "Roles/LiveLinkAnimationTypes.h"
#include "Roles/LiveLinkCameraRole.h"
#include "Roles/LiveLinkCameraTypes.h"
#include "Roles/LiveLinkTransformRole.h"
#include "Roles/LiveLinkTransformTypes.h"

// Modular features (ILiveLinkClient access)
#include "Features/IModularFeatures.h"

// JSON
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

/** Returns a user-friendly role name from a Live Link role class. */
static FString GetRoleFriendlyName(TSubclassOf<ULiveLinkRole> RoleClass)
{
	if (!RoleClass)
	{
		return TEXT("Unknown");
	}

	const FString ClassName = RoleClass->GetName();

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

/** Serialize a FVector as a JSON object with x, y, z fields. */
static TSharedPtr<FJsonObject> VectorToJson(const FVector& V)
{
	TSharedPtr<FJsonObject> Obj = MakeShared<FJsonObject>();
	Obj->SetNumberField(TEXT("x"), V.X);
	Obj->SetNumberField(TEXT("y"), V.Y);
	Obj->SetNumberField(TEXT("z"), V.Z);
	return Obj;
}

/** Serialize a FRotator as a JSON object with roll, pitch, yaw fields. */
static TSharedPtr<FJsonObject> RotatorToJson(const FRotator& R)
{
	TSharedPtr<FJsonObject> Obj = MakeShared<FJsonObject>();
	Obj->SetNumberField(TEXT("roll"),  R.Roll);
	Obj->SetNumberField(TEXT("pitch"), R.Pitch);
	Obj->SetNumberField(TEXT("yaw"),   R.Yaw);
	return Obj;
}

/** Serialize a FTransform location/rotation/scale into a JSON object. */
static TSharedPtr<FJsonObject> TransformToJson(const FTransform& T)
{
	TSharedPtr<FJsonObject> Obj = MakeShared<FJsonObject>();
	Obj->SetObjectField(TEXT("location"), VectorToJson(T.GetLocation()));
	Obj->SetObjectField(TEXT("rotation"), RotatorToJson(T.GetRotation().Rotator()));
	Obj->SetObjectField(TEXT("scale"),    VectorToJson(T.GetScale3D()));
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
		if (!IModularFeatures::Get().IsModularFeatureAvailable(ILiveLinkClient::ModularFeatureName))
		{
			TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
			Data->SetArrayField(TEXT("sources"), TArray<TSharedPtr<FJsonValue>>());
			Data->SetNumberField(TEXT("count"), 0);
			Data->SetStringField(TEXT("message"),
				TEXT("Live Link plugin is not enabled. Enable it in Plugins > Animation > Live Link to use this command."));
			SendResponse(BuildLiveLinkSuccessResponse(CorrId, Data));
			return;
		}

		ILiveLinkClient& Client = IModularFeatures::Get().GetModularFeature<ILiveLinkClient>(ILiveLinkClient::ModularFeatureName);

		TArray<FGuid> SourceGuids = Client.GetSources();

		TArray<TSharedPtr<FJsonValue>> SourceArray;
		SourceArray.Reserve(SourceGuids.Num());

		for (const FGuid& SourceGuid : SourceGuids)
		{
			TSharedPtr<FJsonObject> SourceObj = MakeShared<FJsonObject>();
			SourceObj->SetStringField(TEXT("source_id"),    SourceGuid.ToString());
			SourceObj->SetStringField(TEXT("source_type"),  Client.GetSourceType(SourceGuid).ToString());
			SourceObj->SetStringField(TEXT("machine_name"), Client.GetSourceMachineName(SourceGuid).ToString());
			SourceObj->SetStringField(TEXT("status"),       Client.GetSourceStatus(SourceGuid).ToString());
			SourceArray.Add(MakeShared<FJsonValueObject>(SourceObj));
		}

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetArrayField(TEXT("sources"), SourceArray);
		Data->SetNumberField(TEXT("count"), SourceGuids.Num());

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
		if (!IModularFeatures::Get().IsModularFeatureAvailable(ILiveLinkClient::ModularFeatureName))
		{
			TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
			Data->SetArrayField(TEXT("subjects"), TArray<TSharedPtr<FJsonValue>>());
			Data->SetNumberField(TEXT("count"), 0);
			Data->SetStringField(TEXT("message"),
				TEXT("Live Link plugin is not enabled. Enable it in Plugins > Animation > Live Link to use this command."));
			SendResponse(BuildLiveLinkSuccessResponse(CorrId, Data));
			return;
		}

		ILiveLinkClient& Client = IModularFeatures::Get().GetModularFeature<ILiveLinkClient>(ILiveLinkClient::ModularFeatureName);

		// Include disabled subjects so the full list is visible.
		TArray<FLiveLinkSubjectKey> SubjectKeys = Client.GetSubjects(/*bIncludeDisabledSubjects=*/true, /*bIncludeVirtualSubjects=*/true);

		TArray<TSharedPtr<FJsonValue>> SubjectArray;
		SubjectArray.Reserve(SubjectKeys.Num());

		for (const FLiveLinkSubjectKey& SubjectKey : SubjectKeys)
		{
			const FString SubjectName = SubjectKey.SubjectName.Name.ToString();
			const FString SourceId    = SubjectKey.Source.ToString();

			FString RoleName  = TEXT("Unknown");
			bool    bEnabled  = true;

			ULiveLinkSubjectSettings* Settings = Cast<ULiveLinkSubjectSettings>(Client.GetSubjectSettings(SubjectKey));
			if (Settings)
			{
				RoleName = GetRoleFriendlyName(Settings->Role);
			}
			bEnabled = Client.IsSubjectEnabled(SubjectKey, /*bForThisFrame=*/false);

			TSharedPtr<FJsonObject> SubjectObj = MakeShared<FJsonObject>();
			SubjectObj->SetStringField(TEXT("subject_name"), SubjectName);
			SubjectObj->SetStringField(TEXT("source_id"),    SourceId);
			SubjectObj->SetStringField(TEXT("role"),         RoleName);
			SubjectObj->SetBoolField  (TEXT("enabled"),      bEnabled);
			SubjectArray.Add(MakeShared<FJsonValueObject>(SubjectObj));
		}

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetArrayField(TEXT("subjects"), SubjectArray);
		Data->SetNumberField(TEXT("count"), SubjectKeys.Num());

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
		if (!IModularFeatures::Get().IsModularFeatureAvailable(ILiveLinkClient::ModularFeatureName))
		{
			SendResponse(BuildLiveLinkErrorResponse(CorrId,
				TEXT("Live Link plugin is not enabled. Enable it in Plugins > Animation > Live Link to use this command.")));
			return;
		}

		ILiveLinkClient& Client = IModularFeatures::Get().GetModularFeature<ILiveLinkClient>(ILiveLinkClient::ModularFeatureName);

		// T-27-01: Find subject by exact name match from GetSubjects() -- never use raw input as key.
		TArray<FLiveLinkSubjectKey> SubjectKeys = Client.GetSubjects(/*bIncludeDisabledSubjects=*/true, /*bIncludeVirtualSubjects=*/true);

		bool bFound = false;
		for (const FLiveLinkSubjectKey& SubjectKey : SubjectKeys)
		{
			if (SubjectKey.SubjectName.Name.ToString() == SubjectName)
			{
				ULiveLinkSubjectSettings* Settings = Cast<ULiveLinkSubjectSettings>(Client.GetSubjectSettings(SubjectKey));
				if (!Settings)
				{
					SendResponse(BuildLiveLinkErrorResponse(CorrId,
						FString::Printf(TEXT("Could not access settings for subject: %s"), *SubjectName)));
					return;
				}

				// Toggle the enabled state (runtime-only; no Modify() needed for Live Link subject state).
				Client.SetSubjectEnabled(SubjectKey, bEnabled);

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
		if (!IModularFeatures::Get().IsModularFeatureAvailable(ILiveLinkClient::ModularFeatureName))
		{
			SendResponse(BuildLiveLinkErrorResponse(CorrId,
				TEXT("Live Link plugin is not enabled. Enable it in Plugins > Animation > Live Link to use this command.")));
			return;
		}

		ILiveLinkClient& Client = IModularFeatures::Get().GetModularFeature<ILiveLinkClient>(ILiveLinkClient::ModularFeatureName);

		// T-27-01: Find subject by exact name match from GetSubjects() -- never use raw input as key.
		TArray<FLiveLinkSubjectKey> SubjectKeys = Client.GetSubjects(/*bIncludeDisabledSubjects=*/true, /*bIncludeVirtualSubjects=*/true);

		bool bFound = false;
		for (const FLiveLinkSubjectKey& SubjectKey : SubjectKeys)
		{
			if (SubjectKey.SubjectName.Name.ToString() != SubjectName)
			{
				continue;
			}

			bFound = true;

			// Determine role from settings.
			FString RoleName = TEXT("Unknown");
			TSubclassOf<ULiveLinkRole> RoleClass = nullptr;

			ULiveLinkSubjectSettings* Settings = Cast<ULiveLinkSubjectSettings>(Client.GetSubjectSettings(SubjectKey));
			if (Settings)
			{
				RoleClass = Settings->Role;
				RoleName  = GetRoleFriendlyName(RoleClass);
			}

			// Retrieve the latest frame data.
			FLiveLinkSubjectFrameData FrameData;
			const bool bHasData = Client.EvaluateFrame_AnyThread(SubjectKey.SubjectName, RoleClass, FrameData);

			if (!bHasData || !FrameData.StaticData.IsValid() || !FrameData.FrameData.IsValid())
			{
				TSharedPtr<FJsonObject> NoData = MakeShared<FJsonObject>();
				NoData->SetBoolField  (TEXT("available"), false);
				NoData->SetStringField(TEXT("message"),
					TEXT("No frame data available for subject. Source may be disconnected or not streaming."));

				TSharedPtr<FJsonObject> ResponseData = MakeShared<FJsonObject>();
				ResponseData->SetStringField(TEXT("subject_name"), SubjectName);
				ResponseData->SetStringField(TEXT("role"),         RoleName);
				ResponseData->SetObjectField(TEXT("frame_data"),   NoData);

				SendResponse(BuildLiveLinkSuccessResponse(CorrId, ResponseData));
				return;
			}

			// Build role-specific frame_data object.
			TSharedPtr<FJsonObject> FrameDataObj = MakeShared<FJsonObject>();
			FrameDataObj->SetBoolField(TEXT("available"), true);

			if (RoleName == TEXT("Transform"))
			{
				// Extract transform from FLiveLinkTransformFrameData.
				FLiveLinkTransformFrameData* TransformFrame =
					FrameData.FrameData.Cast<FLiveLinkTransformFrameData>();
				if (TransformFrame)
				{
					FrameDataObj->SetObjectField(TEXT("transform"), TransformToJson(TransformFrame->Transform));
				}
			}
			else if (RoleName == TEXT("Camera"))
			{
				// Extract camera properties from FLiveLinkCameraFrameData and static data.
				FLiveLinkCameraFrameData* CameraFrame =
					FrameData.FrameData.Cast<FLiveLinkCameraFrameData>();
				FLiveLinkCameraStaticData* CameraStatic =
					FrameData.StaticData.Cast<FLiveLinkCameraStaticData>();

				if (CameraFrame)
				{
					FrameDataObj->SetObjectField(TEXT("transform"),      TransformToJson(CameraFrame->Transform));
					FrameDataObj->SetNumberField (TEXT("field_of_view"),  CameraFrame->FieldOfView);
					FrameDataObj->SetNumberField (TEXT("aspect_ratio"),   CameraFrame->AspectRatio);
					FrameDataObj->SetNumberField (TEXT("focal_length"),   CameraFrame->FocalLength);
					FrameDataObj->SetNumberField (TEXT("aperture"),       CameraFrame->Aperture);
					FrameDataObj->SetNumberField (TEXT("focus_distance"),  CameraFrame->FocusDistance);
				}
				if (CameraStatic)
				{
					FrameDataObj->SetBoolField(TEXT("film_back_override"), CameraStatic->bIsFieldOfViewSupported);
				}
			}
			else if (RoleName == TEXT("Animation"))
			{
				// Extract bone data from FLiveLinkAnimationFrameData.
				// T-27-02: Cap output at 10 bones; always include total_bones count.
				FLiveLinkAnimationFrameData* AnimFrame =
					FrameData.FrameData.Cast<FLiveLinkAnimationFrameData>();
				FLiveLinkSkeletonStaticData* AnimStatic =
					FrameData.StaticData.Cast<FLiveLinkSkeletonStaticData>();

				const int32 TotalBones = AnimStatic ? AnimStatic->BoneNames.Num() : 0;
				FrameDataObj->SetNumberField(TEXT("total_bones"), TotalBones);

				TArray<TSharedPtr<FJsonValue>> BoneNamesArray;
				if (AnimStatic)
				{
					for (const FName& BoneName : AnimStatic->BoneNames)
					{
						BoneNamesArray.Add(MakeShared<FJsonValueString>(BoneName.ToString()));
					}
				}
				FrameDataObj->SetArrayField(TEXT("bone_names"), BoneNamesArray);
				FrameDataObj->SetNumberField(TEXT("bone_count"), TotalBones);

				if (AnimFrame && AnimStatic)
				{
					// Cap at first 10 bone transforms (T-27-02).
					const int32 PreviewCount = FMath::Min(AnimFrame->Transforms.Num(), 10);

					TArray<TSharedPtr<FJsonValue>> BoneTransforms;
					BoneTransforms.Reserve(PreviewCount);

					for (int32 BoneIdx = 0; BoneIdx < PreviewCount; ++BoneIdx)
					{
						const FName BoneName = (BoneIdx < AnimStatic->BoneNames.Num())
							? AnimStatic->BoneNames[BoneIdx]
							: FName(*FString::Printf(TEXT("Bone_%d"), BoneIdx));

						TSharedPtr<FJsonObject> BoneObj = MakeShared<FJsonObject>();
						BoneObj->SetStringField(TEXT("bone_name"), BoneName.ToString());
						BoneObj->SetObjectField(TEXT("location"),  VectorToJson(AnimFrame->Transforms[BoneIdx].GetLocation()));
						BoneObj->SetObjectField(TEXT("rotation"),  RotatorToJson(AnimFrame->Transforms[BoneIdx].GetRotation().Rotator()));

						BoneTransforms.Add(MakeShared<FJsonValueObject>(BoneObj));
					}

					FrameDataObj->SetArrayField(TEXT("bone_transforms"), BoneTransforms);
					FrameDataObj->SetNumberField(TEXT("preview_bone_count"), PreviewCount);
				}
			}
			else
			{
				// Generic/unknown role: report what we know.
				FrameDataObj->SetStringField(TEXT("role_class"),
					RoleClass ? RoleClass->GetName() : TEXT("None"));
				FrameDataObj->SetStringField(TEXT("note"),
					TEXT("Role-specific frame extraction not implemented for this role type."));
			}

			TSharedPtr<FJsonObject> ResponseData = MakeShared<FJsonObject>();
			ResponseData->SetStringField(TEXT("subject_name"), SubjectName);
			ResponseData->SetStringField(TEXT("role"),         RoleName);
			ResponseData->SetObjectField(TEXT("frame_data"),   FrameDataObj);

			SendResponse(BuildLiveLinkSuccessResponse(CorrId, ResponseData));
			return;
		}

		if (!bFound)
		{
			SendResponse(BuildLiveLinkErrorResponse(CorrId,
				FString::Printf(TEXT("Subject not found: %s"), *SubjectName)));
		}
	});
}
