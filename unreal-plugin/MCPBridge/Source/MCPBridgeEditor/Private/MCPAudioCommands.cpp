// MCPAudioCommands.cpp (Plan 23-01)
// Implements four audio system inspection command handlers for the MCP bridge:
//   audio.list       -- list all sound assets by type (AUD-01)
//   audio.metasound  -- inspect MetaSound patch graph nodes, inputs, outputs (AUD-02)
//   audio.soundcue   -- read SoundCue node graph and attenuation settings (AUD-03)
//   audio.insights   -- query Audio Insights monitoring data (AUD-04)
//
// All handlers run on the game thread via FMCPCommandRouter::Dispatch.
// All operations are read-only -- no Modify() calls needed.
// asset_path is validated to start with "/Game/" or "/Engine/" before any
// StaticLoadObject call to prevent path traversal (T-23-01).
// audio.soundcue recursion is capped at 50 levels to prevent DoS (T-23-02).
// audio.list type_filter is validated against known types (T-23-03).

#include "MCPAudioCommands.h"

// Sound headers
#include "Sound/SoundWave.h"
#include "Sound/SoundCue.h"
#include "Sound/SoundNode.h"
#include "Sound/SoundNodeWavePlayer.h"
#include "Sound/SoundNodeModulator.h"
#include "Sound/SoundNodeAttenuation.h"
#include "Sound/SoundAttenuation.h"
#include "Engine/Attenuation.h"

// MetaSound headers
#include "MetasoundSource.h"
#include "MetasoundFrontendDocument.h"
#include "MetasoundDocumentInterface.h"

// Asset Registry
#include "AssetRegistry/AssetRegistryModule.h"
#include "AssetRegistry/IAssetRegistry.h"

// Editor / Engine
#include "Editor.h"
#include "AudioDevice.h"
#include "AudioDeviceHandle.h"
#include "Modules/ModuleManager.h"

// JSON
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Returns a JSON success response string (without trailing newline). */
static FString BuildAudioSuccessResponse(const FString& CorrId, TSharedPtr<FJsonObject> Data)
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
static FString BuildAudioErrorResponse(const FString& CorrId, const FString& Error)
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
 * path traversal attacks (T-23-01).
 */
static bool IsValidAssetPath(const FString& AssetPath)
{
	return AssetPath.StartsWith(TEXT("/Game/")) || AssetPath.StartsWith(TEXT("/Engine/"));
}

/**
 * Convert EAttenuationDistanceModel to string for SoundCue attenuation (AUD-03).
 * Enum defined in Engine/Attenuation.h (Linear, Logarithmic, Inverse, LogReverse, NaturalSound, Custom).
 */
static FString AttenuationFalloffModelToString(EAttenuationDistanceModel Model)
{
	switch (Model)
	{
		case EAttenuationDistanceModel::Linear:       return TEXT("Linear");
		case EAttenuationDistanceModel::Logarithmic:  return TEXT("Logarithmic");
		case EAttenuationDistanceModel::Inverse:      return TEXT("Inverse");
		case EAttenuationDistanceModel::LogReverse:   return TEXT("LogReverse");
		case EAttenuationDistanceModel::NaturalSound: return TEXT("NaturalSound");
		case EAttenuationDistanceModel::Custom:       return TEXT("Custom");
		default:                                      return TEXT("Linear");
	}
}

/**
 * Convert ESpatialization to string for SoundCue attenuation (AUD-03).
 */
static FString SpatializationMethodToString(ESoundSpatializationAlgorithm Method)
{
	switch (Method)
	{
		case ESoundSpatializationAlgorithm::SPATIALIZATION_Default:  return TEXT("Panning");
		case ESoundSpatializationAlgorithm::SPATIALIZATION_HRTF:     return TEXT("Binaural");
		default:                                                      return TEXT("Panning");
	}
}

/**
 * Build attenuation data JSON from FSoundAttenuationSettings.
 */
static TSharedPtr<FJsonObject> BuildAttenuationObject(const FSoundAttenuationSettings& Settings)
{
	TSharedPtr<FJsonObject> AttObj = MakeShared<FJsonObject>();
	AttObj->SetNumberField(TEXT("attenuation_inner_radius"),    static_cast<double>(Settings.AttenuationShapeExtents.X));
	AttObj->SetNumberField(TEXT("attenuation_falloff_distance"), static_cast<double>(Settings.FalloffDistance));
	AttObj->SetStringField(TEXT("attenuation_falloff_model"),   AttenuationFalloffModelToString(Settings.DistanceAlgorithm));
	AttObj->SetStringField(TEXT("spatialization_method"),       SpatializationMethodToString(Settings.SpatializationAlgorithm));
	return AttObj;
}

