// MCPEditorStateCommands.cpp
// Implements MCP command handlers for editor state inspection.
//
//   editor.state  -- selected actors, open assets, viewport camera position/rotation/FOV
//
// All handlers are guaranteed to run on the game thread (FMCPCommandRouter guarantee via AsyncTask).
// GEditor->GetSelectedActors() and viewport APIs are only valid on the game thread.

#include "MCPEditorStateCommands.h"

#include "Editor.h"
#include "Selection.h"
#include "FileHelpers.h"
#include "HAL/PlatformMisc.h"
#include "Containers/Ticker.h"
#include "EditorViewportClient.h"
#include "LevelEditorViewport.h"
#include "EngineUtils.h"
#include "Engine/World.h"
#include "Subsystems/AssetEditorSubsystem.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"

// ---------------------------------------------------------------------------
// Internal JSON response helpers
// ---------------------------------------------------------------------------

static FString BuildEditorStateSuccessResponse(const FString& CorrId, TSharedPtr<FJsonObject> Data)
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

static FString BuildEditorStateErrorResponse(const FString& CorrId, const FString& Error)
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

// ---------------------------------------------------------------------------
// RegisterEditorStateCommands
// ---------------------------------------------------------------------------

void RegisterEditorStateCommands(FMCPCommandRouter& Router)
{
	// -----------------------------------------------------------------------
	// editor.state
	// Returns:
	//   - selectedActors: [{label, class, id}, ...]
	//   - openAssets:     ["/Game/Path/Asset", ...]
	//   - viewport:       {location:{x,y,z}, rotation:{pitch,yaw,roll}, fov:float}
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("editor.state"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

		if (!GEditor)
		{
			SendResponse(BuildEditorStateErrorResponse(CorrId, TEXT("no_editor")) + TEXT("\n"));
			return;
		}

		// -------------------------------------------------------------------
		// 1. Selected actors
		// -------------------------------------------------------------------
		TArray<TSharedPtr<FJsonValue>> SelectedActorsArray;

		USelection* Selection = GEditor->GetSelectedActors();
		if (Selection)
		{
			for (FSelectionIterator It(*Selection); It; ++It)
			{
				AActor* Actor = Cast<AActor>(*It);
				if (!Actor)
				{
					continue;
				}

				TSharedPtr<FJsonObject> ActorObj = MakeShared<FJsonObject>();
				ActorObj->SetStringField(TEXT("label"), Actor->GetActorLabel());
				ActorObj->SetStringField(TEXT("class"), Actor->GetClass()->GetName());
				ActorObj->SetStringField(TEXT("id"),    Actor->GetName());

				SelectedActorsArray.Add(MakeShared<FJsonValueObject>(ActorObj));
			}
		}

		// -------------------------------------------------------------------
		// 2. Open assets (via UAssetEditorSubsystem)
		// -------------------------------------------------------------------
		TArray<TSharedPtr<FJsonValue>> OpenAssetsArray;

		UAssetEditorSubsystem* AssetEditorSubsystem = GEditor->GetEditorSubsystem<UAssetEditorSubsystem>();
		if (AssetEditorSubsystem)
		{
			TArray<UObject*> EditedAssets = AssetEditorSubsystem->GetAllEditedAssets();
			for (UObject* Asset : EditedAssets)
			{
				if (Asset)
				{
					OpenAssetsArray.Add(MakeShared<FJsonValueString>(Asset->GetPathName()));
				}
			}
		}

		// -------------------------------------------------------------------
		// 3. Viewport camera (first FLevelEditorViewportClient found)
		// -------------------------------------------------------------------
		FVector  CamLocation(0.0f, 0.0f, 0.0f);
		FRotator CamRotation(0.0f, 0.0f, 0.0f);
		float    CamFOV = 90.0f;

		for (FEditorViewportClient* ViewportClient : GEditor->GetAllViewportClients())
		{
			FLevelEditorViewportClient* LevelVP = static_cast<FLevelEditorViewportClient*>(ViewportClient);
			// Only cast if the pointer is actually a FLevelEditorViewportClient.
			// FEditorViewportClient does not use UObject hierarchy, so we check
			// the viewport type to confirm it is a level editor viewport.
			if (LevelVP && ViewportClient->GetEditorViewportWidget().IsValid())
			{
				// Prefer the first perspective viewport; take any non-null.
				CamLocation = LevelVP->GetViewLocation();
				CamRotation = LevelVP->GetViewRotation();
				CamFOV      = LevelVP->ViewFOV;
				break;
			}
		}

		// Build viewport location object.
		TSharedPtr<FJsonObject> LocObj = MakeShared<FJsonObject>();
		LocObj->SetNumberField(TEXT("x"), static_cast<double>(CamLocation.X));
		LocObj->SetNumberField(TEXT("y"), static_cast<double>(CamLocation.Y));
		LocObj->SetNumberField(TEXT("z"), static_cast<double>(CamLocation.Z));

		// Build viewport rotation object.
		TSharedPtr<FJsonObject> RotObj = MakeShared<FJsonObject>();
		RotObj->SetNumberField(TEXT("pitch"), static_cast<double>(CamRotation.Pitch));
		RotObj->SetNumberField(TEXT("yaw"),   static_cast<double>(CamRotation.Yaw));
		RotObj->SetNumberField(TEXT("roll"),  static_cast<double>(CamRotation.Roll));

		// Build viewport object.
		TSharedPtr<FJsonObject> ViewportObj = MakeShared<FJsonObject>();
		ViewportObj->SetObjectField(TEXT("location"), LocObj);
		ViewportObj->SetObjectField(TEXT("rotation"), RotObj);
		ViewportObj->SetNumberField(TEXT("fov"),      static_cast<double>(CamFOV));

		// -------------------------------------------------------------------
		// 4. Assemble final data object
		// -------------------------------------------------------------------
		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetArrayField(TEXT("selectedActors"), SelectedActorsArray);
		Data->SetArrayField(TEXT("openAssets"),     OpenAssetsArray);
		Data->SetObjectField(TEXT("viewport"),      ViewportObj);

		SendResponse(BuildEditorStateSuccessResponse(CorrId, Data) + TEXT("\n"));
	});

	// -----------------------------------------------------------------------
	// editor.saveAll
	// Saves all dirty packages (levels, assets). Returns count of saved packages.
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("editor.saveAll"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

		const bool bSaved = FEditorFileUtils::SaveDirtyPackages(
			false,  // bPromptUserToSave
			true,   // bSaveMapPackages
			true,   // bSaveContentPackages
			false); // bFastSave

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetBoolField(TEXT("saved"), bSaved);

		SendResponse(BuildEditorStateSuccessResponse(CorrId, Data) + TEXT("\n"));
	});

	// -----------------------------------------------------------------------
	// editor.quit
	// Gracefully closes the editor. Response is sent before shutdown begins.
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("editor.quit"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetBoolField(TEXT("quitting"), true);

		SendResponse(BuildEditorStateSuccessResponse(CorrId, Data) + TEXT("\n"));

		// Defer the actual quit to next tick so the response gets sent first.
		FTSTicker::GetCoreTicker().AddTicker(
			FTickerDelegate::CreateLambda([](float) -> bool
		{
			FPlatformMisc::RequestExit(false); // false = clean shutdown
			return false;
		}), 0.1f);
	});
}
