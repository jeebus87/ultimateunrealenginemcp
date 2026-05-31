// MCPPieCommands.cpp
// Implements MCP command handlers for PIE (Play In Editor) session control.
//
//   pie.start     -- start PIE session (validates not already active)
//   pie.stop      -- stop PIE session (validates PIE is active)
//   pie.logs      -- return buffered log lines captured since PIE started
//   pie.gameState -- return actor positions and active GameMode class during PIE
//
// All handlers are guaranteed to run on the game thread (FMCPCommandRouter guarantee via AsyncTask).
// PIE log capture uses a custom FOutputDevice subclass added to GLog.
// Log ring-buffer is capped at 10,000 lines (T-12-02: DoS mitigation).

#include "MCPPieCommands.h"

#include "Editor.h"
#include "Engine/World.h"
#include "GameFramework/GameModeBase.h"
#include "GameFramework/Actor.h"
#include "EngineUtils.h"
#include "Misc/OutputDevice.h"
#include "Misc/OutputDeviceRedirector.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"

// ---------------------------------------------------------------------------
// PIE log capture — FOutputDevice subclass + ring buffer
// ---------------------------------------------------------------------------

/** Maximum number of log lines retained in the PIE capture buffer (T-12-02). */
static constexpr int32 GPieLogMaxLines = 10000;

/** Ring buffer of log lines captured during PIE. Accessed only on the game thread. */
static TArray<FString> GPieCapturedLogs;

/**
 * Custom output device that appends log messages to GPieCapturedLogs.
 * Added to GLog when PIE starts, removed when PIE stops.
 * The ring buffer is capped at GPieLogMaxLines; oldest entries are dropped first.
 */
class FMCPPieLogCapture : public FOutputDevice
{
public:
	FMCPPieLogCapture()
	{
		// Suppress timestamps — they bloat output and callers can filter by line.
		bSuppressEventTag = false;
		bAutoEmitLineTerminator = false;
	}

	virtual void Serialize(const TCHAR* V, ELogVerbosity::Type Verbosity, const FName& Category) override
	{
		// Format: [Category] Message
		FString Line = FString::Printf(TEXT("[%s] %s"), *Category.ToString(), V);

		// Enforce ring buffer cap: drop oldest entry when at limit (T-12-02).
		if (GPieCapturedLogs.Num() >= GPieLogMaxLines)
		{
			GPieCapturedLogs.RemoveAt(0, 1, EAllowShrinking::No);
		}

		GPieCapturedLogs.Add(MoveTemp(Line));
	}

	virtual bool CanBeUsedOnMultipleThreads() const override
	{
		// Log messages may come from non-game threads; the array is not
		// thread-safe, but FOutputDeviceRedirector serialises calls under a
		// lock before forwarding to device Serialize(), so this is safe.
		return false;
	}
};

/** Singleton log capture device; null when PIE is not running. */
static TUniquePtr<FMCPPieLogCapture> GPieLogDevice;

// ---------------------------------------------------------------------------
// Internal JSON response helpers
// ---------------------------------------------------------------------------

static FString BuildPieSuccessResponse(const FString& CorrId, TSharedPtr<FJsonObject> Data)
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

static FString BuildPieErrorResponse(const FString& CorrId, const FString& Error)
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
// RegisterPieCommands
// ---------------------------------------------------------------------------