/**
 * Recursively build a JSON node tree from a USoundNode (AUD-03).
 * Depth is tracked to cap recursion at MaxDepth levels (T-23-02).
 * Returns nullptr if depth exceeded or node is null.
 */
static TSharedPtr<FJsonObject> BuildSoundNodeTree(USoundNode* Node, int32 Depth, int32 MaxDepth, bool& bDepthExceeded)
{
	if (!Node)
	{
		return nullptr;
	}

	if (Depth >= MaxDepth)
	{
		bDepthExceeded = true;
		TSharedPtr<FJsonObject> TruncObj = MakeShared<FJsonObject>();
		TruncObj->SetStringField(TEXT("node_name"),  TEXT("TRUNCATED"));
		TruncObj->SetStringField(TEXT("node_class"), TEXT("TRUNCATED"));
		TruncObj->SetBoolField(TEXT("depth_exceeded"), true);
		return TruncObj;
	}

	TSharedPtr<FJsonObject> NodeObj = MakeShared<FJsonObject>();
	NodeObj->SetStringField(TEXT("node_name"),  Node->GetName());
	NodeObj->SetStringField(TEXT("node_class"), Node->GetClass()->GetName());

	// Type-specific fields for USoundNodeWavePlayer.
	if (USoundNodeWavePlayer* WavePlayer = Cast<USoundNodeWavePlayer>(Node))
	{
		FString WavePath;
		if (WavePlayer->GetSoundWave())
		{
			WavePath = WavePlayer->GetSoundWave()->GetPathName();
		}
		NodeObj->SetStringField(TEXT("wave_asset_path"), WavePath);
	}

	// Type-specific fields for USoundNodeModulator.
	if (USoundNodeModulator* Modulator = Cast<USoundNodeModulator>(Node))
	{
		NodeObj->SetNumberField(TEXT("pitch_min"),   static_cast<double>(Modulator->PitchMin));
		NodeObj->SetNumberField(TEXT("pitch_max"),   static_cast<double>(Modulator->PitchMax));
		NodeObj->SetNumberField(TEXT("volume_min"),  static_cast<double>(Modulator->VolumeMin));
		NodeObj->SetNumberField(TEXT("volume_max"),  static_cast<double>(Modulator->VolumeMax));
	}

	// Type-specific fields for USoundNodeAttenuation.
	if (USoundNodeAttenuation* AttNode = Cast<USoundNodeAttenuation>(Node))
	{
		const bool bHasCustomAttenuation = (AttNode->AttenuationSettings != nullptr)
			|| (AttNode->bOverrideAttenuation);
		NodeObj->SetBoolField(TEXT("has_custom_attenuation"), bHasCustomAttenuation);

		if (bHasCustomAttenuation)
		{
			const FSoundAttenuationSettings* SettingsPtr = nullptr;
			if (AttNode->AttenuationSettings)
			{
				SettingsPtr = &AttNode->AttenuationSettings->Attenuation;
			}
			else if (AttNode->bOverrideAttenuation)
			{
				SettingsPtr = &AttNode->AttenuationOverrides;
			}

			if (SettingsPtr)
			{
				TSharedPtr<FJsonObject> AttObj = BuildAttenuationObject(*SettingsPtr);
				NodeObj->SetObjectField(TEXT("attenuation"), AttObj);
			}
		}
	}

	// Recurse into child nodes.
	TArray<TSharedPtr<FJsonValue>> ChildrenArray;
	for (USoundNode* Child : Node->ChildNodes)
	{
		TSharedPtr<FJsonObject> ChildObj = BuildSoundNodeTree(Child, Depth + 1, MaxDepth, bDepthExceeded);
		if (ChildObj.IsValid())
		{
			ChildrenArray.Add(MakeShared<FJsonValueObject>(ChildObj));
		}
	}
	NodeObj->SetArrayField(TEXT("children"), ChildrenArray);

	return NodeObj;
}

// ---------------------------------------------------------------------------
// RegisterAudioCommands
// ---------------------------------------------------------------------------

