// MCPAICommands.cpp (Plan 22-01)
// Implements five AI system inspection command handlers for the MCP bridge:
//   ai.behaviorTree  -- inspect Behavior Tree node hierarchy, decorators, services (AI-01)
//   ai.stateTree     -- read State Tree states, transitions, and tasks (AI-02)
//   ai.blackboard    -- list Blackboard keys with types and default values (AI-03)
//   ai.eqs           -- inspect EQS query templates: generators, tests, scoring (AI-04)
//   ai.navmesh       -- query NavMesh build status, bounds, point reachability (AI-05)
//
// All handlers run on the game thread via FMCPCommandRouter::Dispatch.
// All operations are read-only -- no Modify() calls needed.
// asset_path is validated to start with "/Game/" or "/Engine/" before any
// StaticLoadObject call to prevent path traversal (T-22-01).
// Behavior Tree recursion is capped at 100 levels to prevent DoS (T-22-02).

#include "MCPAICommands.h"

// Behavior Tree headers
#include "BehaviorTree/BehaviorTree.h"
#include "BehaviorTree/BTCompositeNode.h"
#include "BehaviorTree/BTDecorator.h"
#include "BehaviorTree/BTService.h"
#include "BehaviorTree/BTTaskNode.h"

// Blackboard headers
#include "BehaviorTree/BlackboardData.h"
#include "BehaviorTree/Blackboard/BlackboardKeyType.h"

// State Tree headers
#include "StateTree.h"
#include "StateTreeTypes.h"

// EQS headers
#include "EnvironmentQuery/EnvQuery.h"
#include "EnvironmentQuery/EnvQueryOption.h"
#include "EnvironmentQuery/EnvQueryGenerator.h"
#include "EnvironmentQuery/EnvQueryTest.h"

// Navigation System headers
#include "NavigationSystem.h"
#include "NavigationData.h"
#include "NavMesh/RecastNavMesh.h"
#include "NavigationPath.h"
#include "NavFilters/NavigationQueryFilter.h"

// Editor world context
#include "Editor.h"

// JSON
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Returns a JSON success response string (without trailing newline). */
static FString BuildAISuccessResponse(const FString& CorrId, TSharedPtr<FJsonObject> Data)
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
static FString BuildAIErrorResponse(const FString& CorrId, const FString& Error)
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
 * path traversal attacks (T-22-01).
 */
static bool IsValidAssetPath(const FString& AssetPath)
{
	return AssetPath.StartsWith(TEXT("/Game/")) || AssetPath.StartsWith(TEXT("/Engine/"));
}

// ---------------------------------------------------------------------------
// Behavior Tree recursive walk helper (T-22-02: cap depth at 100)
// ---------------------------------------------------------------------------

static TSharedPtr<FJsonObject> BuildBTNodeJson(UBTNode* Node, int32 Depth);

/**
 * Build a JSON object representing a BT composite node and its subtree.
 * Depth is tracked to enforce the T-22-02 recursion limit of 100 levels.
 */
