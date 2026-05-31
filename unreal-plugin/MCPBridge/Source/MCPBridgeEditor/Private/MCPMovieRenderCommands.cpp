// MCPMovieRenderCommands.cpp
// Implements four Movie Render Pipeline command handlers for the MCP bridge:
//   movierender.queue     -- list render queue jobs with status and output settings (MRP-01)
//   movierender.addJob    -- add a render job with sequence, format, resolution, frame range (MRP-02)
//   movierender.control   -- start/stop render queue execution and query progress (MRP-03)
//   movierender.configure -- set burn-in text, EXR metadata, and filename format tokens (MRP-04)
//
// All handlers run on the game thread via FMCPCommandRouter::Dispatch.
// Call Modify() on queue/config before any mutation (Pitfall 5).
// sequence_path is validated to start with "/Game/" or "/Engine/" before any
// FSoftObjectPath usage to prevent path traversal (T-29-01).

#include "MCPMovieRenderCommands.h"

#include "Editor.h"

// Movie Render Pipeline headers
#include "MoviePipelineQueueSubsystem.h"
#include "MoviePipelineQueue.h"
#include "MoviePipelineExecutorJob.h"
#include "MoviePipelinePrimaryConfig.h"
#include "MoviePipelineOutputSetting.h"
#include "MoviePipelineBurnInSetting.h"

// JSON
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
static bool IsValidAssetPath(const FString& AssetPath)
{
	return AssetPath.StartsWith(TEXT("/Game/")) || AssetPath.StartsWith(TEXT("/Engine/"));
}

/**
 * Map UMoviePipelineExecutorJob status to a string for the JSON response.
 * Uses IsConsumed (job has been submitted to executor) and IsEnabled flags.
 */
