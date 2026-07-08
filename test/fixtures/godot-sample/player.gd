## The player character.
class_name Player
extends CharacterBody2D

signal died(cause)

@export var speed := 300.0

const HudScene = preload("res://player.tscn")

func _on_area_entered(area):
	take_damage(10)

func take_damage(amount):
	if amount > 0:
		died.emit("hit")
