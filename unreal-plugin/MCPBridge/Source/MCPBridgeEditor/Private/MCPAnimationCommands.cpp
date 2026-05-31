// MCPAnimationCommands.cpp (Plan 17-01)
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

#include "MCPAnimationCommands.h"

// Animation headers
#include "Animation/AnimBlueprint.h"
#include "Animation/AnimMontage.h"
#include "Animation/BlendSpace.h"
#include "Animation/AnimSequence.h"

// AnimGraph headers for state machine node access
#include "AnimGraphNode_StateMachine.h"
#include "AnimStateNode.h"

// Asset Registry
#include "AssetRegistry/AssetRegistryModule.h"
#include "AssetRegistry/IAssetRegistry.h"

// IKRetargeter -- from IKRig plugin
#if WITH_EDITOR
#include "Retargeter/IKRetargeter.h"
#endif

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

		// Collect state machine information by iterating FunctionGraphs and AnimationGraphs.
		// UAnimBlueprint stores its animation nodes in the AnimationGraph (UEdGraph).
		TArray<TSharedPtr<FJsonValue>> StateMachinesArray;

		// Iterate all graphs in the AnimBlueprint to find state machine graphs.
		TArray<UEdGraph*> AllGraphs;
		AllGraphs.Append(AnimBP->FunctionGraphs);
		if (AnimBP->UbergraphPages.Num() > 0)
		{
			AllGraphs.Append(AnimBP->UbergraphPages);
		}
		// Also check AnimationGraph specifically.
		for (UEdGraph* Graph : AnimBP->FunctionGraphs)
		{
			if (Graph)
			{
				AllGraphs.AddUnique(Graph);
			}
		}

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
				UAnimGraphNode_StateMachine* SMNode = Cast<UAnimGraphNode_StateMachine>(Node);
				if (!SMNode)
				{
					continue;
				}

				FString SMName = SMNode->GetNodeTitle(ENodeTitleType::ListView).ToString();

				// Collect states from the state machine graph.
				TArray<TSharedPtr<FJsonValue>> StatesArray;
				TArray<TSharedPtr<FJsonValue>> TransitionsArray;

				// The state machine graph is referenced by BoundGraph.
				UEdGraph* SMGraph = SMNode->GetBoundGraph();
				if (SMGraph)
				{
					for (UEdGraphNode* SMSubNode : SMGraph->Nodes)
					{
						if (!SMSubNode)
						{
							continue;
						}

						// Check if this is a state node.
						UAnimStateNode* StateNode = Cast<UAnimStateNode>(SMSubNode);
						if (StateNode)
						{
							FString StateName = StateNode->GetStateName();
							FString AnimAssetPath;

							// Try to get the animation sequence from the state's bound graph.
							UEdGraph* StateGraph = StateNode->GetBoundGraph();
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
						if (!SMSubNode)
						{
							continue;
						}

						UAnimStateTransitionNode* TransNode = Cast<UAnimStateTransitionNode>(SMSubNode);
						if (!TransNode)
						{
							continue;
						}

						FString SourceState;
						FString TargetState;

						// Get source and target state names via pin connections.
						for (UEdGraphPin* Pin : TransNode->Pins)
						{
							if (!Pin)
							{
								continue;
							}
							if (Pin->Direction == EGPD_Input && Pin->LinkedTo.Num() > 0)
							{
								UAnimStateNode* LinkedState = Cast<UAnimStateNode>(Pin->LinkedTo[0]->GetOwningNode());
								if (LinkedState)
								{
									SourceState = LinkedState->GetStateName();
								}
							}
							else if (Pin->Direction == EGPD_Output && Pin->LinkedTo.Num() > 0)
							{
								UAnimStateNode* LinkedState = Cast<UAnimStateNode>(Pin->LinkedTo[0]->GetOwningNode());
								if (LinkedState)
								{
									TargetState = LinkedState->GetStateName();
								}
							}
						}

						TSharedPtr<FJsonObject> TransObj = MakeShared<FJsonObject>();
						TransObj->SetStringField(TEXT("source_state"), SourceState);
						TransObj->SetStringField(TEXT("target_state"), TargetState);
						TransObj->SetNumberField(TEXT("duration"), static_cast<double>(TransNode->CrossfadeDuration));
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
			if (Section.LinkedSequence)
			{
				LinkedSequenceName = Section.LinkedSequence->GetPathName();
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
			const FBlendParameter& Param = BlendSpace->BlendParameters[i];
			TSharedPtr<FJsonObject> AxisObj = MakeShared<FJsonObject>();
			AxisObj->SetStringField(TEXT("name"), Param.DisplayName);
			AxisObj->SetNumberField(TEXT("min"), static_cast<double>(Param.Min));
			AxisObj->SetNumberField(TEXT("max"), static_cast<double>(Param.Max));
			AxisObj->SetNumberField(TEXT("grid_divisions"), static_cast<double>(Param.GridNum));
			AxesArray.Add(MakeShared<FJsonValueObject>(AxisObj));
		}

		// Build samples array from SampleData.
		TArray<TSharedPtr<FJsonValue>> SamplesArray;
		for (const FBlendSample& Sample : BlendSpace->SampleData)
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

		// Validate path prefix (T-17-01).
		if (!IsValidAssetPath(AssetPath))
		{
			SendResponse(BuildAnimErrorResponse(CorrId, TEXT("invalid_asset_path")) + TEXT("\n"));
			return;
		}

#if WITH_EDITOR
		// Load the IKRetargeter asset.
		UIKRetargeter* Retargeter = Cast<UIKRetargeter>(StaticLoadObject(UIKRetargeter::StaticClass(), nullptr, *AssetPath));
		if (!Retargeter)
		{
			SendResponse(BuildAnimErrorResponse(CorrId, TEXT("retargeter_not_found")) + TEXT("\n"));
			return;
		}

		// Get source and target IK Rig asset paths.
		FString SourceRigPath;
		FString TargetRigPath;

		const UIKRigDefinition* SourceRig = Retargeter->GetSourceIKRig();
		if (SourceRig)
		{
			SourceRigPath = SourceRig->GetPathName();
		}

		const UIKRigDefinition* TargetRig = Retargeter->GetTargetIKRig();
		if (TargetRig)
		{
			TargetRigPath = TargetRig->GetPathName();
		}

		// Collect chain mappings.
		TArray<TSharedPtr<FJsonValue>> ChainMappingsArray;
		for (const FRetargetChainMap& ChainMap : Retargeter->GetChainMapping())
		{
			TSharedPtr<FJsonObject> MappingObj = MakeShared<FJsonObject>();
			MappingObj->SetStringField(TEXT("source_chain"), ChainMap.SourceChain.ToString());
			MappingObj->SetStringField(TEXT("target_chain"), ChainMap.TargetChain.ToString());
			ChainMappingsArray.Add(MakeShared<FJsonValueObject>(MappingObj));
		}

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetStringField(TEXT("asset_path"), AssetPath);
		Data->SetStringField(TEXT("source_rig"), SourceRigPath);
		Data->SetStringField(TEXT("target_rig"), TargetRigPath);
		Data->SetArrayField(TEXT("chain_mappings"), ChainMappingsArray);

		SendResponse(BuildAnimSuccessResponse(CorrId, Data) + TEXT("\n"));
#else
		SendResponse(BuildAnimErrorResponse(CorrId, TEXT("ik_retargeter_requires_editor")) + TEXT("\n"));
#endif
	});
}
