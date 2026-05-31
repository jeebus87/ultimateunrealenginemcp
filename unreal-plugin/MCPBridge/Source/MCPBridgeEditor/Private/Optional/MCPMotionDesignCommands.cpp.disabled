// MCPMotionDesignCommands.cpp (Plan 28-01)
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
// Handlers for sceneStates, transition, and transitionLogic check FModuleManager at
// runtime to degrade gracefully when the Avalanche plugin is not enabled.

#include "MCPMotionDesignCommands.h"

// Remote Control headers (always available when RemoteControl module is loaded)
#include "RemoteControlPreset.h"
#include "RemoteControlField.h"

// Editor world context
#include "Editor.h"

// JSON
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"

// Module manager for runtime Avalanche availability check
#include "Modules/ModuleManager.h"

// UObject reflection for Remote Control property access
#include "UObject/UnrealType.h"
#include "UObject/PropertyPortFlags.h"

// ---------------------------------------------------------------------------
// Forward declarations for Avalanche types (conditional -- may not be present)
// We load these headers only when the modules are actually available.
// If headers are not present in the project's installed UE, conditional
// compilation will still allow the file to compile by avoiding direct type usage
// when modules are absent.
// ---------------------------------------------------------------------------

// Avalanche headers -- present only when Motion Design plugin is installed.
// Guard with a macro so compilation succeeds even without the Avalanche plugin.
#if defined(AVALANCHERUNDOWN_API)
#include "AvaRundownSubsystem.h"
#endif

