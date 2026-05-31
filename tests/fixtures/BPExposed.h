// tests/fixtures/BPExposed.h
// Fixture for bridge-cpp-tools.test.ts — do not modify.
#pragma once
#include "CoreMinimal.h"
#include "BPExposed.generated.h"

UCLASS()
class MYGAME_API AExposedActor : public AActor
{
    GENERATED_BODY()

public:
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="Stats")
    float Health;

    UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category="Stats")
    int32 Level;

    UPROPERTY(EditAnywhere)
    float InternalValue;

    UFUNCTION(BlueprintCallable, Category="Combat")
    void Attack();

    UFUNCTION(BlueprintPure, Category="Stats")
    float GetHealthPercent() const;

    UFUNCTION(BlueprintImplementableEvent, Category="Events")
    void OnDamageTaken(float Damage);

    UFUNCTION()
    void InternalOnly();
};

UCLASS()
class MYGAME_API ANoExposures : public AActor
{
    GENERATED_BODY()

public:
    UPROPERTY(EditAnywhere)
    float HiddenProp;

    UFUNCTION()
    void HiddenFunc();
};