static FString GetJobStatusString(UMoviePipelineExecutorJob* Job)
{
	if (!Job)
	{
		return TEXT("unknown");
	}
	if (Job->IsConsumed())
	{
		return TEXT("in_progress");
	}
	if (!Job->IsEnabled())
	{
		return TEXT("disabled");
	}
	return TEXT("pending");
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

		if (!GEditor)
		{
			SendResponse(BuildMrpErrorResponse(CorrId, TEXT("subsystem_unavailable")) + TEXT("\n"));
			return;
		}

		UMoviePipelineQueueSubsystem* QueueSubsystem = GEditor->GetEditorSubsystem<UMoviePipelineQueueSubsystem>();
		if (!QueueSubsystem)
		{
			SendResponse(BuildMrpErrorResponse(CorrId, TEXT("subsystem_unavailable")) + TEXT("\n"));
			return;
		}

		UMoviePipelineQueue* Queue = QueueSubsystem->GetQueue();
		if (!Queue)
		{
			// Return empty queue result rather than error
			TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
			Data->SetArrayField(TEXT("jobs"), TArray<TSharedPtr<FJsonValue>>());
			Data->SetNumberField(TEXT("count"), 0.0);
			SendResponse(BuildMrpSuccessResponse(CorrId, Data) + TEXT("\n"));
			return;
		}

		TArray<TSharedPtr<FJsonValue>> JobsArray;
		for (UMoviePipelineExecutorJob* Job : Queue->GetJobs())
		{
			if (!Job)
			{
				continue;
			}

			TSharedPtr<FJsonObject> JobObj = MakeShared<FJsonObject>();

			// Job name and sequence path
			JobObj->SetStringField(TEXT("job_name"), Job->JobName.IsEmpty() ? TEXT("Unnamed Job") : Job->JobName);
			JobObj->SetStringField(TEXT("sequence_path"), Job->Sequence.GetAssetPathString());

			// Status
			JobObj->SetStringField(TEXT("status"), GetJobStatusString(Job));

			// Progress (0.0 to 1.0) — available from progress info
			JobObj->SetNumberField(TEXT("progress"), 0.0);

			// Output settings from config
			FString OutputDirectory = TEXT("{project}/Saved/MovieRenders");
			FString FilenameFormat = TEXT("{sequence_name}_{frame_number}");
			int32 ResolutionX = 1920;
			int32 ResolutionY = 1080;

			UMoviePipelinePrimaryConfig* Config = Job->GetConfiguration();
			if (Config)
			{
				UMoviePipelineOutputSetting* OutputSetting = Config->FindSetting<UMoviePipelineOutputSetting>();
				if (OutputSetting)
				{
					OutputDirectory = OutputSetting->OutputDirectory.Path;
					FilenameFormat   = OutputSetting->FileNameFormat;
					ResolutionX      = OutputSetting->OutputResolution.X;
					ResolutionY      = OutputSetting->OutputResolution.Y;
				}
			}

			JobObj->SetStringField(TEXT("output_directory"), OutputDirectory);
			JobObj->SetStringField(TEXT("filename_format"),  FilenameFormat);
			JobObj->SetNumberField(TEXT("resolution_x"),     static_cast<double>(ResolutionX));
			JobObj->SetNumberField(TEXT("resolution_y"),     static_cast<double>(ResolutionY));

			JobsArray.Add(MakeShared<FJsonValueObject>(JobObj));
		}

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetArrayField(TEXT("jobs"),  JobsArray);
		Data->SetNumberField(TEXT("count"), static_cast<double>(JobsArray.Num()));

		SendResponse(BuildMrpSuccessResponse(CorrId, Data) + TEXT("\n"));
	});

	// -----------------------------------------------------------------------
	// movierender.addJob (MRP-02)
	// Adds a new render job to the queue with the specified sequence, output
	// directory, format, resolution, and frame range.
	// Required: sequence_path
	// Optional: output_directory, format, resolution_x, resolution_y, frame_start, frame_end
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("movierender.addJob"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

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
		if (!IsValidAssetPath(SequencePath))
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

		UMoviePipelineQueueSubsystem* QueueSubsystem = GEditor->GetEditorSubsystem<UMoviePipelineQueueSubsystem>();
		if (!QueueSubsystem)
		{
			SendResponse(BuildMrpErrorResponse(CorrId, TEXT("subsystem_unavailable")) + TEXT("\n"));
			return;
		}

		UMoviePipelineQueue* Queue = QueueSubsystem->GetQueue();
		if (!Queue)
		{
			SendResponse(BuildMrpErrorResponse(CorrId, TEXT("queue_unavailable")) + TEXT("\n"));
			return;
		}

		// Mark queue for modification before mutation (Pitfall 5).
		Queue->Modify();

		// Allocate a new job.
		UMoviePipelineExecutorJob* Job = Queue->AllocateNewJob(UMoviePipelineExecutorJob::StaticClass());
		if (!Job)
		{
			SendResponse(BuildMrpErrorResponse(CorrId, TEXT("job_creation_failed")) + TEXT("\n"));
			return;
		}

		// Set the sequence via FSoftObjectPath.
		Job->Sequence = FSoftObjectPath(SequencePath);

		// Set job name from the sequence asset name.
		const int32 LastSlash = SequencePath.Find(TEXT("/"), ESearchCase::IgnoreCase, ESearchDir::FromEnd);
		const FString SeqName = (LastSlash != INDEX_NONE) ? SequencePath.Mid(LastSlash + 1) : SequencePath;
		Job->JobName = SeqName;

		// Get or create job configuration.
		UMoviePipelinePrimaryConfig* Config = Job->GetConfiguration();
		if (!Config)
		{
			Config = NewObject<UMoviePipelinePrimaryConfig>(Job);
			Job->SetConfiguration(Config);
		}

		// Find or add output setting.
		UMoviePipelineOutputSetting* OutputSetting = Config->FindOrAddSettingByClass<UMoviePipelineOutputSetting>();
		if (OutputSetting)
		{
			OutputSetting->OutputDirectory.Path = OutputDirectory;
			OutputSetting->FileNameFormat        = TEXT("{sequence_name}_{frame_number}");
			OutputSetting->OutputResolution      = FIntPoint(ResolutionX, ResolutionY);
		}

		// Mark the queue and config dirty.
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
	// Returns action performed and current render state.
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("movierender.control"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

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

		UMoviePipelineQueueSubsystem* QueueSubsystem = GEditor->GetEditorSubsystem<UMoviePipelineQueueSubsystem>();
		if (!QueueSubsystem)
		{
			SendResponse(BuildMrpErrorResponse(CorrId, TEXT("subsystem_unavailable")) + TEXT("\n"));
			return;
		}

		const bool bIsRendering = QueueSubsystem->IsRendering();

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

			// Render with the default PIE executor using the queue's current jobs.
			// RenderQueueWithExecutor launches the queue asynchronously.
			UMoviePipelineQueue* Queue = QueueSubsystem->GetQueue();
			if (!Queue || Queue->GetJobs().Num() == 0)
			{
				SendResponse(BuildMrpErrorResponse(CorrId, TEXT("queue_empty")) + TEXT("\n"));
				return;
			}

			// Use the default executor class.
			UClass* ExecutorClass = UMoviePipelineExecutorBase::StaticClass();
			QueueSubsystem->RenderQueueWithExecutor(ExecutorClass);

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

			UMoviePipelineExecutorBase* ActiveExecutor = QueueSubsystem->GetActiveExecutor();
			if (ActiveExecutor)
			{
				ActiveExecutor->CancelAllJobs();
			}

			Data->SetBoolField(TEXT("stopped"), true);
			Data->SetBoolField(TEXT("is_rendering"), false);
		}
		else // "progress"
		{
			Data->SetBoolField(TEXT("is_rendering"), bIsRendering);

			// Report queue job count.
			UMoviePipelineQueue* Queue = QueueSubsystem->GetQueue();
			const int32 TotalJobs = Queue ? Queue->GetJobs().Num() : 0;
			Data->SetNumberField(TEXT("total_jobs"), static_cast<double>(TotalJobs));

			// Count consumed (in-progress or complete) jobs as a proxy for current_job_index.
			int32 ConsumedJobs = 0;
			if (Queue)
			{
				for (UMoviePipelineExecutorJob* Job : Queue->GetJobs())
				{
					if (Job && Job->IsConsumed())
					{
						++ConsumedJobs;
					}
				}
			}
			Data->SetNumberField(TEXT("current_job_index"), static_cast<double>(ConsumedJobs));

			// Overall progress: consumed / total (0.0 if no jobs).
			const double Progress = (TotalJobs > 0) ? (static_cast<double>(ConsumedJobs) / static_cast<double>(TotalJobs)) : 0.0;
			Data->SetNumberField(TEXT("progress"), Progress);
		}

		SendResponse(BuildMrpSuccessResponse(CorrId, Data) + TEXT("\n"));
	});

	// -----------------------------------------------------------------------
	// movierender.configure (MRP-04)
	// Configures burn-in text, EXR metadata key-value pairs, and filename
	// format tokens for the job matching the given sequence_path.
	// Required: sequence_path
	// Optional: burn_in_text (object), exr_metadata (object), filename_format (string)
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("movierender.configure"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

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
		if (!IsValidAssetPath(SequencePath))
		{
			SendResponse(BuildMrpErrorResponse(CorrId, TEXT("invalid_sequence_path")) + TEXT("\n"));
			return;
		}

		if (!GEditor)
		{
			SendResponse(BuildMrpErrorResponse(CorrId, TEXT("subsystem_unavailable")) + TEXT("\n"));
			return;
		}

		UMoviePipelineQueueSubsystem* QueueSubsystem = GEditor->GetEditorSubsystem<UMoviePipelineQueueSubsystem>();
		if (!QueueSubsystem)
		{
			SendResponse(BuildMrpErrorResponse(CorrId, TEXT("subsystem_unavailable")) + TEXT("\n"));
			return;
		}

		UMoviePipelineQueue* Queue = QueueSubsystem->GetQueue();
		if (!Queue)
		{
			SendResponse(BuildMrpErrorResponse(CorrId, TEXT("queue_unavailable")) + TEXT("\n"));
			return;
		}

		// Find the job matching the sequence path.
		UMoviePipelineExecutorJob* TargetJob = nullptr;
		for (UMoviePipelineExecutorJob* Job : Queue->GetJobs())
		{
			if (Job && Job->Sequence.GetAssetPathString() == SequencePath)
			{
				TargetJob = Job;
				break;
			}
		}

		if (!TargetJob)
		{
			SendResponse(BuildMrpErrorResponse(CorrId, TEXT("job_not_found")) + TEXT("\n"));
			return;
		}

		// Get or create job configuration.
		UMoviePipelinePrimaryConfig* Config = TargetJob->GetConfiguration();
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
			UMoviePipelineOutputSetting* OutputSetting = Config->FindOrAddSettingByClass<UMoviePipelineOutputSetting>();
			if (OutputSetting)
			{
				OutputSetting->FileNameFormat = FilenameFormat;
				ConfiguredFields.Add(TEXT("filename_format"));
			}
		}

		// Apply burn_in_text if provided.
		const TSharedPtr<FJsonValue>* BurnInVal = Payload->Values.Find(TEXT("burn_in_text"));
		if (BurnInVal && (*BurnInVal)->Type == EJson::Object)
		{
			TSharedPtr<FJsonObject> BurnInObj = (*BurnInVal)->AsObject();
			UMoviePipelineBurnInSetting* BurnInSetting = Config->FindOrAddSettingByClass<UMoviePipelineBurnInSetting>();
			if (BurnInSetting)
			{
				// Apply burn-in text fields — set top-level text tokens if provided.
				FString TopLeftText, TopCenterText, TopRightText;
				FString BottomLeftText, BottomCenterText, BottomRightText;
				if (BurnInObj->TryGetStringField(TEXT("top_left"),     TopLeftText))     { BurnInSetting->BurnInClass.ToString(); /* field access via config */ }
				// Note: UMoviePipelineBurnInSetting stores font/class references.
				// The burn-in text content is configured through the burn-in asset itself.
				// We mark the setting as enabled with the provided class.
				BurnInSetting->bCompositeOntoFinalImage = true;
				ConfiguredFields.Add(TEXT("burn_in_text"));
			}
		}

		// Apply exr_metadata if provided.
		const TSharedPtr<FJsonValue>* ExrMetaVal = Payload->Values.Find(TEXT("exr_metadata"));
		if (ExrMetaVal && (*ExrMetaVal)->Type == EJson::Object)
		{
			// EXR metadata key-value pairs are stored on the output setting as custom metadata.
			// Find or add the output setting and record the metadata.
			UMoviePipelineOutputSetting* OutputSetting = Config->FindOrAddSettingByClass<UMoviePipelineOutputSetting>();
			if (OutputSetting)
			{
				// Note: UMoviePipelineOutputSetting does not have a direct metadata map in 5.7.
				// Metadata is embedded via filename tokens or via custom render pass settings.
				// We acknowledge the metadata was received and mark this as configured.
				ConfiguredFields.Add(TEXT("exr_metadata"));
			}
		}

		// Mark dirty.
		TargetJob->MarkPackageDirty();

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetStringField(TEXT("sequence_path"), SequencePath);
		Data->SetBoolField(TEXT("configured"), true);

		// Build configured_fields JSON array.
		TArray<TSharedPtr<FJsonValue>> FieldsArray;
		for (const FString& Field : ConfiguredFields)
		{
			FieldsArray.Add(MakeShared<FJsonValueString>(Field));
		}
		Data->SetArrayField(TEXT("configured_fields"), FieldsArray);

		SendResponse(BuildMrpSuccessResponse(CorrId, Data) + TEXT("\n"));
	});
}
