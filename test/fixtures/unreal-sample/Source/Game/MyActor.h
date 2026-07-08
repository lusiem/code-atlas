#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "MyActor.generated.h"

UCLASS(Blueprintable)
class GAME_API AMyActor : public AActor {
    GENERATED_BODY()

public:
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Combat")
    float Health = 100.0f;

    UPROPERTY(Replicated)
    int32 Ammo;

    UFUNCTION(BlueprintCallable, Category = "Combat")
    void Fire();
};