#if defined(AVALANCHETRANSITION_API)
#include "AvaTransitionTree.h"
#endif

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
static bool IsValidAssetPath(const FString& AssetPath)
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
	// Optional payload field: rundown_path (string) -- if omitted, all rundown
	//   subsystem instances from the editor world are enumerated.
	// Returns: scene_state_machines[] (machine_name, current_state, states[]).
	// Gracefully degrades if Avalanche plugin is not loaded.
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("motiondesign.sceneStates"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

		// Runtime check: ensure AvalancheRundown module is available.
		if (!FModuleManager::Get().IsModuleLoaded(TEXT("AvalancheRundown")))
		{
			SendResponse(BuildMDErrorResponse(CorrId, TEXT("motion_design_plugin_not_enabled")) + TEXT("\n"));
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
		// We look up the subsystem class by name to maintain header-independence.
		TArray<TSharedPtr<FJsonValue>> MachinesArray;

		// Try to get UAvaRundownSubsystem via the engine subsystem registry.
		// Since the module is confirmed loaded above, we use the subsystem by class name.
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

		UGameInstanceSubsystem* Subsystem = nullptr;
		if (World->GetGameInstance())
		{
			Subsystem = Cast<UGameInstanceSubsystem>(World->GetGameInstance()->GetSubsystemBase(RundownSubsystemClass));
		}

		if (!Subsystem)
		{
			// Try world subsystem as a fallback.
			UWorldSubsystem* WorldSub = Cast<UWorldSubsystem>(World->GetSubsystemBase(RundownSubsystemClass));
			if (!WorldSub)
			{
				// Subsystem not active in this world -- return informative empty result.
				TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
				Data->SetStringField(TEXT("rundown_path"), RundownPath);
				Data->SetArrayField(TEXT("scene_state_machines"), MachinesArray);
				Data->SetStringField(TEXT("note"), TEXT("AvaRundownSubsystem not active in current world; open a level that uses Motion Design"));
				SendResponse(BuildMDSuccessResponse(CorrId, Data) + TEXT("\n"));
				return;
			}
		}

		// Use reflection to enumerate scene state machines from the subsystem.
		// AvaRundownSubsystem exposes state machine data via properties.
		// We iterate FProperty fields to find arrays of state machine descriptors.
		UObject* SubsystemObj = Subsystem ? Cast<UObject>(Subsystem) : nullptr;
		if (!SubsystemObj)
		{
			UWorldSubsystem* WorldSub = Cast<UWorldSubsystem>(World->GetSubsystemBase(RundownSubsystemClass));
			SubsystemObj = WorldSub;
		}

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
		if (!FModuleManager::Get().IsModuleLoaded(TEXT("AvalancheRundown")))
		{
			SendResponse(BuildMDErrorResponse(CorrId, TEXT("motion_design_plugin_not_enabled")) + TEXT("\n"));
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
		// Look for a function named "SetState" or "TriggerTransition" or similar.
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
		if (!FModuleManager::Get().IsModuleLoaded(TEXT("AvalancheTransition")))
		{
			SendResponse(BuildMDErrorResponse(CorrId, TEXT("motion_design_plugin_not_enabled")) + TEXT("\n"));
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
		if (!IsValidAssetPath(AssetPath))
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
	// Validates preset_path with IsValidAssetPath (T-28-01).
	// Calls Modify() before property writes (T-28-03, PITFALLS.md Pitfall 5).
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("motiondesign.remoteControl"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

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
		if (!IsValidAssetPath(PresetPath))
		{
			SendResponse(BuildMDErrorResponse(CorrId, TEXT("invalid_preset_path")) + TEXT("\n"));
			return;
		}

		// Load the Remote Control preset.
		URemoteControlPreset* Preset = Cast<URemoteControlPreset>(StaticLoadObject(URemoteControlPreset::StaticClass(), nullptr, *PresetPath));
		if (!Preset)
		{
			SendResponse(BuildMDErrorResponse(CorrId, TEXT("preset_not_found")) + TEXT("\n"));
			return;
		}

		if (Action == TEXT("list"))
		{
			// List all exposed properties and functions.
			TArray<TSharedPtr<FJsonValue>> PropertiesArray;
			TArray<TSharedPtr<FJsonValue>> FunctionsArray;

			// Iterate exposed properties.
			for (const TWeakPtr<FRemoteControlProperty>& WeakField : Preset->GetExposedEntities<FRemoteControlProperty>())
			{
				TSharedPtr<FRemoteControlProperty> Field = WeakField.Pin();
				if (!Field.IsValid())
				{
					continue;
				}

				TSharedPtr<FJsonObject> PropObj = MakeShared<FJsonObject>();
				PropObj->SetStringField(TEXT("name"), Field->GetLabel().ToString());
				PropObj->SetStringField(TEXT("id"), Field->GetId().ToString());

				// Get field type from the bound property.
				FString TypeName = TEXT("Unknown");
				FString CurrentValue = TEXT("");

				// Access the bound objects to read the current property value.
				TArray<UObject*> BoundObjects = Field->GetBoundObjects();
				if (BoundObjects.Num() > 0 && BoundObjects[0] != nullptr)
				{
					UObject* BoundObj = BoundObjects[0];
					FProperty* Prop = Field->GetProperty();
					if (Prop)
					{
						TypeName = Prop->GetCPPType();
						// Export the current value as string.
						void* PropAddr = Prop->ContainerPtrToValuePtr<void>(BoundObj);
						Prop->ExportTextItem_Direct(CurrentValue, PropAddr, nullptr, BoundObj, PPF_None);
					}
				}

				PropObj->SetStringField(TEXT("type"), TypeName);
				PropObj->SetStringField(TEXT("current_value"), CurrentValue);

				PropertiesArray.Add(MakeShared<FJsonValueObject>(PropObj));
			}

			// Iterate exposed functions.
			for (const TWeakPtr<FRemoteControlFunction>& WeakFunc : Preset->GetExposedEntities<FRemoteControlFunction>())
			{
				TSharedPtr<FRemoteControlFunction> RCFunc = WeakFunc.Pin();
				if (!RCFunc.IsValid())
				{
					continue;
				}

				TSharedPtr<FJsonObject> FuncObj = MakeShared<FJsonObject>();
				FuncObj->SetStringField(TEXT("name"), RCFunc->GetLabel().ToString());
				FuncObj->SetStringField(TEXT("id"), RCFunc->GetId().ToString());

				FunctionsArray.Add(MakeShared<FJsonValueObject>(FuncObj));
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

			// Find the exposed property by label.
			bool bFound = false;
			for (const TWeakPtr<FRemoteControlProperty>& WeakField : Preset->GetExposedEntities<FRemoteControlProperty>())
			{
				TSharedPtr<FRemoteControlProperty> Field = WeakField.Pin();
				if (!Field.IsValid())
				{
					continue;
				}

				if (Field->GetLabel().ToString() != PropertyName)
				{
					continue;
				}

				FString TypeName = TEXT("Unknown");
				FString CurrentValue = TEXT("");

				TArray<UObject*> BoundObjects = Field->GetBoundObjects();
				if (BoundObjects.Num() > 0 && BoundObjects[0] != nullptr)
				{
					FProperty* Prop = Field->GetProperty();
					if (Prop)
					{
						TypeName = Prop->GetCPPType();
						void* PropAddr = Prop->ContainerPtrToValuePtr<void>(BoundObjects[0]);
						Prop->ExportTextItem_Direct(CurrentValue, PropAddr, nullptr, BoundObjects[0], PPF_None);
					}
				}

				TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
				Data->SetStringField(TEXT("preset_path"), PresetPath);
				Data->SetStringField(TEXT("property_name"), PropertyName);
				Data->SetStringField(TEXT("type"), TypeName);
				Data->SetStringField(TEXT("value"), CurrentValue);

				SendResponse(BuildMDSuccessResponse(CorrId, Data) + TEXT("\n"));
				bFound = true;
				break;
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

			// Find the exposed property by label.
			bool bFound = false;
			for (const TWeakPtr<FRemoteControlProperty>& WeakField : Preset->GetExposedEntities<FRemoteControlProperty>())
			{
				TSharedPtr<FRemoteControlProperty> Field = WeakField.Pin();
				if (!Field.IsValid())
				{
					continue;
				}

				if (Field->GetLabel().ToString() != PropertyName)
				{
					continue;
				}

				TArray<UObject*> BoundObjects = Field->GetBoundObjects();
				if (BoundObjects.Num() > 0 && BoundObjects[0] != nullptr)
				{
					FProperty* Prop = Field->GetProperty();
					if (Prop)
					{
						// Mark as modified before property write (T-28-03, PITFALLS.md Pitfall 5).
						BoundObjects[0]->Modify();

						FString ImportText;
						(*ValueJsonPtr)->TryGetString(ImportText);

						void* PropAddr = Prop->ContainerPtrToValuePtr<void>(BoundObjects[0]);
						Prop->ImportText_Direct(*ImportText, PropAddr, BoundObjects[0], PPF_None);

						// Re-export to confirm what was written.
						FString UpdatedValue;
						Prop->ExportTextItem_Direct(UpdatedValue, PropAddr, nullptr, BoundObjects[0], PPF_None);

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
					SendResponse(BuildMDErrorResponse(CorrId, TEXT("no_bound_objects")) + TEXT("\n"));
				}

				bFound = true;
				break;
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

			// Find the exposed function by label.
			bool bFound = false;
			for (const TWeakPtr<FRemoteControlFunction>& WeakFunc : Preset->GetExposedEntities<FRemoteControlFunction>())
			{
				TSharedPtr<FRemoteControlFunction> RCFunc = WeakFunc.Pin();
				if (!RCFunc.IsValid())
				{
					continue;
				}

				if (RCFunc->GetLabel().ToString() != FunctionName)
				{
					continue;
				}

				// Get the UFunction from the Remote Control function.
				UFunction* Func = RCFunc->GetFunction();
				TArray<UObject*> BoundObjects = RCFunc->GetBoundObjects();

				if (Func && BoundObjects.Num() > 0 && BoundObjects[0] != nullptr)
				{
					UObject* BoundObj = BoundObjects[0];

					// Prepare parameter buffer.
					TArray<uint8> Params;
					Params.SetNumZeroed(Func->ParmsSize);

					// Apply args from JSON if provided.
					if (ArgsObj.IsValid())
					{
						for (TFieldIterator<FProperty> ParamIt(Func); ParamIt && (ParamIt->PropertyFlags & CPF_Parm); ++ParamIt)
						{
							FProperty* Param = *ParamIt;
							if (Param->PropertyFlags & CPF_ReturnParm)
							{
								continue;
							}

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

				bFound = true;
				break;
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
