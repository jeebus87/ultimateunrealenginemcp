// MCPAnimationCommands.cpp (Plan 33-03)
// Implements five animation asset inspection command handlers for the MCP bridge:
//   animation.list              -- list all animation assets by type (ANIM-01)
//   animation.inspectAnimBP     -- inspect AnimBlueprint state machines, states, transitions (ANIM-02)
//   animation.inspectMontage    -- read montage sections, notifies, slot assignments (ANIM-03)
//   animation.inspectBlendSpace -- inspect blend space axes, sample points, grid config (ANIM-04)
//   animation.retargetMappings  -- read IK retarget source/target skeleton mappings (ANIM-05)
//
// All handlers run on the game thread via FMCPCommandRouter::Dispatch.
// All operations are read-only -- no Modify() calls needed.
// asset_path is validated to start with "/Game/" or "/Engine/" before any
// StaticLoadObject call to prevent path traversal (T-17-01).
//
// Converted from Optional/MCPAnimationCommands.cpp.disabled to reflection-based approach
// (Plan 33-03). IKRig plugin headers eliminated -- retarget handler now uses
// FindObject<UClass> and FProperty/FArrayProperty reflection to access UIKRetargeter,
// UIKRigDefinition, and FRetargetChainPair without compile-time IKRig dependency.

#include "MCPAnimationCommands.h"
#include "ReflectionHelpers.h"

// Core Animation headers (Engine module -- always available)
#include "Animation/AnimBlueprint.h"
#include "Animation/AnimMontage.h"
#include "Animation/BlendSpace.h"
#include "Animation/BlendSpace1D.h"
#include "Animation/AnimSequence.h"

// AnimGraph state machine classes accessed via reflection (AnimGraph module not linked).
// We use FindObject<UClass> + FProperty reflection to access node titles, state names,
// transition data, and graph connections without compile-time AnimGraph dependency.

// Asset Registry
#include "AssetRegistry/AssetRegistryModule.h"
#include "AssetRegistry/IAssetRegistry.h"

// UE reflection (for IKRig retarget handler)
#include "UObject/UnrealType.h"
#include "UObject/PropertyPortFlags.h"

// JSON
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Returns a JSON success response string (without trailing newline). */
static FString BuildAnimSuccessResponse(const FString& CorrId, TSharedPtr<FJsonObject> Data)
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
static FString BuildAnimErrorResponse(const FString& CorrId, const FString& Error)
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
 * path traversal attacks (T-17-01).
 */
static bool IsValidAssetPath(const FString& AssetPath)
{
	return AssetPath.StartsWith(TEXT("/Game/")) || AssetPath.StartsWith(TEXT("/Engine/"));
}

// ---------------------------------------------------------------------------
// RegisterAnimationCommands
// ---------------------------------------------------------------------------

