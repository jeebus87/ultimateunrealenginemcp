// MCPViewportCommands.cpp
// Implements eight viewport command handlers for the MCP bridge:
//   viewport.screenshot      -- capture the active viewport at a caller-specified resolution (PIE-05)
//   viewport.camera          -- set the active viewport camera position, rotation, and/or FOV (PIE-06)
//   viewport.renderMode      -- switch the active viewport render mode (PIE-07)
//   viewport.hiresScreenshot -- trigger a high-resolution screenshot capture (PIE-08)
//   viewport.lookAt          -- resolve actor label and move editor camera to view it (VIS-03)
//   viewport.frustumActors   -- list actors near the current camera position (VIS-05)
//   viewport.focusActor      -- auto-frame actor from bounding box (VIS-07)
//   viewport.cleanupScreenshots -- delete MCP-generated screenshots (VIS-08)
//
// All handlers run on the game thread (guaranteed by FMCPCommandRouter::Dispatch).
// Threat mitigations applied:
//   T-12-05: hires resolution_multiplier clamped 1..8; final pixel dims clamped to 15360 per axis.
//   T-12-06: screenshot width clamped 64..7680; height clamped 64..4320.
//   T-12-07: render mode uses explicit string allowlist; never passes raw string to SetViewMode.
//   T-12-08: look_at uses GetSafeNormal(); degenerate zero-vector result skips SetViewRotation.
//   T-31-02: frustumActors max_actors clamped 1..200; radius clamped 1..100000.
//   T-31-03: cleanupScreenshots only deletes mcp_screenshot_*.png in MCPScreenshots/; keep_last clamped 0..1000.
//   T-31-05: lookAt/focusActor screenshot width clamped 64..7680; height clamped 64..4320.

#include "MCPViewportCommands.h"

#include "Editor.h"
#include "EditorViewportClient.h"
#include "LevelEditorViewport.h"
#include "UnrealClient.h"
#include "HighResScreenshot.h"
#include "Misc/Paths.h"
#include "Misc/DateTime.h"
#include "HAL/FileManager.h"
#include "Misc/FileHelper.h"
#include "Engine/World.h"
#include "GameFramework/Actor.h"
#include "EngineUtils.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Returns a JSON success response string (without trailing newline). */
static FString BuildViewportSuccessResponse(const FString& CorrId, TSharedPtr<FJsonObject> Data)
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
static FString BuildViewportErrorResponse(const FString& CorrId, const FString& Error)
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
 * Returns the first visible level editor viewport client, or nullptr if none is open.
 * A static_cast is safe here because MCPBridgeEditor only runs inside the editor and
 * GetAllViewportClients() in the level editor context returns FLevelEditorViewportClient
 * instances.
 */
static FLevelEditorViewportClient* GetActiveViewportClient()
{
	if (!GEditor)
	{
		return nullptr;
	}

	for (FEditorViewportClient* VC : GEditor->GetAllViewportClients())
	{
		if (!VC)
		{
			continue;
		}
		FLevelEditorViewportClient* LVC = static_cast<FLevelEditorViewportClient*>(VC);
		if (LVC && LVC->IsVisible())
		{
			return LVC;
		}
	}
	return nullptr;
}

/**
 * Find an actor by label using case-insensitive substring matching.
 *
 * Resolution order:
 *   1. Exact case-insensitive match -- returns immediately.
 *   2. Substring match (case-insensitive) -- returns first match.
 *   3. No match -- returns nullptr.
 *
 * SimilarLabels (optional, up to 10) is populated with substring matches
 * for use in error messages.
 *
 * Threat T-31-01: label is compared against GetActorLabel() (editor-internal string).
 * No path traversal or injection is possible.
 */
static AActor* FindActorByLabelSubstring(
	UWorld* World,
	const FString& Label,
	TArray<FString>* SimilarLabels = nullptr)
{
	if (!World)
	{
		return nullptr;
	}

	const FString LabelLower = Label.ToLower();
	AActor* SubstringMatch = nullptr;

	for (TActorIterator<AActor> It(World); It; ++It)
	{
		AActor* Actor = *It;
		if (!Actor)
		{
			continue;
		}

		const FString ActorLabel = Actor->GetActorLabel();
		const FString ActorLabelLower = ActorLabel.ToLower();

		// Exact case-insensitive match takes priority.
		if (ActorLabelLower == LabelLower)
		{
			return Actor;
		}

		// Collect substring matches for error messages / fallback.
		if (ActorLabelLower.Contains(LabelLower))
		{
			if (!SubstringMatch)
			{
				SubstringMatch = Actor;
			}
			if (SimilarLabels && SimilarLabels->Num() < 10)
			{
				SimilarLabels->Add(ActorLabel);
			}
		}
	}

	return SubstringMatch;
}

/**
 * Returns the MCPScreenshots directory path (Saved/MCPScreenshots/).
 * Creates the directory if it does not already exist.
 */
static FString GetMCPScreenshotDir()
{
	const FString Dir = FPaths::Combine(FPaths::ProjectSavedDir(), TEXT("MCPScreenshots"));
	IFileManager::Get().MakeDirectory(*Dir, true /* bTree */);
	return Dir;
}

/**
 * Queues an MCP screenshot with the given dimensions and returns the target file path.
 *
 * Uses the naming convention mcp_screenshot_{timestamp}.png in the MCPScreenshots directory.
 * Screenshot capture is asynchronous -- the file may not exist immediately after this call.
 *
 * Threat T-31-05: width clamped 64..7680, height clamped 64..4320 (same as T-12-06).
 */
static FString TakeScreenshotToFile(int32 Width, int32 Height)
{
	// Clamp to safe ranges (T-31-05).
	Width  = FMath::Clamp(Width,  64, 7680);
	Height = FMath::Clamp(Height, 64, 4320);

	const FString Timestamp = FDateTime::Now().ToString(TEXT("%Y%m%d_%H%M%S_%s"));
	const FString FileName  = FString::Printf(TEXT("mcp_screenshot_%s.png"), *Timestamp);
	const FString FilePath  = FPaths::Combine(GetMCPScreenshotDir(), FileName);

	GScreenshotResolutionX = Width;
	GScreenshotResolutionY = Height;
	FScreenshotRequest::RequestScreenshot(FilePath, false /* bShowUI */, false /* bAddFilenameSuffix */);

	return FilePath;
}

