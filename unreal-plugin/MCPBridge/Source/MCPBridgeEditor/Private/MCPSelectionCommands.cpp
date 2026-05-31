// MCPSelectionCommands.cpp (Plan 19-01)
// Implements four actor selection command handlers for the MCP bridge:
//   selection.select    -- select/deselect actors by name, label, or class filter (SEL-01)
//   selection.get       -- get current selection or apply all/none/invert bulk operation (SEL-02)
//   selection.duplicate -- duplicate selected actors with optional position offset (SEL-03)
//   selection.convert   -- convert an actor to a different target class (SEL-04)
//
// All handlers run on the game thread via AsyncTask(ENamedThreads::GameThread).
// target_class is validated via FindObject/StaticLoadClass before any actor operation (T-19-01).
// Offset values are clamped to +/-1e7 to prevent floating point issues (T-19-02).
// Actor labels are validated via TActorIterator before conversion (T-19-04).
// Modify() is called before all write operations in duplicate and convert handlers.

#include "MCPSelectionCommands.h"

// Editor
#include "Editor.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "GameFramework/Actor.h"

// Async
#include "Async/Async.h"

// JSON
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"

// Editor actor subsystem
#include "Subsystems/EditorActorSubsystem.h"

// Selection
#include "Selection.h"

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Returns a JSON success response string (without trailing newline). */
static FString BuildSelSuccessResponse(const FString& CorrId, TSharedPtr<FJsonObject> Data)
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
static FString BuildSelErrorResponse(const FString& CorrId, const FString& Error)
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
// RegisterSelectionCommands
// ---------------------------------------------------------------------------

