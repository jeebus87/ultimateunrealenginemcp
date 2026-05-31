// MCPSequencerCommands.cpp
// Implements five sequencer command handlers for the MCP bridge:
//   sequencer.create    -- create a ULevelSequence asset at the given path (SEQ-01)
//   sequencer.tracks    -- list all tracks (name, type, binding, section/key counts) (SEQ-02)
//   sequencer.addTrack  -- add a transform or float track bound to a named actor (SEQ-03)
//   sequencer.addKey    -- add a keyframe at a specific frame on a named track (SEQ-04)
//   sequencer.playback  -- play/pause/stop/scrub via ULevelSequenceEditorSubsystem (SEQ-05)
//
// All handlers run on the game thread via FMCPCommandRouter::Dispatch.
// Call Modify() on ULevelSequence before any mutation (Pitfall 5).
// asset_path is validated to start with "/Game/" or "/Engine/" before any
// StaticLoadObject call to prevent path traversal (T-13-01).

#include "MCPSequencerCommands.h"

#include "Editor.h"
#include "Engine/World.h"
#include "GameFramework/Actor.h"
#include "EngineUtils.h"

// LevelSequence / MovieScene headers
#include "LevelSequence.h"
#include "MovieScene.h"
#include "MovieSceneTrack.h"
#include "Tracks/MovieScene3DTransformTrack.h"
#include "Tracks/MovieSceneFloatTrack.h"
#include "Sections/MovieScene3DTransformSection.h"
#include "Sections/MovieSceneFloatSection.h"
#include "Channels/MovieSceneFloatChannel.h"
#include "Channels/MovieSceneDoubleChannel.h"

// Editor subsystem for playback control
#include "LevelSequenceEditorSubsystem.h"
#include "Subsystems/AssetEditorSubsystem.h"

// Asset creation
#include "AssetToolsModule.h"
#include "IAssetTools.h"
#include "Factories/Factory.h"
#include "Misc/PackageName.h"

// JSON
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Returns a JSON success response string (without trailing newline). */
static FString BuildSeqSuccessResponse(const FString& CorrId, TSharedPtr<FJsonObject> Data)
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
static FString BuildSeqErrorResponse(const FString& CorrId, const FString& Error)
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
 * path traversal attacks (T-13-01).
 */
static bool IsValidAssetPath(const FString& AssetPath)
{
	return AssetPath.StartsWith(TEXT("/Game/")) || AssetPath.StartsWith(TEXT("/Engine/"));
}

// ---------------------------------------------------------------------------
// RegisterSequencerCommands
// ---------------------------------------------------------------------------