/**
 * Resolve an angle preset string or custom {yaw, pitch} object into a FRotator.
 *
 * Presets:
 *   "front"  -- yaw=0,   pitch=0
 *   "back"   -- yaw=180, pitch=0
 *   "left"   -- yaw=-90, pitch=0
 *   "right"  -- yaw=90,  pitch=0
 *   "top"    -- yaw=0,   pitch=-89
 *   "45deg"  -- yaw=45,  pitch=-45
 *
 * If AngleValue is a string, the preset mapping is applied.
 * If AngleValue is an object with yaw/pitch fields, those values are used directly.
 * Defaults to "front" if AngleValue is null or unrecognised.
 */
static FRotator ResolveAngle(const TSharedPtr<FJsonValue>& AngleValue)
{
	float Yaw   = 0.0f;
	float Pitch = 0.0f;

	if (AngleValue.IsValid())
	{
		if (AngleValue->Type == EJson::String)
		{
			const FString Preset = AngleValue->AsString();
			if (Preset == TEXT("back"))       { Yaw = 180.0f; Pitch =   0.0f; }
			else if (Preset == TEXT("left"))  { Yaw = -90.0f; Pitch =   0.0f; }
			else if (Preset == TEXT("right")) { Yaw =  90.0f; Pitch =   0.0f; }
			else if (Preset == TEXT("top"))   { Yaw =   0.0f; Pitch = -89.0f; }
			else if (Preset == TEXT("45deg")) { Yaw =  45.0f; Pitch = -45.0f; }
			// else "front" or unknown -> defaults (yaw=0, pitch=0)
		}
		else if (AngleValue->Type == EJson::Object)
		{
			const TSharedPtr<FJsonObject> AngleObj = AngleValue->AsObject();
			double DYaw = 0.0, DPitch = 0.0;
			AngleObj->TryGetNumberField(TEXT("yaw"),   DYaw);
			AngleObj->TryGetNumberField(TEXT("pitch"), DPitch);
			Yaw   = static_cast<float>(DYaw);
			Pitch = static_cast<float>(DPitch);
		}
	}

	return FRotator(Pitch, Yaw, 0.0f);
}

// ---------------------------------------------------------------------------
// RegisterViewportCommands
// ---------------------------------------------------------------------------