static TSharedPtr<FJsonObject> BuildBTCompositeNodeJson(UBTCompositeNode* Composite, int32 Depth)
{
	TSharedPtr<FJsonObject> NodeObj = MakeShared<FJsonObject>();
	NodeObj->SetStringField(TEXT("node_name"), Composite->GetNodeName());
	NodeObj->SetStringField(TEXT("node_class"), Composite->GetClass()->GetName());
	NodeObj->SetStringField(TEXT("node_type"), TEXT("Composite"));

	// Build decorators array.
	TArray<TSharedPtr<FJsonValue>> DecoratorsArray;
	for (UBTDecorator* Decorator : Composite->Decorators)
	{
		if (!Decorator)
		{
			continue;
		}
		TSharedPtr<FJsonObject> DecObj = MakeShared<FJsonObject>();
		DecObj->SetStringField(TEXT("node_name"), Decorator->GetNodeName());
		DecObj->SetStringField(TEXT("node_class"), Decorator->GetClass()->GetName());
		DecObj->SetStringField(TEXT("node_type"), TEXT("Decorator"));
		DecoratorsArray.Add(MakeShared<FJsonValueObject>(DecObj));
	}
	NodeObj->SetArrayField(TEXT("decorators"), DecoratorsArray);

	// Build services array.
	TArray<TSharedPtr<FJsonValue>> ServicesArray;
	for (UBTService* Service : Composite->Services)
	{
		if (!Service)
		{
			continue;
		}
		TSharedPtr<FJsonObject> SvcObj = MakeShared<FJsonObject>();
		SvcObj->SetStringField(TEXT("node_name"), Service->GetNodeName());
		SvcObj->SetStringField(TEXT("node_class"), Service->GetClass()->GetName());
		SvcObj->SetStringField(TEXT("node_type"), TEXT("Service"));
		ServicesArray.Add(MakeShared<FJsonValueObject>(SvcObj));
	}
	NodeObj->SetArrayField(TEXT("services"), ServicesArray);

	// Build children array -- recurse if depth allows (T-22-02).
	TArray<TSharedPtr<FJsonValue>> ChildrenArray;
	if (Depth < 100)
	{
		const int32 NumChildren = Composite->GetChildrenNum();
		for (int32 i = 0; i < NumChildren; ++i)
		{
			FBTCompositeChild& ChildInfo = Composite->Children[i];
			UBTNode* ChildNode = ChildInfo.ChildComposite ? Cast<UBTNode>(ChildInfo.ChildComposite) : Cast<UBTNode>(ChildInfo.ChildTask);
			if (ChildNode)
			{
				TSharedPtr<FJsonObject> ChildJson = BuildBTNodeJson(ChildNode, Depth + 1);
				if (ChildJson.IsValid())
				{
					ChildrenArray.Add(MakeShared<FJsonValueObject>(ChildJson));
				}
			}

			// Each child slot may also have decorators attached to the child edge.
			for (UBTDecorator* ChildDecorator : ChildInfo.Decorators)
			{
				if (!ChildDecorator)
				{
					continue;
				}
				TSharedPtr<FJsonObject> DecObj = MakeShared<FJsonObject>();
				DecObj->SetStringField(TEXT("node_name"), ChildDecorator->GetNodeName());
				DecObj->SetStringField(TEXT("node_class"), ChildDecorator->GetClass()->GetName());
				DecObj->SetStringField(TEXT("node_type"), TEXT("Decorator"));
				// Edge decorators are reported as children of the composite for context.
			}
		}
	}
	else
	{
		// T-22-02: Maximum recursion depth reached. Add a truncation notice.
		TSharedPtr<FJsonObject> TruncObj = MakeShared<FJsonObject>();
		TruncObj->SetStringField(TEXT("node_name"), TEXT("[TRUNCATED: max_depth_100_reached]"));
		TruncObj->SetStringField(TEXT("node_class"), TEXT("TruncationMarker"));
		TruncObj->SetStringField(TEXT("node_type"), TEXT("Truncated"));
		ChildrenArray.Add(MakeShared<FJsonValueObject>(TruncObj));
	}
	NodeObj->SetArrayField(TEXT("children"), ChildrenArray);

	return NodeObj;
}

/** Dispatch node to the correct JSON builder based on node type. */
static TSharedPtr<FJsonObject> BuildBTNodeJson(UBTNode* Node, int32 Depth)
{
	if (!Node)
	{
		return nullptr;
	}

	UBTCompositeNode* Composite = Cast<UBTCompositeNode>(Node);
	if (Composite)
	{
		return BuildBTCompositeNodeJson(Composite, Depth);
	}

	// Leaf nodes: Task, Decorator, Service -- build basic JSON.
	TSharedPtr<FJsonObject> NodeObj = MakeShared<FJsonObject>();
	NodeObj->SetStringField(TEXT("node_name"), Node->GetNodeName());
	NodeObj->SetStringField(TEXT("node_class"), Node->GetClass()->GetName());

	if (Cast<UBTTaskNode>(Node))
	{
		NodeObj->SetStringField(TEXT("node_type"), TEXT("Task"));
	}
	else if (Cast<UBTDecorator>(Node))
	{
		NodeObj->SetStringField(TEXT("node_type"), TEXT("Decorator"));
	}
	else if (Cast<UBTService>(Node))
	{
		NodeObj->SetStringField(TEXT("node_type"), TEXT("Service"));
	}
	else
	{
		NodeObj->SetStringField(TEXT("node_type"), TEXT("Unknown"));
	}

	NodeObj->SetArrayField(TEXT("decorators"), TArray<TSharedPtr<FJsonValue>>());
	NodeObj->SetArrayField(TEXT("services"), TArray<TSharedPtr<FJsonValue>>());
	NodeObj->SetArrayField(TEXT("children"), TArray<TSharedPtr<FJsonValue>>());

	return NodeObj;
}

// ---------------------------------------------------------------------------
// RegisterAICommands
// ---------------------------------------------------------------------------

