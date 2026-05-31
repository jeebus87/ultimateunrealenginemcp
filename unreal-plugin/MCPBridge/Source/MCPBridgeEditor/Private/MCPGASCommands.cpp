// MCPGASCommands.cpp (Plan 25-01)
// Implements four Gameplay Ability System inspection command handlers for the MCP bridge:
//   gas.abilities    -- list all Gameplay Ability classes with tags, costs, and cooldowns (GAS-01)
//   gas.effects      -- inspect Gameplay Effect modifiers, duration policy, stacking, period (GAS-02)
//   gas.attributes   -- read Attribute Set definitions with base values and clamping info (GAS-03)
//   gas.tags         -- query Gameplay Tag hierarchy and find assets using specific tags (GAS-04)
//
// All handlers run on the game thread via FMCPCommandRouter::Dispatch.
// All operations are read-only -- no Modify() calls needed.
// asset_path is validated to start with "/Game/" or "/Engine/" before any
// StaticLoadObject call to prevent path traversal (T-25-01).
// gas.abilities results are capped at 500 to prevent DoS (T-25-02).
// gas.tags reverse lookup tagged_assets are capped at 200 to prevent DoS (T-25-03).

#include "MCPGASCommands.h"

// Gameplay Ability System headers
#include "Abilities/GameplayAbility.h"
#include "GameplayEffect.h"
#include "AttributeSet.h"
#include "GameplayEffectTypes.h"

// Gameplay Tags headers
#include "GameplayTagsManager.h"
#include "GameplayTagContainer.h"

// Asset Registry
#include "AssetRegistry/AssetRegistryModule.h"
#include "AssetRegistry/IAssetRegistry.h"

// UObject reflection
#include "UObject/Class.h"
#include "UObject/UnrealType.h"
#include "UObject/ObjectMacros.h"

// Engine
#include "Engine/Blueprint.h"

// JSON
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Returns a JSON success response string (without trailing newline). */
static FString BuildGASSuccessResponse(const FString& CorrId, TSharedPtr<FJsonObject> Data)
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
static FString BuildGASErrorResponse(const FString& CorrId, const FString& Error)
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
 * path traversal attacks (T-25-01).
 */
static bool IsValidAssetPath(const FString& AssetPath)
{
	return AssetPath.StartsWith(TEXT("/Game/")) || AssetPath.StartsWith(TEXT("/Engine/"));
}

/**
 * Convert a FGameplayTagContainer to a JSON array of tag name strings.
 */
static TArray<TSharedPtr<FJsonValue>> GameplayTagContainerToJsonArray(const FGameplayTagContainer& Container)
{
	TArray<TSharedPtr<FJsonValue>> TagArray;
	for (const FGameplayTag& Tag : Container)
	{
		TagArray.Add(MakeShared<FJsonValueString>(Tag.ToString()));
	}
	return TagArray;
}

/**
 * Extract the display name of an enum value from a UObject property using reflection.
 * Returns "Unknown" if the property cannot be found or cast.
 */
static FString GetEnumPropertyDisplayName(const UObject* Obj, const FString& PropertyName)
{
	if (!Obj)
	{
		return TEXT("Unknown");
	}

	FProperty* Prop = Obj->GetClass()->FindPropertyByName(FName(*PropertyName));
	if (!Prop)
	{
		return TEXT("Unknown");
	}

	// Try FEnumProperty (UE5 preferred pattern for typed enums)
	if (FEnumProperty* EnumProp = CastField<FEnumProperty>(Prop))
	{
		const void* ValuePtr = EnumProp->ContainerPtrToValuePtr<void>(Obj);
		int64 EnumValue = EnumProp->GetUnderlyingProperty()->GetSignedIntPropertyValue(ValuePtr);
		UEnum* Enum = EnumProp->GetEnum();
		if (Enum)
		{
			return Enum->GetNameStringByValue(EnumValue);
		}
		return FString::Printf(TEXT("%lld"), EnumValue);
	}

	// Try FByteProperty (older TEnumAsByte<> pattern)
	if (FByteProperty* ByteProp = CastField<FByteProperty>(Prop))
	{
		const void* ValuePtr = ByteProp->ContainerPtrToValuePtr<void>(Obj);
		uint8 EnumValue = ByteProp->GetPropertyValue(ValuePtr);
		UEnum* Enum = ByteProp->Enum;
		if (Enum)
		{
			return Enum->GetNameStringByValue((int64)EnumValue);
		}
		return FString::Printf(TEXT("%d"), (int32)EnumValue);
	}

	return TEXT("Unknown");
}

