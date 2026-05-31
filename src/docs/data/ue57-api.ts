// src/docs/data/ue57-api.ts
// Bundled UE 5.7 API reference index — curated set of the most commonly used classes.
// Source: UE 5.7 official API documentation (dev.epicgames.com/documentation/en-us/unreal-engine/API).
// This file is the knowledge base for ue_search_api, ue_lookup_class, ue_get_include_path, ue_check_deprecation.

import type { ApiRecord } from '../types.js';

const c = (id: string, module: string, includePath: string, description: string, opts?: Partial<ApiRecord>): ApiRecord => ({
  id, type: 'class', name: id, fullName: id, className: id, signature: '', returnType: '', parameters: '',
  includePath, module, deprecated: false, deprecatedMessage: '', replacementAPI: '', description, ...opts,
});

const f = (cls: string, name: string, sig: string, ret: string, params: string, inc: string, mod: string, desc: string, opts?: Partial<ApiRecord>): ApiRecord => ({
  id: `${cls}.${name}`, type: 'function', name, fullName: `${cls}.${name}`, className: cls,
  signature: sig, returnType: ret, parameters: params, includePath: inc, module: mod,
  deprecated: false, deprecatedMessage: '', replacementAPI: '', description: desc, ...opts,
});

const p = (cls: string, name: string, inc: string, mod: string, desc: string, opts?: Partial<ApiRecord>): ApiRecord => ({
  id: `${cls}.${name}`, type: 'property', name, fullName: `${cls}.${name}`, className: cls,
  signature: '', returnType: '', parameters: '', includePath: inc, module: mod,
  deprecated: false, deprecatedMessage: '', replacementAPI: '', description: desc, ...opts,
});

const e = (id: string, mod: string, inc: string, desc: string): ApiRecord => ({
  id, type: 'enum', name: id, fullName: id, className: id, signature: '', returnType: '', parameters: '',
  includePath: inc, module: mod, deprecated: false, deprecatedMessage: '', replacementAPI: '', description: desc,
});