void RegisterAnimationCommands(FMCPCommandRouter& Router)
{
	// -----------------------------------------------------------------------
	// animation.list (ANIM-01)
	// Lists animation assets in the project, optionally filtered by type.
	// Optional payload field: type_filter (AnimBlueprint, AnimMontage, BlendSpace,
	//   BlendSpace1D, AnimSequence, or empty string for all).
	// Returns JSON array `assets` with: asset_path, asset_name, asset_type.
	// Uses core Animation module APIs directly (no optional module).
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("animation.list"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
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

		// Access the asset registry.
		FAssetRegistryModule& RegistryModule = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry"));
		IAssetRegistry& Registry = RegistryModule.Get();

		// Build list of class names to query based on type_filter.
		TArray<FString> ClassNames;
		if (TypeFilter.IsEmpty() || TypeFilter == TEXT("AnimBlueprint"))
		{
			ClassNames.Add(TEXT("AnimBlueprint"));
		}
		if (TypeFilter.IsEmpty() || TypeFilter == TEXT("AnimMontage"))
		{
			ClassNames.Add(TEXT("AnimMontage"));
		}
		if (TypeFilter.IsEmpty() || TypeFilter == TEXT("BlendSpace"))
		{
			ClassNames.Add(TEXT("BlendSpace"));
		}
		if (TypeFilter.IsEmpty() || TypeFilter == TEXT("BlendSpace1D"))
		{
			ClassNames.Add(TEXT("BlendSpace1D"));
		}
		if (TypeFilter.IsEmpty() || TypeFilter == TEXT("AnimSequence"))
		{
			ClassNames.Add(TEXT("AnimSequence"));
		}

		// If a type_filter was provided but didn't match any known type, return an error.
		if (!TypeFilter.IsEmpty() && ClassNames.IsEmpty())
		{
			SendResponse(BuildAnimErrorResponse(CorrId, TEXT("unknown_type_filter")) + TEXT("\n"));
			return;
		}

		TArray<TSharedPtr<FJsonValue>> AssetsArray;

		for (const FString& ClassName : ClassNames)
		{
			TArray<FAssetData> AssetList;
			FTopLevelAssetPath ClassPath(TEXT("/Script/Engine"), *ClassName);
			Registry.GetAssetsByClass(ClassPath, AssetList, /*bSearchSubClasses=*/true);

			for (const FAssetData& Asset : AssetList)
			{
				TSharedPtr<FJsonObject> AssetObj = MakeShared<FJsonObject>();
				AssetObj->SetStringField(TEXT("asset_path"), Asset.GetObjectPathString());
				AssetObj->SetStringField(TEXT("asset_name"), Asset.AssetName.ToString());
				AssetObj->SetStringField(TEXT("asset_type"), ClassName);
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

		SendResponse(BuildAnimSuccessResponse(CorrId, Data) + TEXT("\n"));
	});

	// -----------------------------------------------------------------------
	// animation.inspectAnimBP (ANIM-02)
	// Inspects an Animation Blueprint's state machines, states, and transitions.
	// Required payload field: asset_path (must start with /Game/ or /Engine/).
	// Returns: asset_path, skeleton, state_machines array.
	// Uses core Animation/AnimGraph module APIs directly (no optional module).
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("animation.inspectAnimBP"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
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
			SendResponse(BuildAnimErrorResponse(CorrId, TEXT("missing_asset_path")) + TEXT("\n"));
			return;
		}

		// Validate path prefix (T-17-01).
		if (!IsValidAssetPath(AssetPath))
		{
			SendResponse(BuildAnimErrorResponse(CorrId, TEXT("invalid_asset_path")) + TEXT("\n"));
			return;
		}

		// Load the AnimBlueprint asset.
		UAnimBlueprint* AnimBP = Cast<UAnimBlueprint>(StaticLoadObject(UAnimBlueprint::StaticClass(), nullptr, *AssetPath));
		if (!AnimBP)
		{
			SendResponse(BuildAnimErrorResponse(CorrId, TEXT("anim_blueprint_not_found")) + TEXT("\n"));
			return;
		}

		// Extract skeleton name.
		FString SkeletonPath;
		if (AnimBP->TargetSkeleton)
		{
			SkeletonPath = AnimBP->TargetSkeleton->GetPathName();
		}

		// Collect state machine information using reflection (AnimGraph module not linked).
		// We find UAnimGraphNode_StateMachine class at runtime and check node types by class name.
		TArray<TSharedPtr<FJsonValue>> StateMachinesArray;

		// Find AnimGraph classes via reflection.
		UClass* SMNodeClass = FindObject<UClass>(nullptr, TEXT("/Script/AnimGraph.AnimGraphNode_StateMachine"));
		UClass* StateNodeClass = FindObject<UClass>(nullptr, TEXT("/Script/AnimGraph.AnimStateNode"));
		UClass* TransitionNodeClass = FindObject<UClass>(nullptr, TEXT("/Script/AnimGraph.AnimStateTransitionNode"));

		// Iterate all node graphs in the Blueprint looking for state machine nodes.
		TArray<UEdGraph*> AllBPGraphs;
		AnimBP->GetAllGraphs(AllBPGraphs);

		for (UEdGraph* Graph : AllBPGraphs)
		{
			if (!Graph)
			{
				continue;
			}

			for (UEdGraphNode* Node : Graph->Nodes)
			{
				if (!Node || !SMNodeClass || !Node->IsA(SMNodeClass))
				{
					continue;
				}

				FString SMName = Node->GetNodeTitle(ENodeTitleType::ListView).ToString();

				// Collect states from the state machine graph.
				TArray<TSharedPtr<FJsonValue>> StatesArray;
				TArray<TSharedPtr<FJsonValue>> TransitionsArray;

				// Access EditorStateMachineGraph via reflection (FObjectProperty on the base class).
				UEdGraph* SMGraph = nullptr;
				FObjectProperty* SMGraphProp = CastField<FObjectProperty>(Node->GetClass()->FindPropertyByName(TEXT("EditorStateMachineGraph")));
				if (SMGraphProp)
				{
					SMGraph = Cast<UEdGraph>(SMGraphProp->GetObjectPropertyValue_InContainer(Node));
				}

				if (SMGraph)
				{
					for (UEdGraphNode* SMSubNode : SMGraph->Nodes)
					{
						if (!SMSubNode)
						{
							continue;
						}

						// Check if this is a state node (UAnimStateNode).
						if (StateNodeClass && SMSubNode->IsA(StateNodeClass))
						{
							// Get state name via GetStateName() -- call through reflection.
							FString StateName;
							UFunction* GetStateNameFunc = SMSubNode->GetClass()->FindFunctionByName(TEXT("GetStateName"));
							if (GetStateNameFunc)
							{
								// GetStateName returns FString -- use ProcessEvent.
								struct { FString ReturnValue; } Params;
								SMSubNode->ProcessEvent(GetStateNameFunc, &Params);
								StateName = Params.ReturnValue;
							}
							else
							{
								// Fallback: use node title.
								StateName = SMSubNode->GetNodeTitle(ENodeTitleType::ListView).ToString();
							}

							FString AnimAssetPath;

							// Try to get the animation sequence from the state's bound graph.
							UFunction* GetBoundGraphFunc = SMSubNode->GetClass()->FindFunctionByName(TEXT("GetBoundGraph"));
							UEdGraph* StateGraph = nullptr;
							if (GetBoundGraphFunc)
							{
								struct { UEdGraph* ReturnValue; } GraphParams;
								GraphParams.ReturnValue = nullptr;
								SMSubNode->ProcessEvent(GetBoundGraphFunc, &GraphParams);
								StateGraph = GraphParams.ReturnValue;
							}

							if (StateGraph)
							{
								for (UEdGraphNode* StateSubNode : StateGraph->Nodes)
								{
									// Look for AnimSequence player nodes.
									if (StateSubNode && StateSubNode->GetClass()->GetName().Contains(TEXT("AnimSequence")))
									{
										// Try to get asset reference from node properties.
										for (TFieldIterator<FObjectProperty> PropIt(StateSubNode->GetClass()); PropIt; ++PropIt)
										{
											UObject* ObjVal = PropIt->GetObjectPropertyValue_InContainer(StateSubNode);
											if (ObjVal && ObjVal->IsA(UAnimSequenceBase::StaticClass()))
											{
												AnimAssetPath = ObjVal->GetPathName();
												break;
											}
										}
									}
								}
							}

							TSharedPtr<FJsonObject> StateObj = MakeShared<FJsonObject>();
							StateObj->SetStringField(TEXT("name"), StateName);
							StateObj->SetStringField(TEXT("animation_asset"), AnimAssetPath);
							StatesArray.Add(MakeShared<FJsonValueObject>(StateObj));
						}
					}

					// Collect transitions from state machine graph.
					for (UEdGraphNode* SMSubNode : SMGraph->Nodes)
					{
						if (!SMSubNode || !TransitionNodeClass || !SMSubNode->IsA(TransitionNodeClass))
						{
							continue;
						}

						FString SourceState;
						FString TargetState;

						// Get source and target state names via pin connections.
						for (UEdGraphPin* Pin : SMSubNode->Pins)
						{
							if (!Pin)
							{
								continue;
							}
							if (Pin->Direction == EGPD_Input && Pin->LinkedTo.Num() > 0)
							{
								UEdGraphNode* LinkedNode = Pin->LinkedTo[0]->GetOwningNode();
								if (LinkedNode && StateNodeClass && LinkedNode->IsA(StateNodeClass))
								{
									UFunction* GetNameFunc = LinkedNode->GetClass()->FindFunctionByName(TEXT("GetStateName"));
									if (GetNameFunc)
									{
										struct { FString ReturnValue; } P;
										LinkedNode->ProcessEvent(GetNameFunc, &P);
										SourceState = P.ReturnValue;
									}
								}
							}
							else if (Pin->Direction == EGPD_Output && Pin->LinkedTo.Num() > 0)
							{
								UEdGraphNode* LinkedNode = Pin->LinkedTo[0]->GetOwningNode();
								if (LinkedNode && StateNodeClass && LinkedNode->IsA(StateNodeClass))
								{
									UFunction* GetNameFunc = LinkedNode->GetClass()->FindFunctionByName(TEXT("GetStateName"));
									if (GetNameFunc)
									{
										struct { FString ReturnValue; } P;
										LinkedNode->ProcessEvent(GetNameFunc, &P);
										TargetState = P.ReturnValue;
									}
								}
							}
						}

						// Access CrossfadeDuration via reflection.
						double Duration = 0.0;
						FFloatProperty* DurationProp = CastField<FFloatProperty>(SMSubNode->GetClass()->FindPropertyByName(TEXT("CrossfadeDuration")));
						if (DurationProp)
						{
							Duration = static_cast<double>(DurationProp->GetPropertyValue_InContainer(SMSubNode));
						}

						TSharedPtr<FJsonObject> TransObj = MakeShared<FJsonObject>();
						TransObj->SetStringField(TEXT("source_state"), SourceState);
						TransObj->SetStringField(TEXT("target_state"), TargetState);
						TransObj->SetNumberField(TEXT("duration"), Duration);
						TransitionsArray.Add(MakeShared<FJsonValueObject>(TransObj));
					}
				}

				TSharedPtr<FJsonObject> SMObj = MakeShared<FJsonObject>();
				SMObj->SetStringField(TEXT("name"), SMName);
				SMObj->SetArrayField(TEXT("states"), StatesArray);
				SMObj->SetArrayField(TEXT("transitions"), TransitionsArray);
				StateMachinesArray.Add(MakeShared<FJsonValueObject>(SMObj));
			}
		}

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetStringField(TEXT("asset_path"), AssetPath);
		Data->SetStringField(TEXT("skeleton"), SkeletonPath);
		Data->SetArrayField(TEXT("state_machines"), StateMachinesArray);

		SendResponse(BuildAnimSuccessResponse(CorrId, Data) + TEXT("\n"));
	});

	// -----------------------------------------------------------------------
	// animation.inspectMontage (ANIM-03)
	// Reads montage sections, notifies, and slot assignments.
	// Required payload field: asset_path.
	// Returns: asset_path, sections array, notifies array, slots array.
	// Uses core Animation module APIs directly (no optional module).
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("animation.inspectMontage"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
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
			SendResponse(BuildAnimErrorResponse(CorrId, TEXT("missing_asset_path")) + TEXT("\n"));
			return;
		}

		// Validate path prefix (T-17-01).
		if (!IsValidAssetPath(AssetPath))
		{
			SendResponse(BuildAnimErrorResponse(CorrId, TEXT("invalid_asset_path")) + TEXT("\n"));
			return;
		}

		// Load the AnimMontage asset.
		UAnimMontage* Montage = Cast<UAnimMontage>(StaticLoadObject(UAnimMontage::StaticClass(), nullptr, *AssetPath));
		if (!Montage)
		{
			SendResponse(BuildAnimErrorResponse(CorrId, TEXT("montage_not_found")) + TEXT("\n"));
			return;
		}

		// Build sections array from CompositeSections.
		TArray<TSharedPtr<FJsonValue>> SectionsArray;
		for (const FCompositeSection& Section : Montage->CompositeSections)
		{
			FString LinkedSequenceName;
			if (Section.GetLinkedSequence())
			{
				LinkedSequenceName = Section.GetLinkedSequence()->GetPathName();
			}

			TSharedPtr<FJsonObject> SectionObj = MakeShared<FJsonObject>();
			SectionObj->SetStringField(TEXT("name"), Section.SectionName.ToString());
			SectionObj->SetStringField(TEXT("linked_sequence"), LinkedSequenceName);
			SectionsArray.Add(MakeShared<FJsonValueObject>(SectionObj));
		}

		// Build notifies array from Notifies.
		TArray<TSharedPtr<FJsonValue>> NotifiesArray;
		for (const FAnimNotifyEvent& Notify : Montage->Notifies)
		{
			FString NotifyName;
			if (Notify.Notify)
			{
				NotifyName = Notify.Notify->GetClass()->GetName();
			}
			else
			{
				NotifyName = Notify.NotifyName.ToString();
			}

			TSharedPtr<FJsonObject> NotifyObj = MakeShared<FJsonObject>();
			NotifyObj->SetStringField(TEXT("name"), NotifyName);
			NotifyObj->SetNumberField(TEXT("trigger_time"), static_cast<double>(Notify.GetTriggerTime()));
			NotifiesArray.Add(MakeShared<FJsonValueObject>(NotifyObj));
		}

		// Build slots array from SlotAnimTracks.
		TArray<TSharedPtr<FJsonValue>> SlotsArray;
		for (const FSlotAnimationTrack& SlotTrack : Montage->SlotAnimTracks)
		{
			SlotsArray.Add(MakeShared<FJsonValueString>(SlotTrack.SlotName.ToString()));
		}

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetStringField(TEXT("asset_path"), AssetPath);
		Data->SetArrayField(TEXT("sections"), SectionsArray);
		Data->SetArrayField(TEXT("notifies"), NotifiesArray);
		Data->SetArrayField(TEXT("slots"), SlotsArray);

		SendResponse(BuildAnimSuccessResponse(CorrId, Data) + TEXT("\n"));
	});

	// -----------------------------------------------------------------------
	// animation.inspectBlendSpace (ANIM-04)
	// Inspects blend space axes, sample points, and grid configuration.
	// Required payload field: asset_path.
	// Returns: asset_path, is_1d, axes array, samples array.
	// Uses core Animation module APIs directly (no optional module).
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("animation.inspectBlendSpace"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
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
			SendResponse(BuildAnimErrorResponse(CorrId, TEXT("missing_asset_path")) + TEXT("\n"));
			return;
		}

		// Validate path prefix (T-17-01).
		if (!IsValidAssetPath(AssetPath))
		{
			SendResponse(BuildAnimErrorResponse(CorrId, TEXT("invalid_asset_path")) + TEXT("\n"));
			return;
		}

		// Try to load as UBlendSpace first, then UBlendSpace1D.
		UBlendSpace* BlendSpace = Cast<UBlendSpace>(StaticLoadObject(UBlendSpace::StaticClass(), nullptr, *AssetPath));
		bool bIs1D = false;

		if (!BlendSpace)
		{
			// Try UBlendSpace1D explicitly.
			BlendSpace = Cast<UBlendSpace>(StaticLoadObject(UBlendSpace1D::StaticClass(), nullptr, *AssetPath));
			if (BlendSpace && BlendSpace->IsA(UBlendSpace1D::StaticClass()))
			{
				bIs1D = true;
			}
		}
		else if (BlendSpace->IsA(UBlendSpace1D::StaticClass()))
		{
			bIs1D = true;
		}

		if (!BlendSpace)
		{
			SendResponse(BuildAnimErrorResponse(CorrId, TEXT("blend_space_not_found")) + TEXT("\n"));
			return;
		}

		// Build axes array from BlendParameters.
		TArray<TSharedPtr<FJsonValue>> AxesArray;
		// UBlendSpace has BlendParameters[3] (up to 3 axes; 1D uses only index 0).
		const int32 NumAxes = bIs1D ? 1 : 2; // 1D uses 1 axis, 2D uses 2 axes (index 0 and 1).
		for (int32 i = 0; i < NumAxes; ++i)
		{
			const FBlendParameter& Param = BlendSpace->GetBlendParameter(i);
			TSharedPtr<FJsonObject> AxisObj = MakeShared<FJsonObject>();
			AxisObj->SetStringField(TEXT("name"), Param.DisplayName);
			AxisObj->SetNumberField(TEXT("min"), static_cast<double>(Param.Min));
			AxisObj->SetNumberField(TEXT("max"), static_cast<double>(Param.Max));
			AxisObj->SetNumberField(TEXT("grid_divisions"), static_cast<double>(Param.GridNum));
			AxesArray.Add(MakeShared<FJsonValueObject>(AxisObj));
		}

		// Build samples array from SampleData.
		TArray<TSharedPtr<FJsonValue>> SamplesArray;
		for (const FBlendSample& Sample : BlendSpace->GetBlendSamples())
		{
			FString AnimPath;
			if (Sample.Animation)
			{
				AnimPath = Sample.Animation->GetPathName();
			}

			TSharedPtr<FJsonObject> SampleObj = MakeShared<FJsonObject>();
			SampleObj->SetStringField(TEXT("animation"), AnimPath);
			SampleObj->SetNumberField(TEXT("x"), static_cast<double>(Sample.SampleValue.X));
			SampleObj->SetNumberField(TEXT("y"), static_cast<double>(Sample.SampleValue.Y));
			SampleObj->SetNumberField(TEXT("z"), static_cast<double>(Sample.SampleValue.Z));
			SamplesArray.Add(MakeShared<FJsonValueObject>(SampleObj));
		}

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetStringField(TEXT("asset_path"), AssetPath);
		Data->SetBoolField(TEXT("is_1d"), bIs1D);
		Data->SetArrayField(TEXT("axes"), AxesArray);
		Data->SetArrayField(TEXT("samples"), SamplesArray);

		SendResponse(BuildAnimSuccessResponse(CorrId, Data) + TEXT("\n"));
	});

	// -----------------------------------------------------------------------
	// animation.retargetMappings (ANIM-05)
	// Reads IK Retargeter source/target skeleton mappings and chain assignments.
	// Required payload field: asset_path.
	// Returns: asset_path, source_rig, target_rig, chain_mappings array.
	// Threat T-33-07: asset_path validated to prevent path traversal.
	// Threat T-33-08: named error codes only, no raw UE messages.
	//
	// IKRig types accessed via UE reflection (no IKRig plugin headers):
	//   - UIKRetargeter found via FindObject<UClass>(nullptr, "/Script/IKRig.IKRetargeter")
	//   - UIKRigDefinition found via FindObject<UClass>(nullptr, "/Script/IKRig.IKRigDefinition")
	//   - Chain mappings read via FArrayProperty + FScriptArrayHelper
	//   - Source/target rig paths read via FObjectProperty
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("animation.retargetMappings"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
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
			SendResponse(BuildAnimErrorResponse(CorrId, TEXT("missing_asset_path")) + TEXT("\n"));
			return;
		}

		// Validate path prefix (T-17-01, T-33-07).
		if (!IsValidAssetPath(AssetPath))
		{
			SendResponse(BuildAnimErrorResponse(CorrId, TEXT("invalid_asset_path")) + TEXT("\n"));
			return;
		}

		// Check IKRig module is available at runtime.
		if (!MCPReflect::CheckModuleLoaded(TEXT("IKRig")))
		{
			MCPReflect::SendModuleNotAvailable(SendResponse, CorrId, TEXT("IKRig"));
			return;
		}

		// Find UIKRetargeter class via reflection (no IKRig header required).
		UClass* RetargeterClass = MCPReflect::FindClassByPath(TEXT("/Script/IKRig.IKRetargeter"));
		if (!RetargeterClass)
		{
			SendResponse(BuildAnimErrorResponse(CorrId, TEXT("ik_retargeter_class_not_found")) + TEXT("\n"));
			return;
		}

		// Load the IKRetargeter asset as UObject*.
		UObject* RetargeterAsset = StaticLoadObject(RetargeterClass, nullptr, *AssetPath);
		if (!RetargeterAsset)
		{
			SendResponse(BuildAnimErrorResponse(CorrId, TEXT("retargeter_not_found")) + TEXT("\n"));
			return;
		}

		// Read source and target IK Rig asset paths via FProperty reflection.
		// The retargeter class exposes SourceIKRigAsset and TargetIKRigAsset as FObjectProperty.
		FString SourceRigPath;
		FString TargetRigPath;

		// Iterate object properties to find source/target rig references.
		for (TFieldIterator<FObjectProperty> PropIt(RetargeterClass); PropIt; ++PropIt)
		{
			const FString PropName = PropIt->GetName();
			UObject* ObjVal = PropIt->GetObjectPropertyValue_InContainer(RetargeterAsset);

			// Source rig property names in UE 5.7: "SourceIKRigAsset", "SourceRig"
			if ((PropName.Contains(TEXT("Source")) && PropName.Contains(TEXT("Rig"))) ||
			    PropName == TEXT("SourceIKRigAsset"))
			{
				if (ObjVal)
				{
					SourceRigPath = ObjVal->GetPathName();
				}
			}
			// Target rig property names in UE 5.7: "TargetIKRigAsset", "TargetRig"
			else if ((PropName.Contains(TEXT("Target")) && PropName.Contains(TEXT("Rig"))) ||
			         PropName == TEXT("TargetIKRigAsset"))
			{
				if (ObjVal)
				{
					TargetRigPath = ObjVal->GetPathName();
				}
			}
		}

		// Collect chain mappings via FArrayProperty reflection.
		// UIKRetargeter stores chain pairs in a property like "ChainMapping" or "ChainPairs"
		// which is a TArray of FRetargetChainPair (a struct with SourceChainName, TargetChainName).
		TArray<TSharedPtr<FJsonValue>> ChainMappingsArray;

		// Find the array property that contains chain pair structs.
		for (TFieldIterator<FArrayProperty> PropIt(RetargeterClass); PropIt; ++PropIt)
		{
			FArrayProperty* ArrayProp = *PropIt;
			const FString PropName = ArrayProp->GetName();

			// Look for ChainMapping, ChainPairs, RetargetChainPairs, etc.
			if (!PropName.Contains(TEXT("Chain")) && !PropName.Contains(TEXT("Retarget")))
			{
				continue;
			}

			FStructProperty* ElemProp = CastField<FStructProperty>(ArrayProp->Inner);
			if (!ElemProp)
			{
				continue;
			}

			UScriptStruct* PairStruct = ElemProp->Struct;

			// Validate it has SourceChainName and TargetChainName.
			FNameProperty* SourceChainNameProp = CastField<FNameProperty>(
				PairStruct->FindPropertyByName(FName(TEXT("SourceChainName"))));
			FNameProperty* TargetChainNameProp = CastField<FNameProperty>(
				PairStruct->FindPropertyByName(FName(TEXT("TargetChainName"))));

			if (!SourceChainNameProp || !TargetChainNameProp)
			{
				continue;
			}

			// Found the chain pairs array -- iterate elements.
			FScriptArrayHelper ArrayHelper(ArrayProp, ArrayProp->ContainerPtrToValuePtr<void>(RetargeterAsset));
			for (int32 i = 0; i < ArrayHelper.Num(); ++i)
			{
				void* PairPtr = ArrayHelper.GetRawPtr(i);

				FName SourceChainName = SourceChainNameProp->GetPropertyValue_InContainer(PairPtr);
				FName TargetChainName = TargetChainNameProp->GetPropertyValue_InContainer(PairPtr);

				TSharedPtr<FJsonObject> MappingObj = MakeShared<FJsonObject>();
				MappingObj->SetStringField(TEXT("source_chain"), SourceChainName.ToString());
				MappingObj->SetStringField(TEXT("target_chain"), TargetChainName.ToString());
				ChainMappingsArray.Add(MakeShared<FJsonValueObject>(MappingObj));
			}

			// Only process the first matching array (there should be only one chain mapping array).
			break;
		}

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetStringField(TEXT("asset_path"), AssetPath);
		Data->SetStringField(TEXT("source_rig"), SourceRigPath);
		Data->SetStringField(TEXT("target_rig"), TargetRigPath);
		Data->SetArrayField(TEXT("chain_mappings"), ChainMappingsArray);

		SendResponse(BuildAnimSuccessResponse(CorrId, Data) + TEXT("\n"));
	});
}
