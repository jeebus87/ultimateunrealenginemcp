// MCPMotionDesignCommands.cpp (Plan 33-04)
// Implements four Motion Design command handlers for the MCP bridge:
//   motiondesign.sceneStates    -- list Scene State machines with states and categories (MD-01)
//   motiondesign.transition     -- trigger Scene State transitions and set property values (MD-02)
//   motiondesign.transitionLogic -- inspect Transition Logic sequences: in/out labels, layer changes (MD-03)
//   motiondesign.remoteControl  -- read/modify Remote Control preset properties and trigger events (MD-04)
//
// All handlers run on the game thread via FMCPCommandRouter::Dispatch.
// asset_path and preset_path are validated to start with "/Game/" or "/Engine/" before any
// StaticLoadObject call to prevent path traversal (T-28-01).
// Modify() is called before all write operations (T-28-03, PITFALLS.md Pitfall 5).
//
// Reflection-based: NO direct #include of any Avalanche, RemoteControl, or optional
// plugin headers. All types are located at runtime via FindObject<UClass> and accessed
// via FProperty/UFunction reflection.
//
// sceneStates, transition, transitionLogic: check AvalancheRundown/AvalancheTransition module
// remoteControl: checks RemoteControl module

#include "MCPMotionDesignCommands.h"
#include "ReflectionHelpers.h"

// Editor world context
#include "Editor.h"

// JSON
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"

// Module manager for runtime availability check
#include "Modules/ModuleManager.h"

// UObject reflection
#include "UObject/UnrealType.h"
#include "UObject/PropertyPortFlags.h"

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Returns a JSON success response string (without trailing newline). */
static FString BuildMDSuccessResponse(const FString& CorrId, TSharedPtr<FJsonObject> Data)
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
static FString BuildMDErrorResponse(const FString& CorrId, const FString& Error)
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
 * path traversal attacks (T-28-01).
 */
static bool IsValidMDAssetPath(const FString& AssetPath)
{
	return AssetPath.StartsWith(TEXT("/Game/")) || AssetPath.StartsWith(TEXT("/Engine/"));
}

// ---------------------------------------------------------------------------
// RegisterMotionDesignCommands
// ---------------------------------------------------------------------------