export const UE57_API_RECORDS: ApiRecord[] = [
  // ── UObject ──
  c('UObject', 'CoreUObject', 'UObject/Object.h', 'Base class for all UE objects with reflection, serialization, and garbage collection'),
  f('UObject', 'GetClass', 'UClass* GetClass() const', 'UClass*', '', 'UObject/Object.h', 'CoreUObject', 'Returns the UClass that defines this object'),
  f('UObject', 'GetWorld', 'UWorld* GetWorld() const', 'UWorld*', '', 'UObject/Object.h', 'CoreUObject', 'Returns the UWorld this object belongs to'),
  f('UObject', 'IsA', 'bool IsA(const UClass* SomeBase) const', 'bool', 'const UClass* SomeBase', 'UObject/Object.h', 'CoreUObject', 'Returns true if this object is of the specified type'),
  f('UObject', 'GetFName', 'FName GetFName() const', 'FName', '', 'UObject/Object.h', 'CoreUObject', 'Returns the FName of this object'),
  f('UObject', 'GetName', 'FString GetName() const', 'FString', '', 'UObject/Object.h', 'CoreUObject', 'Returns the name of this object as a string'),

  // ── UClass ──
  c('UClass', 'CoreUObject', 'UObject/Class.h', 'Reflection class describing a UObject-derived type'),
  f('UClass', 'GetSuperClass', 'UClass* GetSuperClass() const', 'UClass*', '', 'UObject/Class.h', 'CoreUObject', 'Returns the parent class in the inheritance hierarchy'),
  f('UClass', 'GetDefaultObject', 'UObject* GetDefaultObject(bool bCreateIfNeeded) const', 'UObject*', 'bool bCreateIfNeeded', 'UObject/Class.h', 'CoreUObject', 'Returns the Class Default Object (CDO) for this class'),

  // ── AActor ──
  c('AActor', 'Engine', 'GameFramework/Actor.h', 'Base class for all actors that can be placed or spawned in a level'),
  f('AActor', 'BeginPlay', 'void BeginPlay()', 'void', '', 'GameFramework/Actor.h', 'Engine', 'Called when the game starts or when spawned'),
  f('AActor', 'Tick', 'void Tick(float DeltaTime)', 'void', 'float DeltaTime', 'GameFramework/Actor.h', 'Engine', 'Called every frame'),
  f('AActor', 'GetActorLocation', 'FVector GetActorLocation() const', 'FVector', '', 'GameFramework/Actor.h', 'Engine', 'Returns the location of the actor in world space'),
  f('AActor', 'SetActorLocation', 'bool SetActorLocation(const FVector& NewLocation, bool bSweep, FHitResult* OutSweepHitResult, ETeleportType Teleport)', 'bool', 'const FVector& NewLocation, bool bSweep, FHitResult* OutSweepHitResult, ETeleportType Teleport', 'GameFramework/Actor.h', 'Engine', 'Moves the actor to the specified location'),
  f('AActor', 'GetActorRotation', 'FRotator GetActorRotation() const', 'FRotator', '', 'GameFramework/Actor.h', 'Engine', 'Returns the rotation of the actor in world space'),
  f('AActor', 'SetActorRotation', 'bool SetActorRotation(FRotator NewRotation, ETeleportType Teleport)', 'bool', 'FRotator NewRotation, ETeleportType Teleport', 'GameFramework/Actor.h', 'Engine', 'Sets the actor rotation in world space'),
  f('AActor', 'Destroy', 'void Destroy()', 'void', '', 'GameFramework/Actor.h', 'Engine', 'Destroys this actor and removes it from the level'),
  f('AActor', 'GetComponentByClass', 'UActorComponent* GetComponentByClass(TSubclassOf<UActorComponent> ComponentClass) const', 'UActorComponent*', 'TSubclassOf<UActorComponent> ComponentClass', 'GameFramework/Actor.h', 'Engine', 'Returns the first component of the specified class'),
  f('AActor', 'GetComponents', 'void GetComponents(TArray<UActorComponent*>& OutComponents) const', 'void', 'TArray<UActorComponent*>& OutComponents', 'GameFramework/Actor.h', 'Engine', 'Gets all components owned by this actor'),
  f('AActor', 'AttachToActor', 'void AttachToActor(AActor* ParentActor, const FAttachmentTransformRules& AttachmentRules, FName SocketName)', 'void', 'AActor* ParentActor, const FAttachmentTransformRules& AttachmentRules, FName SocketName', 'GameFramework/Actor.h', 'Engine', 'Attaches this actor to another actor'),
  f('AActor', 'GetDistanceTo', 'float GetDistanceTo(const AActor* OtherActor) const', 'float', 'const AActor* OtherActor', 'GameFramework/Actor.h', 'Engine', 'Returns the distance to another actor'),
  f('AActor', 'SetActorHiddenInGame', 'void SetActorHiddenInGame(bool bNewHidden)', 'void', 'bool bNewHidden', 'GameFramework/Actor.h', 'Engine', 'Sets whether this actor is hidden in the game'),
  f('AActor', 'TeleportTo', 'bool TeleportTo(const FVector& DestLocation, const FRotator& DestRotation, bool bIsATest, bool bNoCheck)', 'bool', 'const FVector& DestLocation, const FRotator& DestRotation, bool bIsATest, bool bNoCheck', 'GameFramework/Actor.h', 'Engine', 'Teleports actor to a new location and rotation'),

  // ── APawn ──
  c('APawn', 'Engine', 'GameFramework/Pawn.h', 'Base class for all actors that can be possessed by a controller'),
  f('APawn', 'GetController', 'AController* GetController() const', 'AController*', '', 'GameFramework/Pawn.h', 'Engine', 'Returns the controller currently possessing this pawn'),
  f('APawn', 'SetupPlayerInputComponent', 'void SetupPlayerInputComponent(UInputComponent* PlayerInputComponent)', 'void', 'UInputComponent* PlayerInputComponent', 'GameFramework/Pawn.h', 'Engine', 'Called to bind input to this pawn'),
  f('APawn', 'GetMovementComponent', 'UPawnMovementComponent* GetMovementComponent() const', 'UPawnMovementComponent*', '', 'GameFramework/Pawn.h', 'Engine', 'Returns the movement component for this pawn'),

  // ── ACharacter ──
  c('ACharacter', 'Engine', 'GameFramework/Character.h', 'Actor with a mesh, capsule, and character movement component'),
  f('ACharacter', 'GetCharacterMovement', 'UCharacterMovementComponent* GetCharacterMovement() const', 'UCharacterMovementComponent*', '', 'GameFramework/Character.h', 'Engine', 'Returns the character movement component'),
  f('ACharacter', 'GetMesh', 'USkeletalMeshComponent* GetMesh() const', 'USkeletalMeshComponent*', '', 'GameFramework/Character.h', 'Engine', 'Returns the skeletal mesh component'),
  f('ACharacter', 'Jump', 'void Jump()', 'void', '', 'GameFramework/Character.h', 'Engine', 'Makes the character jump'),
  f('ACharacter', 'StopJumping', 'void StopJumping()', 'void', '', 'GameFramework/Character.h', 'Engine', 'Stops the character from jumping'),
  f('ACharacter', 'LaunchCharacter', 'void LaunchCharacter(FVector LaunchVelocity, bool bXYOverride, bool bZOverride)', 'void', 'FVector LaunchVelocity, bool bXYOverride, bool bZOverride', 'GameFramework/Character.h', 'Engine', 'Launches the character with a given velocity'),
  f('ACharacter', 'GetCapsuleComponent', 'UCapsuleComponent* GetCapsuleComponent() const', 'UCapsuleComponent*', '', 'GameFramework/Character.h', 'Engine', 'Returns the capsule collision component'),

  // ── AController / APlayerController ──
  c('AController', 'Engine', 'GameFramework/Controller.h', 'Base class for controllers that can possess pawns'),
  f('AController', 'Possess', 'void Possess(APawn* InPawn)', 'void', 'APawn* InPawn', 'GameFramework/Controller.h', 'Engine', 'Takes control of the specified pawn'),
  f('AController', 'UnPossess', 'void UnPossess()', 'void', '', 'GameFramework/Controller.h', 'Engine', 'Releases the currently possessed pawn'),
  f('AController', 'GetPawn', 'APawn* GetPawn() const', 'APawn*', '', 'GameFramework/Controller.h', 'Engine', 'Returns the currently possessed pawn'),

  c('APlayerController', 'Engine', 'GameFramework/PlayerController.h', 'Controller for human players with camera, input, and HUD management'),
  f('APlayerController', 'GetHUD', 'AHUD* GetHUD() const', 'AHUD*', '', 'GameFramework/PlayerController.h', 'Engine', 'Returns the HUD for this player controller'),
  f('APlayerController', 'SetInputMode', 'void SetInputMode(const FInputModeDataBase& InData)', 'void', 'const FInputModeDataBase& InData', 'GameFramework/PlayerController.h', 'Engine', 'Sets the input mode for this player controller'),
  f('APlayerController', 'SetShowMouseCursor', 'void SetShowMouseCursor(bool bShow)', 'void', 'bool bShow', 'GameFramework/PlayerController.h', 'Engine', 'Shows or hides the mouse cursor'),

  // ── GameMode / GameState / PlayerState ──
  c('AGameModeBase', 'Engine', 'GameFramework/GameModeBase.h', 'Base class defining game rules, spawn logic, and match flow'),
  f('AGameModeBase', 'InitGame', 'void InitGame(const FString& MapName, const FString& Options, FString& ErrorMessage)', 'void', 'const FString& MapName, const FString& Options, FString& ErrorMessage', 'GameFramework/GameModeBase.h', 'Engine', 'Initializes the game with the specified map and options'),
  f('AGameModeBase', 'GetDefaultPawnClassForController', 'UClass* GetDefaultPawnClassForController(AController* InController)', 'UClass*', 'AController* InController', 'GameFramework/GameModeBase.h', 'Engine', 'Returns the default pawn class for a given controller'),

  c('AGameMode', 'Engine', 'GameFramework/GameMode.h', 'Extended game mode with match state management'),
  f('AGameMode', 'StartMatch', 'void StartMatch()', 'void', '', 'GameFramework/GameMode.h', 'Engine', 'Transitions game to InProgress match state'),
  f('AGameMode', 'EndMatch', 'void EndMatch()', 'void', '', 'GameFramework/GameMode.h', 'Engine', 'Ends the current match'),

  c('AGameStateBase', 'Engine', 'GameFramework/GameStateBase.h', 'Replicated game state accessible to all clients'),
  f('AGameStateBase', 'GetServerWorldTimeSeconds', 'double GetServerWorldTimeSeconds() const', 'double', '', 'GameFramework/GameStateBase.h', 'Engine', 'Returns the server world time in seconds'),

  c('APlayerState', 'Engine', 'GameFramework/PlayerState.h', 'Replicated per-player state including name and score'),
  f('APlayerState', 'GetPlayerName', 'FString GetPlayerName() const', 'FString', '', 'GameFramework/PlayerState.h', 'Engine', 'Returns the player display name'),
  f('APlayerState', 'GetScore', 'float GetScore() const', 'float', '', 'GameFramework/PlayerState.h', 'Engine', 'Returns the player score'),

  // ── Components ──
  c('UActorComponent', 'Engine', 'Components/ActorComponent.h', 'Base class for all components that can be added to actors'),
  f('UActorComponent', 'BeginPlay', 'void BeginPlay()', 'void', '', 'Components/ActorComponent.h', 'Engine', 'Called when the component begins play'),
  f('UActorComponent', 'TickComponent', 'void TickComponent(float DeltaTime, ELevelTick TickType, FActorComponentTickFunction* ThisTickFunction)', 'void', 'float DeltaTime, ELevelTick TickType, FActorComponentTickFunction* ThisTickFunction', 'Components/ActorComponent.h', 'Engine', 'Called every frame for this component'),
  f('UActorComponent', 'GetOwner', 'AActor* GetOwner() const', 'AActor*', '', 'Components/ActorComponent.h', 'Engine', 'Returns the actor that owns this component'),
  f('UActorComponent', 'RegisterComponent', 'void RegisterComponent()', 'void', '', 'Components/ActorComponent.h', 'Engine', 'Registers the component with its owning actor'),

  c('USceneComponent', 'Engine', 'Components/SceneComponent.h', 'Component with transform — can be attached to other scene components'),
  f('USceneComponent', 'GetRelativeLocation', 'FVector GetRelativeLocation() const', 'FVector', '', 'Components/SceneComponent.h', 'Engine', 'Returns location relative to parent component'),
  f('USceneComponent', 'SetRelativeLocation', 'void SetRelativeLocation(FVector NewLocation, bool bSweep, FHitResult* OutSweepHitResult, ETeleportType Teleport)', 'void', 'FVector NewLocation, bool bSweep, FHitResult* OutSweepHitResult, ETeleportType Teleport', 'Components/SceneComponent.h', 'Engine', 'Sets location relative to parent component'),
  f('USceneComponent', 'SetWorldLocation', 'void SetWorldLocation(FVector NewLocation, bool bSweep, FHitResult* OutSweepHitResult, ETeleportType Teleport)', 'void', 'FVector NewLocation, bool bSweep, FHitResult* OutSweepHitResult, ETeleportType Teleport', 'Components/SceneComponent.h', 'Engine', 'Sets location in world space'),
  f('USceneComponent', 'AttachToComponent', 'bool AttachToComponent(USceneComponent* Parent, const FAttachmentTransformRules& AttachmentRules, FName SocketName)', 'bool', 'USceneComponent* Parent, const FAttachmentTransformRules& AttachmentRules, FName SocketName', 'Components/SceneComponent.h', 'Engine', 'Attaches this component to another scene component'),

  c('UStaticMeshComponent', 'Engine', 'Components/StaticMeshComponent.h', 'Renders a static mesh asset in the world'),
  f('UStaticMeshComponent', 'SetStaticMesh', 'bool SetStaticMesh(UStaticMesh* NewMesh)', 'bool', 'UStaticMesh* NewMesh', 'Components/StaticMeshComponent.h', 'Engine', 'Sets the static mesh to render'),
  f('UStaticMeshComponent', 'GetStaticMesh', 'UStaticMesh* GetStaticMesh() const', 'UStaticMesh*', '', 'Components/StaticMeshComponent.h', 'Engine', 'Returns the currently assigned static mesh'),
  f('UStaticMeshComponent', 'SetMaterial', 'void SetMaterial(int32 ElementIndex, UMaterialInterface* Material)', 'void', 'int32 ElementIndex, UMaterialInterface* Material', 'Components/StaticMeshComponent.h', 'Engine', 'Sets a material on the specified element index'),

  c('USkeletalMeshComponent', 'Engine', 'Components/SkeletalMeshComponent.h', 'Renders a skeletal mesh with animation support'),
  f('USkeletalMeshComponent', 'SetSkeletalMeshAsset', 'void SetSkeletalMeshAsset(USkeletalMesh* NewMesh)', 'void', 'USkeletalMesh* NewMesh', 'Components/SkeletalMeshComponent.h', 'Engine', 'Sets the skeletal mesh asset to render'),
  f('USkeletalMeshComponent', 'PlayAnimation', 'void PlayAnimation(UAnimationAsset* NewAnimToPlay, bool bLooping)', 'void', 'UAnimationAsset* NewAnimToPlay, bool bLooping', 'Components/SkeletalMeshComponent.h', 'Engine', 'Plays an animation asset on this mesh'),
  f('USkeletalMeshComponent', 'GetAnimInstance', 'UAnimInstance* GetAnimInstance() const', 'UAnimInstance*', '', 'Components/SkeletalMeshComponent.h', 'Engine', 'Returns the animation instance driving this mesh'),
  f('USkeletalMeshComponent', 'SetSkeletalMesh', 'void SetSkeletalMesh(USkeletalMesh* NewMesh, bool bReinitPose)', 'void', 'USkeletalMesh* NewMesh, bool bReinitPose', 'Components/SkeletalMeshComponent.h', 'Engine', 'Old overload for setting skeletal mesh — use SetSkeletalMeshAsset instead', { deprecated: true, deprecatedMessage: 'Deprecated in UE 5.1 — use SetSkeletalMeshAsset instead', replacementAPI: 'USkeletalMeshComponent::SetSkeletalMeshAsset' }),

  c('UCapsuleComponent', 'Engine', 'Components/CapsuleComponent.h', 'Capsule-shaped collision primitive used for character collision'),
  f('UCapsuleComponent', 'SetCapsuleRadius', 'void SetCapsuleRadius(float Radius, bool bUpdateOverlaps)', 'void', 'float Radius, bool bUpdateOverlaps', 'Components/CapsuleComponent.h', 'Engine', 'Sets the capsule collision radius'),
  f('UCapsuleComponent', 'SetCapsuleHalfHeight', 'void SetCapsuleHalfHeight(float HalfHeight, bool bUpdateOverlaps)', 'void', 'float HalfHeight, bool bUpdateOverlaps', 'Components/CapsuleComponent.h', 'Engine', 'Sets the capsule half height'),

  c('UBoxComponent', 'Engine', 'Components/BoxComponent.h', 'Box-shaped collision primitive'),
  f('UBoxComponent', 'SetBoxExtent', 'void SetBoxExtent(FVector InBoxExtent, bool bUpdateOverlaps)', 'void', 'FVector InBoxExtent, bool bUpdateOverlaps', 'Components/BoxComponent.h', 'Engine', 'Sets the box extent (half-size)'),

  c('USphereComponent', 'Engine', 'Components/SphereComponent.h', 'Sphere-shaped collision primitive'),
  f('USphereComponent', 'SetSphereRadius', 'void SetSphereRadius(float InSphereRadius, bool bUpdateOverlaps)', 'void', 'float InSphereRadius, bool bUpdateOverlaps', 'Components/SphereComponent.h', 'Engine', 'Sets the sphere collision radius'),

  c('USpringArmComponent', 'Engine', 'GameFramework/SpringArmComponent.h', 'Camera boom that traces to prevent clipping through geometry'),
  p('USpringArmComponent', 'TargetArmLength', 'GameFramework/SpringArmComponent.h', 'Engine', 'Natural length of the spring arm when not colliding'),
  p('USpringArmComponent', 'bUsePawnControlRotation', 'GameFramework/SpringArmComponent.h', 'Engine', 'If true, arm rotation follows pawn control rotation'),

  c('UCameraComponent', 'Engine', 'Camera/CameraComponent.h', 'Camera that captures a scene for rendering to the player viewport'),
  f('UCameraComponent', 'SetFieldOfView', 'void SetFieldOfView(float InFieldOfView)', 'void', 'float InFieldOfView', 'Camera/CameraComponent.h', 'Engine', 'Sets the camera field of view in degrees'),
  f('UCameraComponent', 'GetFieldOfView', 'float GetFieldOfView() const', 'float', '', 'Camera/CameraComponent.h', 'Engine', 'Returns the current field of view in degrees'),

  c('UAudioComponent', 'Engine', 'Components/AudioComponent.h', 'Component for playing sound assets in the world'),
  f('UAudioComponent', 'Play', 'void Play(float StartTime)', 'void', 'float StartTime', 'Components/AudioComponent.h', 'Engine', 'Starts playing the assigned sound'),
  f('UAudioComponent', 'Stop', 'void Stop()', 'void', '', 'Components/AudioComponent.h', 'Engine', 'Stops the currently playing sound'),
  f('UAudioComponent', 'IsPlaying', 'bool IsPlaying() const', 'bool', '', 'Components/AudioComponent.h', 'Engine', 'Returns true if the sound is currently playing'),

  c('UCharacterMovementComponent', 'Engine', 'GameFramework/CharacterMovementComponent.h', 'Handles movement logic for ACharacter including walking, falling, swimming'),
  p('UCharacterMovementComponent', 'MaxWalkSpeed', 'GameFramework/CharacterMovementComponent.h', 'Engine', 'Maximum walking speed in cm/s'),
  p('UCharacterMovementComponent', 'JumpZVelocity', 'GameFramework/CharacterMovementComponent.h', 'Engine', 'Initial velocity for jumping in cm/s'),
  f('UCharacterMovementComponent', 'SetMovementMode', 'void SetMovementMode(EMovementMode NewMovementMode, uint8 NewCustomMode)', 'void', 'EMovementMode NewMovementMode, uint8 NewCustomMode', 'GameFramework/CharacterMovementComponent.h', 'Engine', 'Sets the movement mode'),
  f('UCharacterMovementComponent', 'IsMovingOnGround', 'bool IsMovingOnGround() const', 'bool', '', 'GameFramework/CharacterMovementComponent.h', 'Engine', 'Returns true if the character is on the ground'),
  f('UCharacterMovementComponent', 'IsFalling', 'bool IsFalling() const', 'bool', '', 'GameFramework/CharacterMovementComponent.h', 'Engine', 'Returns true if the character is in the air'),

  c('UParticleSystemComponent', 'Engine', 'Particles/ParticleSystemComponent.h', 'Legacy Cascade particle system component — deprecated in favor of Niagara', { deprecated: true, deprecatedMessage: 'Deprecated in UE 5.0 — use UNiagaraComponent for new effects', replacementAPI: 'UNiagaraComponent' }),
  c('UNiagaraComponent', 'Niagara', 'NiagaraComponent.h', 'Niagara particle system component for VFX'),
  f('UNiagaraComponent', 'Activate', 'void Activate(bool bReset)', 'void', 'bool bReset', 'NiagaraComponent.h', 'Niagara', 'Activates the Niagara system'),
  f('UNiagaraComponent', 'Deactivate', 'void Deactivate()', 'void', '', 'NiagaraComponent.h', 'Niagara', 'Deactivates the Niagara system'),

  // ── Subsystems ──
  c('UGameInstance', 'Engine', 'Engine/GameInstance.h', 'Persistent game instance that survives level transitions'),
  f('UGameInstance', 'GetSubsystem', 'UGameInstanceSubsystem* GetSubsystem(TSubclassOf<UGameInstanceSubsystem> SubsystemClass) const', 'UGameInstanceSubsystem*', 'TSubclassOf<UGameInstanceSubsystem> SubsystemClass', 'Engine/GameInstance.h', 'Engine', 'Returns a subsystem of the specified type'),
  c('UGameInstanceSubsystem', 'Engine', 'Subsystems/GameInstanceSubsystem.h', 'Subsystem with lifetime tied to the game instance'),
  c('UWorldSubsystem', 'Engine', 'Subsystems/WorldSubsystem.h', 'Subsystem with lifetime tied to a UWorld'),
  c('ULocalPlayerSubsystem', 'Engine', 'Subsystems/LocalPlayerSubsystem.h', 'Subsystem with lifetime tied to a local player'),

  // ── UMG / UI ──
  c('UUserWidget', 'UMG', 'Blueprint/UserWidget.h', 'Base class for user-created UI widgets in UMG'),
  f('UUserWidget', 'NativeConstruct', 'void NativeConstruct()', 'void', '', 'Blueprint/UserWidget.h', 'UMG', 'Called when the widget is constructed natively'),
  f('UUserWidget', 'AddToViewport', 'void AddToViewport(int32 ZOrder)', 'void', 'int32 ZOrder', 'Blueprint/UserWidget.h', 'UMG', 'Adds this widget to the player viewport'),
  f('UUserWidget', 'RemoveFromViewport', 'void RemoveFromViewport()', 'void', '', 'Blueprint/UserWidget.h', 'UMG', 'Removes this widget from the viewport', { deprecated: true, deprecatedMessage: 'Deprecated in UE 5.1 — use RemoveFromParent instead', replacementAPI: 'UUserWidget::RemoveFromParent' }),
  f('UUserWidget', 'RemoveFromParent', 'void RemoveFromParent()', 'void', '', 'Blueprint/UserWidget.h', 'UMG', 'Removes this widget from its parent'),
  f('UUserWidget', 'SetVisibility', 'void SetVisibility(ESlateVisibility InVisibility)', 'void', 'ESlateVisibility InVisibility', 'Blueprint/UserWidget.h', 'UMG', 'Sets the visibility of this widget'),

  c('UWidget', 'UMG', 'Components/Widget.h', 'Base class for all UMG widgets'),
  c('UTextBlock', 'UMG', 'Components/TextBlock.h', 'Widget that displays text'),
  f('UTextBlock', 'SetText', 'void SetText(FText InText)', 'void', 'FText InText', 'Components/TextBlock.h', 'UMG', 'Sets the text content of this text block'),
  f('UTextBlock', 'GetText', 'FText GetText() const', 'FText', '', 'Components/TextBlock.h', 'UMG', 'Returns the current text content'),

  c('UButton', 'UMG', 'Components/Button.h', 'Clickable button widget'),
  c('UImage', 'UMG', 'Components/Image.h', 'Widget that displays an image or texture'),
  f('UImage', 'SetBrushFromTexture', 'void SetBrushFromTexture(UTexture2D* Texture, bool bMatchSize)', 'void', 'UTexture2D* Texture, bool bMatchSize', 'Components/Image.h', 'UMG', 'Sets the image brush from a texture'),

  c('UProgressBar', 'UMG', 'Components/ProgressBar.h', 'Bar that fills based on a percentage value'),
  f('UProgressBar', 'SetPercent', 'void SetPercent(float InPercent)', 'void', 'float InPercent', 'Components/ProgressBar.h', 'UMG', 'Sets the fill percentage (0.0 to 1.0)'),

  c('UScrollBox', 'UMG', 'Components/ScrollBox.h', 'Scrollable container for child widgets'),
  c('UCanvasPanel', 'UMG', 'Components/CanvasPanel.h', 'Panel that allows arbitrary positioning of child widgets'),

  // ── Data Assets ──
  c('UPrimaryDataAsset', 'Engine', 'Engine/DataAsset.h', 'Base class for data-only assets with asset management support'),
  f('UPrimaryDataAsset', 'GetPrimaryAssetId', 'FPrimaryAssetId GetPrimaryAssetId() const', 'FPrimaryAssetId', '', 'Engine/DataAsset.h', 'Engine', 'Returns the primary asset ID for asset manager registration'),

  c('UDataTable', 'Engine', 'Engine/DataTable.h', 'Table of structured data rows indexed by name'),
  f('UDataTable', 'FindRow', 'T* FindRow<T>(FName RowName, const FString& ContextString, bool bWarnIfRowMissing) const', 'T*', 'FName RowName, const FString& ContextString, bool bWarnIfRowMissing', 'Engine/DataTable.h', 'Engine', 'Finds a row by name — returns nullptr if not found'),
  f('UDataTable', 'GetAllRows', 'void GetAllRows<T>(const FString& ContextString, TArray<T*>& OutRowArray) const', 'void', 'const FString& ContextString, TArray<T*>& OutRowArray', 'Engine/DataTable.h', 'Engine', 'Gets all rows in the data table'),
  f('UDataTable', 'GetRowNames', 'TArray<FName> GetRowNames() const', 'TArray<FName>', '', 'Engine/DataTable.h', 'Engine', 'Returns all row names in the data table'),

  c('USaveGame', 'Engine', 'GameFramework/SaveGame.h', 'Base class for save game objects that can be serialized to disk'),
  c('UAssetManager', 'Engine', 'Engine/AssetManager.h', 'Singleton managing primary assets and async loading'),
  f('UAssetManager', 'Get', 'UAssetManager& Get()', 'UAssetManager&', '', 'Engine/AssetManager.h', 'Engine', 'Returns the global asset manager singleton'),

  // ── Blueprint / Kismet Libraries ──
  c('UGameplayStatics', 'Engine', 'Kismet/GameplayStatics.h', 'Static utility functions for common gameplay operations'),
  f('UGameplayStatics', 'GetPlayerPawn', 'APawn* GetPlayerPawn(const UObject* WorldContextObject, int32 PlayerIndex)', 'APawn*', 'const UObject* WorldContextObject, int32 PlayerIndex', 'Kismet/GameplayStatics.h', 'Engine', 'Returns the pawn for the specified player index'),
  f('UGameplayStatics', 'GetPlayerController', 'APlayerController* GetPlayerController(const UObject* WorldContextObject, int32 PlayerIndex)', 'APlayerController*', 'const UObject* WorldContextObject, int32 PlayerIndex', 'Kismet/GameplayStatics.h', 'Engine', 'Returns the player controller for the specified player index'),
  f('UGameplayStatics', 'GetAllActorsOfClass', 'void GetAllActorsOfClass(const UObject* WorldContextObject, TSubclassOf<AActor> ActorClass, TArray<AActor*>& OutActors)', 'void', 'const UObject* WorldContextObject, TSubclassOf<AActor> ActorClass, TArray<AActor*>& OutActors', 'Kismet/GameplayStatics.h', 'Engine', 'Finds all actors of the specified class in the world'),
  f('UGameplayStatics', 'SpawnActor', 'AActor* SpawnActor(UClass* Class, const FTransform& Transform, const FActorSpawnParameters& SpawnParameters)', 'AActor*', 'UClass* Class, const FTransform& Transform, const FActorSpawnParameters& SpawnParameters', 'Kismet/GameplayStatics.h', 'Engine', 'Spawns an actor of the specified class at the given transform', { deprecated: true, deprecatedMessage: 'Use UWorld::SpawnActor or UWorld::SpawnActorDeferred instead', replacementAPI: 'UWorld::SpawnActor' }),
  f('UGameplayStatics', 'PlaySoundAtLocation', 'void PlaySoundAtLocation(const UObject* WorldContextObject, USoundBase* Sound, FVector Location, float VolumeMultiplier, float PitchMultiplier, float StartTime, USoundAttenuation* AttenuationSettings, USoundConcurrency* ConcurrencySettings)', 'void', 'const UObject* WorldContextObject, USoundBase* Sound, FVector Location, float VolumeMultiplier, float PitchMultiplier, float StartTime, USoundAttenuation* AttenuationSettings, USoundConcurrency* ConcurrencySettings', 'Kismet/GameplayStatics.h', 'Engine', 'Plays a sound at a location in the world'),
  f('UGameplayStatics', 'ApplyDamage', 'float ApplyDamage(AActor* DamagedActor, float BaseDamage, AController* EventInstigator, AActor* DamageCauser, TSubclassOf<UDamageType> DamageTypeClass)', 'float', 'AActor* DamagedActor, float BaseDamage, AController* EventInstigator, AActor* DamageCauser, TSubclassOf<UDamageType> DamageTypeClass', 'Kismet/GameplayStatics.h', 'Engine', 'Applies damage to an actor'),
  f('UGameplayStatics', 'OpenLevel', 'void OpenLevel(const UObject* WorldContextObject, FName LevelName, bool bAbsolute, FString Options)', 'void', 'const UObject* WorldContextObject, FName LevelName, bool bAbsolute, FString Options', 'Kismet/GameplayStatics.h', 'Engine', 'Opens a new level by name'),
  f('UGameplayStatics', 'SetGamePaused', 'bool SetGamePaused(const UObject* WorldContextObject, bool bPaused)', 'bool', 'const UObject* WorldContextObject, bool bPaused', 'Kismet/GameplayStatics.h', 'Engine', 'Pauses or unpauses the game'),

  c('UKismetSystemLibrary', 'Engine', 'Kismet/KismetSystemLibrary.h', 'System utility functions for traces, debug drawing, and engine queries'),
  f('UKismetSystemLibrary', 'LineTraceSingle', 'bool LineTraceSingle(const UObject* WorldContextObject, FVector Start, FVector End, ETraceTypeQuery TraceChannel, bool bTraceComplex, const TArray<AActor*>& ActorsToIgnore, EDrawDebugTrace DrawDebugType, FHitResult& OutHit, bool bIgnoreSelf, FLinearColor TraceColor, FLinearColor TraceHitColor, float DrawTime)', 'bool', 'const UObject* WorldContextObject, FVector Start, FVector End, ETraceTypeQuery TraceChannel, ...', 'Kismet/KismetSystemLibrary.h', 'Engine', 'Performs a line trace and returns the first hit'),
  f('UKismetSystemLibrary', 'PrintString', 'void PrintString(const UObject* WorldContextObject, const FString& InString, bool bPrintToScreen, bool bPrintToLog, FLinearColor TextColor, float Duration, FName Key)', 'void', 'const UObject* WorldContextObject, const FString& InString, ...', 'Kismet/KismetSystemLibrary.h', 'Engine', 'Prints a string to the screen and/or log'),

  c('UKismetMathLibrary', 'Engine', 'Kismet/KismetMathLibrary.h', 'Math utility functions for vectors, rotators, transforms, and interpolation'),
  f('UKismetMathLibrary', 'FindLookAtRotation', 'FRotator FindLookAtRotation(const FVector& Start, const FVector& Target)', 'FRotator', 'const FVector& Start, const FVector& Target', 'Kismet/KismetMathLibrary.h', 'Engine', 'Returns a rotation looking from Start towards Target'),
  f('UKismetMathLibrary', 'VInterpTo', 'FVector VInterpTo(FVector Current, FVector Target, float DeltaTime, float InterpSpeed)', 'FVector', 'FVector Current, FVector Target, float DeltaTime, float InterpSpeed', 'Kismet/KismetMathLibrary.h', 'Engine', 'Interpolates a vector towards a target at a given speed'),

  // ── Interfaces ──
  c('UInterface', 'CoreUObject', 'UObject/Interface.h', 'Base class for UE interface declarations'),

  // ── World ──
  c('UWorld', 'Engine', 'Engine/World.h', 'The top-level object representing a world/level'),
  f('UWorld', 'SpawnActor', 'AActor* SpawnActor(UClass* Class, const FTransform* Transform, const FActorSpawnParameters& SpawnParameters)', 'AActor*', 'UClass* Class, const FTransform* Transform, const FActorSpawnParameters& SpawnParameters', 'Engine/World.h', 'Engine', 'Spawns an actor in the world at the given transform'),
  f('UWorld', 'GetTimerManager', 'FTimerManager& GetTimerManager() const', 'FTimerManager&', '', 'Engine/World.h', 'Engine', 'Returns the timer manager for setting up timers'),
  f('UWorld', 'GetFirstPlayerController', 'APlayerController* GetFirstPlayerController() const', 'APlayerController*', '', 'Engine/World.h', 'Engine', 'Returns the first local player controller'),

  // ── Static Mesh Actor ──
  c('AStaticMeshActor', 'Engine', 'Engine/StaticMeshActor.h', 'Actor that renders a static mesh in the level'),
  f('AStaticMeshActor', 'GetStaticMeshComponent', 'UStaticMeshComponent* GetStaticMeshComponent() const', 'UStaticMeshComponent*', '', 'Engine/StaticMeshActor.h', 'Engine', 'Returns the static mesh component of this actor'),

  // ── More deprecated symbols ──
  f('AHUD', 'DrawText', 'void DrawText(const FString& Text, FLinearColor TextColor, float ScreenX, float ScreenY, UFont* Font, float Scale, bool bScalePosition)', 'void', 'const FString& Text, FLinearColor TextColor, float ScreenX, float ScreenY, ...', 'GameFramework/HUD.h', 'Engine', 'Draws text on the HUD — use UMG UUserWidget instead', { deprecated: true, deprecatedMessage: 'HUD canvas drawing is deprecated — use UMG widgets for UI', replacementAPI: 'UUserWidget' }),
  c('AHUD', 'Engine', 'GameFramework/HUD.h', 'Legacy HUD base class for canvas-based UI drawing'),

  f('UPrimitiveComponent', 'SetCollisionResponseToAllChannels', 'void SetCollisionResponseToAllChannels(ECollisionResponse NewResponse)', 'void', 'ECollisionResponse NewResponse', 'Components/PrimitiveComponent.h', 'Engine', 'Old signature — use the explicit enum value overload', { deprecated: true, deprecatedMessage: 'Use explicit ECollisionResponse enum value parameter', replacementAPI: 'SetCollisionResponseToAllChannels(ECollisionResponse::ECR_Block)' }),

  // ── Enums ──
  e('ECollisionChannel', 'Engine', 'Engine/EngineTypes.h', 'Collision channel enum for trace and overlap queries'),
  e('ECollisionEnabled', 'Engine', 'Engine/EngineTypes.h', 'Collision mode: NoCollision, QueryOnly, PhysicsOnly, QueryAndPhysics'),
  e('EMovementMode', 'Engine', 'GameFramework/CharacterMovementComponent.h', 'Character movement mode: Walking, Falling, Swimming, Flying, Custom'),
  e('EInputEvent', 'Engine', 'Engine/EngineTypes.h', 'Input event type: Pressed, Released, Repeat, DoubleClick, Axis'),
  e('EAttachmentRule', 'Engine', 'Engine/EngineTypes.h', 'Attachment rule: KeepRelative, KeepWorld, SnapToTarget'),
  e('ESlateVisibility', 'UMG', 'Components/SlateWrapperTypes.h', 'Widget visibility: Visible, Collapsed, Hidden, HitTestInvisible, SelfHitTestInvisible'),

  // ── Additional commonly used classes ──
  c('UPrimitiveComponent', 'Engine', 'Components/PrimitiveComponent.h', 'Base class for components with rendering and collision'),
  c('UInputComponent', 'Engine', 'Components/InputComponent.h', 'Component for binding input actions and axes'),
  c('UAnimInstance', 'Engine', 'Animation/AnimInstance.h', 'Animation instance driving a skeletal mesh'),
  c('UMaterialInterface', 'Engine', 'Materials/MaterialInterface.h', 'Base class for materials and material instances'),
  c('UMaterialInstanceDynamic', 'Engine', 'Materials/MaterialInstanceDynamic.h', 'Runtime-modifiable material instance'),
  c('UTexture2D', 'Engine', 'Engine/Texture2D.h', 'Two-dimensional texture asset'),
  c('USoundBase', 'Engine', 'Sound/SoundBase.h', 'Base class for all sound assets'),
  c('ULevel', 'Engine', 'Engine/Level.h', 'Contains all actors and data for a single map'),
  c('ALight', 'Engine', 'Engine/Light.h', 'Base class for all light actors'),
  c('APointLight', 'Engine', 'Engine/PointLight.h', 'Point light that emits light in all directions'),
  c('ADirectionalLight', 'Engine', 'Engine/DirectionalLight.h', 'Directional light simulating sunlight'),
  c('ASpotLight', 'Engine', 'Engine/SpotLight.h', 'Spot light with a cone-shaped illumination area'),
  c('AVolume', 'Engine', 'GameFramework/Volume.h', 'Base class for volumes used for trigger areas and physics'),
  c('ATriggerBox', 'Engine', 'Engine/TriggerBox.h', 'Box-shaped trigger volume for overlap events'),
  c('ATriggerSphere', 'Engine', 'Engine/TriggerSphere.h', 'Sphere-shaped trigger volume for overlap events'),
  c('APlayerStart', 'Engine', 'GameFramework/PlayerStart.h', 'Marker actor for player spawn locations'),
  c('ANavigationData', 'NavigationSystem', 'NavigationData.h', 'Base class for navigation mesh data used by AI pathfinding'),
  c('AAIController', 'AIModule', 'AIController.h', 'Controller for AI-driven pawns with behavior tree support'),
  c('UBehaviorTree', 'AIModule', 'BehaviorTree/BehaviorTree.h', 'Behavior tree asset for AI decision making'),
  c('UBlackboardComponent', 'AIModule', 'BehaviorTree/BlackboardComponent.h', 'Component storing AI blackboard data for behavior trees'),
  c('UWidgetComponent', 'UMG', 'Components/WidgetComponent.h', 'Renders a UMG widget in 3D world space'),
  c('UTimelineComponent', 'Engine', 'Components/TimelineComponent.h', 'Component for driving property changes over time with curves'),
  c('UProjectileMovementComponent', 'Engine', 'GameFramework/ProjectileMovementComponent.h', 'Component for simple projectile movement with gravity and homing'),
  c('UFloatingPawnMovement', 'Engine', 'GameFramework/FloatingPawnMovement.h', 'Simple movement for pawns that float and fly'),
  c('UPhysicsHandleComponent', 'Engine', 'PhysicsEngine/PhysicsHandleComponent.h', 'Component for picking up and moving physics objects'),
];
