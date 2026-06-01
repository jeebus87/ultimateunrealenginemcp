// MCPGASCommands.cpp (Plan 33-04)
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
//
// Reflection-based: NO direct #include of GameplayAbilities module headers.
// UGameplayAbility, UGameplayEffect, UAttributeSet types are located at runtime
// via FindObject<UClass>. GameplayTags types are core (in Build.cs) and use
// direct includes.

#include "MCPGASCommands.h"
#include "ReflectionHelpers.h"

// Gameplay Tags (core -- in Build.cs, always available)
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
static bool IsValidGASAssetPath(const FString& AssetPath)
{
	return AssetPath.StartsWith(TEXT("/Game/")) || AssetPath.StartsWith(TEXT("/Engine/"));
}

/**
 * Convert a FGameplayTagContainer to a JSON array of tag name strings.
 * FGameplayTagContainer is in the core GameplayTags module (in Build.cs).
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

	// Runtime check: GameplayAbilities module must be loaded.
	if (!MCPReflect::CheckModuleLoaded(TEXT("GameplayAbilities")))
	{
		MCPReflect::SendModuleNotAvailable(SendResponse, CorrId, TEXT("GameplayAbilities"));
		return;
	}

	// Find UGameplayAbility class via reflection.
	UClass* AbilityClass = FindObject<UClass>(nullptr, TEXT("/Script/GameplayAbilities.GameplayAbility"));
	if (!AbilityClass)
	{
		SendResponse(BuildGASErrorResponse(CorrId, TEXT("GameplayAbility_class_not_found")) + TEXT("\n"));
		return;
	}

	// Optional class_filter payload field.
	FString ClassFilter;
	const TSharedPtr<FJsonObject>* PayloadPtr = nullptr;
	if (Cmd->TryGetObjectField(TEXT("payload"), PayloadPtr) && PayloadPtr && PayloadPtr->IsValid())
	{
		(*PayloadPtr)->TryGetStringField(TEXT("class_filter"), ClassFilter);
	}

	// Discover all UGameplayAbility subclass assets via the asset registry.
	IAssetRegistry& AssetRegistry = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry")).Get();

	// Ensure registry is up to date.
	AssetRegistry.SearchAllAssets(/*bSynchronousSearch=*/false);

	FTopLevelAssetPath AbilityClassPath(AbilityClass->GetPathName());
	TArray<FAssetData> AssetList;
	AssetRegistry.GetAssetsByClass(AbilityClassPath, AssetList, /*bSearchSubClasses=*/true);

	// Cap results at 500 (T-25-02).
	constexpr int32 MaxAbilities = 500;
	bool bCapped = AssetList.Num() > MaxAbilities;
	if (bCapped)
	{
		AssetList.SetNum(MaxAbilities);
	}

	TArray<TSharedPtr<FJsonValue>> AbilitiesArray;
	for (const FAssetData& AssetData : AssetList)
	{
		// Apply optional class filter on asset name.
		if (!ClassFilter.IsEmpty() && !AssetData.AssetName.ToString().Contains(ClassFilter))
		{
			continue;
		}

		// Validate path prefix (T-25-01) -- skip assets outside /Game/ or /Engine/.
		FString AssetPath = AssetData.GetObjectPathString();
		if (!IsValidGASAssetPath(AssetPath))
		{
			continue;
		}

		// Load ability CDO as UObject via reflection (no direct UGameplayAbility cast needed).
		UObject* AbilityCDO = StaticLoadObject(AbilityClass, nullptr, *AssetPath);

		// For Blueprint assets, try loading via Blueprint->GeneratedClass.
		if (!AbilityCDO)
		{
			UBlueprint* BP = Cast<UBlueprint>(
				StaticLoadObject(UBlueprint::StaticClass(), nullptr, *AssetPath)
			);
			if (BP && BP->GeneratedClass && BP->GeneratedClass->IsChildOf(AbilityClass))
			{
				AbilityCDO = BP->GeneratedClass->GetDefaultObject();
			}
		}

		if (!AbilityCDO)
		{
			continue;
		}

		TSharedPtr<FJsonObject> AbilityObj = MakeShared<FJsonObject>();
		AbilityObj->SetStringField(TEXT("class_name"), AbilityCDO->GetClass()->GetName());
		AbilityObj->SetStringField(TEXT("asset_path"), AssetPath);

		// Ability tags -- FGameplayTagContainer is a core type, use reflection struct property.
		{
			FStructProperty* TagsProp = CastField<FStructProperty>(AbilityCDO->GetClass()->FindPropertyByName(TEXT("AbilityTags")));
			if (TagsProp)
			{
				const FGameplayTagContainer* Tags = TagsProp->ContainerPtrToValuePtr<FGameplayTagContainer>(AbilityCDO);
				if (Tags)
				{
					AbilityObj->SetArrayField(TEXT("ability_tags"), GameplayTagContainerToJsonArray(*Tags));
				}
			}
			else
			{
				AbilityObj->SetArrayField(TEXT("ability_tags"), TArray<TSharedPtr<FJsonValue>>());
			}
		}

		// Cancel / block tags via FProperty reflection.
		{
			TArray<TSharedPtr<FJsonValue>> CancelTagsArray;
			TArray<TSharedPtr<FJsonValue>> BlockTagsArray;

			if (FStructProperty* CancelProp = CastField<FStructProperty>(AbilityCDO->GetClass()->FindPropertyByName(TEXT("CancelAbilitiesWithTag"))))
			{
				const FGameplayTagContainer* CancelTags = CancelProp->ContainerPtrToValuePtr<FGameplayTagContainer>(AbilityCDO);
				if (CancelTags)
				{
					CancelTagsArray = GameplayTagContainerToJsonArray(*CancelTags);
				}
			}
			if (FStructProperty* BlockProp = CastField<FStructProperty>(AbilityCDO->GetClass()->FindPropertyByName(TEXT("BlockAbilitiesWithTag"))))
			{
				const FGameplayTagContainer* BlockTags = BlockProp->ContainerPtrToValuePtr<FGameplayTagContainer>(AbilityCDO);
				if (BlockTags)
				{
					BlockTagsArray = GameplayTagContainerToJsonArray(*BlockTags);
				}
			}
			AbilityObj->SetArrayField(TEXT("cancel_abilities_with_tag"), CancelTagsArray);
			AbilityObj->SetArrayField(TEXT("block_abilities_with_tag"), BlockTagsArray);
		}

		// Cost and cooldown GE class references -- read via reflection.
		{
			FString CostGEName = TEXT("None");
			FString CooldownGEName = TEXT("None");

			// CostGameplayEffectClass is a TSubclassOf<UGameplayEffect> property.
			FProperty* CostProp = AbilityCDO->GetClass()->FindPropertyByName(TEXT("CostGameplayEffectClass"));
			if (FClassProperty* CostClassProp = CastField<FClassProperty>(CostProp))
			{
				UClass* CostClass = Cast<UClass>(CostClassProp->GetObjectPropertyValue_InContainer(AbilityCDO));
				if (CostClass)
				{
					CostGEName = CostClass->GetName();
				}
			}

			FProperty* CooldownProp = AbilityCDO->GetClass()->FindPropertyByName(TEXT("CooldownGameplayEffectClass"));
			if (FClassProperty* CooldownClassProp = CastField<FClassProperty>(CooldownProp))
			{
				UClass* CooldownClass = Cast<UClass>(CooldownClassProp->GetObjectPropertyValue_InContainer(AbilityCDO));
				if (CooldownClass)
				{
					CooldownGEName = CooldownClass->GetName();
				}
			}

			AbilityObj->SetStringField(TEXT("cost_gameplay_effect_class"), CostGEName);
			AbilityObj->SetStringField(TEXT("cooldown_gameplay_effect_class"), CooldownGEName);
		}

		// Instancing policy via reflection.
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

	// Runtime check: GameplayAbilities module must be loaded.
	if (!MCPReflect::CheckModuleLoaded(TEXT("GameplayAbilities")))
	{
		MCPReflect::SendModuleNotAvailable(SendResponse, CorrId, TEXT("GameplayAbilities"));
		return;
	}

	// Find UGameplayEffect class via reflection.
	UClass* GEClass = FindObject<UClass>(nullptr, TEXT("/Script/GameplayAbilities.GameplayEffect"));
	if (!GEClass)
	{
		SendResponse(BuildGASErrorResponse(CorrId, TEXT("GameplayEffect_class_not_found")) + TEXT("\n"));
		return;
	}

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

	// Validate path (T-25-01).
	if (!IsValidGASAssetPath(AssetPath))
	{
		SendResponse(BuildGASErrorResponse(CorrId,
			TEXT("asset_path must start with /Game/ or /Engine/")) + TEXT("\n"));
		return;
	}

	// Load as GameplayEffect CDO.
	UObject* GEObj = StaticLoadObject(GEClass, nullptr, *AssetPath);

	// For Blueprint-based GEs.
	if (!GEObj)
	{
		UBlueprint* BP = Cast<UBlueprint>(
			StaticLoadObject(UBlueprint::StaticClass(), nullptr, *AssetPath)
		);
		if (BP && BP->GeneratedClass && BP->GeneratedClass->IsChildOf(GEClass))
		{
			GEObj = BP->GeneratedClass->GetDefaultObject();
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

	// Duration policy via reflection.
	FString DurationPolicy = GetEnumPropertyDisplayName(GEObj, TEXT("DurationPolicy"));
	Data->SetStringField(TEXT("duration_policy"), DurationPolicy);

	// Modifiers array -- reflect on the FGameplayModifierInfo array.
	TArray<TSharedPtr<FJsonValue>> ModifiersArray;

	FArrayProperty* ModifiersProp = CastField<FArrayProperty>(GEObj->GetClass()->FindPropertyByName(TEXT("Modifiers")));
	if (ModifiersProp)
	{
		FScriptArrayHelper ArrayHelper(ModifiersProp, ModifiersProp->ContainerPtrToValuePtr<void>(GEObj));
		FStructProperty* ModInfoStructProp = CastField<FStructProperty>(ModifiersProp->Inner);

		for (int32 i = 0; i < ArrayHelper.Num(); ++i)
		{
			void* ModInfoPtr = ArrayHelper.GetRawPtr(i);
			if (!ModInfoStructProp || !ModInfoPtr)
			{
				continue;
			}

			TSharedPtr<FJsonObject> ModObj = MakeShared<FJsonObject>();

			// Attribute name -- FGameplayAttribute struct with GetName() / owning class.
			FString AttributeName = TEXT("Unknown");
			FString AttrSetName = TEXT("None");
			FStructProperty* AttributeProp = CastField<FStructProperty>(ModInfoStructProp->Struct->FindPropertyByName(TEXT("Attribute")));
			if (AttributeProp)
			{
				void* AttrPtr = AttributeProp->ContainerPtrToValuePtr<void>(ModInfoPtr);
				// FGameplayAttribute has a UProperty* and a UClass* pointer.
				// Access via inner property reflection.
				FObjectProperty* PropertyPtrProp = CastField<FObjectProperty>(AttributeProp->Struct->FindPropertyByName(TEXT("Attribute")));
				if (!PropertyPtrProp)
				{
					// Try alternate name used in some UE versions.
					PropertyPtrProp = CastField<FObjectProperty>(AttributeProp->Struct->FindPropertyByName(TEXT("Property")));
				}
				if (PropertyPtrProp)
				{
					UObject* PropObj = PropertyPtrProp->GetObjectPropertyValue_InContainer(AttrPtr);
					if (PropObj)
					{
						AttributeName = PropObj->GetName();
					}
				}

				// Try reading owning class (AttributeSet).
				FClassProperty* OwnerClassProp = CastField<FClassProperty>(AttributeProp->Struct->FindPropertyByName(TEXT("AttributeOwner")));
				if (OwnerClassProp)
				{
					UClass* OwnerClass = Cast<UClass>(OwnerClassProp->GetObjectPropertyValue_InContainer(AttrPtr));
					if (OwnerClass)
					{
						AttrSetName = OwnerClass->GetName();
					}
				}
			}
			ModObj->SetStringField(TEXT("attribute"), AttributeName);
			ModObj->SetStringField(TEXT("attribute_set"), AttrSetName);

			// ModifierOp enum -- reflect on the struct field.
			FString ModOpStr = TEXT("Unknown");
			{
				FProperty* ModOpProp = ModInfoStructProp->Struct->FindPropertyByName(TEXT("ModifierOp"));
				if (FByteProperty* ByteProp = CastField<FByteProperty>(ModOpProp))
				{
					const void* ValuePtr = ByteProp->ContainerPtrToValuePtr<void>(ModInfoPtr);
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
					const void* ValuePtr = EnumProp->ContainerPtrToValuePtr<void>(ModInfoPtr);
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
			ModObj->SetStringField(TEXT("modifier_op"), ModOpStr);

			// Magnitude -- read from ModifierMagnitude struct via export.
			FString MagnitudeDesc = TEXT("Calculated");
			FStructProperty* MagProp = CastField<FStructProperty>(ModInfoStructProp->Struct->FindPropertyByName(TEXT("ModifierMagnitude")));
			if (MagProp)
			{
				void* MagPtr = MagProp->ContainerPtrToValuePtr<void>(ModInfoPtr);
				// Try to get MagnitudeCalculationType enum.
				FProperty* MagTypeProp = MagProp->Struct->FindPropertyByName(TEXT("MagnitudeCalculationType"));
				int64 MagTypeVal = 0;
				if (FEnumProperty* EnumProp = CastField<FEnumProperty>(MagTypeProp))
				{
					const void* ValPtr = EnumProp->ContainerPtrToValuePtr<void>(MagPtr);
					MagTypeVal = EnumProp->GetUnderlyingProperty()->GetSignedIntPropertyValue(ValPtr);
				}
				else if (FByteProperty* ByteProp = CastField<FByteProperty>(MagTypeProp))
				{
					const void* ValPtr = ByteProp->ContainerPtrToValuePtr<void>(MagPtr);
					MagTypeVal = (int64)ByteProp->GetPropertyValue(ValPtr);
				}

				// EGameplayEffectMagnitudeCalculation: ScalableFloat=0, AttributeBased=1, Custom=2, SetByCaller=3
				switch (MagTypeVal)
				{
					case 0:
					{
						// ScalableFloat -- try to read the scalar float value via reflection.
						FStructProperty* ScalableFloatProp = CastField<FStructProperty>(MagProp->Struct->FindPropertyByName(TEXT("ScalableFloatMagnitude")));
						if (ScalableFloatProp)
						{
							void* SFPtr = ScalableFloatProp->ContainerPtrToValuePtr<void>(MagPtr);
							FFloatProperty* ValueProp = CastField<FFloatProperty>(ScalableFloatProp->Struct->FindPropertyByName(TEXT("Value")));
							if (ValueProp)
							{
								float ScalarVal = ValueProp->GetPropertyValue_InContainer(SFPtr);
								MagnitudeDesc = FString::Printf(TEXT("%f"), ScalarVal);
							}
						}
						else
						{
							MagnitudeDesc = TEXT("ScalableFloat");
						}
						break;
					}
					case 1: MagnitudeDesc = TEXT("AttributeBased"); break;
					case 2: MagnitudeDesc = TEXT("Custom"); break;
					case 3: MagnitudeDesc = TEXT("SetByCaller"); break;
					default: MagnitudeDesc = TEXT("Calculated"); break;
				}
			}
			ModObj->SetStringField(TEXT("magnitude_value"), MagnitudeDesc);

			ModifiersArray.Add(MakeShared<FJsonValueObject>(ModObj));
		}
	}
	Data->SetArrayField(TEXT("modifiers"), ModifiersArray);

	// Stacking type and limit via reflection.
	FString StackingType = GetEnumPropertyDisplayName(GEObj, TEXT("StackingType"));
	Data->SetStringField(TEXT("stacking_type"), StackingType);

	// StackLimitCount -- integer property.
	int64 StackLimit = MCPReflect::GetIntProperty(GEObj, TEXT("StackLimitCount"));
	Data->SetNumberField(TEXT("stack_limit_count"), static_cast<double>(StackLimit));

	// Period -- FScalableFloat struct, read via reflection.
	{
		double PeriodValue = 0.0;
		FStructProperty* PeriodProp = CastField<FStructProperty>(GEObj->GetClass()->FindPropertyByName(TEXT("Period")));
		if (PeriodProp)
		{
			void* PeriodPtr = PeriodProp->ContainerPtrToValuePtr<void>(GEObj);
			FFloatProperty* ValueProp = CastField<FFloatProperty>(PeriodProp->Struct->FindPropertyByName(TEXT("Value")));
			if (ValueProp)
			{
				PeriodValue = static_cast<double>(ValueProp->GetPropertyValue_InContainer(PeriodPtr));
			}
		}
		Data->SetNumberField(TEXT("period_interval"), PeriodValue);
	}

	// Gameplay Cue tags -- read GameplayCues array via reflection.
	{
		TArray<TSharedPtr<FJsonValue>> AllCueTagsArray;
		FArrayProperty* CuesProp = CastField<FArrayProperty>(GEObj->GetClass()->FindPropertyByName(TEXT("GameplayCues")));
		if (CuesProp)
		{
			FScriptArrayHelper CuesArrayHelper(CuesProp, CuesProp->ContainerPtrToValuePtr<void>(GEObj));
			FStructProperty* CueElemProp = CastField<FStructProperty>(CuesProp->Inner);
			for (int32 i = 0; i < CuesArrayHelper.Num(); ++i)
			{
				void* CuePtr = CuesArrayHelper.GetRawPtr(i);
				if (!CueElemProp || !CuePtr) continue;

				// FGameplayEffectCue has GameplayCueTags (FGameplayTagContainer).
				FStructProperty* CueTagsProp = CastField<FStructProperty>(CueElemProp->Struct->FindPropertyByName(TEXT("GameplayCueTags")));
				if (CueTagsProp)
				{
					const FGameplayTagContainer* CueTags = CueTagsProp->ContainerPtrToValuePtr<FGameplayTagContainer>(CuePtr);
					if (CueTags)
					{
						for (const FGameplayTag& Tag : *CueTags)
						{
							AllCueTagsArray.Add(MakeShared<FJsonValueString>(Tag.ToString()));
						}
					}
				}
			}
		}
		Data->SetArrayField(TEXT("gameplay_cue_tags"), AllCueTagsArray);
	}

	SendResponse(BuildGASSuccessResponse(CorrId, Data) + TEXT("\n"));
}

// ---------------------------------------------------------------------------
// gas.attributes handler (GAS-03)
// ---------------------------------------------------------------------------

static void HandleGasAttributes(TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
{
	FString CorrId;
	Cmd->TryGetStringField(TEXT("correlationId"), CorrId);

	// Runtime check: GameplayAbilities module must be loaded.
	if (!MCPReflect::CheckModuleLoaded(TEXT("GameplayAbilities")))
	{
		MCPReflect::SendModuleNotAvailable(SendResponse, CorrId, TEXT("GameplayAbilities"));
		return;
	}

	// Find UAttributeSet class via reflection.
	UClass* AttributeSetClass = FindObject<UClass>(nullptr, TEXT("/Script/GameplayAbilities.AttributeSet"));
	if (!AttributeSetClass)
	{
		SendResponse(BuildGASErrorResponse(CorrId, TEXT("AttributeSet_class_not_found")) + TEXT("\n"));
		return;
	}

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

	// Validate path (T-25-01).
	if (!IsValidGASAssetPath(AssetPath))
	{
		SendResponse(BuildGASErrorResponse(CorrId,
			TEXT("asset_path must start with /Game/ or /Engine/")) + TEXT("\n"));
		return;
	}

	UClass* AttrSetClass = nullptr;
	UObject* AttrSetCDO = nullptr;

	// Try Blueprint path.
	UBlueprint* BP = Cast<UBlueprint>(
		StaticLoadObject(UBlueprint::StaticClass(), nullptr, *AssetPath)
	);
	if (BP && BP->GeneratedClass && BP->GeneratedClass->IsChildOf(AttributeSetClass))
	{
		AttrSetClass = BP->GeneratedClass;
		AttrSetCDO = AttrSetClass->GetDefaultObject();
	}

	// Try loading directly as CDO.
	if (!AttrSetCDO)
	{
		AttrSetCDO = StaticLoadObject(AttributeSetClass, nullptr, *AssetPath);
		if (AttrSetCDO)
		{
			AttrSetClass = AttrSetCDO->GetClass();
		}
	}

	// Try StaticLoadClass for native classes.
	if (!AttrSetCDO)
	{
		AttrSetClass = StaticLoadClass(AttributeSetClass, nullptr, *AssetPath);
		if (AttrSetClass)
		{
			AttrSetCDO = AttrSetClass->GetDefaultObject();
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

	// Iterate numeric properties (float attributes on attribute sets).
	TArray<TSharedPtr<FJsonValue>> AttributesArray;
	for (TFieldIterator<FNumericProperty> PropIt(AttrSetClass, EFieldIteratorFlags::IncludeSuper); PropIt; ++PropIt)
	{
		FNumericProperty* NumProp = *PropIt;
		if (!NumProp)
		{
			continue;
		}

		TSharedPtr<FJsonObject> AttrObj = MakeShared<FJsonObject>();
		AttrObj->SetStringField(TEXT("attribute_name"), NumProp->GetName());

		// Read base value from CDO.
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

		// Replication check.
		bool bReplicated = NumProp->HasAnyPropertyFlags(CPF_Net);
		AttrObj->SetBoolField(TEXT("replicated"), bReplicated);

		// Clamping note -- exact clamp values require inspecting PreAttributeBaseChange
		// override implementation which is not reliably extractable at CDO level.
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
// Uses core GameplayTags module -- no reflection needed.
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

	// Gather all registered gameplay tags.
	FGameplayTagContainer AllTagsContainer;
	TagsManager.RequestAllGameplayTags(AllTagsContainer, /*bOnlyIncludeDictionaryTags=*/false);

	TArray<TSharedPtr<FJsonValue>> TagsArray;
	for (const FGameplayTag& Tag : AllTagsContainer)
	{
		FString TagName = Tag.ToString();

		// Apply filter if provided.
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

	// Optional reverse lookup: find assets that reference a given tag (T-25-03: cap at 200).
	if (!FindAssetsWithTag.IsEmpty())
	{
		// Validate the tag exists.
		FGameplayTag LookupTag = TagsManager.RequestGameplayTag(FName(*FindAssetsWithTag), /*ErrorIfNotFound=*/false);

		TArray<TSharedPtr<FJsonValue>> TaggedAssetsArray;

		if (LookupTag.IsValid())
		{
			IAssetRegistry& AssetRegistry = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry")).Get();

			// Search /Game/ for assets.
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
				if (!IsValidGASAssetPath(AssetPath))
				{
					continue;
				}

				// Check if this asset has the tag in its tags metadata.
				bool bHasTag = false;
				FAssetDataTagMapSharedView::FFindTagResult TagResult =
					AssetData.TagsAndValues.FindTag(TEXT("GameplayTags"));
				if (TagResult.IsSet())
				{
					bHasTag = TagResult.GetValue().Contains(FindAssetsWithTag);
				}

				if (!bHasTag)
				{
					// Also check AssetBundleData tag.
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