void RegisterSelectionCommands(FMCPCommandRouter& Router)
{
	// -----------------------------------------------------------------------
	// selection.select (SEL-01)
	// Selects or deselects actors by label, name, or class filter.
	//
	// Optional payload fields:
	//   actors       -- string array of actor labels/names (supports * wildcards)
	//   class_filter -- string class name to match (e.g. "StaticMeshActor")
	//   action       -- "select" (default) or "deselect"
	//
	// Returns: selected_count and actors array with label, class, selected state.
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("selection.select"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

		// Extract payload.
		TSharedPtr<FJsonObject> Payload;
		const TSharedPtr<FJsonValue>* PayloadVal = Cmd->Values.Find(TEXT("payload"));
		if (PayloadVal && (*PayloadVal)->Type == EJson::Object)
		{
			Payload = (*PayloadVal)->AsObject();
		}

		// Extract actors array.
		TArray<FString> ActorNames;
		if (Payload.IsValid())
		{
			const TArray<TSharedPtr<FJsonValue>>* ActorsArray = nullptr;
			if (Payload->TryGetArrayField(TEXT("actors"), ActorsArray) && ActorsArray)
			{
				for (const TSharedPtr<FJsonValue>& Val : *ActorsArray)
				{
					FString Name;
					if (Val.IsValid() && Val->TryGetString(Name))
					{
						ActorNames.Add(Name);
					}
				}
			}
		}

		// Extract class_filter and action.
		FString ClassFilter;
		FString Action = TEXT("select");
		if (Payload.IsValid())
		{
			Payload->TryGetStringField(TEXT("class_filter"), ClassFilter);
			FString ActionVal;
			if (Payload->TryGetStringField(TEXT("action"), ActionVal) && !ActionVal.IsEmpty())
			{
				Action = ActionVal;
			}
		}

		const bool bSelect = (Action != TEXT("deselect"));

		AsyncTask(ENamedThreads::GameThread, [CorrId, SendResponse, ActorNames, ClassFilter, bSelect]()
		{
			if (!GEditor)
			{
				SendResponse(BuildSelErrorResponse(CorrId, TEXT("editor_not_available")) + TEXT("\n"));
				return;
			}

			UWorld* World = GEditor->GetEditorWorldContext().World();
			if (!World)
			{
				SendResponse(BuildSelErrorResponse(CorrId, TEXT("no_world_open")) + TEXT("\n"));
				return;
			}

			TArray<TSharedPtr<FJsonValue>> ActorsResultArray;
			int32 MatchCount = 0;

			for (TActorIterator<AActor> It(World); It; ++It)
			{
				AActor* Actor = *It;
				if (!Actor)
				{
					continue;
				}

				const FString ActorLabel = Actor->GetActorLabel();
				const FString ActorName = Actor->GetName();
				const FString ActorClass = Actor->GetClass()->GetName();

				bool bMatches = false;

				// Match against actors array (by label or name, supports wildcards).
				if (ActorNames.Num() > 0)
				{
					for (const FString& Pattern : ActorNames)
					{
						if (Pattern.Contains(TEXT("*")))
						{
							// Wildcard matching.
							if (ActorLabel.MatchesWildcard(Pattern) || ActorName.MatchesWildcard(Pattern))
							{
								bMatches = true;
								break;
							}
						}
						else
						{
							// Exact match by label or name.
							if (ActorLabel == Pattern || ActorName == Pattern)
							{
								bMatches = true;
								break;
							}
						}
					}
				}

				// Match against class filter.
				if (!ClassFilter.IsEmpty())
				{
					if (ClassFilter.Contains(TEXT("*")))
					{
						if (ActorClass.MatchesWildcard(ClassFilter))
						{
							bMatches = true;
						}
					}
					else
					{
						if (ActorClass == ClassFilter)
						{
							bMatches = true;
						}
					}
				}

				// If no filter specified, match all actors.
				if (ActorNames.Num() == 0 && ClassFilter.IsEmpty())
				{
					bMatches = true;
				}

				if (bMatches)
				{
					GEditor->SelectActor(Actor, bSelect, /*bNotify=*/true);
					++MatchCount;

					const FTransform& T = Actor->GetActorTransform();
					FVector Loc = T.GetLocation();
					FRotator Rot = T.GetRotation().Rotator();
					FVector Scale = T.GetScale3D();

					TSharedPtr<FJsonObject> LocObj = MakeShared<FJsonObject>();
					LocObj->SetNumberField(TEXT("x"), static_cast<double>(Loc.X));
					LocObj->SetNumberField(TEXT("y"), static_cast<double>(Loc.Y));
					LocObj->SetNumberField(TEXT("z"), static_cast<double>(Loc.Z));

					TSharedPtr<FJsonObject> ActorObj = MakeShared<FJsonObject>();
					ActorObj->SetStringField(TEXT("label"), ActorLabel);
					ActorObj->SetStringField(TEXT("class"), ActorClass);
					ActorObj->SetBoolField(TEXT("selected"), bSelect);
					ActorObj->SetObjectField(TEXT("location"), LocObj);

					ActorsResultArray.Add(MakeShared<FJsonValueObject>(ActorObj));
				}
			}

			TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
			Data->SetNumberField(TEXT("selected_count"), static_cast<double>(MatchCount));
			Data->SetArrayField(TEXT("actors"), ActorsResultArray);

			SendResponse(BuildSelSuccessResponse(CorrId, Data) + TEXT("\n"));
		});
	});

	// -----------------------------------------------------------------------
	// selection.get (SEL-02)
	// Gets the current editor selection or applies a bulk selection mode.
	//
	// Optional payload fields:
	//   mode -- "current" (default), "all", "none", "invert"
	//
	// Returns: count and actors array with label, class, and transform.
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("selection.get"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

		// Extract mode from payload.
		FString Mode = TEXT("current");
		const TSharedPtr<FJsonValue>* PayloadVal = Cmd->Values.Find(TEXT("payload"));
		if (PayloadVal && (*PayloadVal)->Type == EJson::Object)
		{
			TSharedPtr<FJsonObject> Payload = (*PayloadVal)->AsObject();
			FString ModeVal;
			if (Payload->TryGetStringField(TEXT("mode"), ModeVal) && !ModeVal.IsEmpty())
			{
				Mode = ModeVal;
			}
		}

		AsyncTask(ENamedThreads::GameThread, [CorrId, SendResponse, Mode]()
		{
			if (!GEditor)
			{
				SendResponse(BuildSelErrorResponse(CorrId, TEXT("editor_not_available")) + TEXT("\n"));
				return;
			}

			UWorld* World = GEditor->GetEditorWorldContext().World();
			if (!World)
			{
				SendResponse(BuildSelErrorResponse(CorrId, TEXT("no_world_open")) + TEXT("\n"));
				return;
			}

			// Apply bulk selection modes.
			if (Mode == TEXT("all"))
			{
				for (TActorIterator<AActor> It(World); It; ++It)
				{
					AActor* Actor = *It;
					if (Actor)
					{
						GEditor->SelectActor(Actor, /*bInSelected=*/true, /*bNotify=*/true, /*bSelectEvenIfHidden=*/false);
					}
				}
				GEditor->NoteSelectionChange();
			}
			else if (Mode == TEXT("none"))
			{
				GEditor->SelectNone(/*bNoteSelectionChange=*/true, /*bDeselectBSPSurfs=*/true);
			}
			else if (Mode == TEXT("invert"))
			{
				for (TActorIterator<AActor> It(World); It; ++It)
				{
					AActor* Actor = *It;
					if (Actor)
					{
						const bool bCurrentlySelected = Actor->IsSelected();
						GEditor->SelectActor(Actor, !bCurrentlySelected, /*bNotify=*/true, /*bSelectEvenIfHidden=*/false);
					}
				}
				GEditor->NoteSelectionChange();
			}
			// mode == "current": just read the existing selection without changes.

			// Build response from current selection.
			TArray<TSharedPtr<FJsonValue>> ActorsArray;

			USelection* Selection = GEditor->GetSelectedActors();
			if (Selection)
			{
				TArray<UObject*> SelectedObjects;
				Selection->GetSelectedObjects(AActor::StaticClass(), SelectedObjects);

				for (UObject* Obj : SelectedObjects)
				{
					AActor* Actor = Cast<AActor>(Obj);
					if (!Actor)
					{
						continue;
					}

					const FTransform& T = Actor->GetActorTransform();
					FVector Loc = T.GetLocation();
					FRotator Rot = T.GetRotation().Rotator();
					FVector Scale = T.GetScale3D();

					TSharedPtr<FJsonObject> LocObj = MakeShared<FJsonObject>();
					LocObj->SetNumberField(TEXT("x"), static_cast<double>(Loc.X));
					LocObj->SetNumberField(TEXT("y"), static_cast<double>(Loc.Y));
					LocObj->SetNumberField(TEXT("z"), static_cast<double>(Loc.Z));

					TSharedPtr<FJsonObject> RotObj = MakeShared<FJsonObject>();
					RotObj->SetNumberField(TEXT("pitch"), static_cast<double>(Rot.Pitch));
					RotObj->SetNumberField(TEXT("yaw"), static_cast<double>(Rot.Yaw));
					RotObj->SetNumberField(TEXT("roll"), static_cast<double>(Rot.Roll));

					TSharedPtr<FJsonObject> ScaleObj = MakeShared<FJsonObject>();
					ScaleObj->SetNumberField(TEXT("x"), static_cast<double>(Scale.X));
					ScaleObj->SetNumberField(TEXT("y"), static_cast<double>(Scale.Y));
					ScaleObj->SetNumberField(TEXT("z"), static_cast<double>(Scale.Z));

					TSharedPtr<FJsonObject> TransformObj = MakeShared<FJsonObject>();
					TransformObj->SetObjectField(TEXT("location"), LocObj);
					TransformObj->SetObjectField(TEXT("rotation"), RotObj);
					TransformObj->SetObjectField(TEXT("scale"), ScaleObj);

					TSharedPtr<FJsonObject> ActorObj = MakeShared<FJsonObject>();
					ActorObj->SetStringField(TEXT("label"), Actor->GetActorLabel());
					ActorObj->SetStringField(TEXT("class"), Actor->GetClass()->GetName());
					ActorObj->SetObjectField(TEXT("transform"), TransformObj);

					ActorsArray.Add(MakeShared<FJsonValueObject>(ActorObj));
				}
			}

			TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
			Data->SetStringField(TEXT("mode"), Mode);
			Data->SetNumberField(TEXT("count"), static_cast<double>(ActorsArray.Num()));
			Data->SetArrayField(TEXT("actors"), ActorsArray);

			SendResponse(BuildSelSuccessResponse(CorrId, Data) + TEXT("\n"));
		});
	});

	// -----------------------------------------------------------------------
	// selection.duplicate (SEL-03)
	// Duplicates all currently selected actors with an optional offset.
	//
	// Optional payload fields:
	//   offset -- object with x, y, z doubles (default: {x:100, y:0, z:0})
	//             Clamped to +/-1e7 to prevent floating point issues (T-19-02).
	//
	// Returns: duplicated_count and array of new actor labels, classes, locations.
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("selection.duplicate"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

		// Extract offset from payload.
		double OffsetX = 100.0;
		double OffsetY = 0.0;
		double OffsetZ = 0.0;

		const TSharedPtr<FJsonValue>* PayloadVal = Cmd->Values.Find(TEXT("payload"));
		if (PayloadVal && (*PayloadVal)->Type == EJson::Object)
		{
			TSharedPtr<FJsonObject> Payload = (*PayloadVal)->AsObject();
			const TSharedPtr<FJsonValue>* OffsetVal = Payload->Values.Find(TEXT("offset"));
			if (OffsetVal && (*OffsetVal)->Type == EJson::Object)
			{
				TSharedPtr<FJsonObject> OffsetObj = (*OffsetVal)->AsObject();
				OffsetObj->TryGetNumberField(TEXT("x"), OffsetX);
				OffsetObj->TryGetNumberField(TEXT("y"), OffsetY);
				OffsetObj->TryGetNumberField(TEXT("z"), OffsetZ);
			}
		}

		// Clamp offset values to prevent floating point issues (T-19-02).
		constexpr double MaxOffset = 1e7;
		OffsetX = FMath::Clamp(OffsetX, -MaxOffset, MaxOffset);
		OffsetY = FMath::Clamp(OffsetY, -MaxOffset, MaxOffset);
		OffsetZ = FMath::Clamp(OffsetZ, -MaxOffset, MaxOffset);

		const FVector Offset(OffsetX, OffsetY, OffsetZ);

		AsyncTask(ENamedThreads::GameThread, [CorrId, SendResponse, Offset]()
		{
			if (!GEditor)
			{
				SendResponse(BuildSelErrorResponse(CorrId, TEXT("editor_not_available")) + TEXT("\n"));
				return;
			}

			UWorld* World = GEditor->GetEditorWorldContext().World();
			if (!World)
			{
				SendResponse(BuildSelErrorResponse(CorrId, TEXT("no_world_open")) + TEXT("\n"));
				return;
			}

			// Collect currently selected actors.
			TArray<AActor*> SelectedActors;
			USelection* Selection = GEditor->GetSelectedActors();
			if (Selection)
			{
				TArray<UObject*> SelectedObjects;
				Selection->GetSelectedObjects(AActor::StaticClass(), SelectedObjects);
				for (UObject* Obj : SelectedObjects)
				{
					AActor* Actor = Cast<AActor>(Obj);
					if (Actor)
					{
						SelectedActors.Add(Actor);
					}
				}
			}

			if (SelectedActors.Num() == 0)
			{
				SendResponse(BuildSelErrorResponse(CorrId, TEXT("no_actors_selected")) + TEXT("\n"));
				return;
			}

			// Use UEditorActorSubsystem to duplicate actors.
			UEditorActorSubsystem* EditorActorSubsystem = GEditor->GetEditorSubsystem<UEditorActorSubsystem>();
			if (!EditorActorSubsystem)
			{
				SendResponse(BuildSelErrorResponse(CorrId, TEXT("editor_actor_subsystem_unavailable")) + TEXT("\n"));
				return;
			}

			TArray<AActor*> DuplicatedActors = EditorActorSubsystem->DuplicateActors(SelectedActors);

			TArray<TSharedPtr<FJsonValue>> DuplicatesArray;
			for (AActor* NewActor : DuplicatedActors)
			{
				if (!NewActor)
				{
					continue;
				}

				// Modify() before write operation.
				NewActor->Modify();

				// Apply offset.
				FVector NewLocation = NewActor->GetActorLocation() + Offset;
				NewActor->SetActorLocation(NewLocation);

				TSharedPtr<FJsonObject> LocObj = MakeShared<FJsonObject>();
				LocObj->SetNumberField(TEXT("x"), static_cast<double>(NewLocation.X));
				LocObj->SetNumberField(TEXT("y"), static_cast<double>(NewLocation.Y));
				LocObj->SetNumberField(TEXT("z"), static_cast<double>(NewLocation.Z));

				TSharedPtr<FJsonObject> ActorObj = MakeShared<FJsonObject>();
				ActorObj->SetStringField(TEXT("label"), NewActor->GetActorLabel());
				ActorObj->SetStringField(TEXT("class"), NewActor->GetClass()->GetName());
				ActorObj->SetObjectField(TEXT("location"), LocObj);

				DuplicatesArray.Add(MakeShared<FJsonValueObject>(ActorObj));
			}

			TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
			Data->SetNumberField(TEXT("duplicated_count"), static_cast<double>(DuplicatesArray.Num()));
			Data->SetArrayField(TEXT("actors"), DuplicatesArray);

			SendResponse(BuildSelSuccessResponse(CorrId, Data) + TEXT("\n"));
		});
	});

	// -----------------------------------------------------------------------
	// selection.convert (SEL-04)
	// Converts an actor to a different target class.
	//
	// Required payload fields:
	//   actor_label  -- string label of the actor to convert (validated T-19-04)
	//   target_class -- string class name, e.g. "StaticMeshActor" or
	//                   "Blueprint'/Game/BP_MyActor.BP_MyActor_C'"
	//                   (validated via FindObject/StaticLoadClass T-19-01)
	//
	// Returns: success, new_label, new_class, transform.
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("selection.convert"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

		// Extract payload.
		TSharedPtr<FJsonObject> Payload;
		const TSharedPtr<FJsonValue>* PayloadVal = Cmd->Values.Find(TEXT("payload"));
		if (PayloadVal && (*PayloadVal)->Type == EJson::Object)
		{
			Payload = (*PayloadVal)->AsObject();
		}

		FString ActorLabel;
		FString TargetClassName;
		if (!Payload.IsValid() ||
			!Payload->TryGetStringField(TEXT("actor_label"), ActorLabel) || ActorLabel.IsEmpty())
		{
			SendResponse(BuildSelErrorResponse(CorrId, TEXT("missing_actor_label")) + TEXT("\n"));
			return;
		}
		if (!Payload->TryGetStringField(TEXT("target_class"), TargetClassName) || TargetClassName.IsEmpty())
		{
			SendResponse(BuildSelErrorResponse(CorrId, TEXT("missing_target_class")) + TEXT("\n"));
			return;
		}

		AsyncTask(ENamedThreads::GameThread, [CorrId, SendResponse, ActorLabel, TargetClassName]()
		{
			if (!GEditor)
			{
				SendResponse(BuildSelErrorResponse(CorrId, TEXT("editor_not_available")) + TEXT("\n"));
				return;
			}

			UWorld* World = GEditor->GetEditorWorldContext().World();
			if (!World)
			{
				SendResponse(BuildSelErrorResponse(CorrId, TEXT("no_world_open")) + TEXT("\n"));
				return;
			}

			// Find the actor by label (T-19-04: validate actor exists).
			AActor* FoundActor = nullptr;
			for (TActorIterator<AActor> It(World); It; ++It)
			{
				if ((*It)->GetActorLabel() == ActorLabel)
				{
					FoundActor = *It;
					break;
				}
			}

			if (!FoundActor)
			{
				SendResponse(BuildSelErrorResponse(CorrId, TEXT("actor_not_found")) + TEXT("\n"));
				return;
			}

			// Resolve target class (T-19-01: validate target class before any actor operation).
			UClass* TargetClass = nullptr;
			if (TargetClassName.StartsWith(TEXT("/")) || TargetClassName.Contains(TEXT("Blueprint'")))
			{
				// Blueprint class path -- use StaticLoadClass.
				TargetClass = StaticLoadClass(AActor::StaticClass(), nullptr, *TargetClassName);
			}
			else
			{
				// Native class name -- search loaded classes.
				TargetClass = FindObject<UClass>(ANY_PACKAGE, *TargetClassName);
				if (!TargetClass)
				{
					// Try with the Actor suffix convention common in UE.
					FString WithPrefix = FString::Printf(TEXT("/Script/Engine.%s"), *TargetClassName);
					TargetClass = StaticLoadClass(AActor::StaticClass(), nullptr, *WithPrefix);
				}
			}

			if (!TargetClass)
			{
				SendResponse(BuildSelErrorResponse(CorrId, TEXT("target_class_not_found")) + TEXT("\n"));
				return;
			}

			// Validate target class is an actor class.
			if (!TargetClass->IsChildOf(AActor::StaticClass()))
			{
				SendResponse(BuildSelErrorResponse(CorrId, TEXT("target_class_not_actor_subclass")) + TEXT("\n"));
				return;
			}

			// Capture transform before conversion.
			FTransform ActorTransform = FoundActor->GetActorTransform();
			FVector Loc = ActorTransform.GetLocation();
			FRotator Rot = ActorTransform.GetRotation().Rotator();
			FVector Scale = ActorTransform.GetScale3D();

			// Modify() before conversion write.
			FoundActor->Modify();

			// Use GEditor->ConvertActors to perform the conversion.
			TArray<AActor*> ActorsToConvert;
			ActorsToConvert.Add(FoundActor);

			// ConvertActors signature: ConvertActors(const TArray<AActor*>&, UClass*, const TSet<FString>&, bool)
			// The third parameter is a set of property names to preserve; pass empty set for default behavior.
			TSet<FString> PropertyNamesToPreserve;
			GEditor->ConvertActors(ActorsToConvert, TargetClass, PropertyNamesToPreserve, /*bUseStandardTransfer=*/true);

			// Find the newly converted actor at the same location.
			// ConvertActors destroys the original and spawns the new actor at the same transform.
			// We locate it by searching for the target class at the original location.
			AActor* NewActor = nullptr;
			float BestDist = FLT_MAX;
			for (TActorIterator<AActor> It(World); It; ++It)
			{
				AActor* Candidate = *It;
				if (!Candidate || !Candidate->IsA(TargetClass))
				{
					continue;
				}
				float Dist = static_cast<float>(FVector::Dist(Candidate->GetActorLocation(), Loc));
				if (Dist < BestDist)
				{
					BestDist = Dist;
					NewActor = Candidate;
				}
			}

			TSharedPtr<FJsonObject> LocObj = MakeShared<FJsonObject>();
			LocObj->SetNumberField(TEXT("x"), static_cast<double>(Loc.X));
			LocObj->SetNumberField(TEXT("y"), static_cast<double>(Loc.Y));
			LocObj->SetNumberField(TEXT("z"), static_cast<double>(Loc.Z));

			TSharedPtr<FJsonObject> RotObj = MakeShared<FJsonObject>();
			RotObj->SetNumberField(TEXT("pitch"), static_cast<double>(Rot.Pitch));
			RotObj->SetNumberField(TEXT("yaw"), static_cast<double>(Rot.Yaw));
			RotObj->SetNumberField(TEXT("roll"), static_cast<double>(Rot.Roll));

			TSharedPtr<FJsonObject> ScaleObj = MakeShared<FJsonObject>();
			ScaleObj->SetNumberField(TEXT("x"), static_cast<double>(Scale.X));
			ScaleObj->SetNumberField(TEXT("y"), static_cast<double>(Scale.Y));
			ScaleObj->SetNumberField(TEXT("z"), static_cast<double>(Scale.Z));

			TSharedPtr<FJsonObject> TransformObj = MakeShared<FJsonObject>();
			TransformObj->SetObjectField(TEXT("location"), LocObj);
			TransformObj->SetObjectField(TEXT("rotation"), RotObj);
			TransformObj->SetObjectField(TEXT("scale"), ScaleObj);

			TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
			Data->SetStringField(TEXT("original_label"), ActorLabel);
			Data->SetStringField(TEXT("new_label"), NewActor ? NewActor->GetActorLabel() : ActorLabel);
			Data->SetStringField(TEXT("new_class"), TargetClass->GetName());
			Data->SetObjectField(TEXT("transform"), TransformObj);

			SendResponse(BuildSelSuccessResponse(CorrId, Data) + TEXT("\n"));
		});
	});
}