void RegisterAudioCommands(FMCPCommandRouter& Router)
{
	// -----------------------------------------------------------------------
	// audio.list (AUD-01)
	// Lists sound assets in the project, optionally filtered by type.
	// Optional payload field: type_filter ("SoundWave", "SoundCue", "MetaSound", or empty for all).
	// Returns JSON array `assets` with: asset_path, asset_name, asset_type.
	// For SoundWave assets: duration, sample_rate, num_channels, compression_name also returned.
	// Threat T-23-03: unrecognized type_filter values query all types (permissive fallback).
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("audio.list"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

		// Extract optional payload.
		TSharedPtr<FJsonObject> Payload;
		const TSharedPtr<FJsonValue>* PayloadVal = Cmd->Values.Find(TEXT("payload"));
		if (PayloadVal && (*PayloadVal)->Type == EJson::Object)
		{
			Payload = (*PayloadVal)->AsObject();
		}

		FString TypeFilter;
		if (Payload.IsValid())
		{
			Payload->TryGetStringField(TEXT("type_filter"), TypeFilter);
		}

		// T-23-03: Validate type_filter against known values. Unrecognized values fall back to all.
		const bool bFilterSoundWave = TypeFilter.IsEmpty() || TypeFilter == TEXT("SoundWave");
		const bool bFilterSoundCue  = TypeFilter.IsEmpty() || TypeFilter == TEXT("SoundCue");
		const bool bFilterMetaSound = TypeFilter.IsEmpty() || TypeFilter == TEXT("MetaSound");

		// Access the asset registry.
		FAssetRegistryModule& RegistryModule = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry"));
		IAssetRegistry& Registry = RegistryModule.Get();

		TArray<TSharedPtr<FJsonValue>> AssetsArray;

		// Query SoundWave assets.
		if (bFilterSoundWave)
		{
			TArray<FAssetData> AssetList;
			FTopLevelAssetPath ClassPath(TEXT("/Script/Engine"), TEXT("SoundWave"));
			Registry.GetAssetsByClass(ClassPath, AssetList, /*bSearchSubClasses=*/true);

			for (const FAssetData& Asset : AssetList)
			{
				TSharedPtr<FJsonObject> AssetObj = MakeShared<FJsonObject>();
				AssetObj->SetStringField(TEXT("asset_path"), Asset.GetObjectPathString());
				AssetObj->SetStringField(TEXT("asset_name"), Asset.AssetName.ToString());
				AssetObj->SetStringField(TEXT("asset_type"), TEXT("SoundWave"));

				// Attempt to load to get audio metadata.
				USoundWave* SoundWave = Cast<USoundWave>(
					StaticLoadObject(USoundWave::StaticClass(), nullptr, *Asset.GetObjectPathString()));
				if (SoundWave)
				{
					AssetObj->SetNumberField(TEXT("duration"),     static_cast<double>(SoundWave->GetDuration()));
					AssetObj->SetNumberField(TEXT("sample_rate"),  static_cast<double>(SoundWave->GetSampleRateForCurrentPlatform()));
					AssetObj->SetNumberField(TEXT("num_channels"), static_cast<double>(SoundWave->NumChannels));
					// Compression name from the compression format enum via Audio::ToName().
					const FName CompressionFName = Audio::ToName(SoundWave->GetSoundCompressionType());
					AssetObj->SetStringField(TEXT("compression_name"), CompressionFName.IsNone() ? TEXT("Unknown") : CompressionFName.ToString());
				}
				else
				{
					AssetObj->SetNumberField(TEXT("duration"),     0.0);
					AssetObj->SetNumberField(TEXT("sample_rate"),  0.0);
					AssetObj->SetNumberField(TEXT("num_channels"), 0.0);
					AssetObj->SetStringField(TEXT("compression_name"), TEXT("Unknown"));
				}

				AssetsArray.Add(MakeShared<FJsonValueObject>(AssetObj));
			}
		}

		// Query SoundCue assets.
		if (bFilterSoundCue)
		{
			TArray<FAssetData> AssetList;
			FTopLevelAssetPath ClassPath(TEXT("/Script/Engine"), TEXT("SoundCue"));
			Registry.GetAssetsByClass(ClassPath, AssetList, /*bSearchSubClasses=*/true);

			for (const FAssetData& Asset : AssetList)
			{
				TSharedPtr<FJsonObject> AssetObj = MakeShared<FJsonObject>();
				AssetObj->SetStringField(TEXT("asset_path"), Asset.GetObjectPathString());
				AssetObj->SetStringField(TEXT("asset_name"), Asset.AssetName.ToString());
				AssetObj->SetStringField(TEXT("asset_type"), TEXT("SoundCue"));
				AssetsArray.Add(MakeShared<FJsonValueObject>(AssetObj));
			}
		}

		// Query MetaSound assets.
		if (bFilterMetaSound)
		{
			TArray<FAssetData> AssetList;
			FTopLevelAssetPath ClassPath(TEXT("/Script/MetasoundEngine"), TEXT("MetaSoundSource"));
			Registry.GetAssetsByClass(ClassPath, AssetList, /*bSearchSubClasses=*/true);

			for (const FAssetData& Asset : AssetList)
			{
				TSharedPtr<FJsonObject> AssetObj = MakeShared<FJsonObject>();
				AssetObj->SetStringField(TEXT("asset_path"), Asset.GetObjectPathString());
				AssetObj->SetStringField(TEXT("asset_name"), Asset.AssetName.ToString());
				AssetObj->SetStringField(TEXT("asset_type"), TEXT("MetaSound"));
				AssetsArray.Add(MakeShared<FJsonValueObject>(AssetObj));
			}
		}

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetArrayField(TEXT("assets"), AssetsArray);
		Data->SetNumberField(TEXT("count"), static_cast<double>(AssetsArray.Num()));
		if (!TypeFilter.IsEmpty())
		{
			Data->SetStringField(TEXT("type_filter"), TypeFilter);
		}

		SendResponse(BuildAudioSuccessResponse(CorrId, Data) + TEXT("\n"));
	});

	// -----------------------------------------------------------------------
	// audio.metasound (AUD-02)
	// Inspects a MetaSound patch graph: nodes, edges, inputs, outputs.
	// Required payload field: asset_path (must start with /Game/ or /Engine/).
	// Returns: asset_path, nodes[], edges[], inputs[], outputs[].
	// Threat T-23-01: asset_path validated before StaticLoadObject.
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("audio.metasound"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
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
			SendResponse(BuildAudioErrorResponse(CorrId, TEXT("missing_asset_path")) + TEXT("\n"));
			return;
		}

		// Validate path prefix (T-23-01).
		if (!IsValidAssetPath(AssetPath))
		{
			SendResponse(BuildAudioErrorResponse(CorrId, TEXT("invalid_asset_path")) + TEXT("\n"));
			return;
		}

		// Load the MetaSoundSource asset.
		UMetaSoundSource* MetaSound = Cast<UMetaSoundSource>(
			StaticLoadObject(UMetaSoundSource::StaticClass(), nullptr, *AssetPath));
		if (!MetaSound)
		{
			SendResponse(BuildAudioErrorResponse(CorrId, TEXT("metasound_not_found")) + TEXT("\n"));
			return;
		}

		// Access the MetaSound document via IMetaSoundDocumentInterface.
		// UMetaSoundSource directly inherits IMetaSoundDocumentInterface, providing GetConstDocument().
		const IMetaSoundDocumentInterface* DocInterface = Cast<IMetaSoundDocumentInterface>(MetaSound);
		if (!DocInterface)
		{
			SendResponse(BuildAudioErrorResponse(CorrId, TEXT("metasound_document_interface_unavailable")) + TEXT("\n"));
			return;
		}

		const FMetasoundFrontendDocument& Document = DocInterface->GetConstDocument();
		const FMetasoundFrontendGraphClass& RootGraph = Document.RootGraph;

		// Build nodes and edges arrays by iterating paged graphs (UE 5.7 API).
		// RootGraph.Graph is deprecated since 5.5; use GetConstGraphPages() instead.
		TArray<TSharedPtr<FJsonValue>> NodesArray;
		TArray<TSharedPtr<FJsonValue>> EdgesArray;

		for (const FMetasoundFrontendGraph& GraphPage : RootGraph.GetConstGraphPages())
		{
			for (const FMetasoundFrontendNode& Node : GraphPage.Nodes)
			{
				TSharedPtr<FJsonObject> NodeObj = MakeShared<FJsonObject>();
				NodeObj->SetStringField(TEXT("node_id"),          Node.GetID().ToString());
				NodeObj->SetStringField(TEXT("node_class_name"),  Node.ClassID.ToString());
				NodeObj->SetStringField(TEXT("node_name"),        Node.Name.ToString());
				NodesArray.Add(MakeShared<FJsonValueObject>(NodeObj));
			}

			for (const FMetasoundFrontendEdge& Edge : GraphPage.Edges)
			{
				TSharedPtr<FJsonObject> EdgeObj = MakeShared<FJsonObject>();
				EdgeObj->SetStringField(TEXT("from_node"),   Edge.FromNodeID.ToString());
				EdgeObj->SetStringField(TEXT("from_output"), Edge.FromVertexID.ToString());
				EdgeObj->SetStringField(TEXT("to_node"),     Edge.ToNodeID.ToString());
				EdgeObj->SetStringField(TEXT("to_input"),    Edge.ToVertexID.ToString());
				EdgesArray.Add(MakeShared<FJsonValueObject>(EdgeObj));
			}
		}

		// Build inputs array using GetDefaultInterface() (replaces deprecated Interface property in UE 5.6+).
		TArray<TSharedPtr<FJsonValue>> InputsArray;
		for (const FMetasoundFrontendClassInput& Input : RootGraph.GetDefaultInterface().Inputs)
		{
			TSharedPtr<FJsonObject> InObj = MakeShared<FJsonObject>();
			InObj->SetStringField(TEXT("name"),      Input.Name.ToString());
			InObj->SetStringField(TEXT("type_name"), Input.TypeName.ToString());
			InputsArray.Add(MakeShared<FJsonValueObject>(InObj));
		}

		// Build outputs array.
		TArray<TSharedPtr<FJsonValue>> OutputsArray;
		for (const FMetasoundFrontendClassOutput& Output : RootGraph.GetDefaultInterface().Outputs)
		{
			TSharedPtr<FJsonObject> OutObj = MakeShared<FJsonObject>();
			OutObj->SetStringField(TEXT("name"),      Output.Name.ToString());
			OutObj->SetStringField(TEXT("type_name"), Output.TypeName.ToString());
			OutputsArray.Add(MakeShared<FJsonValueObject>(OutObj));
		}

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetStringField(TEXT("asset_path"), AssetPath);
		Data->SetArrayField(TEXT("nodes"),       NodesArray);
		Data->SetArrayField(TEXT("edges"),       EdgesArray);
		Data->SetArrayField(TEXT("inputs"),      InputsArray);
		Data->SetArrayField(TEXT("outputs"),     OutputsArray);

		SendResponse(BuildAudioSuccessResponse(CorrId, Data) + TEXT("\n"));
	});

	// -----------------------------------------------------------------------
	// audio.soundcue (AUD-03)
	// Reads a SoundCue node graph starting from FirstNode and recursively builds
	// a tree of node objects. Includes type-specific fields for WavePlayer,
	// Modulator, and Attenuation nodes. Also returns cue-level attenuation if set.
	//
	// Required payload field: asset_path (must start with /Game/ or /Engine/).
	// Returns: asset_path, first_node (recursive tree), cue_attenuation (optional).
	//
	// Threat T-23-01: asset_path validated before StaticLoadObject.
	// Threat T-23-02: node tree recursion capped at 50 levels.
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("audio.soundcue"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
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
			SendResponse(BuildAudioErrorResponse(CorrId, TEXT("missing_asset_path")) + TEXT("\n"));
			return;
		}

		// Validate path prefix (T-23-01).
		if (!IsValidAssetPath(AssetPath))
		{
			SendResponse(BuildAudioErrorResponse(CorrId, TEXT("invalid_asset_path")) + TEXT("\n"));
			return;
		}

		// Load the SoundCue asset.
		USoundCue* SoundCue = Cast<USoundCue>(
			StaticLoadObject(USoundCue::StaticClass(), nullptr, *AssetPath));
		if (!SoundCue)
		{
			SendResponse(BuildAudioErrorResponse(CorrId, TEXT("sound_cue_not_found")) + TEXT("\n"));
			return;
		}

		// Build the node tree starting from FirstNode (T-23-02: cap at 50 levels).
		constexpr int32 MaxDepth = 50;
		bool bDepthExceeded = false;
		TSharedPtr<FJsonObject> FirstNodeObj = BuildSoundNodeTree(SoundCue->FirstNode, 0, MaxDepth, bDepthExceeded);

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetStringField(TEXT("asset_path"), AssetPath);

		if (FirstNodeObj.IsValid())
		{
			Data->SetObjectField(TEXT("first_node"), FirstNodeObj);
		}

		if (bDepthExceeded)
		{
			Data->SetBoolField(TEXT("depth_truncated"), true);
			Data->SetStringField(TEXT("depth_truncated_message"),
				TEXT("Node tree truncated at 50 levels to prevent runaway on malformed assets (T-23-02)."));
		}

		// Check for cue-level attenuation settings via GetAttenuationSettingsToApply()
		// (returns nullptr if no attenuation override is set).
		const FSoundAttenuationSettings* CueAttenuation = SoundCue->GetAttenuationSettingsToApply();
		if (CueAttenuation)
		{
			TSharedPtr<FJsonObject> CueAttObj = BuildAttenuationObject(*CueAttenuation);
			Data->SetObjectField(TEXT("cue_attenuation"), CueAttObj);
		}

		SendResponse(BuildAudioSuccessResponse(CorrId, Data) + TEXT("\n"));
	});

	// -----------------------------------------------------------------------
	// audio.insights (AUD-04)
	// Queries Audio Insights monitoring data. Gracefully handles the case where
	// the AudioInsights plugin is not enabled.
	//
	// Payload: none required.
	// Returns: available (bool), message (if unavailable), active_sound_count (int),
	//          max_channels (int), recent_events[] (empty array -- detailed event history
	//          requires direct Audio Insights dashboard access).
	//
	// Threat T-23-04: editor-only monitoring data; accepted risk (not sensitive).
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("audio.insights"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

		// Check if AudioInsights module is loaded at runtime (no hard Build.cs dependency).
		const bool bAudioInsightsLoaded = FModuleManager::Get().IsModuleLoaded(TEXT("AudioInsights"));

		if (!bAudioInsightsLoaded)
		{
			TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
			Data->SetBoolField(TEXT("available"), false);
			Data->SetStringField(TEXT("message"),
				TEXT("AudioInsights plugin is not enabled. Enable it in Plugins > Audio > Audio Insights to use this command."));

			SendResponse(BuildAudioSuccessResponse(CorrId, Data) + TEXT("\n"));
			return;
		}

		// AudioInsights is available. Get the editor world audio device.
		if (!GEditor)
		{
			TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
			Data->SetBoolField(TEXT("available"), true);
			Data->SetStringField(TEXT("message"), TEXT("GEditor not available."));
			Data->SetNumberField(TEXT("active_sound_count"), 0.0);
			Data->SetNumberField(TEXT("max_channels"),       0.0);
			Data->SetArrayField(TEXT("recent_events"),       TArray<TSharedPtr<FJsonValue>>());

			SendResponse(BuildAudioSuccessResponse(CorrId, Data) + TEXT("\n"));
			return;
		}

		UWorld* World = GEditor->GetEditorWorldContext().World();
		if (!World)
		{
			TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
			Data->SetBoolField(TEXT("available"), true);
			Data->SetStringField(TEXT("message"), TEXT("No world open in editor."));
			Data->SetNumberField(TEXT("active_sound_count"), 0.0);
			Data->SetNumberField(TEXT("max_channels"),       0.0);
			Data->SetArrayField(TEXT("recent_events"),       TArray<TSharedPtr<FJsonValue>>());

			SendResponse(BuildAudioSuccessResponse(CorrId, Data) + TEXT("\n"));
			return;
		}

		FAudioDeviceHandle AudioDeviceHandle = World->GetAudioDevice();
		FAudioDevice* AudioDevice = AudioDeviceHandle.GetAudioDevice();

		int32 ActiveSoundCount = 0;
		int32 MaxChannels      = 0;

		if (AudioDevice)
		{
			ActiveSoundCount = AudioDevice->GetNumActiveSources();
			MaxChannels      = AudioDevice->GetMaxChannels();
		}

		// recent_events: detailed event history requires direct Audio Insights dashboard access.
		// Return empty array with informational note.
		TArray<TSharedPtr<FJsonValue>> RecentEvents;

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetBoolField(TEXT("available"),          true);
		Data->SetNumberField(TEXT("active_sound_count"), static_cast<double>(ActiveSoundCount));
		Data->SetNumberField(TEXT("max_channels"),       static_cast<double>(MaxChannels));
		Data->SetArrayField(TEXT("recent_events"),       RecentEvents);
		Data->SetStringField(TEXT("recent_events_note"),
			TEXT("Detailed event history requires direct Audio Insights dashboard access in the editor."));

		SendResponse(BuildAudioSuccessResponse(CorrId, Data) + TEXT("\n"));
	});
}
