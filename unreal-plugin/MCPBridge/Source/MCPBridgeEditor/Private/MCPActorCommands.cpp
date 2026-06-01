// MCPActorCommands.cpp
// Implements four actor command handlers for the MCP bridge:
//   actor.list    -- enumerate all actors in the open level
//   actor.spawn   -- spawn an actor by class name at a given location
//   actor.transform -- move/rotate/scale an actor by label
//   actor.delete  -- remove an actor from the level
//
// All handlers run on the game thread (guaranteed by FMCPCommandRouter::Dispatch).
// actor.transform and actor.delete call Actor->Modify() before any state change
// to ensure UE undo/redo history is recorded correctly (Pitfall 5).

#include "MCPActorCommands.h"

#include "Editor.h"
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
static FString BuildActorSuccessResponse(const FString& CorrId, TSharedPtr<FJsonObject> Data)
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
static FString BuildActorErrorResponse(const FString& CorrId, const FString& Error)
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
// RegisterActorCommands
// ---------------------------------------------------------------------------

void RegisterActorCommands(FMCPCommandRouter& Router)
{
	// -----------------------------------------------------------------------
	// actor.list
	// Enumerates all placed actors in the open level (skips Unreal internal
	// "Default_*" actors).  Returns label, class, id, location, rotation, scale.
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("actor.list"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

		UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
		if (!World)
		{
			SendResponse(BuildActorErrorResponse(CorrId, TEXT("no_world_open")) + TEXT("\n"));
			return;
		}

		TArray<TSharedPtr<FJsonValue>> ActorsArray;

		for (TActorIterator<AActor> It(World); It; ++It)
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

			const FVector  L = Actor->GetActorLocation();
			const FRotator R = Actor->GetActorRotation();
			const FVector  S = Actor->GetActorScale3D();

			// Build location object.
			TSharedPtr<FJsonObject> LocObj = MakeShared<FJsonObject>();
			LocObj->SetNumberField(TEXT("x"), L.X);
			LocObj->SetNumberField(TEXT("y"), L.Y);
			LocObj->SetNumberField(TEXT("z"), L.Z);

			// Build rotation object.
			TSharedPtr<FJsonObject> RotObj = MakeShared<FJsonObject>();
			RotObj->SetNumberField(TEXT("pitch"), R.Pitch);
			RotObj->SetNumberField(TEXT("yaw"),   R.Yaw);
			RotObj->SetNumberField(TEXT("roll"),  R.Roll);

			// Build scale object.
			TSharedPtr<FJsonObject> ScaleObj = MakeShared<FJsonObject>();
			ScaleObj->SetNumberField(TEXT("x"), S.X);
			ScaleObj->SetNumberField(TEXT("y"), S.Y);
			ScaleObj->SetNumberField(TEXT("z"), S.Z);

			TSharedPtr<FJsonObject> ActorObj = MakeShared<FJsonObject>();
			ActorObj->SetStringField(TEXT("label"), Actor->GetActorLabel());
			ActorObj->SetStringField(TEXT("class"), Actor->GetClass()->GetName());
			ActorObj->SetStringField(TEXT("id"),    Actor->GetName());
			ActorObj->SetObjectField(TEXT("location"), LocObj);
			ActorObj->SetObjectField(TEXT("rotation"), RotObj);
			ActorObj->SetObjectField(TEXT("scale"),    ScaleObj);

			ActorsArray.Add(MakeShared<FJsonValueObject>(ActorObj));
		}

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetArrayField(TEXT("actors"), ActorsArray);
		Data->SetNumberField(TEXT("count"), static_cast<double>(ActorsArray.Num()));

		SendResponse(BuildActorSuccessResponse(CorrId, Data) + TEXT("\n"));
	});

	// -----------------------------------------------------------------------
	// actor.spawn
	// Creates an actor of a given class at the specified location.
	// Validates the class exists and derives from AActor before spawning.
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("actor.spawn"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

		// Extract payload object.
		TSharedPtr<FJsonObject> Payload;
		const TSharedPtr<FJsonValue>* PayloadVal = Cmd->Values.Find(TEXT("payload"));
		if (PayloadVal && (*PayloadVal)->Type == EJson::Object)
		{
			Payload = (*PayloadVal)->AsObject();
		}

		FString ClassName;
		if (!Payload.IsValid() || !Payload->TryGetStringField(TEXT("class_name"), ClassName) || ClassName.IsEmpty())
		{
			SendResponse(BuildActorErrorResponse(CorrId, TEXT("missing_class_name")) + TEXT("\n"));
			return;
		}

		// Extract optional location (defaults to origin).
		double X = 0.0, Y = 0.0, Z = 0.0;
		{
			const TSharedPtr<FJsonObject>* LocObj;
			if (Payload.IsValid() && Payload->TryGetObjectField(TEXT("location"), LocObj))
			{
				(*LocObj)->TryGetNumberField(TEXT("x"), X);
				(*LocObj)->TryGetNumberField(TEXT("y"), Y);
				(*LocObj)->TryGetNumberField(TEXT("z"), Z);
			}
		}

		UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
		if (!World)
		{
			SendResponse(BuildActorErrorResponse(CorrId, TEXT("no_world_open")) + TEXT("\n"));
			return;
		}

		// Find actor class by name; try exact name then A-prefixed name.
		UClass* ActorClass = FindFirstObject<UClass>( *ClassName);
		if (!ActorClass)
		{
			ActorClass = FindFirstObject<UClass>( *(TEXT("A") + ClassName));
		}
		if (!ActorClass)
		{
			SendResponse(BuildActorErrorResponse(CorrId, TEXT("class_not_found")) + TEXT("\n"));
			return;
		}

		// Validate the resolved class is an AActor subclass (T-09-01).
		if (!ActorClass->IsChildOf(AActor::StaticClass()))
		{
			SendResponse(BuildActorErrorResponse(CorrId, TEXT("not_an_actor_class")) + TEXT("\n"));
			return;
		}

		FActorSpawnParameters Params;
		Params.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;

		const FVector   Location(X, Y, Z);
		const FRotator  Rotation(0.0, 0.0, 0.0);

		// Optional label — applied AFTER spawn via SetActorLabel().
		// Do NOT set Params.Name — UE's name-uniqueness check can fatal-error
		// when the requested FName collides with internal naming patterns.
		FString Label;
		Payload->TryGetStringField(TEXT("label"), Label);

		AActor* Spawned = World->SpawnActor<AActor>(ActorClass, Location, Rotation, Params);
		if (!Spawned)
		{
			SendResponse(BuildActorErrorResponse(CorrId, TEXT("spawn_failed")) + TEXT("\n"));
			return;
		}

		// Apply explicit label if provided (overrides auto-generated label).
		if (!Label.IsEmpty())
		{
			Spawned->SetActorLabel(Label);
		}

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetStringField(TEXT("label"), Spawned->GetActorLabel());
		Data->SetStringField(TEXT("id"),    Spawned->GetName());
		Data->SetStringField(TEXT("class"), ClassName);

		SendResponse(BuildActorSuccessResponse(CorrId, Data) + TEXT("\n"));
	});

	// -----------------------------------------------------------------------
	// actor.transform
	// Moves/rotates/scales an existing actor located by its display label.
	// Calls Actor->Modify() before any change to record the operation in the
	// UE undo stack (Pitfall 5: missing Modify() causes silent data loss).
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("actor.transform"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
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
		if (!Payload.IsValid() || !Payload->TryGetStringField(TEXT("actor_label"), ActorLabel) || ActorLabel.IsEmpty())
		{
			SendResponse(BuildActorErrorResponse(CorrId, TEXT("missing_actor_label")) + TEXT("\n"));
			return;
		}

		UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
		if (!World)
		{
			SendResponse(BuildActorErrorResponse(CorrId, TEXT("no_world_open")) + TEXT("\n"));
			return;
		}

		// Find actor by display label.
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
			SendResponse(BuildActorErrorResponse(CorrId, TEXT("actor_not_found")) + TEXT("\n"));
			return;
		}

		// Mark the actor for modification BEFORE any property change (Pitfall 5).
		TargetActor->Modify();

		// Track which fields were applied for the response.
		TSharedPtr<FJsonObject> Applied = MakeShared<FJsonObject>();

		// Apply location if provided.
		{
			const TSharedPtr<FJsonObject>* LocObj;
			if (Payload->TryGetObjectField(TEXT("location"), LocObj))
			{
				double X = 0.0, Y = 0.0, Z = 0.0;
				(*LocObj)->TryGetNumberField(TEXT("x"), X);
				(*LocObj)->TryGetNumberField(TEXT("y"), Y);
				(*LocObj)->TryGetNumberField(TEXT("z"), Z);

				TargetActor->SetActorLocation(FVector(X, Y, Z), false, nullptr, ETeleportType::TeleportPhysics);

				TSharedPtr<FJsonObject> AppliedLoc = MakeShared<FJsonObject>();
				AppliedLoc->SetNumberField(TEXT("x"), X);
				AppliedLoc->SetNumberField(TEXT("y"), Y);
				AppliedLoc->SetNumberField(TEXT("z"), Z);
				Applied->SetObjectField(TEXT("location"), AppliedLoc);
			}
		}

		// Apply rotation if provided.
		{
			const TSharedPtr<FJsonObject>* RotObj;
			if (Payload->TryGetObjectField(TEXT("rotation"), RotObj))
			{
				double Pitch = 0.0, Yaw = 0.0, Roll = 0.0;
				(*RotObj)->TryGetNumberField(TEXT("pitch"), Pitch);
				(*RotObj)->TryGetNumberField(TEXT("yaw"),   Yaw);
				(*RotObj)->TryGetNumberField(TEXT("roll"),  Roll);

				TargetActor->SetActorRotation(FRotator(Pitch, Yaw, Roll), ETeleportType::TeleportPhysics);

				TSharedPtr<FJsonObject> AppliedRot = MakeShared<FJsonObject>();
				AppliedRot->SetNumberField(TEXT("pitch"), Pitch);
				AppliedRot->SetNumberField(TEXT("yaw"),   Yaw);
				AppliedRot->SetNumberField(TEXT("roll"),  Roll);
				Applied->SetObjectField(TEXT("rotation"), AppliedRot);
			}
		}

		// Apply scale if provided.
		{
			const TSharedPtr<FJsonObject>* ScaleObj;
			if (Payload->TryGetObjectField(TEXT("scale"), ScaleObj))
			{
				double X = 1.0, Y = 1.0, Z = 1.0;
				(*ScaleObj)->TryGetNumberField(TEXT("x"), X);
				(*ScaleObj)->TryGetNumberField(TEXT("y"), Y);
				(*ScaleObj)->TryGetNumberField(TEXT("z"), Z);

				TargetActor->SetActorScale3D(FVector(X, Y, Z));

				TSharedPtr<FJsonObject> AppliedScale = MakeShared<FJsonObject>();
				AppliedScale->SetNumberField(TEXT("x"), X);
				AppliedScale->SetNumberField(TEXT("y"), Y);
				AppliedScale->SetNumberField(TEXT("z"), Z);
				Applied->SetObjectField(TEXT("scale"), AppliedScale);
			}
		}

		// Mark the level package dirty so Unreal knows it needs saving.
		if (TargetActor->GetLevel())
		{
			TargetActor->GetLevel()->MarkPackageDirty();
		}

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetStringField(TEXT("label"), ActorLabel);
		Data->SetObjectField(TEXT("applied"), Applied);

		SendResponse(BuildActorSuccessResponse(CorrId, Data) + TEXT("\n"));
	});

	// -----------------------------------------------------------------------
	// actor.delete
	// Removes an actor from the level by its display label.
	// Calls Actor->Modify() before destruction to record the deletion in the
	// UE undo stack (Pitfall 5).  DestroyActor returns false for indestructible
	// actors (T-09-03: that error is returned to the caller).
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("actor.delete"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
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
		if (!Payload.IsValid() || !Payload->TryGetStringField(TEXT("actor_label"), ActorLabel) || ActorLabel.IsEmpty())
		{
			SendResponse(BuildActorErrorResponse(CorrId, TEXT("missing_actor_label")) + TEXT("\n"));
			return;
		}

		UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
		if (!World)
		{
			SendResponse(BuildActorErrorResponse(CorrId, TEXT("no_world_open")) + TEXT("\n"));
			return;
		}

		// Find actor by display label.
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
			SendResponse(BuildActorErrorResponse(CorrId, TEXT("actor_not_found")) + TEXT("\n"));
			return;
		}

		// Mark the actor for modification BEFORE destruction (Pitfall 5).
		TargetActor->Modify();

		// DestroyActor: bNetForce=false, bShouldModifyLevel=true (marks level dirty).
		const bool bDestroyed = World->DestroyActor(TargetActor, false, true);
		if (!bDestroyed)
		{
			// Indestructible actor -- return structured error (T-09-03).
			SendResponse(BuildActorErrorResponse(CorrId, TEXT("destroy_failed")) + TEXT("\n"));
			return;
		}

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetStringField(TEXT("label"), ActorLabel);
		Data->SetBoolField(TEXT("destroyed"), true);

		SendResponse(BuildActorSuccessResponse(CorrId, Data) + TEXT("\n"));
	});

	// -----------------------------------------------------------------------
	// actor.setProperty
	// Sets a UPROPERTY on an actor by label.  Supports:
	//   - Primitive types: bool, int, float, FString, FName, FText
	//   - Actor references: resolved by actor label in the current world
	//   - Asset references: resolved by UE asset path (e.g. /Game/Data/DA_Key)
	// Payload: { actor_label, property_name, value, value_type }
	// value_type: "bool"|"int"|"float"|"string"|"name"|"text"|"actor"|"asset"
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("actor.setProperty"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

		TSharedPtr<FJsonObject> Payload;
		const TSharedPtr<FJsonValue>* PayloadVal = Cmd->Values.Find(TEXT("payload"));
		if (PayloadVal && (*PayloadVal)->Type == EJson::Object)
		{
			Payload = (*PayloadVal)->AsObject();
		}

		FString ActorLabel, PropertyName, ValueType;
		if (!Payload.IsValid()
			|| !Payload->TryGetStringField(TEXT("actor_label"), ActorLabel)  || ActorLabel.IsEmpty()
			|| !Payload->TryGetStringField(TEXT("property_name"), PropertyName) || PropertyName.IsEmpty()
			|| !Payload->TryGetStringField(TEXT("value_type"), ValueType) || ValueType.IsEmpty())
		{
			SendResponse(BuildActorErrorResponse(CorrId, TEXT("missing_required_fields")) + TEXT("\n"));
			return;
		}

		UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
		if (!World)
		{
			SendResponse(BuildActorErrorResponse(CorrId, TEXT("no_world_open")) + TEXT("\n"));
			return;
		}

		// Find target actor by label.
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
			SendResponse(BuildActorErrorResponse(CorrId, TEXT("actor_not_found")) + TEXT("\n"));
			return;
		}

		// Find the UPROPERTY by name on the actor's class.
		FProperty* Prop = TargetActor->GetClass()->FindPropertyByName(FName(*PropertyName));
		if (!Prop)
		{
			SendResponse(BuildActorErrorResponse(CorrId, TEXT("property_not_found")) + TEXT("\n"));
			return;
		}

		TargetActor->Modify();
		void* ValuePtr = Prop->ContainerPtrToValuePtr<void>(TargetActor);

		if (ValueType == TEXT("bool"))
		{
			bool bVal = false;
			Payload->TryGetBoolField(TEXT("value"), bVal);
			if (FBoolProperty* BoolProp = CastField<FBoolProperty>(Prop))
			{
				BoolProp->SetPropertyValue(ValuePtr, bVal);
			}
		}
		else if (ValueType == TEXT("int"))
		{
			int32 IntVal = 0;
			Payload->TryGetNumberField(TEXT("value"), *(double*)&IntVal);
			double Dbl = 0;
			Payload->TryGetNumberField(TEXT("value"), Dbl);
			IntVal = static_cast<int32>(Dbl);
			if (FIntProperty* IntProp = CastField<FIntProperty>(Prop))
			{
				IntProp->SetPropertyValue(ValuePtr, IntVal);
			}
		}
		else if (ValueType == TEXT("float"))
		{
			double Dbl = 0.0;
			Payload->TryGetNumberField(TEXT("value"), Dbl);
			if (FFloatProperty* FloatProp = CastField<FFloatProperty>(Prop))
			{
				FloatProp->SetPropertyValue(ValuePtr, static_cast<float>(Dbl));
			}
			else if (FDoubleProperty* DoubleProp = CastField<FDoubleProperty>(Prop))
			{
				DoubleProp->SetPropertyValue(ValuePtr, Dbl);
			}
		}
		else if (ValueType == TEXT("string"))
		{
			FString StrVal;
			Payload->TryGetStringField(TEXT("value"), StrVal);
			if (FStrProperty* StrProp = CastField<FStrProperty>(Prop))
			{
				StrProp->SetPropertyValue(ValuePtr, StrVal);
			}
		}
		else if (ValueType == TEXT("name"))
		{
			FString StrVal;
			Payload->TryGetStringField(TEXT("value"), StrVal);
			if (FNameProperty* NameProp = CastField<FNameProperty>(Prop))
			{
				NameProp->SetPropertyValue(ValuePtr, FName(*StrVal));
			}
		}
		else if (ValueType == TEXT("text"))
		{
			FString StrVal;
			Payload->TryGetStringField(TEXT("value"), StrVal);
			if (FTextProperty* TextProp = CastField<FTextProperty>(Prop))
			{
				TextProp->SetPropertyValue(ValuePtr, FText::FromString(StrVal));
			}
		}
		else if (ValueType == TEXT("actor"))
		{
			// value is the label of another actor in the world.
			FString RefLabel;
			Payload->TryGetStringField(TEXT("value"), RefLabel);
			AActor* RefActor = nullptr;
			for (TActorIterator<AActor> It(World); It; ++It)
			{
				if ((*It)->GetActorLabel() == RefLabel)
				{
					RefActor = *It;
					break;
				}
			}
			FObjectProperty* ObjProp = CastField<FObjectProperty>(Prop);
			if (ObjProp)
			{
				ObjProp->SetObjectPropertyValue(ValuePtr, RefActor);
			}
		}
		else if (ValueType == TEXT("asset"))
		{
			// value is an asset path, e.g. /Game/Data/DA_ValveHandle
			FString AssetPath;
			Payload->TryGetStringField(TEXT("value"), AssetPath);
			UObject* Asset = LoadObject<UObject>(nullptr, *AssetPath);
			if (!Asset)
			{
				SendResponse(BuildActorErrorResponse(CorrId, TEXT("asset_not_found")) + TEXT("\n"));
				return;
			}
			FObjectProperty* ObjProp = CastField<FObjectProperty>(Prop);
			if (ObjProp)
			{
				ObjProp->SetObjectPropertyValue(ValuePtr, Asset);
			}
		}
		else
		{
			SendResponse(BuildActorErrorResponse(CorrId, TEXT("unsupported_value_type")) + TEXT("\n"));
			return;
		}

		// Mark level dirty.
		if (TargetActor->GetLevel())
		{
			TargetActor->GetLevel()->MarkPackageDirty();
		}

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetStringField(TEXT("label"), ActorLabel);
		Data->SetStringField(TEXT("property"), PropertyName);
		Data->SetStringField(TEXT("value_type"), ValueType);
		Data->SetBoolField(TEXT("applied"), true);

		SendResponse(BuildActorSuccessResponse(CorrId, Data) + TEXT("\n"));
	});
}