void RegisterViewportCommands(FMCPCommandRouter& Router)
{
	// -----------------------------------------------------------------------
	// viewport.screenshot (PIE-05)
	// Captures the active viewport at a caller-specified resolution. The UE
	// screenshot system works asynchronously -- the file is queued and written
	// on the next render frame.  The handler returns the screenshots directory
	// (FPaths::ScreenShotDir()) and the requested dimensions.
	//
	// Threat T-12-06: width clamped 64..7680, height clamped 64..4320.
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("viewport.screenshot"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

		// Extract optional payload.
		TSharedPtr<FJsonObject> Payload;
		const TSharedPtr<FJsonValue>* PayloadVal = Cmd->Values.Find(TEXT("payload"));
		if (PayloadVal && (*PayloadVal)->Type == EJson::Object)
		{
			Payload = (*PayloadVal)->AsObject();
		}

		// Read width and height with defaults (T-12-06: clamp to safe ranges).
		int32 Width  = 1920;
		int32 Height = 1080;

		if (Payload.IsValid())
		{
			double RawWidth = 0.0;
			if (Payload->TryGetNumberField(TEXT("width"), RawWidth))
			{
				Width = FMath::Clamp(static_cast<int32>(RawWidth), 64, 7680);
			}
			double RawHeight = 0.0;
			if (Payload->TryGetNumberField(TEXT("height"), RawHeight))
			{
				Height = FMath::Clamp(static_cast<int32>(RawHeight), 64, 4320);
			}
		}

		// Set global screenshot resolution and queue capture.
		GScreenshotResolutionX = Width;
		GScreenshotResolutionY = Height;
		FScreenshotRequest::RequestScreenshot(false /* bShowUI */);

		// Return the directory where UE will write the screenshot file.
		const FString ShotDir = FPaths::ScreenShotDir();

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetStringField(TEXT("screenshot_dir"), ShotDir);
		Data->SetNumberField(TEXT("width"),  static_cast<double>(Width));
		Data->SetNumberField(TEXT("height"), static_cast<double>(Height));
		Data->SetBoolField(TEXT("queued"), true);

		SendResponse(BuildViewportSuccessResponse(CorrId, Data) + TEXT("\n"));
	});

	// -----------------------------------------------------------------------
	// viewport.camera (PIE-06)
	// Sets the active level viewport camera's location, rotation, and/or FOV.
	// Supports optional "look_at" to compute rotation from a world-space target.
	//
	// Payload fields (all optional):
	//   location  {x, y, z}        -- world-space camera position
	//   rotation  {pitch, yaw, roll} -- camera rotation (overridden by look_at)
	//   fov       float             -- field of view in degrees (clamped 5..170)
	//   look_at   {x, y, z}        -- world-space target point; requires location
	//
	// Threat T-12-08: look_at uses GetSafeNormal() -- degenerate zero result skips SetViewRotation.
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("viewport.camera"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

		// Extract optional payload.
		TSharedPtr<FJsonObject> Payload;
		const TSharedPtr<FJsonValue>* PayloadVal = Cmd->Values.Find(TEXT("payload"));
		if (PayloadVal && (*PayloadVal)->Type == EJson::Object)
		{
			Payload = (*PayloadVal)->AsObject();
		}

		FLevelEditorViewportClient* ViewportClient = GetActiveViewportClient();
		if (!ViewportClient)
		{
			SendResponse(BuildViewportErrorResponse(CorrId, TEXT("no_active_viewport")) + TEXT("\n"));
			return;
		}

		TSharedPtr<FJsonObject> Applied = MakeShared<FJsonObject>();

		bool bHasLocation = false;
		FVector NewLocation(ForceInitToZero);

		// Apply location if provided.
		if (Payload.IsValid())
		{
			const TSharedPtr<FJsonObject>* LocObj;
			if (Payload->TryGetObjectField(TEXT("location"), LocObj))
			{
				double X = 0.0, Y = 0.0, Z = 0.0;
				(*LocObj)->TryGetNumberField(TEXT("x"), X);
				(*LocObj)->TryGetNumberField(TEXT("y"), Y);
				(*LocObj)->TryGetNumberField(TEXT("z"), Z);
				NewLocation = FVector(X, Y, Z);
				bHasLocation = true;

				ViewportClient->SetViewLocation(NewLocation);

				TSharedPtr<FJsonObject> AppliedLoc = MakeShared<FJsonObject>();
				AppliedLoc->SetNumberField(TEXT("x"), X);
				AppliedLoc->SetNumberField(TEXT("y"), Y);
				AppliedLoc->SetNumberField(TEXT("z"), Z);
				Applied->SetObjectField(TEXT("location"), AppliedLoc);
			}

			// Apply explicit rotation if provided (may be overridden by look_at below).
			{
				const TSharedPtr<FJsonObject>* RotObj;
				if (Payload->TryGetObjectField(TEXT("rotation"), RotObj))
				{
					double Pitch = 0.0, Yaw = 0.0, Roll = 0.0;
					(*RotObj)->TryGetNumberField(TEXT("pitch"), Pitch);
					(*RotObj)->TryGetNumberField(TEXT("yaw"),   Yaw);
					(*RotObj)->TryGetNumberField(TEXT("roll"),  Roll);
					const FRotator NewRot(Pitch, Yaw, Roll);
					ViewportClient->SetViewRotation(NewRot);

					TSharedPtr<FJsonObject> AppliedRot = MakeShared<FJsonObject>();
					AppliedRot->SetNumberField(TEXT("pitch"), Pitch);
					AppliedRot->SetNumberField(TEXT("yaw"),   Yaw);
					AppliedRot->SetNumberField(TEXT("roll"),  Roll);
					Applied->SetObjectField(TEXT("rotation"), AppliedRot);
				}
			}

			// Apply FOV if provided (clamped to safe range).
			{
				double RawFov = 0.0;
				if (Payload->TryGetNumberField(TEXT("fov"), RawFov))
				{
					const float ClampedFov = FMath::Clamp(static_cast<float>(RawFov), 5.0f, 170.0f);
					ViewportClient->ViewFOV = ClampedFov;
					Applied->SetNumberField(TEXT("fov"), static_cast<double>(ClampedFov));
				}
			}

			// Apply look_at override (requires location to have been provided).
			// T-12-08: Use GetSafeNormal() -- if result is near-zero (degenerate look_at
			// that is the same as the camera position), skip SetViewRotation.
			if (bHasLocation)
			{
				const TSharedPtr<FJsonObject>* LookAtObj;
				if (Payload->TryGetObjectField(TEXT("look_at"), LookAtObj))
				{
					double LX = 0.0, LY = 0.0, LZ = 0.0;
					(*LookAtObj)->TryGetNumberField(TEXT("x"), LX);
					(*LookAtObj)->TryGetNumberField(TEXT("y"), LY);
					(*LookAtObj)->TryGetNumberField(TEXT("z"), LZ);

					const FVector LookAtTarget(LX, LY, LZ);
					const FVector Direction = (LookAtTarget - NewLocation).GetSafeNormal();

					// Only apply rotation if direction is non-degenerate (T-12-08).
					if (!Direction.IsNearlyZero())
					{
						const FRotator LookAtRot = Direction.Rotation();
						ViewportClient->SetViewRotation(LookAtRot);

						TSharedPtr<FJsonObject> AppliedLookRot = MakeShared<FJsonObject>();
						AppliedLookRot->SetNumberField(TEXT("pitch"), static_cast<double>(LookAtRot.Pitch));
						AppliedLookRot->SetNumberField(TEXT("yaw"),   static_cast<double>(LookAtRot.Yaw));
						AppliedLookRot->SetNumberField(TEXT("roll"),  static_cast<double>(LookAtRot.Roll));
						// Override any explicitly applied rotation in the response.
						Applied->SetObjectField(TEXT("rotation"), AppliedLookRot);

						TSharedPtr<FJsonObject> AppliedLookAt = MakeShared<FJsonObject>();
						AppliedLookAt->SetNumberField(TEXT("x"), LX);
						AppliedLookAt->SetNumberField(TEXT("y"), LY);
						AppliedLookAt->SetNumberField(TEXT("z"), LZ);
						Applied->SetObjectField(TEXT("look_at"), AppliedLookAt);
					}
				}
			}
		}

		// Force the viewport to redraw with the new camera state.
		ViewportClient->Invalidate();

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetObjectField(TEXT("applied"), Applied);

		SendResponse(BuildViewportSuccessResponse(CorrId, Data) + TEXT("\n"));
	});

	// -----------------------------------------------------------------------
	// viewport.renderMode (PIE-07)
	// Switches the active viewport to a named render mode.
	//
	// Supported modes: lit, unlit, wireframe, collision, detail_lighting
	//
	// Threat T-12-07: explicit string allowlist -- never passes raw user input
	// to SetViewMode().  Unknown modes return "unknown_render_mode" error.
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("viewport.renderMode"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

		// Extract optional payload.
		TSharedPtr<FJsonObject> Payload;
		const TSharedPtr<FJsonValue>* PayloadVal = Cmd->Values.Find(TEXT("payload"));
		if (PayloadVal && (*PayloadVal)->Type == EJson::Object)
		{
			Payload = (*PayloadVal)->AsObject();
		}

		// "mode" is required.
		FString Mode;
		if (!Payload.IsValid() || !Payload->TryGetStringField(TEXT("mode"), Mode) || Mode.IsEmpty())
		{
			SendResponse(BuildViewportErrorResponse(CorrId, TEXT("missing_mode")) + TEXT("\n"));
			return;
		}

		FLevelEditorViewportClient* ViewportClient = GetActiveViewportClient();
		if (!ViewportClient)
		{
			SendResponse(BuildViewportErrorResponse(CorrId, TEXT("no_active_viewport")) + TEXT("\n"));
			return;
		}

		// Explicit allowlist mapping (T-12-07).
		EViewModeIndex ModeIndex = VMI_Lit;
		bool bModeKnown = false;

		if (Mode == TEXT("lit"))
		{
			ModeIndex  = VMI_Lit;
			bModeKnown = true;
		}
		else if (Mode == TEXT("unlit"))
		{
			ModeIndex  = VMI_Unlit;
			bModeKnown = true;
		}
		else if (Mode == TEXT("wireframe"))
		{
			ModeIndex  = VMI_Wireframe;
			bModeKnown = true;
		}
		else if (Mode == TEXT("collision"))
		{
			ModeIndex  = VMI_CollisionPawn;
			bModeKnown = true;
		}
		else if (Mode == TEXT("detail_lighting"))
		{
			// VMI_Lit_DetailLighting is "Detail Lighting" mode in UE 5.7 (not VMI_LightingOnly).
			ModeIndex  = VMI_Lit_DetailLighting;
			bModeKnown = true;
		}

		if (!bModeKnown)
		{
			// Return error with list of valid modes so the caller can correct the request.
			const FString ErrMsg = FString::Printf(
				TEXT("unknown_render_mode: '%s'. Valid modes: lit, unlit, wireframe, collision, detail_lighting"),
				*Mode);
			SendResponse(BuildViewportErrorResponse(CorrId, ErrMsg) + TEXT("\n"));
			return;
		}

		ViewportClient->SetViewMode(ModeIndex);
		ViewportClient->Invalidate();

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetStringField(TEXT("mode"),       Mode);
		Data->SetNumberField(TEXT("mode_index"),  static_cast<double>(ModeIndex));

		SendResponse(BuildViewportSuccessResponse(CorrId, Data) + TEXT("\n"));
	});

	// -----------------------------------------------------------------------
	// viewport.hiresScreenshot (PIE-08)
	// Triggers a high-resolution screenshot at a caller-specified multiplier and
	// base resolution.  UE writes the file asynchronously; the handler returns
	// the screenshots directory and the computed final dimensions.
	//
	// Payload fields (all optional):
	//   resolution_multiplier int32 (default 2, clamped 1..8)
	//   width                 int32 (default 1920, base resolution)
	//   height                int32 (default 1080, base resolution)
	//
	// Threat T-12-05: multiplier clamped 1..8; final pixel dims clamped to 15360 per axis.
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("viewport.hiresScreenshot"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

		// Extract optional payload.
		TSharedPtr<FJsonObject> Payload;
		const TSharedPtr<FJsonValue>* PayloadVal = Cmd->Values.Find(TEXT("payload"));
		if (PayloadVal && (*PayloadVal)->Type == EJson::Object)
		{
			Payload = (*PayloadVal)->AsObject();
		}

		// Read parameters with defaults (T-12-05: clamp multiplier and final dims).
		int32 Multiplier = 2;
		int32 BaseWidth  = 1920;
		int32 BaseHeight = 1080;

		if (Payload.IsValid())
		{
			double RawMult = 0.0;
			if (Payload->TryGetNumberField(TEXT("resolution_multiplier"), RawMult))
			{
				Multiplier = FMath::Clamp(static_cast<int32>(RawMult), 1, 8);
			}

			double RawWidth = 0.0;
			if (Payload->TryGetNumberField(TEXT("width"), RawWidth))
			{
				// Base width has same practical limits as the standard screenshot.
				BaseWidth = FMath::Clamp(static_cast<int32>(RawWidth), 64, 7680);
			}

			double RawHeight = 0.0;
			if (Payload->TryGetNumberField(TEXT("height"), RawHeight))
			{
				BaseHeight = FMath::Clamp(static_cast<int32>(RawHeight), 64, 4320);
			}
		}

		// Compute final resolution and clamp per-axis to prevent GPU OOM (T-12-05).
		constexpr int32 MaxPixelsPerAxis = 15360;
		const int32 FinalWidth  = FMath::Min(BaseWidth  * Multiplier, MaxPixelsPerAxis);
		const int32 FinalHeight = FMath::Min(BaseHeight * Multiplier, MaxPixelsPerAxis);

		// Configure UE high-resolution screenshot system.
		// SetResolution(X, Y, Scale) takes the final pixel dimensions and an optional scale
		// factor (defaults to 1.0f meaning no additional scale applied on top).
		GScreenshotResolutionX = FinalWidth;
		GScreenshotResolutionY = FinalHeight;
		GetHighResScreenshotConfig().SetResolution(
			static_cast<uint32>(FinalWidth),
			static_cast<uint32>(FinalHeight),
			1.0f);
		GIsHighResScreenshot = true;

		// Queue the screenshot capture.
		FScreenshotRequest::RequestScreenshot(false /* bShowUI */);

		const FString ShotDir = FPaths::ScreenShotDir();

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetStringField(TEXT("screenshot_dir"),         ShotDir);
		Data->SetNumberField(TEXT("width"),                  static_cast<double>(FinalWidth));
		Data->SetNumberField(TEXT("height"),                 static_cast<double>(FinalHeight));
		Data->SetNumberField(TEXT("resolution_multiplier"),  static_cast<double>(Multiplier));
		Data->SetBoolField(TEXT("queued"), true);

		SendResponse(BuildViewportSuccessResponse(CorrId, Data) + TEXT("\n"));
	});

	// -----------------------------------------------------------------------
	// viewport.lookAt (VIS-03)
	// Resolves an actor label (or accepts an explicit world position) and moves
	// the editor camera to view it from the requested distance and angle.
	// Optionally takes a screenshot after moving.
	//
	// Payload fields:
	//   target    string | {x,y,z}  -- actor label or explicit world position (required)
	//   distance  float             -- camera distance from target (optional; auto from bounds)
	//   angle     string | {yaw,pitch} -- preset or custom (default "front")
	//   screenshot bool             -- take screenshot after moving (default true)
	//   width     int               -- screenshot width  (default 1280, clamped 64..7680)
	//   height    int               -- screenshot height (default 720,  clamped 64..4320)
	//
	// Threat T-31-01: actor label resolved via TActorIterator -- no injection possible.
	// Threat T-31-05: screenshot dimensions clamped 64..7680 / 64..4320.
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("viewport.lookAt"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

		TSharedPtr<FJsonObject> Payload;
		const TSharedPtr<FJsonValue>* PayloadVal = Cmd->Values.Find(TEXT("payload"));
		if (PayloadVal && (*PayloadVal)->Type == EJson::Object)
		{
			Payload = (*PayloadVal)->AsObject();
		}

		if (!Payload.IsValid())
		{
			SendResponse(BuildViewportErrorResponse(CorrId, TEXT("missing_payload")) + TEXT("\n"));
			return;
		}

		// Resolve target.
		const TSharedPtr<FJsonValue>* TargetVal = Payload->Values.Find(TEXT("target"));
		if (!TargetVal || !TargetVal->IsValid())
		{
			SendResponse(BuildViewportErrorResponse(CorrId, TEXT("missing_target")) + TEXT("\n"));
			return;
		}

		FLevelEditorViewportClient* ViewportClient = GetActiveViewportClient();
		if (!ViewportClient)
		{
			SendResponse(BuildViewportErrorResponse(CorrId, TEXT("no_active_viewport")) + TEXT("\n"));
			return;
		}

		FVector TargetPos(ForceInitToZero);
		FString ResolvedActorLabel;
		FVector ActorOrigin(ForceInitToZero);
		FVector ActorExtent(ForceInitToZero);
		bool bHasActorBounds = false;

		if ((*TargetVal)->Type == EJson::String)
		{
			// Resolve actor label to world position.
			const FString ActorLabel = (*TargetVal)->AsString();

			UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
			if (!World)
			{
				SendResponse(BuildViewportErrorResponse(CorrId, TEXT("no_editor_world")) + TEXT("\n"));
				return;
			}

			TArray<FString> SimilarLabels;
			AActor* FoundActor = FindActorByLabelSubstring(World, ActorLabel, &SimilarLabels);
			if (!FoundActor)
			{
				// Build error with similar label suggestions.
				TSharedPtr<FJsonObject> ErrData = MakeShared<FJsonObject>();
				ErrData->SetStringField(TEXT("error"), TEXT("actor_not_found"));
				ErrData->SetStringField(TEXT("requested_label"), ActorLabel);
				TArray<TSharedPtr<FJsonValue>> SimilarArray;
				for (const FString& S : SimilarLabels)
				{
					SimilarArray.Add(MakeShared<FJsonValueString>(S));
				}
				ErrData->SetArrayField(TEXT("similar_labels"), SimilarArray);

				TSharedPtr<FJsonObject> ErrObj = MakeShared<FJsonObject>();
				ErrObj->SetBoolField(TEXT("success"), false);
				ErrObj->SetStringField(TEXT("correlationId"), CorrId);
				ErrObj->SetStringField(TEXT("error"), TEXT("actor_not_found"));
				ErrObj->SetObjectField(TEXT("data"), ErrData);
				FString ErrOutput;
				TSharedRef<TJsonWriter<>> W = TJsonWriterFactory<>::Create(&ErrOutput);
				FJsonSerializer::Serialize(ErrObj.ToSharedRef(), W);
				SendResponse(ErrOutput + TEXT("\n"));
				return;
			}

			FoundActor->GetActorBounds(false, ActorOrigin, ActorExtent);
			TargetPos = ActorOrigin; // Use bounds origin (centre of actor) as target.
			ResolvedActorLabel = FoundActor->GetActorLabel();
			bHasActorBounds = true;
		}
		else if ((*TargetVal)->Type == EJson::Object)
		{
			// Explicit world position {x, y, z}.
			const TSharedPtr<FJsonObject> PosObj = (*TargetVal)->AsObject();
			double X = 0.0, Y = 0.0, Z = 0.0;
			PosObj->TryGetNumberField(TEXT("x"), X);
			PosObj->TryGetNumberField(TEXT("y"), Y);
			PosObj->TryGetNumberField(TEXT("z"), Z);
			TargetPos = FVector(X, Y, Z);
		}
		else
		{
			SendResponse(BuildViewportErrorResponse(CorrId, TEXT("invalid_target_type")) + TEXT("\n"));
			return;
		}

		// Resolve distance. If not provided and target is an actor, auto-calculate from bounds.
		double RawDistance = -1.0;
		Payload->TryGetNumberField(TEXT("distance"), RawDistance);

		float Distance;
		if (RawDistance > 0.0)
		{
			Distance = static_cast<float>(RawDistance);
		}
		else if (bHasActorBounds)
		{
			// Auto-calculate: enough to see the full actor (extents * 2, minimum 100).
			Distance = FMath::Max(static_cast<float>(ActorExtent.Size()) * 2.0f, 100.0f);
		}
		else
		{
			Distance = 500.0f;
		}

		// Resolve angle preset or custom {yaw, pitch}.
		const TSharedPtr<FJsonValue>* AngleVal = Payload->Values.Find(TEXT("angle"));
		const FRotator AngleRot = AngleVal ? ResolveAngle(*AngleVal) : FRotator(0.0f, 0.0f, 0.0f);

		// Compute camera position: target + direction_from_angle * (-distance).
		// The angle rotator describes where the camera sits relative to the target.
		const FVector AngleDir = AngleRot.Vector(); // unit vector pointing "forward" in that rotation
		const FVector CameraPos = TargetPos + AngleDir * (-Distance);

		// Compute camera rotation: look from camera toward target.
		const FVector LookDir = (TargetPos - CameraPos).GetSafeNormal();

		ViewportClient->SetViewLocation(CameraPos);
		if (!LookDir.IsNearlyZero())
		{
			ViewportClient->SetViewRotation(LookDir.Rotation());
		}
		ViewportClient->Invalidate();

		// Screenshot parameters (T-31-05: clamped).
		bool bTakeScreenshot = true;
		Payload->TryGetBoolField(TEXT("screenshot"), bTakeScreenshot);

		double RawWidth = 1280.0, RawHeight = 720.0;
		Payload->TryGetNumberField(TEXT("width"),  RawWidth);
		Payload->TryGetNumberField(TEXT("height"), RawHeight);
		const int32 ShotWidth  = FMath::Clamp(static_cast<int32>(RawWidth),  64, 7680);
		const int32 ShotHeight = FMath::Clamp(static_cast<int32>(RawHeight), 64, 4320);

		FString FilePath;
		if (bTakeScreenshot)
		{
			FilePath = TakeScreenshotToFile(ShotWidth, ShotHeight);
		}

		// Build response data.
		const FRotator CamRot = ViewportClient->GetViewRotation();

		auto MakeVec = [](const FVector& V) -> TSharedPtr<FJsonObject>
		{
			TSharedPtr<FJsonObject> Obj = MakeShared<FJsonObject>();
			Obj->SetNumberField(TEXT("x"), static_cast<double>(V.X));
			Obj->SetNumberField(TEXT("y"), static_cast<double>(V.Y));
			Obj->SetNumberField(TEXT("z"), static_cast<double>(V.Z));
			return Obj;
		};

		TSharedPtr<FJsonObject> CamRotObj = MakeShared<FJsonObject>();
		CamRotObj->SetNumberField(TEXT("pitch"), static_cast<double>(CamRot.Pitch));
		CamRotObj->SetNumberField(TEXT("yaw"),   static_cast<double>(CamRot.Yaw));
		CamRotObj->SetNumberField(TEXT("roll"),  static_cast<double>(CamRot.Roll));

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetObjectField(TEXT("camera_position"), MakeVec(CameraPos));
		Data->SetObjectField(TEXT("camera_rotation"), CamRotObj);
		Data->SetObjectField(TEXT("target_position"), MakeVec(TargetPos));

		if (!ResolvedActorLabel.IsEmpty())
		{
			Data->SetStringField(TEXT("actor_label"), ResolvedActorLabel);

			TSharedPtr<FJsonObject> BoundsObj = MakeShared<FJsonObject>();
			BoundsObj->SetObjectField(TEXT("origin"), MakeVec(ActorOrigin));
			BoundsObj->SetObjectField(TEXT("extent"), MakeVec(ActorExtent));
			Data->SetObjectField(TEXT("actor_bounds"), BoundsObj);
		}

		if (!FilePath.IsEmpty())
		{
			Data->SetStringField(TEXT("file_path"), FilePath);
		}

		SendResponse(BuildViewportSuccessResponse(CorrId, Data) + TEXT("\n"));
	});

	// -----------------------------------------------------------------------
	// viewport.frustumActors (VIS-05)
	// Returns actors within a given radius of the current camera position,
	// sorted by distance ascending.
	//
	// Payload fields (all optional):
	//   radius     float -- max distance from camera (default 10000)
	//   max_actors int   -- max actors to return (default 50)
	//
	// Threat T-31-02: max_actors clamped 1..200; radius clamped 1..100000.
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("viewport.frustumActors"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

		TSharedPtr<FJsonObject> Payload;
		const TSharedPtr<FJsonValue>* PayloadVal = Cmd->Values.Find(TEXT("payload"));
		if (PayloadVal && (*PayloadVal)->Type == EJson::Object)
		{
			Payload = (*PayloadVal)->AsObject();
		}

		FLevelEditorViewportClient* ViewportClient = GetActiveViewportClient();
		if (!ViewportClient)
		{
			SendResponse(BuildViewportErrorResponse(CorrId, TEXT("no_active_viewport")) + TEXT("\n"));
			return;
		}

		UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
		if (!World)
		{
			SendResponse(BuildViewportErrorResponse(CorrId, TEXT("no_editor_world")) + TEXT("\n"));
			return;
		}

		// Read parameters with defaults and clamp (T-31-02).
		double RawRadius    = 10000.0;
		double RawMaxActors = 50.0;
		if (Payload.IsValid())
		{
			Payload->TryGetNumberField(TEXT("radius"),     RawRadius);
			Payload->TryGetNumberField(TEXT("max_actors"), RawMaxActors);
		}
		const float Radius    = static_cast<float>(FMath::Clamp(RawRadius,    1.0, 100000.0));
		const int32 MaxActors = FMath::Clamp(static_cast<int32>(RawMaxActors), 1, 200);

		const FVector CameraPos = ViewportClient->GetViewLocation();

		// Collect actors within radius.
		struct FActorEntry
		{
			FString Label;
			FString ClassName;
			float   Distance;
			FVector WorldPos;
			FVector BoundsOrigin;
			FVector BoundsExtent;
		};
		TArray<FActorEntry> Entries;

		for (TActorIterator<AActor> It(World); It; ++It)
		{
			AActor* Actor = *It;
			if (!Actor)
			{
				continue;
			}

			const FVector ActorPos  = Actor->GetActorLocation();
			const float   Dist      = FVector::Dist(CameraPos, ActorPos);

			if (Dist <= Radius)
			{
				FVector BoundsOrigin(ForceInitToZero);
				FVector BoundsExtent(ForceInitToZero);
				Actor->GetActorBounds(false, BoundsOrigin, BoundsExtent);

				FActorEntry Entry;
				Entry.Label        = Actor->GetActorLabel();
				Entry.ClassName    = Actor->GetClass() ? Actor->GetClass()->GetName() : TEXT("Unknown");
				Entry.Distance     = Dist;
				Entry.WorldPos     = ActorPos;
				Entry.BoundsOrigin = BoundsOrigin;
				Entry.BoundsExtent = BoundsExtent;
				Entries.Add(MoveTemp(Entry));
			}
		}

		// Sort by distance ascending.
		Entries.Sort([](const FActorEntry& A, const FActorEntry& B)
		{
			return A.Distance < B.Distance;
		});

		// Clamp to max_actors.
		if (Entries.Num() > MaxActors)
		{
			Entries.SetNum(MaxActors);
		}

		auto MakeVec = [](const FVector& V) -> TSharedPtr<FJsonObject>
		{
			TSharedPtr<FJsonObject> Obj = MakeShared<FJsonObject>();
			Obj->SetNumberField(TEXT("x"), static_cast<double>(V.X));
			Obj->SetNumberField(TEXT("y"), static_cast<double>(V.Y));
			Obj->SetNumberField(TEXT("z"), static_cast<double>(V.Z));
			return Obj;
		};

		TArray<TSharedPtr<FJsonValue>> ActorArray;
		for (const FActorEntry& Entry : Entries)
		{
			TSharedPtr<FJsonObject> BoundsObj = MakeShared<FJsonObject>();
			BoundsObj->SetObjectField(TEXT("origin"), MakeVec(Entry.BoundsOrigin));
			BoundsObj->SetObjectField(TEXT("extent"), MakeVec(Entry.BoundsExtent));

			TSharedPtr<FJsonObject> ActorObj = MakeShared<FJsonObject>();
			ActorObj->SetStringField(TEXT("label"),          Entry.Label);
			ActorObj->SetStringField(TEXT("class_name"),     Entry.ClassName);
			ActorObj->SetNumberField(TEXT("distance"),       static_cast<double>(Entry.Distance));
			ActorObj->SetObjectField(TEXT("world_position"), MakeVec(Entry.WorldPos));
			ActorObj->SetObjectField(TEXT("bounds"),         BoundsObj);

			ActorArray.Add(MakeShared<FJsonValueObject>(ActorObj));
		}

		TSharedPtr<FJsonObject> CamPosObj = MakeShared<FJsonObject>();
		CamPosObj->SetNumberField(TEXT("x"), static_cast<double>(CameraPos.X));
		CamPosObj->SetNumberField(TEXT("y"), static_cast<double>(CameraPos.Y));
		CamPosObj->SetNumberField(TEXT("z"), static_cast<double>(CameraPos.Z));

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetObjectField(TEXT("camera_position"), CamPosObj);
		Data->SetNumberField(TEXT("actor_count"),     static_cast<double>(ActorArray.Num()));
		Data->SetArrayField(TEXT("actors"),           ActorArray);

		SendResponse(BuildViewportSuccessResponse(CorrId, Data) + TEXT("\n"));
	});

	// -----------------------------------------------------------------------
	// viewport.focusActor (VIS-07)
	// Finds an actor by label, computes ideal camera distance from bounding box,
	// and frames it in the viewport with optional screenshot.
	//
	// Payload fields:
	//   actor_label string              -- label of actor to frame (required)
	//   padding     float               -- multiplier on bounds for framing (default 1.5)
	//   angle       string | {yaw,pitch} -- viewing angle preset or custom (default "front")
	//   screenshot  bool                -- take screenshot after framing (default true)
	//   width       int                 -- screenshot width  (default 1280, clamped 64..7680)
	//   height      int                 -- screenshot height (default 720,  clamped 64..4320)
	//
	// Threat T-31-01: actor label resolved via TActorIterator -- no injection possible.
	// Threat T-31-05: screenshot dimensions clamped 64..7680 / 64..4320.
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("viewport.focusActor"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

		TSharedPtr<FJsonObject> Payload;
		const TSharedPtr<FJsonValue>* PayloadVal = Cmd->Values.Find(TEXT("payload"));
		if (PayloadVal && (*PayloadVal)->Type == EJson::Object)
		{
			Payload = (*PayloadVal)->AsObject();
		}

		FString ActorLabel;
		if (!Payload.IsValid() || !Payload->TryGetStringField(TEXT("actor_label"), ActorLabel) || ActorLabel.IsEmpty())
		{
			SendResponse(BuildViewportErrorResponse(CorrId, TEXT("missing_actor_label")) + TEXT("\n"));
			return;
		}

		FLevelEditorViewportClient* ViewportClient = GetActiveViewportClient();
		if (!ViewportClient)
		{
			SendResponse(BuildViewportErrorResponse(CorrId, TEXT("no_active_viewport")) + TEXT("\n"));
			return;
		}

		UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
		if (!World)
		{
			SendResponse(BuildViewportErrorResponse(CorrId, TEXT("no_editor_world")) + TEXT("\n"));
			return;
		}

		TArray<FString> SimilarLabels;
		AActor* FoundActor = FindActorByLabelSubstring(World, ActorLabel, &SimilarLabels);
		if (!FoundActor)
		{
			TSharedPtr<FJsonObject> ErrData = MakeShared<FJsonObject>();
			ErrData->SetStringField(TEXT("error"), TEXT("actor_not_found"));
			ErrData->SetStringField(TEXT("requested_label"), ActorLabel);
			TArray<TSharedPtr<FJsonValue>> SimilarArray;
			for (const FString& S : SimilarLabels)
			{
				SimilarArray.Add(MakeShared<FJsonValueString>(S));
			}
			ErrData->SetArrayField(TEXT("similar_labels"), SimilarArray);

			TSharedPtr<FJsonObject> ErrObj = MakeShared<FJsonObject>();
			ErrObj->SetBoolField(TEXT("success"), false);
			ErrObj->SetStringField(TEXT("correlationId"), CorrId);
			ErrObj->SetStringField(TEXT("error"), TEXT("actor_not_found"));
			ErrObj->SetObjectField(TEXT("data"), ErrData);
			FString ErrOutput;
			TSharedRef<TJsonWriter<>> W = TJsonWriterFactory<>::Create(&ErrOutput);
			FJsonSerializer::Serialize(ErrObj.ToSharedRef(), W);
			SendResponse(ErrOutput + TEXT("\n"));
			return;
		}

		FVector BoundsOrigin(ForceInitToZero);
		FVector BoundsExtent(ForceInitToZero);
		FoundActor->GetActorBounds(false, BoundsOrigin, BoundsExtent);

		// Read padding with default 1.5.
		double RawPadding = 1.5;
		if (Payload.IsValid())
		{
			Payload->TryGetNumberField(TEXT("padding"), RawPadding);
		}
		const float Padding = FMath::Max(static_cast<float>(RawPadding), 0.1f); // minimum 0.1 to avoid zero distance

		// Compute framing distance: bounds extent size * padding.
		const float FramingDistance = FMath::Max(BoundsExtent.Size() * Padding, 50.0f);

		// Resolve angle preset or custom {yaw, pitch}.
		const TSharedPtr<FJsonValue>* AngleVal = Payload ? Payload->Values.Find(TEXT("angle")) : nullptr;
		const FRotator AngleRot = AngleVal ? ResolveAngle(*AngleVal) : FRotator(0.0f, 0.0f, 0.0f);

		// Camera placement: from bounds origin, offset by angle direction * (-distance).
		const FVector AngleDir = AngleRot.Vector();
		const FVector CameraPos = BoundsOrigin + AngleDir * (-FramingDistance);

		// Camera rotation: look toward bounds origin.
		const FVector LookDir = (BoundsOrigin - CameraPos).GetSafeNormal();

		ViewportClient->SetViewLocation(CameraPos);
		if (!LookDir.IsNearlyZero())
		{
			ViewportClient->SetViewRotation(LookDir.Rotation());
		}
		ViewportClient->Invalidate();

		// Screenshot parameters (T-31-05: clamped).
		bool bTakeScreenshot = true;
		if (Payload.IsValid())
		{
			Payload->TryGetBoolField(TEXT("screenshot"), bTakeScreenshot);
		}

		double RawWidth = 1280.0, RawHeight = 720.0;
		if (Payload.IsValid())
		{
			Payload->TryGetNumberField(TEXT("width"),  RawWidth);
			Payload->TryGetNumberField(TEXT("height"), RawHeight);
		}
		const int32 ShotWidth  = FMath::Clamp(static_cast<int32>(RawWidth),  64, 7680);
		const int32 ShotHeight = FMath::Clamp(static_cast<int32>(RawHeight), 64, 4320);

		FString FilePath;
		if (bTakeScreenshot)
		{
			FilePath = TakeScreenshotToFile(ShotWidth, ShotHeight);
		}

		// Build response data.
		const FRotator CamRot = ViewportClient->GetViewRotation();
		const FVector  ActorPos = FoundActor->GetActorLocation();
		const FString  ActorClassName = FoundActor->GetClass() ? FoundActor->GetClass()->GetName() : TEXT("Unknown");

		auto MakeVec = [](const FVector& V) -> TSharedPtr<FJsonObject>
		{
			TSharedPtr<FJsonObject> Obj = MakeShared<FJsonObject>();
			Obj->SetNumberField(TEXT("x"), static_cast<double>(V.X));
			Obj->SetNumberField(TEXT("y"), static_cast<double>(V.Y));
			Obj->SetNumberField(TEXT("z"), static_cast<double>(V.Z));
			return Obj;
		};

		TSharedPtr<FJsonObject> CamRotObj = MakeShared<FJsonObject>();
		CamRotObj->SetNumberField(TEXT("pitch"), static_cast<double>(CamRot.Pitch));
		CamRotObj->SetNumberField(TEXT("yaw"),   static_cast<double>(CamRot.Yaw));
		CamRotObj->SetNumberField(TEXT("roll"),  static_cast<double>(CamRot.Roll));

		TSharedPtr<FJsonObject> BoundsObj = MakeShared<FJsonObject>();
		BoundsObj->SetObjectField(TEXT("origin"), MakeVec(BoundsOrigin));
		BoundsObj->SetObjectField(TEXT("extent"), MakeVec(BoundsExtent));

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetStringField(TEXT("actor_label"),       FoundActor->GetActorLabel());
		Data->SetStringField(TEXT("actor_class"),       ActorClassName);
		Data->SetObjectField(TEXT("actor_position"),    MakeVec(ActorPos));
		Data->SetObjectField(TEXT("actor_bounds"),      BoundsObj);
		Data->SetObjectField(TEXT("camera_position"),   MakeVec(CameraPos));
		Data->SetObjectField(TEXT("camera_rotation"),   CamRotObj);
		Data->SetNumberField(TEXT("framing_distance"),  static_cast<double>(FramingDistance));

		if (!FilePath.IsEmpty())
		{
			Data->SetStringField(TEXT("file_path"), FilePath);
		}

		SendResponse(BuildViewportSuccessResponse(CorrId, Data) + TEXT("\n"));
	});

	// -----------------------------------------------------------------------
	// viewport.cleanupScreenshots (VIS-08)
	// Deletes MCP-generated screenshots (mcp_screenshot_*.png) from the dedicated
	// MCPScreenshots/ directory. Supports keep_last to preserve the N most recent.
	//
	// Payload fields (all optional):
	//   keep_last int -- number of most recent screenshots to keep (default 0, clamped 0..1000)
	//
	// Threat T-31-03: only deletes files matching mcp_screenshot_*.png in MCPScreenshots/;
	// never accepts user-provided paths; keep_last clamped 0..1000.
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("viewport.cleanupScreenshots"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

		TSharedPtr<FJsonObject> Payload;
		const TSharedPtr<FJsonValue>* PayloadVal = Cmd->Values.Find(TEXT("payload"));
		if (PayloadVal && (*PayloadVal)->Type == EJson::Object)
		{
			Payload = (*PayloadVal)->AsObject();
		}

		// Read keep_last with default 0 and clamp to safe range (T-31-03).
		double RawKeepLast = 0.0;
		if (Payload.IsValid())
		{
			Payload->TryGetNumberField(TEXT("keep_last"), RawKeepLast);
		}
		const int32 KeepLast = FMath::Clamp(static_cast<int32>(RawKeepLast), 0, 1000);

		const FString ScreenshotDir = GetMCPScreenshotDir();
		const FString GlobPattern   = FPaths::Combine(ScreenshotDir, TEXT("mcp_screenshot_*.png"));

		// Find all MCP screenshots.
		TArray<FString> FoundFiles;
		IFileManager::Get().FindFiles(FoundFiles, *GlobPattern, true /* bFiles */, false /* bDirs */);

		// Sort by name ascending (timestamp-in-name ensures chronological order).
		FoundFiles.Sort();

		// Build list of files to delete (all except the last KeepLast entries).
		int32 DeleteCount = FMath::Max(FoundFiles.Num() - KeepLast, 0);
		TArray<FString> ToDelete = TArray<FString>(FoundFiles.GetData(), DeleteCount);
		const int32 KeptCount = FoundFiles.Num() - DeleteCount;

		int32 DeletedCount   = 0;
		int64 BytesFreed     = 0;

		for (const FString& FileName : ToDelete)
		{
			const FString FullPath = FPaths::Combine(ScreenshotDir, FileName);

			// Get file size before deleting.
			const int64 FileSize = IFileManager::Get().FileSize(*FullPath);
			if (FileSize > 0)
			{
				BytesFreed += FileSize;
			}

			if (IFileManager::Get().Delete(*FullPath, false /* bRequireExists */, false /* bEvenReadOnly */))
			{
				++DeletedCount;
			}
		}

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetNumberField(TEXT("deleted_count"), static_cast<double>(DeletedCount));
		Data->SetNumberField(TEXT("bytes_freed"),   static_cast<double>(BytesFreed));
		Data->SetNumberField(TEXT("kept_count"),    static_cast<double>(KeptCount));
		Data->SetStringField(TEXT("screenshot_dir"), ScreenshotDir);

		SendResponse(BuildViewportSuccessResponse(CorrId, Data) + TEXT("\n"));
	});
}