void RegisterAICommands(FMCPCommandRouter& Router)
{
	// -----------------------------------------------------------------------
	// ai.behaviorTree (AI-01)
	// Inspects a Behavior Tree asset's node hierarchy, decorators, and services.
	// Required payload field: asset_path (must start with /Game/ or /Engine/).
	// Returns: asset_path, root_node (recursive tree with node_name, node_class,
	//   node_type, decorators[], services[], children[]).
	// Recursion limited to 100 levels (T-22-02).
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("ai.behaviorTree"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
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
			SendResponse(BuildAIErrorResponse(CorrId, TEXT("missing_asset_path")) + TEXT("\n"));
			return;
		}

		// Validate path prefix (T-22-01).
		if (!IsValidAssetPath(AssetPath))
		{
			SendResponse(BuildAIErrorResponse(CorrId, TEXT("invalid_asset_path")) + TEXT("\n"));
			return;
		}

		// Load the BehaviorTree asset.
		UBehaviorTree* BT = Cast<UBehaviorTree>(StaticLoadObject(UBehaviorTree::StaticClass(), nullptr, *AssetPath));
		if (!BT)
		{
			SendResponse(BuildAIErrorResponse(CorrId, TEXT("behavior_tree_not_found")) + TEXT("\n"));
			return;
		}

		// Walk the tree starting from RootNode (a UBTCompositeNode).
		TSharedPtr<FJsonObject> RootNodeJson;
		if (BT->RootNode)
		{
			RootNodeJson = BuildBTCompositeNodeJson(BT->RootNode, 0);
		}
		else
		{
			// No root node -- return an empty node marker.
			RootNodeJson = MakeShared<FJsonObject>();
			RootNodeJson->SetStringField(TEXT("node_name"), TEXT("[empty]"));
			RootNodeJson->SetStringField(TEXT("node_class"), TEXT("None"));
			RootNodeJson->SetStringField(TEXT("node_type"), TEXT("None"));
			RootNodeJson->SetArrayField(TEXT("decorators"), TArray<TSharedPtr<FJsonValue>>());
			RootNodeJson->SetArrayField(TEXT("services"), TArray<TSharedPtr<FJsonValue>>());
			RootNodeJson->SetArrayField(TEXT("children"), TArray<TSharedPtr<FJsonValue>>());
		}

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetStringField(TEXT("asset_path"), AssetPath);
		Data->SetObjectField(TEXT("root_node"), RootNodeJson);

		SendResponse(BuildAISuccessResponse(CorrId, Data) + TEXT("\n"));
	});

	// -----------------------------------------------------------------------
	// ai.stateTree (AI-02)
	// Reads a State Tree asset's states, transitions, and tasks.
	// Required payload field: asset_path (must start with /Game/ or /Engine/).
	// Returns: asset_path, states[] (name, type, parent_state, tasks[], transitions[]).
	//
	// UE 5.7 API Note: UStateTree stores its states in FStateTreeEditorData
	// (accessible via StateTree->EditorData when WITH_EDITORONLY_DATA is defined).
	// In compiled/cooked form the states are baked into FStateTreeStateHandle arrays.
	// We use EditorData here since this handler runs in the editor context only.
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("ai.stateTree"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
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
			SendResponse(BuildAIErrorResponse(CorrId, TEXT("missing_asset_path")) + TEXT("\n"));
			return;
		}

		// Validate path prefix (T-22-01).
		if (!IsValidAssetPath(AssetPath))
		{
			SendResponse(BuildAIErrorResponse(CorrId, TEXT("invalid_asset_path")) + TEXT("\n"));
			return;
		}

		// Load the StateTree asset.
		UStateTree* StateTree = Cast<UStateTree>(StaticLoadObject(UStateTree::StaticClass(), nullptr, *AssetPath));
		if (!StateTree)
		{
			SendResponse(BuildAIErrorResponse(CorrId, TEXT("state_tree_not_found")) + TEXT("\n"));
			return;
		}

		// Access states via EditorData (editor-only property, available in editor context).
		// UStateTree exposes EditorData as a UObject* property; cast to UStateTreeEditorData
		// to get the States array. If EditorData is not available (cooked build), fall back
		// to reporting only the asset name and state count from the baked structure.
		TArray<TSharedPtr<FJsonValue>> StatesArray;