// ---------------------------------------------------------------------------
// gas.abilities handler (GAS-01)
// ---------------------------------------------------------------------------

static void HandleGasAbilities(TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
{
	FString CorrId;
	Cmd->TryGetStringField(TEXT("correlationId"), CorrId);

	// Optional class_filter payload field
	FString ClassFilter;
	const TSharedPtr<FJsonObject>* PayloadPtr = nullptr;
	if (Cmd->TryGetObjectField(TEXT("payload"), PayloadPtr) && PayloadPtr && PayloadPtr->IsValid())
	{
		(*PayloadPtr)->TryGetStringField(TEXT("class_filter"), ClassFilter);
	}

	// Discover all UGameplayAbility subclass assets via the asset registry
	IAssetRegistry& AssetRegistry = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry")).Get();

	// Ensure registry is up to date
	AssetRegistry.SearchAllAssets(/*bSynchronousSearch=*/false);

	FTopLevelAssetPath AbilityClassPath(UGameplayAbility::StaticClass()->GetPathName());
	TArray<FAssetData> AssetList;
	AssetRegistry.GetAssetsByClass(AbilityClassPath, AssetList, /*bSearchSubClasses=*/true);

	// Cap results at 500 (T-25-02)
	constexpr int32 MaxAbilities = 500;
	bool bCapped = AssetList.Num() > MaxAbilities;
	if (bCapped)
	{
		AssetList.SetNum(MaxAbilities);
	}

	TArray<TSharedPtr<FJsonValue>> AbilitiesArray;
	for (const FAssetData& AssetData : AssetList)
	{
		// Apply optional class filter on asset name
		if (!ClassFilter.IsEmpty() && !AssetData.AssetName.ToString().Contains(ClassFilter))
		{
			continue;
		}

		// Validate path prefix (T-25-01) -- skip assets outside /Game/ or /Engine/
		FString AssetPath = AssetData.GetObjectPathString();
		if (!IsValidAssetPath(AssetPath))
		{
			continue;
		}

		// Load the ability CDO
		UGameplayAbility* AbilityCDO = Cast<UGameplayAbility>(
			StaticLoadObject(UGameplayAbility::StaticClass(), nullptr, *AssetPath)
		);

		// For Blueprint assets, try loading via Blueprint->GeneratedClass
		if (!AbilityCDO)
		{
			UBlueprint* BP = Cast<UBlueprint>(
				StaticLoadObject(UBlueprint::StaticClass(), nullptr, *AssetPath)
			);
			if (BP && BP->GeneratedClass)
			{
				AbilityCDO = Cast<UGameplayAbility>(BP->GeneratedClass->GetDefaultObject());
			}
		}

		if (!AbilityCDO)
		{
			continue;
		}

		TSharedPtr<FJsonObject> AbilityObj = MakeShared<FJsonObject>();
		AbilityObj->SetStringField(TEXT("class_name"), AbilityCDO->GetClass()->GetName());
		AbilityObj->SetStringField(TEXT("asset_path"), AssetPath);

		// Ability tags
		AbilityObj->SetArrayField(TEXT("ability_tags"),
			GameplayTagContainerToJsonArray(AbilityCDO->AbilityTags));

		// Cancel / block tags
		AbilityObj->SetArrayField(TEXT("cancel_abilities_with_tag"),
			GameplayTagContainerToJsonArray(AbilityCDO->CancelAbilitiesWithTag));
		AbilityObj->SetArrayField(TEXT("block_abilities_with_tag"),
			GameplayTagContainerToJsonArray(AbilityCDO->BlockAbilitiesWithTag));

		// Cost and cooldown GE class references
		FString CostGEName = AbilityCDO->CostGameplayEffectClass
			? AbilityCDO->CostGameplayEffectClass->GetName()
			: TEXT("None");
		FString CooldownGEName = AbilityCDO->CooldownGameplayEffectClass
			? AbilityCDO->CooldownGameplayEffectClass->GetName()
			: TEXT("None");
		AbilityObj->SetStringField(TEXT("cost_gameplay_effect_class"), CostGEName);
		AbilityObj->SetStringField(TEXT("cooldown_gameplay_effect_class"), CooldownGEName);

		// Instancing policy via reflection
		FString InstancingPolicy = GetEnumPropertyDisplayName(AbilityCDO, TEXT("InstancingPolicy"));
		AbilityObj->SetStringField(TEXT("instancing_policy"), InstancingPolicy);

		AbilitiesArray.Add(MakeShared<FJsonValueObject>(AbilityObj));
	}

	TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
	Data->SetArrayField(TEXT("abilities"), AbilitiesArray);
	if (bCapped)
	{
		Data->SetBoolField(TEXT("capped"), true);
		Data->SetNumberField(TEXT("cap_limit"), MaxAbilities);
	}

	SendResponse(BuildGASSuccessResponse(CorrId, Data) + TEXT("\n"));
}

// ---------------------------------------------------------------------------
// gas.effects handler (GAS-02)
// ---------------------------------------------------------------------------

static void HandleGasEffects(TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
{
	FString CorrId;
	Cmd->TryGetStringField(TEXT("correlationId"), CorrId);

	FString AssetPath;
	const TSharedPtr<FJsonObject>* PayloadPtr = nullptr;
	if (Cmd->TryGetObjectField(TEXT("payload"), PayloadPtr) && PayloadPtr && PayloadPtr->IsValid())
	{
		(*PayloadPtr)->TryGetStringField(TEXT("asset_path"), AssetPath);
	}

	if (AssetPath.IsEmpty())
	{
		SendResponse(BuildGASErrorResponse(CorrId, TEXT("payload.asset_path is required")) + TEXT("\n"));
		return;
	}

	// Validate path (T-25-01)
	if (!IsValidAssetPath(AssetPath))
	{
		SendResponse(BuildGASErrorResponse(CorrId,
			TEXT("asset_path must start with /Game/ or /Engine/")) + TEXT("\n"));
		return;
	}

	// Load as UGameplayEffect CDO
	UGameplayEffect* GEObj = Cast<UGameplayEffect>(
		StaticLoadObject(UGameplayEffect::StaticClass(), nullptr, *AssetPath)
	);

	// For Blueprint-based GEs
	if (!GEObj)
	{
		UBlueprint* BP = Cast<UBlueprint>(
			StaticLoadObject(UBlueprint::StaticClass(), nullptr, *AssetPath)
		);
		if (BP && BP->GeneratedClass)
		{
			GEObj = Cast<UGameplayEffect>(BP->GeneratedClass->GetDefaultObject());
		}
	}

	if (!GEObj)
	{
		SendResponse(BuildGASErrorResponse(CorrId,
			FString::Printf(TEXT("Failed to load UGameplayEffect at: %s"), *AssetPath)) + TEXT("\n"));
		return;
	}

	TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
	Data->SetStringField(TEXT("asset_path"), AssetPath);

	// Duration policy via reflection
	FString DurationPolicy = GetEnumPropertyDisplayName(GEObj, TEXT("DurationPolicy"));
	Data->SetStringField(TEXT("duration_policy"), DurationPolicy);

	// Modifiers array
	TArray<TSharedPtr<FJsonValue>> ModifiersArray;
	for (const FGameplayModifierInfo& ModInfo : GEObj->Modifiers)
	{
		TSharedPtr<FJsonObject> ModObj = MakeShared<FJsonObject>();

		// Attribute name and owning set
		ModObj->SetStringField(TEXT("attribute"), ModInfo.Attribute.GetName());
		FString AttrSetName = ModInfo.Attribute.GetAttributeSetClass()
			? ModInfo.Attribute.GetAttributeSetClass()->GetName()
			: TEXT("None");
		ModObj->SetStringField(TEXT("attribute_set"), AttrSetName);

		// Modifier operation via reflection on FGameplayModifierInfo
		// ModifierOp is an EGameplayModOp::Type inside FGameplayModifierInfo
		// We reflect on the struct property directly
		FString ModOpStr = TEXT("Unknown");
		{
			UScriptStruct* ModInfoStruct = FGameplayModifierInfo::StaticStruct();
			if (ModInfoStruct)
			{
				FProperty* ModOpProp = ModInfoStruct->FindPropertyByName(TEXT("ModifierOp"));
				if (FByteProperty* ByteProp = CastField<FByteProperty>(ModOpProp))
				{
					const void* ValuePtr = ByteProp->ContainerPtrToValuePtr<void>(&ModInfo);
					uint8 EnumVal = ByteProp->GetPropertyValue(ValuePtr);
					UEnum* Enum = ByteProp->Enum;
					if (Enum)
					{
						ModOpStr = Enum->GetNameStringByValue((int64)EnumVal);
					}
					else
					{
						ModOpStr = FString::Printf(TEXT("%d"), (int32)EnumVal);
					}
				}
				else if (FEnumProperty* EnumProp = CastField<FEnumProperty>(ModOpProp))
				{
					const void* ValuePtr = EnumProp->ContainerPtrToValuePtr<void>(&ModInfo);
					int64 EnumVal = EnumProp->GetUnderlyingProperty()->GetSignedIntPropertyValue(ValuePtr);
					UEnum* Enum = EnumProp->GetEnum();
					if (Enum)
					{
						ModOpStr = Enum->GetNameStringByValue(EnumVal);
					}
					else
					{
						ModOpStr = FString::Printf(TEXT("%lld"), EnumVal);
					}
				}
			}
		}
		ModObj->SetStringField(TEXT("modifier_op"), ModOpStr);

		// Magnitude value
		FString MagnitudeDesc;
		{
			const FGameplayEffectModifierMagnitude& Mag = ModInfo.ModifierMagnitude;
			EGameplayEffectMagnitudeCalculation MagType = Mag.GetMagnitudeCalculationType();
			switch (MagType)
			{
				case EGameplayEffectMagnitudeCalculation::ScalableFloat:
				{
					float ScalarValue = 0.0f;
					Mag.GetStaticMagnitudeIfPossible(1.0f, ScalarValue);
					MagnitudeDesc = FString::Printf(TEXT("%f"), ScalarValue);
					break;
				}
				case EGameplayEffectMagnitudeCalculation::AttributeBased:
					MagnitudeDesc = TEXT("AttributeBased");
					break;
				case EGameplayEffectMagnitudeCalculation::CustomCalculationClass:
					MagnitudeDesc = TEXT("Custom");
					break;
				case EGameplayEffectMagnitudeCalculation::SetByCaller:
					MagnitudeDesc = TEXT("SetByCaller");
					break;
				default:
					MagnitudeDesc = TEXT("Calculated");
					break;
			}
		}
		ModObj->SetStringField(TEXT("magnitude_value"), MagnitudeDesc);

		ModifiersArray.Add(MakeShared<FJsonValueObject>(ModObj));
	}
	Data->SetArrayField(TEXT("modifiers"), ModifiersArray);

	// Stacking type and limit via reflection
	FString StackingType = GetEnumPropertyDisplayName(GEObj, TEXT("StackingType"));
	Data->SetStringField(TEXT("stacking_type"), StackingType);
	Data->SetNumberField(TEXT("stack_limit_count"), (double)GEObj->StackLimitCount);

	// Period interval (period is a FScalableFloat, extract base value)
	float PeriodValue = 0.0f;
	GEObj->Period.GetStaticValue(PeriodValue);
	Data->SetNumberField(TEXT("period_interval"), (double)PeriodValue);

	// Gameplay Cue tags
	Data->SetArrayField(TEXT("gameplay_cue_tags"),
		GameplayTagContainerToJsonArray(GEObj->GameplayCueTags));

	SendResponse(BuildGASSuccessResponse(CorrId, Data) + TEXT("\n"));
}

// ---------------------------------------------------------------------------
// gas.attributes handler (GAS-03)
// ---------------------------------------------------------------------------

static void HandleGasAttributes(TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
{
	FString CorrId;
	Cmd->TryGetStringField(TEXT("correlationId"), CorrId);

	FString AssetPath;
	const TSharedPtr<FJsonObject>* PayloadPtr = nullptr;
	if (Cmd->TryGetObjectField(TEXT("payload"), PayloadPtr) && PayloadPtr && PayloadPtr->IsValid())
	{
		(*PayloadPtr)->TryGetStringField(TEXT("asset_path"), AssetPath);
	}

	if (AssetPath.IsEmpty())
	{
		SendResponse(BuildGASErrorResponse(CorrId, TEXT("payload.asset_path is required")) + TEXT("\n"));
		return;
	}

	// Validate path (T-25-01)
	if (!IsValidAssetPath(AssetPath))
	{
		SendResponse(BuildGASErrorResponse(CorrId,
			TEXT("asset_path must start with /Game/ or /Engine/")) + TEXT("\n"));
		return;
	}

	// Attempt to load as AttributeSet -- try Blueprint first, then direct CDO
	UClass* AttrSetClass = nullptr;
	UAttributeSet* AttrSetCDO = nullptr;

	// Try Blueprint path
	UBlueprint* BP = Cast<UBlueprint>(
		StaticLoadObject(UBlueprint::StaticClass(), nullptr, *AssetPath)
	);
	if (BP && BP->GeneratedClass && BP->GeneratedClass->IsChildOf(UAttributeSet::StaticClass()))
	{
		AttrSetClass = BP->GeneratedClass;
		AttrSetCDO = Cast<UAttributeSet>(AttrSetClass->GetDefaultObject());
	}

	// Try loading directly as a native class CDO
	if (!AttrSetCDO)
	{
		AttrSetCDO = Cast<UAttributeSet>(
			StaticLoadObject(UAttributeSet::StaticClass(), nullptr, *AssetPath)
		);
		if (AttrSetCDO)
		{
			AttrSetClass = AttrSetCDO->GetClass();
		}
	}

	// Try StaticLoadClass for native classes
	if (!AttrSetCDO)
	{
		AttrSetClass = StaticLoadClass(UAttributeSet::StaticClass(), nullptr, *AssetPath);
		if (AttrSetClass)
		{
			AttrSetCDO = Cast<UAttributeSet>(AttrSetClass->GetDefaultObject());
		}
	}

	if (!AttrSetCDO || !AttrSetClass)
	{
		SendResponse(BuildGASErrorResponse(CorrId,
			FString::Printf(TEXT("Failed to load UAttributeSet at: %s"), *AssetPath)) + TEXT("\n"));
		return;
	}

	TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
	Data->SetStringField(TEXT("class_name"), AttrSetClass->GetName());

	// Iterate numeric properties (float attributes on attribute sets)
	TArray<TSharedPtr<FJsonValue>> AttributesArray;
	for (TFieldIterator<FNumericProperty> PropIt(AttrSetClass, EFieldIteratorFlags::IncludeSuper); PropIt; ++PropIt)
	{
		FNumericProperty* NumProp = *PropIt;
		if (!NumProp)
		{
			continue;
		}

		// Only include replicated or BlueprintReadOnly properties (typical for GAS attributes)
		// We include all numeric properties on AttributeSet subclasses as they are attributes
		TSharedPtr<FJsonObject> AttrObj = MakeShared<FJsonObject>();
		AttrObj->SetStringField(TEXT("attribute_name"), NumProp->GetName());

		// Read base value from CDO
		double BaseValue = 0.0;
		if (NumProp->IsFloatingPoint())
		{
			const void* ValuePtr = NumProp->ContainerPtrToValuePtr<void>(AttrSetCDO);
			BaseValue = NumProp->GetFloatingPointPropertyValue(ValuePtr);
		}
		else if (NumProp->IsInteger())
		{
			const void* ValuePtr = NumProp->ContainerPtrToValuePtr<void>(AttrSetCDO);
			BaseValue = (double)NumProp->GetSignedIntPropertyValue(ValuePtr);
		}
		AttrObj->SetNumberField(TEXT("base_value"), BaseValue);

		// Replication check
		bool bReplicated = NumProp->HasAnyPropertyFlags(CPF_Net);
		AttrObj->SetBoolField(TEXT("replicated"), bReplicated);

		// Clamping note -- exact clamp values require inspecting PreAttributeBaseChange
		// override implementation which is not reliably extractable at CDO level
		bool bHasClamping = AttrSetClass->IsFunctionImplementedInScript(TEXT("PreAttributeBaseChange")) ||
		                    AttrSetClass->IsFunctionImplementedInScript(TEXT("PostAttributeChange"));
		AttrObj->SetBoolField(TEXT("has_clamping"), bHasClamping);
		if (bHasClamping)
		{
			AttrObj->SetStringField(TEXT("clamp_note"), TEXT("check_implementation"));
		}

		AttributesArray.Add(MakeShared<FJsonValueObject>(AttrObj));
	}
	Data->SetArrayField(TEXT("attributes"), AttributesArray);

	SendResponse(BuildGASSuccessResponse(CorrId, Data) + TEXT("\n"));
}

// ---------------------------------------------------------------------------
// gas.tags handler (GAS-04)
// ---------------------------------------------------------------------------

static void HandleGasTags(TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
{
	FString CorrId;
	Cmd->TryGetStringField(TEXT("correlationId"), CorrId);

	FString TagFilter;
	FString FindAssetsWithTag;
	const TSharedPtr<FJsonObject>* PayloadPtr = nullptr;
	if (Cmd->TryGetObjectField(TEXT("payload"), PayloadPtr) && PayloadPtr && PayloadPtr->IsValid())
	{
		(*PayloadPtr)->TryGetStringField(TEXT("tag_filter"), TagFilter);
		(*PayloadPtr)->TryGetStringField(TEXT("find_assets_with_tag"), FindAssetsWithTag);
	}

	UGameplayTagsManager& TagsManager = UGameplayTagsManager::Get();

	// Gather all registered gameplay tags
	FGameplayTagContainer AllTagsContainer;
	TagsManager.RequestAllGameplayTags(AllTagsContainer, /*bOnlyIncludeDictionaryTags=*/false);

	TArray<TSharedPtr<FJsonValue>> TagsArray;
	for (const FGameplayTag& Tag : AllTagsContainer)
	{
		FString TagName = Tag.ToString();

		// Apply filter if provided
		if (!TagFilter.IsEmpty() && !TagName.StartsWith(TagFilter) && !TagName.Contains(TagFilter))
		{
			continue;
		}

		TagsArray.Add(MakeShared<FJsonValueString>(TagName));
	}

	TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
	Data->SetArrayField(TEXT("tags"), TagsArray);
	Data->SetNumberField(TEXT("total_registered"), (double)AllTagsContainer.Num());
	if (!TagFilter.IsEmpty())
	{
		Data->SetStringField(TEXT("tag_filter"), TagFilter);
	}

	// Optional reverse lookup: find assets that reference a given tag (T-25-03: cap at 200)
	if (!FindAssetsWithTag.IsEmpty())
	{
		// Validate the tag exists
		FGameplayTag LookupTag = TagsManager.RequestGameplayTag(FName(*FindAssetsWithTag), /*ErrorIfNotFound=*/false);

		TArray<TSharedPtr<FJsonValue>> TaggedAssetsArray;

		if (LookupTag.IsValid())
		{
			IAssetRegistry& AssetRegistry = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry")).Get();

			// Search /Game/ for assets
			TArray<FAssetData> AllAssets;
			AssetRegistry.GetAllAssets(AllAssets, /*bSkipARFilteredAssets=*/false);

			constexpr int32 MaxTaggedAssets = 200;
			int32 Found = 0;
			bool bTaggedCapped = false;

			for (const FAssetData& AssetData : AllAssets)
			{
				if (Found >= MaxTaggedAssets)
				{
					bTaggedCapped = true;
					break;
				}

				FString AssetPath = AssetData.GetObjectPathString();
				if (!IsValidAssetPath(AssetPath))
				{
					continue;
				}

				// Check if this asset has the tag in its tags metadata
				// FAssetData::TagsAndValues contains gameplay-relevant tags
				bool bHasTag = false;
				FAssetDataTagMapSharedView::FFindTagResult TagResult =
					AssetData.TagsAndValues.FindTag(TEXT("GameplayTags"));
				if (TagResult.IsSet())
				{
					bHasTag = TagResult.GetValue().Contains(FindAssetsWithTag);
				}

				if (!bHasTag)
				{
					// Also check AssetBundleData tag
					FAssetDataTagMapSharedView::FFindTagResult BundleResult =
						AssetData.TagsAndValues.FindTag(TEXT("AssetBundleData"));
					if (BundleResult.IsSet())
					{
						bHasTag = BundleResult.GetValue().Contains(FindAssetsWithTag);
					}
				}

				if (bHasTag)
				{
					TaggedAssetsArray.Add(MakeShared<FJsonValueString>(AssetPath));
					++Found;
				}
			}

			if (bTaggedCapped)
			{
				Data->SetBoolField(TEXT("tagged_assets_capped"), true);
				Data->SetNumberField(TEXT("tagged_assets_cap_limit"), MaxTaggedAssets);
			}
		}
		else
		{
			UE_LOG(LogTemp, Warning, TEXT("[MCPGASCommands] gas.tags: tag '%s' not found in registry"),
				*FindAssetsWithTag);
		}

		Data->SetArrayField(TEXT("tagged_assets"), TaggedAssetsArray);
		Data->SetStringField(TEXT("find_assets_with_tag"), FindAssetsWithTag);
	}

	SendResponse(BuildGASSuccessResponse(CorrId, Data) + TEXT("\n"));
}

// ---------------------------------------------------------------------------
// RegisterGASCommands -- wire all four handlers into the router
// ---------------------------------------------------------------------------

void RegisterGASCommands(FMCPCommandRouter& Router)
{
	// gas.abilities -- list all Gameplay Ability classes with tags, costs, and cooldowns (GAS-01)
	Router.RegisterHandler(TEXT("gas.abilities"),
		[](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
		{
			HandleGasAbilities(Cmd, SendResponse);
		});

	// gas.effects -- inspect Gameplay Effect modifiers, duration policy, stacking, period (GAS-02)
	Router.RegisterHandler(TEXT("gas.effects"),
		[](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
		{
			HandleGasEffects(Cmd, SendResponse);
		});

	// gas.attributes -- read Attribute Set definitions with base values and clamping info (GAS-03)
	Router.RegisterHandler(TEXT("gas.attributes"),
		[](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
		{
			HandleGasAttributes(Cmd, SendResponse);
		});

	// gas.tags -- query Gameplay Tag hierarchy and find assets using specific tags (GAS-04)
	Router.RegisterHandler(TEXT("gas.tags"),
		[](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
		{
			HandleGasTags(Cmd, SendResponse);
		});
}