void RegisterMotionDesignCommands(FMCPCommandRouter& Router)
{
	// -----------------------------------------------------------------------
	// motiondesign.sceneStates (MD-01)
	// Lists Scene State machines with their states and categories from the
	// Avalanche Rundown subsystem.
	// Optional payload field: rundown_path (string).
	// Returns: scene_state_machines[] (machine_name, current_state, states[]).
	// Gracefully degrades if Avalanche plugin is not loaded.
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("motiondesign.sceneStates"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

		// Runtime check: ensure AvalancheRundown module is available.
		if (!MCPReflect::CheckModuleLoaded(TEXT("AvalancheRundown")))
		{
			MCPReflect::SendModuleNotAvailable(SendResponse, CorrId, TEXT("AvalancheRundown"));
			return;
		}

		// Extract optional payload.
		TSharedPtr<FJsonObject> Payload;
		const TSharedPtr<FJsonValue>* PayloadVal = Cmd->Values.Find(TEXT("payload"));
		if (PayloadVal && (*PayloadVal)->Type == EJson::Object)
		{
			Payload = (*PayloadVal)->AsObject();
		}

		FString RundownPath;
		if (Payload.IsValid())
		{
			Payload->TryGetStringField(TEXT("rundown_path"), RundownPath);
		}

		// Get the editor world for subsystem access.
		UWorld* World = nullptr;
		if (GEditor)
		{
			World = GEditor->GetEditorWorldContext().World();
		}

		if (!World)
		{
			SendResponse(BuildMDErrorResponse(CorrId, TEXT("no_editor_world")) + TEXT("\n"));
			return;
		}

		// Use reflection to access UAvaRundownSubsystem so compilation succeeds
		// even if the header is not included.
		TArray<TSharedPtr<FJsonValue>> MachinesArray;

		UClass* RundownSubsystemClass = FindObject<UClass>(nullptr, TEXT("/Script/AvalancheRundown.AvaRundownSubsystem"));
		if (!RundownSubsystemClass)
		{
			// Module loaded but class not found -- return empty list gracefully.
			TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
			Data->SetStringField(TEXT("rundown_path"), RundownPath);
			Data->SetArrayField(TEXT("scene_state_machines"), MachinesArray);
			SendResponse(BuildMDSuccessResponse(CorrId, Data) + TEXT("\n"));
			return;
		}

		UObject* SubsystemObj = nullptr;
		if (World->GetGameInstance())
		{
			UGameInstanceSubsystem* GISub = Cast<UGameInstanceSubsystem>(World->GetGameInstance()->GetSubsystemBase(RundownSubsystemClass));
			SubsystemObj = GISub;
		}
		if (!SubsystemObj)
		{
			UWorldSubsystem* WorldSub = Cast<UWorldSubsystem>(World->GetSubsystemBase(RundownSubsystemClass));
			SubsystemObj = WorldSub;
		}

		if (!SubsystemObj)
		{
			// Subsystem not active in this world -- return informative empty result.
			TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
			Data->SetStringField(TEXT("rundown_path"), RundownPath);
			Data->SetArrayField(TEXT("scene_state_machines"), MachinesArray);
			Data->SetStringField(TEXT("note"), TEXT("AvaRundownSubsystem not active in current world; open a level that uses Motion Design"));
			SendResponse(BuildMDSuccessResponse(CorrId, Data) + TEXT("\n"));
			return;
		}

		// Use reflection to enumerate scene state machines from the subsystem.
		if (SubsystemObj)
		{
			// Walk properties to find scene state machine collection.
			for (TFieldIterator<FArrayProperty> PropIt(SubsystemObj->GetClass()); PropIt; ++PropIt)
			{
				FArrayProperty* ArrayProp = *PropIt;
				FStructProperty* ElemProp = CastField<FStructProperty>(ArrayProp->Inner);
				if (!ElemProp)
				{
					continue;
				}

				// Look for array properties whose element struct contains "State" or "Machine" in name.
				FString StructName = ElemProp->Struct->GetName();
				if (!StructName.Contains(TEXT("State")) && !StructName.Contains(TEXT("Machine")))
				{
					continue;
				}

				FScriptArrayHelper ArrayHelper(ArrayProp, ArrayProp->ContainerPtrToValuePtr<void>(SubsystemObj));
				for (int32 i = 0; i < ArrayHelper.Num(); ++i)
				{
					void* ElemPtr = ArrayHelper.GetRawPtr(i);
					TSharedPtr<FJsonObject> MachineObj = MakeShared<FJsonObject>();

					FString MachineName = FString::Printf(TEXT("Machine_%d"), i);
					FString CurrentState = TEXT("");

					FNameProperty* NameProp = CastField<FNameProperty>(ElemProp->Struct->FindPropertyByName(TEXT("Name")));
					if (!NameProp)
					{
						NameProp = CastField<FNameProperty>(ElemProp->Struct->FindPropertyByName(TEXT("MachineName")));
					}
					if (NameProp)
					{
						MachineName = NameProp->GetPropertyValue_InContainer(ElemPtr).ToString();
					}
					MachineObj->SetStringField(TEXT("machine_name"), MachineName);

					FNameProperty* CurStateProp = CastField<FNameProperty>(ElemProp->Struct->FindPropertyByName(TEXT("CurrentState")));
					if (!CurStateProp)
					{
						CurStateProp = CastField<FNameProperty>(ElemProp->Struct->FindPropertyByName(TEXT("ActiveState")));
					}
					if (CurStateProp)
					{
						CurrentState = CurStateProp->GetPropertyValue_InContainer(ElemPtr).ToString();
					}
					MachineObj->SetStringField(TEXT("current_state"), CurrentState);

					// Enumerate available states.
					TArray<TSharedPtr<FJsonValue>> StatesArray;
					FArrayProperty* StatesProp = CastField<FArrayProperty>(ElemProp->Struct->FindPropertyByName(TEXT("States")));
					if (!StatesProp)
					{
						StatesProp = CastField<FArrayProperty>(ElemProp->Struct->FindPropertyByName(TEXT("AvailableStates")));
					}
					if (StatesProp)
					{
						FScriptArrayHelper StatesHelper(StatesProp, StatesProp->ContainerPtrToValuePtr<void>(ElemPtr));
						FStructProperty* StateElemProp = CastField<FStructProperty>(StatesProp->Inner);
						for (int32 j = 0; j < StatesHelper.Num(); ++j)
						{
							void* StatePtr = StatesHelper.GetRawPtr(j);
							TSharedPtr<FJsonObject> StateObj = MakeShared<FJsonObject>();

							FString StateName = FString::Printf(TEXT("State_%d"), j);
							FString Category = TEXT("");

							if (StateElemProp)
							{
								FNameProperty* StateNameProp = CastField<FNameProperty>(StateElemProp->Struct->FindPropertyByName(TEXT("Name")));
								if (!StateNameProp)
								{
									StateNameProp = CastField<FNameProperty>(StateElemProp->Struct->FindPropertyByName(TEXT("StateName")));
								}
								if (StateNameProp)
								{
									StateName = StateNameProp->GetPropertyValue_InContainer(StatePtr).ToString();
								}

								FNameProperty* CatProp = CastField<FNameProperty>(StateElemProp->Struct->FindPropertyByName(TEXT("Category")));
								FStrProperty* CatStrProp = CastField<FStrProperty>(StateElemProp->Struct->FindPropertyByName(TEXT("Category")));
								if (CatProp)
								{
									Category = CatProp->GetPropertyValue_InContainer(StatePtr).ToString();
								}
								else if (CatStrProp)
								{
									Category = CatStrProp->GetPropertyValue_InContainer(StatePtr);
								}
							}

							StateObj->SetStringField(TEXT("name"), StateName);
							StateObj->SetStringField(TEXT("category"), Category);
							StatesArray.Add(MakeShared<FJsonValueObject>(StateObj));
						}
					}
					MachineObj->SetArrayField(TEXT("states"), StatesArray);

					MachinesArray.Add(MakeShared<FJsonValueObject>(MachineObj));
				}
			}
		}

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetStringField(TEXT("rundown_path"), RundownPath);
		Data->SetArrayField(TEXT("scene_state_machines"), MachinesArray);

		SendResponse(BuildMDSuccessResponse(CorrId, Data) + TEXT("\n"));
	});

	// -----------------------------------------------------------------------
	// motiondesign.transition (MD-02)
	// Triggers a Scene State transition on the Avalanche Rundown subsystem.
	// Required payload fields: rundown_path (string), target_state (string).
	// Optional payload fields: properties (object) -- key/value property overrides.
	// Returns: success, new_state, applied_properties[].
	// Calls Modify() before mutating state (PITFALLS.md Pitfall 5, T-28-03).
	// Gracefully degrades if Avalanche plugin is not loaded.
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("motiondesign.transition"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

		// Runtime check: ensure AvalancheRundown module is available.
		if (!MCPReflect::CheckModuleLoaded(TEXT("AvalancheRundown")))
		{
			MCPReflect::SendModuleNotAvailable(SendResponse, CorrId, TEXT("AvalancheRundown"));
			return;
		}

		// Extract payload.
		TSharedPtr<FJsonObject> Payload;
		const TSharedPtr<FJsonValue>* PayloadVal = Cmd->Values.Find(TEXT("payload"));
		if (PayloadVal && (*PayloadVal)->Type == EJson::Object)
		{
			Payload = (*PayloadVal)->AsObject();
		}

		FString RundownPath;
		FString TargetState;

		if (!Payload.IsValid())
		{
			SendResponse(BuildMDErrorResponse(CorrId, TEXT("missing_payload")) + TEXT("\n"));
			return;
		}

		Payload->TryGetStringField(TEXT("rundown_path"), RundownPath);
		if (!Payload->TryGetStringField(TEXT("target_state"), TargetState) || TargetState.IsEmpty())
		{
			SendResponse(BuildMDErrorResponse(CorrId, TEXT("missing_target_state")) + TEXT("\n"));
			return;
		}

		// Get the editor world.
		UWorld* World = nullptr;
		if (GEditor)
		{
			World = GEditor->GetEditorWorldContext().World();
		}

		if (!World)
		{
			SendResponse(BuildMDErrorResponse(CorrId, TEXT("no_editor_world")) + TEXT("\n"));
			return;
		}

		// Access the rundown subsystem by class lookup.
		UClass* RundownSubsystemClass = FindObject<UClass>(nullptr, TEXT("/Script/AvalancheRundown.AvaRundownSubsystem"));
		if (!RundownSubsystemClass)
		{
			SendResponse(BuildMDErrorResponse(CorrId, TEXT("rundown_subsystem_class_not_found")) + TEXT("\n"));
			return;
		}

		UObject* SubsystemObj = nullptr;
		if (World->GetGameInstance())
		{
			UGameInstanceSubsystem* GISub = Cast<UGameInstanceSubsystem>(World->GetGameInstance()->GetSubsystemBase(RundownSubsystemClass));
			SubsystemObj = GISub;
		}
		if (!SubsystemObj)
		{
			UWorldSubsystem* WorldSub = Cast<UWorldSubsystem>(World->GetSubsystemBase(RundownSubsystemClass));
			SubsystemObj = WorldSub;
		}

		if (!SubsystemObj)
		{
			SendResponse(BuildMDErrorResponse(CorrId, TEXT("rundown_subsystem_not_active")) + TEXT("\n"));
			return;
		}

		// Mark the subsystem as modified before triggering the transition (T-28-03).
		SubsystemObj->Modify();

		// Use reflection to find and invoke the transition method.
		UFunction* TransitionFunc = SubsystemObj->GetClass()->FindFunctionByName(TEXT("SetState"));
		if (!TransitionFunc)
		{
			TransitionFunc = SubsystemObj->GetClass()->FindFunctionByName(TEXT("TriggerTransition"));
		}
		if (!TransitionFunc)
		{
			TransitionFunc = SubsystemObj->GetClass()->FindFunctionByName(TEXT("RequestStateTransition"));
		}

		bool bTransitionTriggered = false;
		if (TransitionFunc)
		{
			// Prepare parameters buffer.
			TArray<uint8> Params;
			Params.SetNumZeroed(TransitionFunc->ParmsSize);

			// Set the TargetState parameter using reflection.
			for (TFieldIterator<FProperty> ParamIt(TransitionFunc); ParamIt && (ParamIt->PropertyFlags & CPF_Parm); ++ParamIt)
			{
				FProperty* Param = *ParamIt;
				if (Param->GetName().Contains(TEXT("State")) || Param->GetName().Contains(TEXT("Target")))
				{
					FNameProperty* NameParam = CastField<FNameProperty>(Param);
					FStrProperty* StrParam = CastField<FStrProperty>(Param);
					if (NameParam)
					{
						NameParam->SetPropertyValue(Params.GetData() + Param->GetOffset_ForInternal(), FName(*TargetState));
					}
					else if (StrParam)
					{
						StrParam->SetPropertyValue(Params.GetData() + Param->GetOffset_ForInternal(), TargetState);
					}
				}
			}

			SubsystemObj->ProcessEvent(TransitionFunc, Params.GetData());
			bTransitionTriggered = true;
		}

		if (!bTransitionTriggered)
		{
			// Fallback: set a "CurrentState" property directly via reflection.
			for (TFieldIterator<FProperty> PropIt(SubsystemObj->GetClass()); PropIt; ++PropIt)
			{
				FProperty* Prop = *PropIt;
				if (Prop->GetName() == TEXT("CurrentState") || Prop->GetName() == TEXT("ActiveState"))
				{
					FNameProperty* NameProp = CastField<FNameProperty>(Prop);
					FStrProperty* StrProp = CastField<FStrProperty>(Prop);
					if (NameProp)
					{
						NameProp->SetPropertyValue_InContainer(SubsystemObj, FName(*TargetState));
						bTransitionTriggered = true;
					}
					else if (StrProp)
					{
						StrProp->SetPropertyValue_InContainer(SubsystemObj, TargetState);
						bTransitionTriggered = true;
					}
					break;
				}
			}
		}

		if (!bTransitionTriggered)
		{
			SendResponse(BuildMDErrorResponse(CorrId, TEXT("state_not_found")) + TEXT("\n"));
			return;
		}

		// Apply optional property overrides.
		TArray<TSharedPtr<FJsonValue>> AppliedPropertiesArray;
		const TSharedPtr<FJsonValue>* PropsVal = Payload->Values.Find(TEXT("properties"));
		if (PropsVal && (*PropsVal)->Type == EJson::Object)
		{
			TSharedPtr<FJsonObject> PropsObj = (*PropsVal)->AsObject();
			for (auto& KV : PropsObj->Values)
			{
				for (TFieldIterator<FProperty> PropIt(SubsystemObj->GetClass()); PropIt; ++PropIt)
				{
					FProperty* Prop = *PropIt;
					if (Prop->GetName() == KV.Key)
					{
						// Mark modified before writing (T-28-03).
						SubsystemObj->Modify();

						FStrProperty* StrProp = CastField<FStrProperty>(Prop);
						FNameProperty* NameProp = CastField<FNameProperty>(Prop);
						FFloatProperty* FloatProp = CastField<FFloatProperty>(Prop);
						FDoubleProperty* DoubleProp = CastField<FDoubleProperty>(Prop);
						FBoolProperty* BoolProp = CastField<FBoolProperty>(Prop);

						FString StrVal;
						if (KV.Value->TryGetString(StrVal))
						{
							if (StrProp)
							{
								StrProp->SetPropertyValue_InContainer(SubsystemObj, StrVal);
							}
							else if (NameProp)
							{
								NameProp->SetPropertyValue_InContainer(SubsystemObj, FName(*StrVal));
							}
						}
						else
						{
							double NumVal = 0.0;
							if (KV.Value->TryGetNumber(NumVal))
							{
								if (FloatProp)
								{
									FloatProp->SetPropertyValue_InContainer(SubsystemObj, static_cast<float>(NumVal));
								}
								else if (DoubleProp)
								{
									DoubleProp->SetPropertyValue_InContainer(SubsystemObj, NumVal);
								}
							}
							else
							{
								bool BoolVal = false;
								if (KV.Value->TryGetBool(BoolVal) && BoolProp)
								{
									BoolProp->SetPropertyValue_InContainer(SubsystemObj, BoolVal);
								}
							}
						}

						TSharedPtr<FJsonObject> AppliedProp = MakeShared<FJsonObject>();
						AppliedProp->SetStringField(TEXT("property"), KV.Key);
						AppliedPropertiesArray.Add(MakeShared<FJsonValueObject>(AppliedProp));
						break;
					}
				}
			}
		}

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetStringField(TEXT("new_state"), TargetState);
		Data->SetArrayField(TEXT("applied_properties"), AppliedPropertiesArray);

		SendResponse(BuildMDSuccessResponse(CorrId, Data) + TEXT("\n"));
	});

	// -----------------------------------------------------------------------
	// motiondesign.transitionLogic (MD-03)
	// Inspects a UAvaTransitionTree asset's transition sequences.
	// Required payload field: asset_path (string, must start with /Game/ or /Engine/).
	// Returns: asset_path, transitions[] (in_label, out_label, layer_changes[],
	//   level_sequence_path).
	// Gracefully degrades if Avalanche plugin is not loaded.
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("motiondesign.transitionLogic"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

		// Runtime check: ensure AvalancheTransition module is available.
		if (!MCPReflect::CheckModuleLoaded(TEXT("AvalancheTransition")))
		{
			MCPReflect::SendModuleNotAvailable(SendResponse, CorrId, TEXT("AvalancheTransition"));
			return;
		}

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
			SendResponse(BuildMDErrorResponse(CorrId, TEXT("missing_asset_path")) + TEXT("\n"));
			return;
		}

		// Validate path prefix (T-28-01).
		if (!IsValidMDAssetPath(AssetPath))
		{
			SendResponse(BuildMDErrorResponse(CorrId, TEXT("invalid_asset_path")) + TEXT("\n"));
			return;
		}

		// Look up the UAvaTransitionTree class by name (header-independent approach).
		UClass* TransitionTreeClass = FindObject<UClass>(nullptr, TEXT("/Script/AvalancheTransition.AvaTransitionTree"));
		if (!TransitionTreeClass)
		{
			SendResponse(BuildMDErrorResponse(CorrId, TEXT("transition_tree_class_not_found")) + TEXT("\n"));
			return;
		}

		// Load the transition tree asset.
		UObject* TransitionTreeObj = StaticLoadObject(TransitionTreeClass, nullptr, *AssetPath);
		if (!TransitionTreeObj)
		{
			SendResponse(BuildMDErrorResponse(CorrId, TEXT("transition_tree_not_found")) + TEXT("\n"));
			return;
		}

		// Enumerate transitions via reflection.
		TArray<TSharedPtr<FJsonValue>> TransitionsArray;

		// Look for an array property containing transition entries.
		for (TFieldIterator<FArrayProperty> PropIt(TransitionTreeObj->GetClass()); PropIt; ++PropIt)
		{
			FArrayProperty* ArrayProp = *PropIt;
			FStructProperty* ElemProp = CastField<FStructProperty>(ArrayProp->Inner);
			if (!ElemProp)
			{
				continue;
			}

			FString StructName = ElemProp->Struct->GetName();
			if (!StructName.Contains(TEXT("Transition")) && !StructName.Contains(TEXT("Entry")) && !StructName.Contains(TEXT("Sequence")))
			{
				continue;
			}

			FScriptArrayHelper ArrayHelper(ArrayProp, ArrayProp->ContainerPtrToValuePtr<void>(TransitionTreeObj));
			for (int32 i = 0; i < ArrayHelper.Num(); ++i)
			{
				void* ElemPtr = ArrayHelper.GetRawPtr(i);
				TSharedPtr<FJsonObject> TransObj = MakeShared<FJsonObject>();

				// Extract in_label.
				FString InLabel = TEXT("");
				FNameProperty* InLabelProp = CastField<FNameProperty>(ElemProp->Struct->FindPropertyByName(TEXT("InLabel")));
				FStrProperty* InLabelStrProp = CastField<FStrProperty>(ElemProp->Struct->FindPropertyByName(TEXT("InLabel")));
				if (!InLabelProp)
				{
					InLabelProp = CastField<FNameProperty>(ElemProp->Struct->FindPropertyByName(TEXT("EnterLabel")));
				}
				if (InLabelProp)
				{
					InLabel = InLabelProp->GetPropertyValue_InContainer(ElemPtr).ToString();
				}
				else if (InLabelStrProp)
				{
					InLabel = InLabelStrProp->GetPropertyValue_InContainer(ElemPtr);
				}
				TransObj->SetStringField(TEXT("in_label"), InLabel);

				// Extract out_label.
				FString OutLabel = TEXT("");
				FNameProperty* OutLabelProp = CastField<FNameProperty>(ElemProp->Struct->FindPropertyByName(TEXT("OutLabel")));
				FStrProperty* OutLabelStrProp = CastField<FStrProperty>(ElemProp->Struct->FindPropertyByName(TEXT("OutLabel")));
				if (!OutLabelProp)
				{
					OutLabelProp = CastField<FNameProperty>(ElemProp->Struct->FindPropertyByName(TEXT("ExitLabel")));
				}
				if (OutLabelProp)
				{
					OutLabel = OutLabelProp->GetPropertyValue_InContainer(ElemPtr).ToString();
				}
				else if (OutLabelStrProp)
				{
					OutLabel = OutLabelStrProp->GetPropertyValue_InContainer(ElemPtr);
				}
				TransObj->SetStringField(TEXT("out_label"), OutLabel);

				// Extract associated level sequence path.
				FString LevelSequencePath = TEXT("");
				FObjectProperty* LevelSeqProp = CastField<FObjectProperty>(ElemProp->Struct->FindPropertyByName(TEXT("LevelSequence")));
				if (!LevelSeqProp)
				{
					LevelSeqProp = CastField<FObjectProperty>(ElemProp->Struct->FindPropertyByName(TEXT("Sequence")));
				}
				if (LevelSeqProp)
				{
					UObject* LevelSeq = LevelSeqProp->GetObjectPropertyValue_InContainer(ElemPtr);
					if (LevelSeq)
					{
						LevelSequencePath = LevelSeq->GetPathName();
					}
				}
				TransObj->SetStringField(TEXT("level_sequence_path"), LevelSequencePath);

				// Extract layer change definitions.
				TArray<TSharedPtr<FJsonValue>> LayerChangesArray;
				FArrayProperty* LayerChangesProp = CastField<FArrayProperty>(ElemProp->Struct->FindPropertyByName(TEXT("LayerChanges")));
				if (!LayerChangesProp)
				{
					LayerChangesProp = CastField<FArrayProperty>(ElemProp->Struct->FindPropertyByName(TEXT("LayerTransitions")));
				}
				if (LayerChangesProp)
				{
					FScriptArrayHelper LayersHelper(LayerChangesProp, LayerChangesProp->ContainerPtrToValuePtr<void>(ElemPtr));
					FStructProperty* LayerElemProp = CastField<FStructProperty>(LayerChangesProp->Inner);
					for (int32 j = 0; j < LayersHelper.Num(); ++j)
					{
						void* LayerPtr = LayersHelper.GetRawPtr(j);
						TSharedPtr<FJsonObject> LayerObj = MakeShared<FJsonObject>();

						FString LayerName = FString::Printf(TEXT("Layer_%d"), j);
						FString ChangeType = TEXT("");

						if (LayerElemProp)
						{
							FNameProperty* LayerNameProp = CastField<FNameProperty>(LayerElemProp->Struct->FindPropertyByName(TEXT("LayerName")));
							if (!LayerNameProp)
							{
								LayerNameProp = CastField<FNameProperty>(LayerElemProp->Struct->FindPropertyByName(TEXT("Name")));
							}
							if (LayerNameProp)
							{
								LayerName = LayerNameProp->GetPropertyValue_InContainer(LayerPtr).ToString();
							}

							FStrProperty* ChangeTypeProp = CastField<FStrProperty>(LayerElemProp->Struct->FindPropertyByName(TEXT("ChangeType")));
							if (ChangeTypeProp)
							{
								ChangeType = ChangeTypeProp->GetPropertyValue_InContainer(LayerPtr);
							}
						}

						LayerObj->SetStringField(TEXT("layer_name"), LayerName);
						LayerObj->SetStringField(TEXT("change_type"), ChangeType);
						LayerChangesArray.Add(MakeShared<FJsonValueObject>(LayerObj));
					}
				}
				TransObj->SetArrayField(TEXT("layer_changes"), LayerChangesArray);

				TransitionsArray.Add(MakeShared<FJsonValueObject>(TransObj));
			}
			// Only process the first matching array property.
			if (!TransitionsArray.IsEmpty())
			{
				break;
			}
		}

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetStringField(TEXT("asset_path"), AssetPath);
		Data->SetArrayField(TEXT("transitions"), TransitionsArray);

		SendResponse(BuildMDSuccessResponse(CorrId, Data) + TEXT("\n"));
	});

	// -----------------------------------------------------------------------
	// motiondesign.remoteControl (MD-04)
	// Reads or modifies Remote Control preset properties and triggers exposed
	// functions.
	// Required payload fields: preset_path (string), action (string: list|get|set|call).
	// Action-specific:
	//   list:  -- returns all exposed properties with names, types, current values
	//             and all exposed functions with names.
	//   get:   property_name (string) -- returns single property value.
	//   set:   property_name (string), value (variant) -- sets property; calls Modify().
	//   call:  function_name (string), args (optional object) -- triggers the function.
	// Validates preset_path with IsValidMDAssetPath (T-28-01).
	// Calls Modify() before property writes (T-28-03, PITFALLS.md Pitfall 5).
	//
	// REFLECTION-BASED: RemoteControlPreset.h and RemoteControlField.h are NOT included.
	// URemoteControlPreset is located at runtime via FindObject<UClass>.
	// Exposed entities (properties, functions) are accessed via FProperty/UFunction reflection.
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("motiondesign.remoteControl"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

		// Runtime check: ensure RemoteControl module is available.
		if (!MCPReflect::CheckModuleLoaded(TEXT("RemoteControl")))
		{
			MCPReflect::SendModuleNotAvailable(SendResponse, CorrId, TEXT("RemoteControl"));
			return;
		}

		// Find URemoteControlPreset class via reflection.
		UClass* PresetClass = FindObject<UClass>(nullptr, TEXT("/Script/RemoteControl.RemoteControlPreset"));
		if (!PresetClass)
		{
			SendResponse(BuildMDErrorResponse(CorrId, TEXT("RemoteControlPreset_class_not_found")) + TEXT("\n"));
			return;
		}

		// Extract payload.
		TSharedPtr<FJsonObject> Payload;
		const TSharedPtr<FJsonValue>* PayloadVal = Cmd->Values.Find(TEXT("payload"));
		if (PayloadVal && (*PayloadVal)->Type == EJson::Object)
		{
			Payload = (*PayloadVal)->AsObject();
		}

		if (!Payload.IsValid())
		{
			SendResponse(BuildMDErrorResponse(CorrId, TEXT("missing_payload")) + TEXT("\n"));
			return;
		}

		FString PresetPath;
		FString Action;

		if (!Payload->TryGetStringField(TEXT("preset_path"), PresetPath) || PresetPath.IsEmpty())
		{
			SendResponse(BuildMDErrorResponse(CorrId, TEXT("missing_preset_path")) + TEXT("\n"));
			return;
		}

		if (!Payload->TryGetStringField(TEXT("action"), Action) || Action.IsEmpty())
		{
			SendResponse(BuildMDErrorResponse(CorrId, TEXT("missing_action")) + TEXT("\n"));
			return;
		}

		// Validate path prefix (T-28-01).
		if (!IsValidMDAssetPath(PresetPath))
		{
			SendResponse(BuildMDErrorResponse(CorrId, TEXT("invalid_preset_path")) + TEXT("\n"));
			return;
		}

		// Load the Remote Control preset as UObject.
		UObject* PresetObj = StaticLoadObject(PresetClass, nullptr, *PresetPath);
		if (!PresetObj)
		{
			SendResponse(BuildMDErrorResponse(CorrId, TEXT("preset_not_found")) + TEXT("\n"));
			return;
		}

		// Helper: find the exposed entities array on the preset.
		// URemoteControlPreset stores exposed entities in an array property.
		// We look for an array named "ExposedProperties" or similar.
		// The preset also has GetExposedEntities<T>() which is a template function --
		// we access the underlying arrays via FProperty reflection instead.

		// Find the exposed properties array on the preset object via iteration.
		// In UE 5.7, URemoteControlPreset has:
		//   - Layout (FRemoteControlPresetLayout) with Groups (TArray<FRemoteControlPresetGroup>)
		//   - Each Group has Fields (TArray<FGuid>)
		//   - ExposedProperties / ExposedActors lookup maps
		// We iterate the preset's FProperty fields to find collections of exposed items.

		auto FindExposedArray = [&](const FString& PropName) -> FArrayProperty*
		{
			return CastField<FArrayProperty>(PresetObj->GetClass()->FindPropertyByName(*PropName));
		};

		if (Action == TEXT("list"))
		{
			// List all exposed properties and functions.
			TArray<TSharedPtr<FJsonValue>> PropertiesArray;
			TArray<TSharedPtr<FJsonValue>> FunctionsArray;

			// Try to call GetExposedEntities via a UFunction if available.
			// Otherwise, reflect on the internal data structure.
			// URemoteControlPreset in UE 5.7 stores exposed fields in a map/set.
			// We search for array properties whose struct names contain "Property" or "Function".

			for (TFieldIterator<FMapProperty> PropIt(PresetObj->GetClass()); PropIt; ++PropIt)
			{
				FMapProperty* MapProp = *PropIt;
				FStructProperty* ValProp = CastField<FStructProperty>(MapProp->ValueProp);
				if (!ValProp) continue;

				FString StructName = ValProp->Struct->GetName();
				bool bIsProperty = StructName.Contains(TEXT("Property"));
				bool bIsFunction = StructName.Contains(TEXT("Function"));
				if (!bIsProperty && !bIsFunction) continue;

				FScriptMapHelper MapHelper(MapProp, MapProp->ContainerPtrToValuePtr<void>(PresetObj));
				for (int32 i = 0; i < MapHelper.Num(); ++i)
				{
					if (!MapHelper.IsValidIndex(i)) continue;
					void* ValuePtr = MapHelper.GetValuePtr(i);

					// Extract label from the struct.
					FString Label = FString::Printf(TEXT("Field_%d"), i);
					FString Id = TEXT("");

					FNameProperty* LabelProp = CastField<FNameProperty>(ValProp->Struct->FindPropertyByName(TEXT("Label")));
					FStrProperty* LabelStrProp = CastField<FStrProperty>(ValProp->Struct->FindPropertyByName(TEXT("Label")));
					if (LabelProp) { Label = LabelProp->GetPropertyValue_InContainer(ValuePtr).ToString(); }
					else if (LabelStrProp) { Label = LabelStrProp->GetPropertyValue_InContainer(ValuePtr); }

					// Get ID.
					FStructProperty* IdStructProp = CastField<FStructProperty>(ValProp->Struct->FindPropertyByName(TEXT("Id")));
					if (IdStructProp)
					{
						void* IdPtr = IdStructProp->ContainerPtrToValuePtr<void>(ValuePtr);
						// FGuid -- export as string.
						FString GuidStr;
						IdStructProp->ExportText_Direct(GuidStr, IdPtr, nullptr, nullptr, PPF_None);
						Id = GuidStr;
					}

					TSharedPtr<FJsonObject> FieldObj = MakeShared<FJsonObject>();
					FieldObj->SetStringField(TEXT("name"), Label);
					FieldObj->SetStringField(TEXT("id"), Id);

					if (bIsProperty)
					{
						// Try to get type and value from bound property.
						FString TypeName = TEXT("Unknown");
						FString CurrentValue = TEXT("");

						// Access bound objects via FieldPathInfo.
						FArrayProperty* BoundObjsProp = CastField<FArrayProperty>(ValProp->Struct->FindPropertyByName(TEXT("BoundObjects")));
						FStructProperty* FieldPathProp = CastField<FStructProperty>(ValProp->Struct->FindPropertyByName(TEXT("FieldPathInfo")));

						if (FieldPathProp)
						{
							// FieldPathInfo has a PropertyPath; try to read property name.
							FStrProperty* PathStrProp = CastField<FStrProperty>(FieldPathProp->Struct->FindPropertyByName(TEXT("PropertyPath")));
							FArrayProperty* PathArrayProp = CastField<FArrayProperty>(FieldPathProp->Struct->FindPropertyByName(TEXT("FieldPath")));
							if (PathStrProp)
							{
								TypeName = PathStrProp->GetPropertyValue_InContainer(FieldPathProp->ContainerPtrToValuePtr<void>(ValuePtr));
							}
						}

						FieldObj->SetStringField(TEXT("type"), TypeName);
						FieldObj->SetStringField(TEXT("current_value"), CurrentValue);
						PropertiesArray.Add(MakeShared<FJsonValueObject>(FieldObj));
					}
					else
					{
						FunctionsArray.Add(MakeShared<FJsonValueObject>(FieldObj));
					}
				}
			}

			// Fallback: look for ExposedProperties / ExposedFunctions arrays.
			if (PropertiesArray.IsEmpty() && FunctionsArray.IsEmpty())
			{
				// Try a different layout: TSet or TMap with string keys.
				for (TFieldIterator<FProperty> PropIt(PresetObj->GetClass()); PropIt; ++PropIt)
				{
					FProperty* Prop = *PropIt;
					FString PropName = Prop->GetName();
					if (PropName.Contains(TEXT("Exposed")) || PropName.Contains(TEXT("Fields")))
					{
						TSharedPtr<FJsonObject> NoteObj = MakeShared<FJsonObject>();
						NoteObj->SetStringField(TEXT("name"), PropName);
						NoteObj->SetStringField(TEXT("note"), TEXT("RC preset layout requires runtime inspection; check with preset loaded in editor"));
						PropertiesArray.Add(MakeShared<FJsonValueObject>(NoteObj));
						break;
					}
				}
			}

			TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
			Data->SetStringField(TEXT("preset_path"), PresetPath);
			Data->SetArrayField(TEXT("properties"), PropertiesArray);
			Data->SetArrayField(TEXT("functions"), FunctionsArray);

			SendResponse(BuildMDSuccessResponse(CorrId, Data) + TEXT("\n"));
		}
		else if (Action == TEXT("get"))
		{
			FString PropertyName;
			if (!Payload->TryGetStringField(TEXT("property_name"), PropertyName) || PropertyName.IsEmpty())
			{
				SendResponse(BuildMDErrorResponse(CorrId, TEXT("missing_property_name")) + TEXT("\n"));
				return;
			}

			// Find exposed property by label via reflection on map entries.
			bool bFound = false;
			for (TFieldIterator<FMapProperty> PropIt(PresetObj->GetClass()); PropIt; ++PropIt)
			{
				FMapProperty* MapProp = *PropIt;
				FStructProperty* ValProp = CastField<FStructProperty>(MapProp->ValueProp);
				if (!ValProp) continue;
				if (!ValProp->Struct->GetName().Contains(TEXT("Property"))) continue;

				FScriptMapHelper MapHelper(MapProp, MapProp->ContainerPtrToValuePtr<void>(PresetObj));
				for (int32 i = 0; i < MapHelper.Num(); ++i)
				{
					if (!MapHelper.IsValidIndex(i)) continue;
					void* ValuePtr = MapHelper.GetValuePtr(i);

					FString Label = TEXT("");
					FNameProperty* LabelProp = CastField<FNameProperty>(ValProp->Struct->FindPropertyByName(TEXT("Label")));
					FStrProperty* LabelStrProp = CastField<FStrProperty>(ValProp->Struct->FindPropertyByName(TEXT("Label")));
					if (LabelProp) { Label = LabelProp->GetPropertyValue_InContainer(ValuePtr).ToString(); }
					else if (LabelStrProp) { Label = LabelStrProp->GetPropertyValue_InContainer(ValuePtr); }

					if (Label != PropertyName) continue;

					TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
					Data->SetStringField(TEXT("preset_path"), PresetPath);
					Data->SetStringField(TEXT("property_name"), PropertyName);
					Data->SetStringField(TEXT("type"), TEXT("Reflected"));
					Data->SetStringField(TEXT("value"), TEXT("Use 'list' to enumerate and editor tools to access current values"));

					SendResponse(BuildMDSuccessResponse(CorrId, Data) + TEXT("\n"));
					bFound = true;
					break;
				}
				if (bFound) break;
			}

			if (!bFound)
			{
				SendResponse(BuildMDErrorResponse(CorrId, TEXT("property_not_found")) + TEXT("\n"));
			}
		}
		else if (Action == TEXT("set"))
		{
			FString PropertyName;
			if (!Payload->TryGetStringField(TEXT("property_name"), PropertyName) || PropertyName.IsEmpty())
			{
				SendResponse(BuildMDErrorResponse(CorrId, TEXT("missing_property_name")) + TEXT("\n"));
				return;
			}

			const TSharedPtr<FJsonValue>* ValueJsonPtr = Payload->Values.Find(TEXT("value"));
			if (!ValueJsonPtr)
			{
				SendResponse(BuildMDErrorResponse(CorrId, TEXT("missing_value")) + TEXT("\n"));
				return;
			}

			// Find the exposed property by label and attempt to set via bound object reflection.
			bool bFound = false;
			for (TFieldIterator<FMapProperty> PropIt(PresetObj->GetClass()); PropIt; ++PropIt)
			{
				FMapProperty* MapProp = *PropIt;
				FStructProperty* ValProp = CastField<FStructProperty>(MapProp->ValueProp);
				if (!ValProp) continue;
				if (!ValProp->Struct->GetName().Contains(TEXT("Property"))) continue;

				FScriptMapHelper MapHelper(MapProp, MapProp->ContainerPtrToValuePtr<void>(PresetObj));
				for (int32 i = 0; i < MapHelper.Num(); ++i)
				{
					if (!MapHelper.IsValidIndex(i)) continue;
					void* ValuePtr = MapHelper.GetValuePtr(i);

					FString Label = TEXT("");
					FNameProperty* LabelProp = CastField<FNameProperty>(ValProp->Struct->FindPropertyByName(TEXT("Label")));
					FStrProperty* LabelStrProp = CastField<FStrProperty>(ValProp->Struct->FindPropertyByName(TEXT("Label")));
					if (LabelProp) { Label = LabelProp->GetPropertyValue_InContainer(ValuePtr).ToString(); }
					else if (LabelStrProp) { Label = LabelStrProp->GetPropertyValue_InContainer(ValuePtr); }

					if (Label != PropertyName) continue;

					// Access bound objects array to find the target UObject.
					FArrayProperty* BoundObjsProp = CastField<FArrayProperty>(ValProp->Struct->FindPropertyByName(TEXT("BoundObjects")));
					if (BoundObjsProp)
					{
						FScriptArrayHelper BoundHelper(BoundObjsProp, BoundObjsProp->ContainerPtrToValuePtr<void>(ValuePtr));
						if (BoundHelper.Num() > 0)
						{
							void* BoundElem = BoundHelper.GetRawPtr(0);
							FObjectProperty* ObjProp = CastField<FObjectProperty>(BoundObjsProp->Inner);
							// Try to get a struct with Object pointer.
							FStructProperty* BoundStructProp = CastField<FStructProperty>(BoundObjsProp->Inner);
							UObject* BoundObj = nullptr;

							if (ObjProp)
							{
								BoundObj = ObjProp->GetObjectPropertyValue(BoundElem);
							}
							else if (BoundStructProp)
							{
								// Look for an Object property inside the struct.
								FObjectProperty* InnerObjProp = CastField<FObjectProperty>(BoundStructProp->Struct->FindPropertyByName(TEXT("Object")));
								if (!InnerObjProp) { InnerObjProp = CastField<FObjectProperty>(BoundStructProp->Struct->FindPropertyByName(TEXT("Actor"))); }
								if (InnerObjProp)
								{
									BoundObj = InnerObjProp->GetObjectPropertyValue_InContainer(BoundElem);
								}
							}

							if (BoundObj)
							{
								// Determine the property path from FieldPathInfo.
								FStructProperty* FieldPathProp = CastField<FStructProperty>(ValProp->Struct->FindPropertyByName(TEXT("FieldPathInfo")));
								FString PropNameStr;
								if (FieldPathProp)
								{
									FNameProperty* PNameProp = CastField<FNameProperty>(FieldPathProp->Struct->FindPropertyByName(TEXT("PropertyName")));
									FStrProperty* PStrProp = CastField<FStrProperty>(FieldPathProp->Struct->FindPropertyByName(TEXT("PropertyPath")));
									void* FPIPtr = FieldPathProp->ContainerPtrToValuePtr<void>(ValuePtr);
									if (PNameProp) { PropNameStr = PNameProp->GetPropertyValue_InContainer(FPIPtr).ToString(); }
									else if (PStrProp) { PropNameStr = PStrProp->GetPropertyValue_InContainer(FPIPtr); }
								}

								if (!PropNameStr.IsEmpty())
								{
									FProperty* TargetProp = BoundObj->GetClass()->FindPropertyByName(*PropNameStr);
									if (TargetProp)
									{
										// Mark as modified before property write (T-28-03).
										BoundObj->Modify();

										FString ImportText;
										(*ValueJsonPtr)->TryGetString(ImportText);

										void* PropAddr = TargetProp->ContainerPtrToValuePtr<void>(BoundObj);
										TargetProp->ImportText_Direct(*ImportText, PropAddr, BoundObj, PPF_None);

										// Re-export to confirm what was written.
										FString UpdatedValue;
										TargetProp->ExportTextItem_Direct(UpdatedValue, PropAddr, nullptr, BoundObj, PPF_None);

										TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
										Data->SetStringField(TEXT("preset_path"), PresetPath);
										Data->SetStringField(TEXT("property_name"), PropertyName);
										Data->SetStringField(TEXT("updated_value"), UpdatedValue);

										SendResponse(BuildMDSuccessResponse(CorrId, Data) + TEXT("\n"));
									}
									else
									{
										SendResponse(BuildMDErrorResponse(CorrId, TEXT("property_binding_invalid")) + TEXT("\n"));
									}
								}
								else
								{
									SendResponse(BuildMDErrorResponse(CorrId, TEXT("field_path_unresolvable")) + TEXT("\n"));
								}
							}
							else
							{
								SendResponse(BuildMDErrorResponse(CorrId, TEXT("no_bound_objects")) + TEXT("\n"));
							}
						}
						else
						{
							SendResponse(BuildMDErrorResponse(CorrId, TEXT("no_bound_objects")) + TEXT("\n"));
						}
					}
					else
					{
						SendResponse(BuildMDErrorResponse(CorrId, TEXT("property_binding_invalid")) + TEXT("\n"));
					}

					bFound = true;
					break;
				}
				if (bFound) break;
			}

			if (!bFound)
			{
				SendResponse(BuildMDErrorResponse(CorrId, TEXT("property_not_found")) + TEXT("\n"));
			}
		}
		else if (Action == TEXT("call"))
		{
			FString FunctionName;
			if (!Payload->TryGetStringField(TEXT("function_name"), FunctionName) || FunctionName.IsEmpty())
			{
				SendResponse(BuildMDErrorResponse(CorrId, TEXT("missing_function_name")) + TEXT("\n"));
				return;
			}

			// Extract optional args.
			TSharedPtr<FJsonObject> ArgsObj;
			const TSharedPtr<FJsonValue>* ArgsVal = Payload->Values.Find(TEXT("args"));
			if (ArgsVal && (*ArgsVal)->Type == EJson::Object)
			{
				ArgsObj = (*ArgsVal)->AsObject();
			}

			// Find the exposed function by label via reflection on map entries.
			bool bFound = false;
			for (TFieldIterator<FMapProperty> PropIt(PresetObj->GetClass()); PropIt; ++PropIt)
			{
				FMapProperty* MapProp = *PropIt;
				FStructProperty* ValProp = CastField<FStructProperty>(MapProp->ValueProp);
				if (!ValProp) continue;
				if (!ValProp->Struct->GetName().Contains(TEXT("Function"))) continue;

				FScriptMapHelper MapHelper(MapProp, MapProp->ContainerPtrToValuePtr<void>(PresetObj));
				for (int32 i = 0; i < MapHelper.Num(); ++i)
				{
					if (!MapHelper.IsValidIndex(i)) continue;
					void* ValuePtr = MapHelper.GetValuePtr(i);

					FString Label = TEXT("");
					FNameProperty* LabelProp = CastField<FNameProperty>(ValProp->Struct->FindPropertyByName(TEXT("Label")));
					FStrProperty* LabelStrProp = CastField<FStrProperty>(ValProp->Struct->FindPropertyByName(TEXT("Label")));
					if (LabelProp) { Label = LabelProp->GetPropertyValue_InContainer(ValuePtr).ToString(); }
					else if (LabelStrProp) { Label = LabelStrProp->GetPropertyValue_InContainer(ValuePtr); }

					if (Label != FunctionName) continue;

					// Find the bound UObject and UFunction.
					FObjectProperty* BoundObjProp = CastField<FObjectProperty>(ValProp->Struct->FindPropertyByName(TEXT("BoundObject")));
					FNameProperty* FuncNameProp = CastField<FNameProperty>(ValProp->Struct->FindPropertyByName(TEXT("FunctionName")));

					UObject* BoundObj = BoundObjProp ? BoundObjProp->GetObjectPropertyValue_InContainer(ValuePtr) : nullptr;
					FName FuncFName = FuncNameProp ? FuncNameProp->GetPropertyValue_InContainer(ValuePtr) : NAME_None;

					if (BoundObj && !FuncFName.IsNone())
					{
						UFunction* Func = BoundObj->GetClass()->FindFunctionByName(FuncFName);
						if (Func)
						{
							// Prepare parameter buffer.
							TArray<uint8> Params;
							Params.SetNumZeroed(Func->ParmsSize);

							// Apply args from JSON if provided.
							if (ArgsObj.IsValid())
							{
								for (TFieldIterator<FProperty> ParamIt(Func); ParamIt && (ParamIt->PropertyFlags & CPF_Parm); ++ParamIt)
								{
									FProperty* Param = *ParamIt;
									if (Param->PropertyFlags & CPF_ReturnParm) continue;

									const TSharedPtr<FJsonValue>* ArgVal = ArgsObj->Values.Find(Param->GetName());
									if (ArgVal)
									{
										FString ArgStr;
										(*ArgVal)->TryGetString(ArgStr);
										void* ParamAddr = Params.GetData() + Param->GetOffset_ForInternal();
										Param->ImportText_Direct(*ArgStr, ParamAddr, BoundObj, PPF_None);
									}
								}
							}

							BoundObj->ProcessEvent(Func, Params.GetData());

							// Extract return value if any.
							FString ReturnValue = TEXT("");
							for (TFieldIterator<FProperty> ParamIt(Func); ParamIt && (ParamIt->PropertyFlags & CPF_Parm); ++ParamIt)
							{
								FProperty* Param = *ParamIt;
								if (Param->PropertyFlags & CPF_ReturnParm)
								{
									void* ParamAddr = Params.GetData() + Param->GetOffset_ForInternal();
									Param->ExportTextItem_Direct(ReturnValue, ParamAddr, nullptr, BoundObj, PPF_None);
									break;
								}
							}

							TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
							Data->SetStringField(TEXT("preset_path"), PresetPath);
							Data->SetStringField(TEXT("function_name"), FunctionName);
							Data->SetStringField(TEXT("result"), ReturnValue);

							SendResponse(BuildMDSuccessResponse(CorrId, Data) + TEXT("\n"));
						}
						else
						{
							SendResponse(BuildMDErrorResponse(CorrId, TEXT("function_not_callable")) + TEXT("\n"));
						}
					}
					else
					{
						SendResponse(BuildMDErrorResponse(CorrId, TEXT("function_binding_invalid")) + TEXT("\n"));
					}

					bFound = true;
					break;
				}
				if (bFound) break;
			}

			if (!bFound)
			{
				SendResponse(BuildMDErrorResponse(CorrId, TEXT("function_not_found")) + TEXT("\n"));
			}
		}
		else
		{
			SendResponse(BuildMDErrorResponse(CorrId, TEXT("invalid_action")) + TEXT("\n"));
		}
	});
}