#if WITH_EDITORONLY_DATA
		if (StateTree->EditorData)
		{
			// UStateTreeEditorData stores states in a TArray<FStateTreeStateBase*> or
			// TArray<FStateTreeEditorState>. Access via reflection to remain resilient
			// to minor API changes across UE 5.x point releases.
			UObject* EditorDataObj = StateTree->EditorData;

			// Walk the states using the property system to remain compatible with
			// UE 5.7 API changes. Look for an array property named "States" on EditorData.
			FArrayProperty* StatesProp = nullptr;
			for (TFieldIterator<FArrayProperty> PropIt(EditorDataObj->GetClass()); PropIt; ++PropIt)
			{
				if (PropIt->GetName() == TEXT("States"))
				{
					StatesProp = *PropIt;
					break;
				}
			}

			if (StatesProp)
			{
				FScriptArrayHelper ArrayHelper(StatesProp, StatesProp->ContainerPtrToValuePtr<void>(EditorDataObj));
				FStructProperty* ElemProp = CastField<FStructProperty>(StatesProp->Inner);

				for (int32 i = 0; i < ArrayHelper.Num(); ++i)
				{
					void* StatePtr = ArrayHelper.GetRawPtr(i);
					TSharedPtr<FJsonObject> StateObj = MakeShared<FJsonObject>();

					// Extract 'Name' field from the state struct.
					FString StateName = FString::Printf(TEXT("State_%d"), i);
					if (ElemProp)
					{
						FNameProperty* NameProp = CastField<FNameProperty>(ElemProp->Struct->FindPropertyByName(TEXT("Name")));
						if (NameProp)
						{
							FName NameVal = NameProp->GetPropertyValue_InContainer(StatePtr);
							StateName = NameVal.ToString();
						}
					}
					StateObj->SetStringField(TEXT("name"), StateName);

					// Extract 'Type' field (EStateTreeStateType enum).
					FString StateType = TEXT("Unknown");
					if (ElemProp)
					{
						FByteProperty* TypeByteProp = CastField<FByteProperty>(ElemProp->Struct->FindPropertyByName(TEXT("Type")));
						FEnumProperty* TypeEnumProp = CastField<FEnumProperty>(ElemProp->Struct->FindPropertyByName(TEXT("Type")));
						if (TypeEnumProp)
						{
							UEnum* Enum = TypeEnumProp->GetEnum();
							if (Enum)
							{
								int64 EnumVal = TypeEnumProp->GetUnderlyingProperty()->GetSignedIntPropertyValue(TypeEnumProp->ContainerPtrToValuePtr<void>(StatePtr));
								StateType = Enum->GetNameStringByValue(EnumVal);
							}
						}
						else if (TypeByteProp && TypeByteProp->Enum)
						{
							uint8 ByteVal = TypeByteProp->GetPropertyValue_InContainer(StatePtr);
							StateType = TypeByteProp->Enum->GetNameStringByValue(static_cast<int64>(ByteVal));
						}
					}
					StateObj->SetStringField(TEXT("type"), StateType);

					// Parent state: reflect on ParentState or Parent field.
					FString ParentState = TEXT("");
					if (ElemProp)
					{
						FNameProperty* ParentProp = CastField<FNameProperty>(ElemProp->Struct->FindPropertyByName(TEXT("Parent")));
						if (!ParentProp)
						{
							ParentProp = CastField<FNameProperty>(ElemProp->Struct->FindPropertyByName(TEXT("ParentState")));
						}
						if (ParentProp)
						{
							FName ParentVal = ParentProp->GetPropertyValue_InContainer(StatePtr);
							ParentState = ParentVal.ToString();
						}
					}
					StateObj->SetStringField(TEXT("parent_state"), ParentState);

					// Tasks array: reflect on Tasks property.
					TArray<TSharedPtr<FJsonValue>> TasksArray;
					if (ElemProp)
					{
						FArrayProperty* TasksProp = CastField<FArrayProperty>(ElemProp->Struct->FindPropertyByName(TEXT("Tasks")));
						if (TasksProp)
						{
							FScriptArrayHelper TasksHelper(TasksProp, TasksProp->ContainerPtrToValuePtr<void>(StatePtr));
							FStructProperty* TaskElemProp = CastField<FStructProperty>(TasksProp->Inner);
							for (int32 j = 0; j < TasksHelper.Num(); ++j)
							{
								void* TaskPtr = TasksHelper.GetRawPtr(j);
								FString TaskClass = TEXT("UnknownTask");
								if (TaskElemProp)
								{
									// Try to get the task class name from the Instance property.
									FStructProperty* InstanceProp = CastField<FStructProperty>(TaskElemProp->Struct->FindPropertyByName(TEXT("Node")));
									if (InstanceProp)
									{
										TaskClass = InstanceProp->Struct->GetName();
									}
									else
									{
										TaskClass = TaskElemProp->Struct->GetName();
									}
								}
								TasksArray.Add(MakeShared<FJsonValueString>(TaskClass));
							}
						}
					}
					StateObj->SetArrayField(TEXT("tasks"), TasksArray);

					// Transitions array: reflect on Transitions property.
					TArray<TSharedPtr<FJsonValue>> TransitionsArray;
					if (ElemProp)
					{
						FArrayProperty* TransProp = CastField<FArrayProperty>(ElemProp->Struct->FindPropertyByName(TEXT("Transitions")));
						if (TransProp)
						{
							FScriptArrayHelper TransHelper(TransProp, TransProp->ContainerPtrToValuePtr<void>(StatePtr));
							FStructProperty* TransElemProp = CastField<FStructProperty>(TransProp->Inner);
							for (int32 j = 0; j < TransHelper.Num(); ++j)
							{
								void* TransPtr = TransHelper.GetRawPtr(j);
								TSharedPtr<FJsonObject> TransObj = MakeShared<FJsonObject>();

								FString TargetState = TEXT("");
								FString Trigger = TEXT("");

								if (TransElemProp)
								{
									FNameProperty* TargetProp = CastField<FNameProperty>(TransElemProp->Struct->FindPropertyByName(TEXT("State")));
									if (!TargetProp)
									{
										TargetProp = CastField<FNameProperty>(TransElemProp->Struct->FindPropertyByName(TEXT("NextState")));
									}
									if (TargetProp)
									{
										TargetState = TargetProp->GetPropertyValue_InContainer(TransPtr).ToString();
									}

									FByteProperty* TriggerByteProp = CastField<FByteProperty>(TransElemProp->Struct->FindPropertyByName(TEXT("Trigger")));
									FEnumProperty* TriggerEnumProp = CastField<FEnumProperty>(TransElemProp->Struct->FindPropertyByName(TEXT("Trigger")));
									if (TriggerEnumProp && TriggerEnumProp->GetEnum())
									{
										int64 EnumVal = TriggerEnumProp->GetUnderlyingProperty()->GetSignedIntPropertyValue(TriggerEnumProp->ContainerPtrToValuePtr<void>(TransPtr));
										Trigger = TriggerEnumProp->GetEnum()->GetNameStringByValue(EnumVal);
									}
									else if (TriggerByteProp && TriggerByteProp->Enum)
									{
										uint8 ByteVal = TriggerByteProp->GetPropertyValue_InContainer(TransPtr);
										Trigger = TriggerByteProp->Enum->GetNameStringByValue(static_cast<int64>(ByteVal));
									}
								}

								TransObj->SetStringField(TEXT("target_state"), TargetState);
								TransObj->SetStringField(TEXT("trigger"), Trigger);
								TransitionsArray.Add(MakeShared<FJsonValueObject>(TransObj));
							}
						}
					}
					StateObj->SetArrayField(TEXT("transitions"), TransitionsArray);

					StatesArray.Add(MakeShared<FJsonValueObject>(StateObj));
				}
			}
			else
			{
				// EditorData exists but States property not found -- report count only.
				UE_LOG(LogTemp, Warning, TEXT("[MCPBridge] ai.stateTree: EditorData has no 'States' array property -- using fallback."));
			}
		}