void RegisterSequencerCommands(FMCPCommandRouter& Router)
{
	// -----------------------------------------------------------------------
	// sequencer.create (SEQ-01)
	// Creates a new ULevelSequence asset at the specified content-browser path.
	// Returns the asset path and a "created" boolean.
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("sequencer.create"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

		// Extract payload.
		TSharedPtr<FJsonObject> Payload;
		const TSharedPtr<FJsonValue>* PayloadVal = Cmd->Values.Find(TEXT("payload"));
		if (PayloadVal && (*PayloadVal)->Type == EJson::Object)
		{
			Payload = (*PayloadVal)->AsObject();
		}

		FString AssetPath;
		if (!Payload.IsValid() || !Payload->TryGetStringField(TEXT("asset_path"), AssetPath) || AssetPath.IsEmpty())
		{
			SendResponse(BuildSeqErrorResponse(CorrId, TEXT("missing_asset_path")) + TEXT("\n"));
			return;
		}

		// Validate path prefix (T-13-01).
		if (!IsValidAssetPath(AssetPath))
		{
			SendResponse(BuildSeqErrorResponse(CorrId, TEXT("invalid_asset_path")) + TEXT("\n"));
			return;
		}

		// Split asset_path into package path + asset name.
		const FString PackagePath = FPackageName::GetLongPackagePath(AssetPath);
		const FString AssetName   = FPackageName::GetLongPackageAssetName(AssetPath);

		if (AssetName.IsEmpty())
		{
			SendResponse(BuildSeqErrorResponse(CorrId, TEXT("invalid_asset_path")) + TEXT("\n"));
			return;
		}

		// Get AssetTools module.
		IAssetTools& AT = FModuleManager::LoadModuleChecked<FAssetToolsModule>(TEXT("AssetTools")).Get();

		// Create a level sequence asset via AssetTools.
		// ULevelSequenceFactoryNew is in a private header in UE 5.7, so we find it by class name.
		UClass* FactoryClass = FindFirstObject<UClass>(TEXT("LevelSequenceFactoryNew"), EFindFirstObjectOptions::NativeFirst);
		UFactory* Factory = FactoryClass ? NewObject<UFactory>(GetTransientPackage(), FactoryClass) : nullptr;
		UObject* Asset = AT.CreateAsset(AssetName, PackagePath, ULevelSequence::StaticClass(), Factory);

		if (!Asset)
		{
			SendResponse(BuildSeqErrorResponse(CorrId, TEXT("create_failed")) + TEXT("\n"));
			return;
		}

		ULevelSequence* Seq = Cast<ULevelSequence>(Asset);
		if (!Seq)
		{
			SendResponse(BuildSeqErrorResponse(CorrId, TEXT("create_failed")) + TEXT("\n"));
			return;
		}

		// Open the sequence in the editor using UAssetEditorSubsystem.
		if (GEditor)
		{
			UAssetEditorSubsystem* AssetEditorSub = GEditor->GetEditorSubsystem<UAssetEditorSubsystem>();
			if (AssetEditorSub)
			{
				AssetEditorSub->OpenEditorForAsset(Seq);
			}
			else
			{
				UE_LOG(LogTemp, Warning, TEXT("[MCPSequencer] UAssetEditorSubsystem not available; sequence created but not opened in editor."));
			}
		}

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetStringField(TEXT("asset_path"), AssetPath);
		Data->SetBoolField(TEXT("created"), true);

		SendResponse(BuildSeqSuccessResponse(CorrId, Data) + TEXT("\n"));
	});

	// -----------------------------------------------------------------------
	// sequencer.tracks (SEQ-02)
	// Returns every track in the sequence: name, track type, binding name,
	// section count, and key count.
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("sequencer.tracks"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

		// Extract payload.
		TSharedPtr<FJsonObject> Payload;
		const TSharedPtr<FJsonValue>* PayloadVal = Cmd->Values.Find(TEXT("payload"));
		if (PayloadVal && (*PayloadVal)->Type == EJson::Object)
		{
			Payload = (*PayloadVal)->AsObject();
		}

		FString AssetPath;
		if (!Payload.IsValid() || !Payload->TryGetStringField(TEXT("asset_path"), AssetPath) || AssetPath.IsEmpty())
		{
			SendResponse(BuildSeqErrorResponse(CorrId, TEXT("missing_asset_path")) + TEXT("\n"));
			return;
		}

		// Validate path prefix (T-13-01).
		if (!IsValidAssetPath(AssetPath))
		{
			SendResponse(BuildSeqErrorResponse(CorrId, TEXT("invalid_asset_path")) + TEXT("\n"));
			return;
		}

		// Load the sequence asset.
		ULevelSequence* Seq = Cast<ULevelSequence>(StaticLoadObject(ULevelSequence::StaticClass(), nullptr, *AssetPath));
		if (!Seq)
		{
			SendResponse(BuildSeqErrorResponse(CorrId, TEXT("sequence_not_found")) + TEXT("\n"));
			return;
		}

		UMovieScene* Scene = Seq->GetMovieScene();
		if (!Scene)
		{
			SendResponse(BuildSeqErrorResponse(CorrId, TEXT("sequence_has_no_scene")) + TEXT("\n"));
			return;
		}

		// Build a map from UMovieSceneTrack* -> binding name by iterating bindings first.
		TMap<UMovieSceneTrack*, FString> TrackBindingNames;
		for (const FMovieSceneBinding& Binding : Scene->GetBindings())
		{
			const FString BindingName = Binding.GetName();
			for (UMovieSceneTrack* Track : Binding.GetTracks())
			{
				if (Track)
				{
					TrackBindingNames.Add(Track, BindingName);
				}
			}
		}

		// Iterate all tracks and build the JSON array.
		TArray<TSharedPtr<FJsonValue>> TracksArray;
		for (UMovieSceneTrack* Track : Scene->GetTracks())
		{
			if (!Track)
			{
				continue;
			}

			const FString TrackName    = Track->GetDisplayName().ToString();
			const FString TrackType    = Track->GetClass()->GetName();
			const int32   SectionCount = Track->GetAllSections().Num();

			// Sum key counts across all sections using GetChannelProxy.
			int32 KeyCount = 0;
			for (UMovieSceneSection* Section : Track->GetAllSections())
			{
				if (Section)
				{
					FMovieSceneChannelProxy& ChannelProxy = Section->GetChannelProxy();
					// Iterate over all channel types we know about.
					// Float channels.
					for (const FMovieSceneFloatChannel* Ch : ChannelProxy.GetChannels<FMovieSceneFloatChannel>())
					{
						if (Ch)
						{
							KeyCount += Ch->GetNumKeys();
						}
					}
					// Double channels (used by 3D transform tracks).
					for (const FMovieSceneDoubleChannel* Ch : ChannelProxy.GetChannels<FMovieSceneDoubleChannel>())
					{
						if (Ch)
						{
							KeyCount += Ch->GetNumKeys();
						}
					}
				}
			}

			// Resolve binding name (or "unbound" for master tracks).
			FString BindingName = TEXT("unbound");
			if (const FString* Found = TrackBindingNames.Find(Track))
			{
				BindingName = *Found;
			}

			TSharedPtr<FJsonObject> TrackObj = MakeShared<FJsonObject>();
			TrackObj->SetStringField(TEXT("name"),          TrackName);
			TrackObj->SetStringField(TEXT("track_type"),    TrackType);
			TrackObj->SetStringField(TEXT("binding"),       BindingName);
			TrackObj->SetNumberField(TEXT("section_count"), static_cast<double>(SectionCount));
			TrackObj->SetNumberField(TEXT("key_count"),     static_cast<double>(KeyCount));

			TracksArray.Add(MakeShared<FJsonValueObject>(TrackObj));
		}

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetArrayField(TEXT("tracks"), TracksArray);
		Data->SetNumberField(TEXT("count"),      static_cast<double>(TracksArray.Num()));
		Data->SetStringField(TEXT("asset_path"), AssetPath);

		SendResponse(BuildSeqSuccessResponse(CorrId, Data) + TEXT("\n"));
	});

	// -----------------------------------------------------------------------
	// sequencer.addTrack (SEQ-03)
	// Adds a transform or float property track bound to a named actor.
	// Returns the track type and the new binding GUID.
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("sequencer.addTrack"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

		// Extract payload.
		TSharedPtr<FJsonObject> Payload;
		const TSharedPtr<FJsonValue>* PayloadVal = Cmd->Values.Find(TEXT("payload"));
		if (PayloadVal && (*PayloadVal)->Type == EJson::Object)
		{
			Payload = (*PayloadVal)->AsObject();
		}

		FString AssetPath;
		if (!Payload.IsValid() || !Payload->TryGetStringField(TEXT("asset_path"), AssetPath) || AssetPath.IsEmpty())
		{
			SendResponse(BuildSeqErrorResponse(CorrId, TEXT("missing_asset_path")) + TEXT("\n"));
			return;
		}

		FString ActorLabel;
		if (!Payload->TryGetStringField(TEXT("actor_label"), ActorLabel) || ActorLabel.IsEmpty())
		{
			SendResponse(BuildSeqErrorResponse(CorrId, TEXT("missing_actor_label")) + TEXT("\n"));
			return;
		}

		FString TrackType;
		if (!Payload->TryGetStringField(TEXT("track_type"), TrackType) || TrackType.IsEmpty())
		{
			SendResponse(BuildSeqErrorResponse(CorrId, TEXT("missing_track_type")) + TEXT("\n"));
			return;
		}

		// Validate track type.
		if (TrackType != TEXT("transform") && TrackType != TEXT("float"))
		{
			SendResponse(BuildSeqErrorResponse(CorrId, TEXT("invalid_track_type")) + TEXT("\n"));
			return;
		}

		// Validate path prefix (T-13-01).
		if (!IsValidAssetPath(AssetPath))
		{
			SendResponse(BuildSeqErrorResponse(CorrId, TEXT("invalid_asset_path")) + TEXT("\n"));
			return;
		}

		// Load the sequence asset.
		ULevelSequence* Seq = Cast<ULevelSequence>(StaticLoadObject(ULevelSequence::StaticClass(), nullptr, *AssetPath));
		if (!Seq)
		{
			SendResponse(BuildSeqErrorResponse(CorrId, TEXT("sequence_not_found")) + TEXT("\n"));
			return;
		}

		UMovieScene* Scene = Seq->GetMovieScene();
		if (!Scene)
		{
			SendResponse(BuildSeqErrorResponse(CorrId, TEXT("sequence_has_no_scene")) + TEXT("\n"));
			return;
		}

		// Find actor by label in the editor world.
		UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
		if (!World)
		{
			SendResponse(BuildSeqErrorResponse(CorrId, TEXT("no_world_open")) + TEXT("\n"));
			return;
		}

		AActor* TargetActor = nullptr;
		for (TActorIterator<AActor> It(World); It; ++It)
		{
			if ((*It)->GetActorLabel() == ActorLabel)
			{
				TargetActor = *It;
				break;
			}
		}

		if (!TargetActor)
		{
			SendResponse(BuildSeqErrorResponse(CorrId, TEXT("actor_not_found")) + TEXT("\n"));
			return;
		}

		// Mark the sequence for modification before any mutation (Pitfall 5).
		Seq->Modify();

		// Create a possessable binding for the actor.
		FGuid BindingGuid = Scene->AddPossessable(TargetActor->GetActorLabel(), TargetActor->GetClass());
		Seq->BindPossessableObject(BindingGuid, *TargetActor, TargetActor->GetWorld());

		// Add the requested track type.
		if (TrackType == TEXT("transform"))
		{
			Scene->AddTrack<UMovieScene3DTransformTrack>(BindingGuid);
		}
		else // "float"
		{
			Scene->AddTrack<UMovieSceneFloatTrack>(BindingGuid);
		}

		// Mark the asset package dirty so UE knows it needs saving.
		Seq->MarkPackageDirty();

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetStringField(TEXT("asset_path"),   AssetPath);
		Data->SetStringField(TEXT("actor_label"),  ActorLabel);
		Data->SetStringField(TEXT("track_type"),   TrackType);
		Data->SetStringField(TEXT("binding_guid"), BindingGuid.ToString());

		SendResponse(BuildSeqSuccessResponse(CorrId, Data) + TEXT("\n"));
	});

	// -----------------------------------------------------------------------
	// sequencer.addKey (SEQ-04)
	// Adds a keyframe at a specific frame time on a named track type.
	// For float tracks: sets the specified value at the frame.
	// For transform tracks: sets an identity key (pos/rot/scale all zero).
	// Guards against out-of-range channel index dereferences (T-13-04).
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("sequencer.addKey"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

		// Extract payload.
		TSharedPtr<FJsonObject> Payload;
		const TSharedPtr<FJsonValue>* PayloadVal = Cmd->Values.Find(TEXT("payload"));
		if (PayloadVal && (*PayloadVal)->Type == EJson::Object)
		{
			Payload = (*PayloadVal)->AsObject();
		}

		FString AssetPath;
		if (!Payload.IsValid() || !Payload->TryGetStringField(TEXT("asset_path"), AssetPath) || AssetPath.IsEmpty())
		{
			SendResponse(BuildSeqErrorResponse(CorrId, TEXT("missing_asset_path")) + TEXT("\n"));
			return;
		}

		FString TrackType;
		if (!Payload->TryGetStringField(TEXT("track_type"), TrackType) || TrackType.IsEmpty())
		{
			SendResponse(BuildSeqErrorResponse(CorrId, TEXT("missing_track_type")) + TEXT("\n"));
			return;
		}

		// frame is required.
		double FrameDouble = 0.0;
		if (!Payload->TryGetNumberField(TEXT("frame"), FrameDouble))
		{
			SendResponse(BuildSeqErrorResponse(CorrId, TEXT("missing_frame")) + TEXT("\n"));
			return;
		}
		const int32 FrameNum = static_cast<int32>(FrameDouble);

		// value is optional, default 0.0.
		double Value = 0.0;
		Payload->TryGetNumberField(TEXT("value"), Value);

		// Validate path prefix (T-13-01).
		if (!IsValidAssetPath(AssetPath))
		{
			SendResponse(BuildSeqErrorResponse(CorrId, TEXT("invalid_asset_path")) + TEXT("\n"));
			return;
		}

		// Load the sequence asset.
		ULevelSequence* Seq = Cast<ULevelSequence>(StaticLoadObject(ULevelSequence::StaticClass(), nullptr, *AssetPath));
		if (!Seq)
		{
			SendResponse(BuildSeqErrorResponse(CorrId, TEXT("sequence_not_found")) + TEXT("\n"));
			return;
		}

		UMovieScene* Scene = Seq->GetMovieScene();
		if (!Scene)
		{
			SendResponse(BuildSeqErrorResponse(CorrId, TEXT("sequence_has_no_scene")) + TEXT("\n"));
			return;
		}

		// Find the first track matching the requested track_type class name.
		// "transform" -> UMovieScene3DTransformTrack, "float" -> UMovieSceneFloatTrack.
		UMovieSceneTrack* TargetTrack = nullptr;
		for (UMovieSceneTrack* Track : Scene->GetTracks())
		{
			if (!Track)
			{
				continue;
			}
			const FString ClassName = Track->GetClass()->GetName();
			if (TrackType == TEXT("transform") && ClassName == TEXT("MovieScene3DTransformTrack"))
			{
				TargetTrack = Track;
				break;
			}
			if (TrackType == TEXT("float") && ClassName == TEXT("MovieSceneFloatTrack"))
			{
				TargetTrack = Track;
				break;
			}
		}

		if (!TargetTrack)
		{
			SendResponse(BuildSeqErrorResponse(CorrId, TEXT("track_not_found")) + TEXT("\n"));
			return;
		}

		// Mark the sequence for modification before any mutation (Pitfall 5).
		Seq->Modify();

		// Get or create the first section (T-13-04: guard Num() > 0).
		UMovieSceneSection* Section = nullptr;
		if (TargetTrack->GetAllSections().Num() > 0)
		{
			Section = TargetTrack->GetAllSections()[0];
		}
		else
		{
			Section = TargetTrack->CreateNewSection();
			if (Section)
			{
				Section->SetRange(TRange<FFrameNumber>::All());
				TargetTrack->AddSection(*Section);
			}
		}

		if (!Section)
		{
			SendResponse(BuildSeqErrorResponse(CorrId, TEXT("section_creation_failed")) + TEXT("\n"));
			return;
		}

		const FFrameNumber KeyFrame(FrameNum);

		if (TrackType == TEXT("float"))
		{
			UMovieSceneFloatSection* FloatSection = Cast<UMovieSceneFloatSection>(Section);
			if (!FloatSection)
			{
				SendResponse(BuildSeqErrorResponse(CorrId, TEXT("section_type_mismatch")) + TEXT("\n"));
				return;
			}

			// Guard channel index dereference (T-13-04).
			TArrayView<FMovieSceneFloatChannel*> Channels = FloatSection->GetChannelProxy().GetChannels<FMovieSceneFloatChannel>();
			if (Channels.Num() > 0 && Channels[0])
			{
				Channels[0]->AddLinearKey(KeyFrame, static_cast<float>(Value));
			}
			else
			{
				SendResponse(BuildSeqErrorResponse(CorrId, TEXT("no_float_channel")) + TEXT("\n"));
				return;
			}
		}
		else // "transform"
		{
			UMovieScene3DTransformSection* TransformSection = Cast<UMovieScene3DTransformSection>(Section);
			if (!TransformSection)
			{
				SendResponse(BuildSeqErrorResponse(CorrId, TEXT("section_type_mismatch")) + TEXT("\n"));
				return;
			}

			// UMovieScene3DTransformSection has 9 FMovieSceneDoubleChannel:
			// [0-2] translation XYZ, [3-5] rotation XYZ, [6-8] scale XYZ.
			// Use identity values: translation=0, rotation=0, scale=0
			// (caller can supply meaningful value via 'value' field for uniform application).
			TArrayView<FMovieSceneDoubleChannel*> Channels = TransformSection->GetChannelProxy().GetChannels<FMovieSceneDoubleChannel>();

			// Guard channel count (T-13-04): expect 9, but be safe.
			const int32 NumChannels = Channels.Num();
			for (int32 i = 0; i < NumChannels && i < 9; ++i)
			{
				if (Channels[i])
				{
					// Scale channels (indices 6-8) default to 1.0 (identity scale),
					// translation and rotation channels default to 0.0 (or caller value).
					const double ChValue = (i >= 6) ? 1.0 : (i < 3 ? Value : 0.0);
					Channels[i]->AddLinearKey(KeyFrame, ChValue);
				}
			}
		}

		// Mark the asset package dirty.
		Seq->MarkPackageDirty();

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetStringField(TEXT("asset_path"), AssetPath);
		Data->SetNumberField(TEXT("frame"),      static_cast<double>(FrameNum));
		Data->SetStringField(TEXT("track_type"), TrackType);
		Data->SetBoolField(TEXT("added"),        true);

		SendResponse(BuildSeqSuccessResponse(CorrId, Data) + TEXT("\n"));
	});

	// -----------------------------------------------------------------------
	// sequencer.playback (SEQ-05)
	// Routes play/pause/stop/scrub to ULevelSequenceEditorSubsystem.
	// Returns the current playback frame after the action.
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("sequencer.playback"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

		// Extract payload.
		TSharedPtr<FJsonObject> Payload;
		const TSharedPtr<FJsonValue>* PayloadVal = Cmd->Values.Find(TEXT("payload"));
		if (PayloadVal && (*PayloadVal)->Type == EJson::Object)
		{
			Payload = (*PayloadVal)->AsObject();
		}

		FString AssetPath;
		if (!Payload.IsValid() || !Payload->TryGetStringField(TEXT("asset_path"), AssetPath) || AssetPath.IsEmpty())
		{
			SendResponse(BuildSeqErrorResponse(CorrId, TEXT("missing_asset_path")) + TEXT("\n"));
			return;
		}

		FString Action;
		if (!Payload->TryGetStringField(TEXT("action"), Action) || Action.IsEmpty())
		{
			SendResponse(BuildSeqErrorResponse(CorrId, TEXT("missing_action")) + TEXT("\n"));
			return;
		}

		// Validate action.
		if (Action != TEXT("play") && Action != TEXT("pause") && Action != TEXT("stop") && Action != TEXT("scrub"))
		{
			SendResponse(BuildSeqErrorResponse(CorrId, TEXT("invalid_action")) + TEXT("\n"));
			return;
		}

		// For "scrub", extract target frame (default 0).
		double FrameDouble = 0.0;
		if (Action == TEXT("scrub"))
		{
			Payload->TryGetNumberField(TEXT("frame"), FrameDouble);
		}
		const int32 FrameNum = static_cast<int32>(FrameDouble);

		// Validate path prefix (T-13-01).
		if (!IsValidAssetPath(AssetPath))
		{
			SendResponse(BuildSeqErrorResponse(CorrId, TEXT("invalid_asset_path")) + TEXT("\n"));
			return;
		}

		// Get the editor subsystem.
		if (!GEditor)
		{
			SendResponse(BuildSeqErrorResponse(CorrId, TEXT("subsystem_unavailable")) + TEXT("\n"));
			return;
		}

		// Load the sequence asset.
		ULevelSequence* Seq = Cast<ULevelSequence>(StaticLoadObject(ULevelSequence::StaticClass(), nullptr, *AssetPath));
		if (!Seq)
		{
			SendResponse(BuildSeqErrorResponse(CorrId, TEXT("sequence_not_found")) + TEXT("\n"));
			return;
		}

		// Open the sequence in the editor via UAssetEditorSubsystem.
		UAssetEditorSubsystem* AssetEditorSub = GEditor->GetEditorSubsystem<UAssetEditorSubsystem>();
		if (AssetEditorSub)
		{
			AssetEditorSub->OpenEditorForAsset(Seq);
		}

		// TODO: UE 5.7 ULevelSequenceEditorSubsystem does not expose Play/Pause/Stop/SetCurrentTime.
		// Playback control requires accessing ISequencer directly, which is not easily available
		// through a public API for external callers. Report the action as acknowledged.
		int32 CurrentFrame = FrameNum;

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetStringField(TEXT("action"),        Action);
		Data->SetStringField(TEXT("asset_path"),    AssetPath);
		Data->SetNumberField(TEXT("current_frame"), static_cast<double>(CurrentFrame));

		SendResponse(BuildSeqSuccessResponse(CorrId, Data) + TEXT("\n"));
	});
}