void RegisterPieCommands(FMCPCommandRouter& Router)
{
	// -----------------------------------------------------------------------
	// pie.start
	// Starts a PIE session.
	// Guard: returns "pie_already_active" if PIE is already running (T-12-01).
	// Clears log buffer, creates and registers the log capture device.
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("pie.start"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

		if (!GEditor)
		{
			SendResponse(BuildPieErrorResponse(CorrId, TEXT("no_editor")) + TEXT("\n"));
			return;
		}

		// T-12-01: Prevent double-start.
		if (GEditor->IsPlayingSessionInEditor())
		{
			SendResponse(BuildPieErrorResponse(CorrId, TEXT("pie_already_active")) + TEXT("\n"));
			return;
		}

		// Reset log buffer and start capture.
		GPieCapturedLogs.Empty();
		GPieLogDevice = MakeUnique<FMCPPieLogCapture>();
		GLog->AddOutputDevice(GPieLogDevice.Get());

		// Start PIE using RequestPlaySession (UE 5.7 API).
		FRequestPlaySessionParams Params;
		GEditor->RequestPlaySession(Params);

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetBoolField(TEXT("started"), true);

		SendResponse(BuildPieSuccessResponse(CorrId, Data) + TEXT("\n"));
	});

	// -----------------------------------------------------------------------
	// pie.stop
	// Stops the active PIE session.
	// Guard: returns "pie_not_active" if PIE is not currently running.
	// Removes and destroys the log capture device.
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("pie.stop"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

		if (!GEditor)
		{
			SendResponse(BuildPieErrorResponse(CorrId, TEXT("no_editor")) + TEXT("\n"));
			return;
		}

		if (!GEditor->IsPlayingSessionInEditor())
		{
			SendResponse(BuildPieErrorResponse(CorrId, TEXT("pie_not_active")) + TEXT("\n"));
			return;
		}

		// Detach and destroy the log capture device before ending the session.
		if (GPieLogDevice.IsValid())
		{
			GLog->RemoveOutputDevice(GPieLogDevice.Get());
			GPieLogDevice.Reset();
		}

		GEditor->RequestEndPlayMap();

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetBoolField(TEXT("stopped"), true);

		SendResponse(BuildPieSuccessResponse(CorrId, Data) + TEXT("\n"));
	});

	// -----------------------------------------------------------------------
	// pie.logs
	// Returns buffered log lines captured since the last pie.start.
	// Optional payload fields:
	//   category_filter (string) -- substring match, case-insensitive; empty = all
	//   max_lines       (int32)  -- number of most-recent lines to return [1..1000], default 100
	// Response: {lines:[...], total_captured:int, returned:int}
	// T-12-02: max_lines clamped to 1000.
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("pie.logs"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

		// Extract optional payload.
		FString CategoryFilter;
		int32   MaxLines = 100;

		const TSharedPtr<FJsonValue>* PayloadVal = Cmd->Values.Find(TEXT("payload"));
		if (PayloadVal && (*PayloadVal)->Type == EJson::Object)
		{
			TSharedPtr<FJsonObject> Payload = (*PayloadVal)->AsObject();
			Payload->TryGetStringField(TEXT("category_filter"), CategoryFilter);

			double MaxLinesDouble = 100.0;
			if (Payload->TryGetNumberField(TEXT("max_lines"), MaxLinesDouble))
			{
				MaxLines = static_cast<int32>(MaxLinesDouble);
			}
		}

		// Clamp max_lines to [1, 1000] (T-12-02 DoS mitigation).
		MaxLines = FMath::Clamp(MaxLines, 1, 1000);

		const int32 TotalCaptured = GPieCapturedLogs.Num();

		// Filter by category if requested.
		TArray<FString> Filtered;
		if (CategoryFilter.IsEmpty())
		{
			Filtered = GPieCapturedLogs;
		}
		else
		{
			for (const FString& Line : GPieCapturedLogs)
			{
				if (Line.Contains(CategoryFilter, ESearchCase::IgnoreCase))
				{
					Filtered.Add(Line);
				}
			}
		}

		// Take the last MaxLines entries (most recent).
		const int32 StartIdx = FMath::Max(0, Filtered.Num() - MaxLines);
		const int32 ReturnedCount = Filtered.Num() - StartIdx;

		TArray<TSharedPtr<FJsonValue>> LinesArray;
		LinesArray.Reserve(ReturnedCount);
		for (int32 i = StartIdx; i < Filtered.Num(); ++i)
		{
			LinesArray.Add(MakeShared<FJsonValueString>(Filtered[i]));
		}

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetArrayField(TEXT("lines"),           LinesArray);
		Data->SetNumberField(TEXT("total_captured"),  static_cast<double>(TotalCaptured));
		Data->SetNumberField(TEXT("returned"),        static_cast<double>(ReturnedCount));

		SendResponse(BuildPieSuccessResponse(CorrId, Data) + TEXT("\n"));
	});

	// -----------------------------------------------------------------------
	// pie.gameState
	// Returns the active GameMode class and up to 200 actor positions from
	// the PIE world (GEditor->PlayWorld).
	// Guard: returns "pie_not_active" if PIE is not running.
	// Response: {game_mode_class:string, actor_count:int, actors:[{label,class,location:{x,y,z}},...]}
	// T-12-03: actor list capped at 200.
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("pie.gameState"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

		if (!GEditor)
		{
			SendResponse(BuildPieErrorResponse(CorrId, TEXT("no_editor")) + TEXT("\n"));
			return;
		}

		if (!GEditor->IsPlayingSessionInEditor())
		{
			SendResponse(BuildPieErrorResponse(CorrId, TEXT("pie_not_active")) + TEXT("\n"));
			return;
		}

		UWorld* PieWorld = GEditor->PlayWorld;
		if (!PieWorld)
		{
			SendResponse(BuildPieErrorResponse(CorrId, TEXT("pie_world_unavailable")) + TEXT("\n"));
			return;
		}

		// Resolve the active GameMode class name.
		AGameModeBase* GM = PieWorld->GetAuthGameMode<AGameModeBase>();
		FString GameModeClass = GM ? GM->GetClass()->GetName() : TEXT("None");

		// Iterate PIE actors, capped at 200 (T-12-03).
		static constexpr int32 MaxActors = 200;
		TArray<TSharedPtr<FJsonValue>> ActorsArray;
		ActorsArray.Reserve(MaxActors);

		for (TActorIterator<AActor> It(PieWorld); It && ActorsArray.Num() < MaxActors; ++It)
		{
			AActor* Actor = *It;
			if (!Actor)
			{
				continue;
			}

			// Skip Unreal internal default actors.
			if (Actor->GetName().StartsWith(TEXT("Default_")))
			{
				continue;
			}

			const FVector Loc = Actor->GetActorLocation();

			TSharedPtr<FJsonObject> LocObj = MakeShared<FJsonObject>();
			LocObj->SetNumberField(TEXT("x"), static_cast<double>(Loc.X));
			LocObj->SetNumberField(TEXT("y"), static_cast<double>(Loc.Y));
			LocObj->SetNumberField(TEXT("z"), static_cast<double>(Loc.Z));

			TSharedPtr<FJsonObject> ActorObj = MakeShared<FJsonObject>();
			ActorObj->SetStringField(TEXT("label"),    Actor->GetActorLabel());
			ActorObj->SetStringField(TEXT("class"),    Actor->GetClass()->GetName());
			ActorObj->SetObjectField(TEXT("location"), LocObj);

			ActorsArray.Add(MakeShared<FJsonValueObject>(ActorObj));
		}

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetStringField(TEXT("game_mode_class"), GameModeClass);
		Data->SetNumberField(TEXT("actor_count"),     static_cast<double>(ActorsArray.Num()));
		Data->SetArrayField(TEXT("actors"),           ActorsArray);

		SendResponse(BuildPieSuccessResponse(CorrId, Data) + TEXT("\n"));
	});
}