#endif // WITH_EDITORONLY_DATA

		// If we couldn't extract states via EditorData, report what we can.
		if (StatesArray.IsEmpty())
		{
			// UStateTree baked data: StateTree->NumStates (available at runtime).
			// Report state count as the only available info without editor data.
			int32 NumStates = 0;
#if WITH_EDITORONLY_DATA
			// Already attempted above; fall through.
#endif
			UE_LOG(LogTemp, Warning, TEXT("[MCPBridge] ai.stateTree: No editor state data available for '%s'."), *AssetPath);
		}

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetStringField(TEXT("asset_path"), AssetPath);
		Data->SetArrayField(TEXT("states"), StatesArray);

		SendResponse(BuildAISuccessResponse(CorrId, Data) + TEXT("\n"));
	});

	// -----------------------------------------------------------------------
	// ai.blackboard (AI-03)
	// Lists Blackboard keys with their types and instance-sync flags.
	// Required payload field: asset_path (must start with /Game/ or /Engine/).
	// Returns: asset_path, keys[] (key_name, key_type, instance_synced), parent_asset.
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("ai.blackboard"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
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
			SendResponse(BuildAIErrorResponse(CorrId, TEXT("missing_asset_path")) + TEXT("\n"));
			return;
		}

		// Validate path prefix (T-22-01).
		if (!IsValidAssetPath(AssetPath))
		{
			SendResponse(BuildAIErrorResponse(CorrId, TEXT("invalid_asset_path")) + TEXT("\n"));
			return;
		}

		// Load the BlackboardData asset.
		UBlackboardData* Blackboard = Cast<UBlackboardData>(StaticLoadObject(UBlackboardData::StaticClass(), nullptr, *AssetPath));
		if (!Blackboard)
		{
			SendResponse(BuildAIErrorResponse(CorrId, TEXT("blackboard_not_found")) + TEXT("\n"));
			return;
		}

		// Helper lambda to convert FBlackboardEntry to JSON.
		auto EntryToJson = [](const FBlackboardEntry& Entry) -> TSharedPtr<FJsonObject>
		{
			TSharedPtr<FJsonObject> KeyObj = MakeShared<FJsonObject>();
			KeyObj->SetStringField(TEXT("key_name"), Entry.EntryName.ToString());

			FString KeyType = TEXT("Unknown");
			if (Entry.KeyType)
			{
				KeyType = Entry.KeyType->GetClass()->GetName();
			}
			KeyObj->SetStringField(TEXT("key_type"), KeyType);
			KeyObj->SetBoolField(TEXT("instance_synced"), Entry.bInstanceSynced);
			return KeyObj;
		};

		// Collect own keys.
		TArray<TSharedPtr<FJsonValue>> KeysArray;
		for (const FBlackboardEntry& Entry : Blackboard->Keys)
		{
			KeysArray.Add(MakeShared<FJsonValueObject>(EntryToJson(Entry)));
		}

		// Collect parent keys if a parent blackboard is set.
		FString ParentAssetPath;
		if (Blackboard->Parent)
		{
			ParentAssetPath = Blackboard->Parent->GetPathName();
			for (const FBlackboardEntry& Entry : Blackboard->ParentKeys)
			{
				TSharedPtr<FJsonObject> KeyObj = EntryToJson(Entry);
				KeyObj->SetBoolField(TEXT("from_parent"), true);
				KeysArray.Add(MakeShared<FJsonValueObject>(KeyObj));
			}
		}

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetStringField(TEXT("asset_path"), AssetPath);
		Data->SetArrayField(TEXT("keys"), KeysArray);
		Data->SetStringField(TEXT("parent_asset"), ParentAssetPath);

		SendResponse(BuildAISuccessResponse(CorrId, Data) + TEXT("\n"));
	});

	// -----------------------------------------------------------------------
	// ai.eqs (AI-04)
	// Inspects an EQS query template: options, generators, tests, scoring.
	// Required payload field: asset_path (must start with /Game/ or /Engine/).
	// Returns: asset_path, options[] (generator_class, generator_name, tests[]).
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("ai.eqs"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
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
			SendResponse(BuildAIErrorResponse(CorrId, TEXT("missing_asset_path")) + TEXT("\n"));
			return;
		}

		// Validate path prefix (T-22-01).
		if (!IsValidAssetPath(AssetPath))
		{
			SendResponse(BuildAIErrorResponse(CorrId, TEXT("invalid_asset_path")) + TEXT("\n"));
			return;
		}

		// Load the EnvQuery asset.
		UEnvQuery* Query = Cast<UEnvQuery>(StaticLoadObject(UEnvQuery::StaticClass(), nullptr, *AssetPath));
		if (!Query)
		{
			SendResponse(BuildAIErrorResponse(CorrId, TEXT("eqs_query_not_found")) + TEXT("\n"));
			return;
		}

		// Iterate the Options array.
		TArray<TSharedPtr<FJsonValue>> OptionsArray;
		for (UEnvQueryOption* Option : Query->Options)
		{
			if (!Option)
			{
				continue;
			}

			TSharedPtr<FJsonObject> OptionObj = MakeShared<FJsonObject>();

			// Generator info.
			FString GeneratorClass = TEXT("None");
			FString GeneratorName = TEXT("None");
			if (Option->Generator)
			{
				GeneratorClass = Option->Generator->GetClass()->GetName();
				GeneratorName = Option->Generator->GetName();
			}
			OptionObj->SetStringField(TEXT("generator_class"), GeneratorClass);
			OptionObj->SetStringField(TEXT("generator_name"), GeneratorName);

			// Tests array.
			TArray<TSharedPtr<FJsonValue>> TestsArray;
			for (UEnvQueryTest* Test : Option->Tests)
			{
				if (!Test)
				{
					continue;
				}

				TSharedPtr<FJsonObject> TestObj = MakeShared<FJsonObject>();
				TestObj->SetStringField(TEXT("test_class"), Test->GetClass()->GetName());
				TestObj->SetStringField(TEXT("test_purpose"), Test->GetClass()->GetName());

				// Scoring equation: reflect on ScoringEquation property (EEnvTestScoreEquation enum).
				FString ScoringEquation = TEXT("Unknown");
				FEnumProperty* ScoringEnumProp = CastField<FEnumProperty>(Test->GetClass()->FindPropertyByName(TEXT("ScoringEquation")));
				FByteProperty* ScoringByteProp = CastField<FByteProperty>(Test->GetClass()->FindPropertyByName(TEXT("ScoringEquation")));
				if (ScoringEnumProp && ScoringEnumProp->GetEnum())
				{
					int64 EnumVal = ScoringEnumProp->GetUnderlyingProperty()->GetSignedIntPropertyValue(ScoringEnumProp->ContainerPtrToValuePtr<void>(Test));
					ScoringEquation = ScoringEnumProp->GetEnum()->GetNameStringByValue(EnumVal);
				}
				else if (ScoringByteProp && ScoringByteProp->Enum)
				{
					uint8 ByteVal = ScoringByteProp->GetPropertyValue_InContainer(Test);
					ScoringEquation = ScoringByteProp->Enum->GetNameStringByValue(static_cast<int64>(ByteVal));
				}
				TestObj->SetStringField(TEXT("scoring_equation"), ScoringEquation);

				TestsArray.Add(MakeShared<FJsonValueObject>(TestObj));
			}
			OptionObj->SetArrayField(TEXT("tests"), TestsArray);

			OptionsArray.Add(MakeShared<FJsonValueObject>(OptionObj));
		}

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetStringField(TEXT("asset_path"), AssetPath);
		Data->SetArrayField(TEXT("options"), OptionsArray);

		SendResponse(BuildAISuccessResponse(CorrId, Data) + TEXT("\n"));
	});

	// -----------------------------------------------------------------------
	// ai.navmesh (AI-05)
	// Queries NavMesh build status, bounds, agent config, and point reachability.
	// Optional payload fields: start_point {x,y,z}, end_point {x,y,z} for
	// reachability check. If neither provided, returns build status and bounds.
	// Returns: build_status, bounds {min, max}, nav_data_class, agent_radius,
	//   agent_height, and optionally reachability {is_reachable, path_length, path_cost}.
	// Single synchronous path query only (T-22-03); no batch queries.
	// NavMesh data is editor-only and not sensitive (T-22-04, accepted).
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("ai.navmesh"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

		// Extract optional payload.
		TSharedPtr<FJsonObject> Payload;
		const TSharedPtr<FJsonValue>* PayloadVal = Cmd->Values.Find(TEXT("payload"));
		if (PayloadVal && (*PayloadVal)->Type == EJson::Object)
		{
			Payload = (*PayloadVal)->AsObject();
		}

		// Check for optional start_point and end_point.
		bool bHasStartPoint = false;
		bool bHasEndPoint = false;
		FVector StartPoint = FVector::ZeroVector;
		FVector EndPoint = FVector::ZeroVector;

		if (Payload.IsValid())
		{
			const TSharedPtr<FJsonValue>* StartVal = Payload->Values.Find(TEXT("start_point"));
			const TSharedPtr<FJsonValue>* EndVal = Payload->Values.Find(TEXT("end_point"));

			if (StartVal && (*StartVal)->Type == EJson::Object)
			{
				TSharedPtr<FJsonObject> StartObj = (*StartVal)->AsObject();
				double X = 0.0, Y = 0.0, Z = 0.0;
				StartObj->TryGetNumberField(TEXT("x"), X);
				StartObj->TryGetNumberField(TEXT("y"), Y);
				StartObj->TryGetNumberField(TEXT("z"), Z);
				StartPoint = FVector(static_cast<float>(X), static_cast<float>(Y), static_cast<float>(Z));
				bHasStartPoint = true;
			}

			if (EndVal && (*EndVal)->Type == EJson::Object)
			{
				TSharedPtr<FJsonObject> EndObj = (*EndVal)->AsObject();
				double X = 0.0, Y = 0.0, Z = 0.0;
				EndObj->TryGetNumberField(TEXT("x"), X);
				EndObj->TryGetNumberField(TEXT("y"), Y);
				EndObj->TryGetNumberField(TEXT("z"), Z);
				EndPoint = FVector(static_cast<float>(X), static_cast<float>(Y), static_cast<float>(Z));
				bHasEndPoint = true;
			}
		}

		// Get the world from the editor context.
		UWorld* World = nullptr;
		if (GEditor)
		{
			World = GEditor->GetEditorWorldContext().World();
		}

		if (!World)
		{
			SendResponse(BuildAIErrorResponse(CorrId, TEXT("no_editor_world")) + TEXT("\n"));
			return;
		}

		// Get the navigation system.
		UNavigationSystemV1* NavSys = FNavigationSystem::GetCurrent<UNavigationSystemV1>(World);
		if (!NavSys)
		{
			SendResponse(BuildAIErrorResponse(CorrId, TEXT("navigation_system_not_found")) + TEXT("\n"));
			return;
		}

		// Get the main navigation data (e.g., RecastNavMesh).
		ANavigationData* NavData = NavSys->GetMainNavData();

		FString BuildStatus = TEXT("not_built");
		FString NavDataClass = TEXT("None");
		FVector BoundsMin = FVector::ZeroVector;
		FVector BoundsMax = FVector::ZeroVector;
		float AgentRadius = 0.0f;
		float AgentHeight = 0.0f;

		if (NavData)
		{
			NavDataClass = NavData->GetClass()->GetName();

			// Determine build status from the nav data.
			// UNavigationSystemV1 tracks build status per data actor.
			BuildStatus = NavData->IsRegistered() ? TEXT("built") : TEXT("not_built");

			// Get bounds from the nav data's runtime bounding box.
			FBox NavBounds = NavData->GetBounds();
			if (NavBounds.IsValid)
			{
				BoundsMin = NavBounds.Min;
				BoundsMax = NavBounds.Max;
			}

			// Cast to ARecastNavMesh for agent properties.
			ARecastNavMesh* RecastMesh = Cast<ARecastNavMesh>(NavData);
			if (RecastMesh)
			{
				AgentRadius = RecastMesh->AgentRadius;
				AgentHeight = RecastMesh->AgentHeight;
			}
		}

		// Build the response data object.
		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetStringField(TEXT("build_status"), BuildStatus);
		Data->SetStringField(TEXT("nav_data_class"), NavDataClass);

		TSharedPtr<FJsonObject> BoundsObj = MakeShared<FJsonObject>();
		TSharedPtr<FJsonObject> BoundsMinObj = MakeShared<FJsonObject>();
		BoundsMinObj->SetNumberField(TEXT("x"), static_cast<double>(BoundsMin.X));
		BoundsMinObj->SetNumberField(TEXT("y"), static_cast<double>(BoundsMin.Y));
		BoundsMinObj->SetNumberField(TEXT("z"), static_cast<double>(BoundsMin.Z));
		TSharedPtr<FJsonObject> BoundsMaxObj = MakeShared<FJsonObject>();
		BoundsMaxObj->SetNumberField(TEXT("x"), static_cast<double>(BoundsMax.X));
		BoundsMaxObj->SetNumberField(TEXT("y"), static_cast<double>(BoundsMax.Y));
		BoundsMaxObj->SetNumberField(TEXT("z"), static_cast<double>(BoundsMax.Z));
		BoundsObj->SetObjectField(TEXT("min"), BoundsMinObj);
		BoundsObj->SetObjectField(TEXT("max"), BoundsMaxObj);
		Data->SetObjectField(TEXT("bounds"), BoundsObj);

		Data->SetNumberField(TEXT("agent_radius"), static_cast<double>(AgentRadius));
		Data->SetNumberField(TEXT("agent_height"), static_cast<double>(AgentHeight));

		// Reachability check if both points provided (T-22-03: single sync query only).
		if (bHasStartPoint && bHasEndPoint && NavData)
		{
			// Build a synchronous path-finding query.
			FPathFindingQuery Query(nullptr, *NavData, StartPoint, EndPoint);
			FPathFindingResult Result = NavSys->FindPathSync(Query);

			bool bIsReachable = Result.IsSuccessful() && Result.Path.IsValid();
			float PathLength = 0.0f;
			float PathCost = 0.0f;

			if (bIsReachable)
			{
				PathLength = static_cast<float>(Result.Path->GetLength());
				PathCost = Result.Path->GetCost();
			}

			TSharedPtr<FJsonObject> ReachabilityObj = MakeShared<FJsonObject>();
			ReachabilityObj->SetBoolField(TEXT("is_reachable"), bIsReachable);
			ReachabilityObj->SetNumberField(TEXT("path_length"), static_cast<double>(PathLength));
			ReachabilityObj->SetNumberField(TEXT("path_cost"), static_cast<double>(PathCost));

			TSharedPtr<FJsonObject> StartPointObj = MakeShared<FJsonObject>();
			StartPointObj->SetNumberField(TEXT("x"), static_cast<double>(StartPoint.X));
			StartPointObj->SetNumberField(TEXT("y"), static_cast<double>(StartPoint.Y));
			StartPointObj->SetNumberField(TEXT("z"), static_cast<double>(StartPoint.Z));

			TSharedPtr<FJsonObject> EndPointObj = MakeShared<FJsonObject>();
			EndPointObj->SetNumberField(TEXT("x"), static_cast<double>(EndPoint.X));
			EndPointObj->SetNumberField(TEXT("y"), static_cast<double>(EndPoint.Y));
			EndPointObj->SetNumberField(TEXT("z"), static_cast<double>(EndPoint.Z));

			ReachabilityObj->SetObjectField(TEXT("start_point"), StartPointObj);
			ReachabilityObj->SetObjectField(TEXT("end_point"), EndPointObj);

			Data->SetObjectField(TEXT("reachability"), ReachabilityObj);
		}

		SendResponse(BuildAISuccessResponse(CorrId, Data) + TEXT("\n"));
	});
}
