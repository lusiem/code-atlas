import { describe, expect, it } from 'vitest';
import { extractFile } from '../src/parsing/extractor.js';
import { cExtractor } from '../src/parsing/langs/c.js';
import { cppExtractor } from '../src/parsing/langs/cpp.js';
import { kotlinExtractor } from '../src/parsing/langs/kotlin.js';
import { rustExtractor } from '../src/parsing/langs/rust.js';
import { goExtractor } from '../src/parsing/langs/go.js';
import { javaExtractor } from '../src/parsing/langs/java.js';
import { csharpExtractor } from '../src/parsing/langs/csharp.js';
import { gdscriptExtractor } from '../src/parsing/langs/gdscript.js';
import { phpExtractor } from '../src/parsing/langs/php.js';
import { rubyExtractor } from '../src/parsing/langs/ruby.js';
import { luaExtractor } from '../src/parsing/langs/lua.js';
import { solidityExtractor } from '../src/parsing/langs/solidity.js';
import { zigExtractor } from '../src/parsing/langs/zig.js';
import { nixExtractor } from '../src/parsing/langs/nix.js';
import { swiftExtractor } from '../src/parsing/langs/swift.js';
import { scalaExtractor } from '../src/parsing/langs/scala.js';
import { dartExtractor } from '../src/parsing/langs/dart.js';
import { terraformExtractor } from '../src/parsing/langs/terraform.js';
import { pascalExtractor } from '../src/parsing/langs/pascal.js';
import type { ExtractedSymbol, FileExtraction } from '../src/types.js';

function index(result: FileExtraction): Map<string, ExtractedSymbol> {
  return new Map(result.symbols.map((s) => [s.name, s]));
}

function parentOf(result: FileExtraction, sym: ExtractedSymbol): string | null {
  return sym.parentIndex === null ? null : result.symbols[sym.parentIndex]!.name;
}

const CPP_SRC = `#include <vector>
#include "util.h"
#define MAX_SIZE 100
namespace geo {
/** A shape. */
class Shape : public Base, public IDrawable {
public:
  Shape();
  virtual double area() const;
  int id_, count_;
};
struct Point { double x; double y; };
enum class Color { Red, Green };
using Alias = int;
double Shape::area() const { return 0.0; }
}
int helper(int n) { return n; }
int main() {
  geo::Shape s;
  double a = s.area();
  int b = helper(2);
  b = 5;
  return 0;
}
`;

describe('cpp extractor', () => {
  const resultP = extractFile(cppExtractor, CPP_SRC);

  it('extracts classes, structs, enums, namespaces, macros with docs', async () => {
    const result = await resultP;
    const byName = index(result);
    const shape = result.symbols.find((s) => s.name === 'Shape' && s.kind === 'class')!;
    expect(shape.docComment).toBe('A shape.');
    expect(byName.get('Point')!.kind).toBe('struct');
    expect(byName.get('Color')!.kind).toBe('enum');
    expect(byName.get('Red')!.kind).toBe('enum_member');
    expect(byName.get('geo')!.kind).toBe('namespace');
    expect(byName.get('MAX_SIZE')!.kind).toBe('macro');
    expect(byName.get('Alias')!.kind).toBe('type_alias');
  });

  it('classifies constructors, methods, multi-declarator fields', async () => {
    const result = await resultP;
    const byName = index(result);
    const ctor = result.symbols.find((s) => s.name === 'Shape' && s.kind === 'constructor');
    expect(ctor).toBeDefined();
    expect(parentOf(result, ctor!)).toBe('Shape');
    // both names of `int id_, count_;` become fields
    expect(byName.get('id_')!.kind).toBe('field');
    expect(byName.get('count_')!.kind).toBe('field');
    expect(parentOf(result, byName.get('count_')!)).toBe('Shape');
    // out-of-class definition is a method
    const areas = result.symbols.filter((s) => s.name === 'area');
    expect(areas.some((s) => s.kind === 'method' && s.signature!.includes('Shape::area'))).toBe(true);
    expect(byName.get('helper')!.kind).toBe('function');
  });

  it('records base classes and includes', async () => {
    const result = await resultP;
    const shape = result.symbols.find((s) => s.name === 'Shape' && s.kind === 'class')!;
    expect(shape.bases).toEqual([
      { name: 'Base', kind: 'extends' },
      { name: 'IDrawable', kind: 'extends' },
    ]);
    expect(result.imports).toEqual([
      { specifier: '<vector>', names: [], startLine: 1 },
      { specifier: 'util.h', names: [], startLine: 2 },
    ]);
  });

  it('captures call and write occurrences', async () => {
    const result = await resultP;
    const calls = result.occurrences.filter((o) => o.role === 'call').map((o) => o.name);
    expect(calls).toContain('area');
    expect(calls).toContain('helper');
    const writes = result.occurrences.filter((o) => o.role === 'write').map((o) => o.name);
    expect(writes).toContain('b');
  });
});

const UNREAL_SRC = `#pragma once
#include "MyActor.generated.h"

UCLASS(Blueprintable, BlueprintType)
class MYGAME_API AMyActor : public AActor
{
	GENERATED_BODY()

public:
	AMyActor();

	UFUNCTION(BlueprintCallable, Category = "Combat")
	void Fire(int32 Ammo);

	UPROPERTY(EditAnywhere, Replicated,
		meta = (ClampMin = "0"))
	float Health = 100.0f;

protected:
	virtual void BeginPlay() override;
};

USTRUCT(BlueprintType)
struct FDamageInfo
{
	GENERATED_BODY()

	UPROPERTY(EditAnywhere)
	float Amount = 0.0f;
};
`;

describe('cpp extractor on Unreal headers', () => {
  const resultP = extractFile(cppExtractor, UNREAL_SRC);

  it('extracts UCLASS classes despite the dllexport macro, bases intact', async () => {
    const result = await resultP;
    const actor = result.symbols.find((s) => s.name === 'AMyActor' && s.kind === 'class');
    expect(actor).toBeDefined();
    expect(actor!.bases).toEqual([{ name: 'AActor', kind: 'extends' }]);
    // the blanked macro must not bleed into the signature
    expect(actor!.signature).toBe('class AMyActor : public AActor');
  });

  it('members belong to the class, not the file', async () => {
    const result = await resultP;
    const byName = index(result);
    expect(byName.get('Fire')!.kind).toBe('method');
    expect(parentOf(result, byName.get('Fire')!)).toBe('AMyActor');
    expect(byName.get('Health')!.kind).toBe('field');
    expect(parentOf(result, byName.get('Health')!)).toBe('AMyActor');
    const ctor = result.symbols.find((s) => s.name === 'AMyActor' && s.kind === 'constructor');
    expect(ctor).toBeDefined();
  });

  it('suppresses GENERATED_BODY and bare macro artifacts', async () => {
    const result = await resultP;
    const names = result.symbols.map((s) => s.name);
    expect(names).not.toContain('GENERATED_BODY');
    expect(names).not.toContain('UPROPERTY');
    expect(names).not.toContain('UFUNCTION');
  });

  it('attaches reflection macros to the annotated symbol, multi-line included', async () => {
    const result = await resultP;
    const byName = index(result);
    const actor = result.symbols.find((s) => s.name === 'AMyActor' && s.kind === 'class')!;
    expect(actor.docComment).toBe('UCLASS(Blueprintable, BlueprintType)');
    expect(byName.get('Fire')!.docComment).toBe('UFUNCTION(BlueprintCallable, Category = "Combat")');
    // specifiers spanning lines collapse to one
    expect(byName.get('Health')!.docComment).toBe(
      'UPROPERTY(EditAnywhere, Replicated, meta = (ClampMin = "0"))',
    );
    expect(byName.get('FDamageInfo')!.docComment).toBe('USTRUCT(BlueprintType)');
    expect(byName.get('Amount')!.docComment).toBe('UPROPERTY(EditAnywhere)');
    // un-annotated members stay clean
    expect(byName.get('BeginPlay')!.docComment).toBeNull();
  });
});

const RUST_SRC = `use std::collections::HashMap;
use crate::util::{helper, other as alias};
mod submod;
/// A point.
pub struct Point { pub x: f64, y: f64 }
pub enum Color { Red, Green(u8) }
pub trait Draw { fn draw(&self); }
impl Draw for Point {
    fn draw(&self) { render(self.x); }
}
impl Point {
    pub fn new(x: f64, y: f64) -> Self { Point { x, y } }
}
pub const MAX: usize = 10;
type Pair = (i32, i32);
pub fn main() {
    let p = Point::new(1.0, 2.0);
    p.draw();
    helper();
}
`;

describe('rust extractor', () => {
  const resultP = extractFile(rustExtractor, RUST_SRC);

  it('extracts structs, enums, traits, impls, consts with visibility', async () => {
    const result = await resultP;
    const byName = index(result);
    const point = result.symbols.find((s) => s.name === 'Point' && s.kind === 'struct')!;
    expect(point.docComment).toBe('A point.');
    expect(point.isExported).toBe(true);
    expect(byName.get('Color')!.kind).toBe('enum');
    expect(byName.get('Red')!.kind).toBe('enum_member');
    expect(byName.get('Draw')!.kind).toBe('trait');
    expect(byName.get('MAX')!.kind).toBe('constant');
    expect(byName.get('Pair')!.kind).toBe('type_alias');
    expect(byName.get('Pair')!.isExported).toBe(false);
    expect(byName.get('x')!.kind).toBe('field');
    expect(byName.get('y')!.isExported).toBe(false);
  });

  it('classifies impl members as methods/constructors and records trait impls', async () => {
    const result = await resultP;
    const news = result.symbols.filter((s) => s.name === 'new');
    expect(news[0]!.kind).toBe('constructor');
    expect(parentOf(result, news[0]!)).toBe('Point');
    const draws = result.symbols.filter((s) => s.name === 'draw' && s.kind === 'method');
    expect(draws.length).toBe(2); // trait signature + impl
    const impls = result.symbols.filter((s) => s.kind === 'impl');
    const traitImpl = impls.find((s) => s.bases.length > 0)!;
    expect(traitImpl.bases).toEqual([{ name: 'Draw', kind: 'implements' }]);
  });

  it('extracts use declarations and mod statements as imports', async () => {
    const result = await resultP;
    expect(result.imports).toContainEqual({
      specifier: 'std::collections::HashMap',
      names: ['HashMap'],
      startLine: 1,
    });
    expect(result.imports).toContainEqual({
      specifier: 'crate::util',
      names: ['helper', 'alias'],
      startLine: 2,
    });
    expect(result.imports).toContainEqual({ specifier: './submod', names: ['submod'], startLine: 3 });
  });

  it('captures scoped and method call occurrences', async () => {
    const result = await resultP;
    const calls = result.occurrences.filter((o) => o.role === 'call').map((o) => o.name);
    expect(calls).toContain('new');
    expect(calls).toContain('draw');
    expect(calls).toContain('helper');
    expect(calls).toContain('render');
  });
});

const GO_SRC = `package geometry

import (
	"fmt"
	m "math"
)

// Shape is a shape.
type Shape interface {
	Area() float64
}

type Circle struct {
	Base
	Radius float64
	label  string
}

func (c *Circle) Area() float64 {
	return m.Pi * c.Radius * c.Radius
}

func NewCircle(r float64) *Circle {
	return &Circle{Radius: r}
}

const MaxShapes = 100
var registry = "r"

func run() {
	c := NewCircle(2.0)
	fmt.Println(c.Area())
	registry = "x"
}
`;

describe('go extractor', () => {
  const resultP = extractFile(goExtractor, GO_SRC);

  it('extracts types, methods, funcs, consts, vars with capitalization exports', async () => {
    const result = await resultP;
    const byName = index(result);
    const shape = byName.get('Shape')!;
    expect(shape.kind).toBe('interface');
    expect(shape.docComment).toBe('Shape is a shape.');
    expect(shape.isExported).toBe(true);
    expect(byName.get('Circle')!.kind).toBe('struct');
    expect(byName.get('Radius')!.kind).toBe('field');
    expect(byName.get('label')!.isExported).toBe(false);
    expect(byName.get('NewCircle')!.kind).toBe('function');
    expect(byName.get('MaxShapes')!.kind).toBe('constant');
    expect(byName.get('registry')!.kind).toBe('variable');
    expect(byName.get('run')!.isExported).toBe(false);
    // interface method + receiver method
    const areas = result.symbols.filter((s) => s.name === 'Area' && s.kind === 'method');
    expect(areas.length).toBe(2);
  });

  it('records embedded structs as bases and aliased imports', async () => {
    const result = await resultP;
    const circle = result.symbols.find((s) => s.name === 'Circle')!;
    expect(circle.bases).toEqual([{ name: 'Base', kind: 'extends' }]);
    expect(result.imports).toContainEqual({ specifier: 'fmt', names: ['fmt'], startLine: 4 });
    expect(result.imports).toContainEqual({ specifier: 'math', names: ['m'], startLine: 5 });
  });

  it('captures calls and writes', async () => {
    const result = await resultP;
    const calls = result.occurrences.filter((o) => o.role === 'call').map((o) => o.name);
    expect(calls).toContain('NewCircle');
    expect(calls).toContain('Println');
    expect(calls).toContain('Area');
    const writes = result.occurrences.filter((o) => o.role === 'write').map((o) => o.name);
    expect(writes).toContain('registry');
  });
});

const JAVA_SRC = `package com.example.geo;

import java.util.List;
import java.util.*;

/** A shape. */
public abstract class Shape extends Base implements Drawable, Serializable {
    private int id, version;
    public Shape(int id) { this.id = id; }
    public abstract double area();
    protected void log(String msg) { System.out.println(msg); }
}

interface Drawable {
    void draw();
}

enum Color { RED, GREEN }

class Main {
    public static void main(String[] args) {
        Shape s = make();
        double a = s.area();
        a = 2.0;
    }
}
`;

describe('java extractor', () => {
  const resultP = extractFile(javaExtractor, JAVA_SRC);

  it('extracts classes, interfaces, enums, members with modifiers', async () => {
    const result = await resultP;
    const byName = index(result);
    const shape = result.symbols.find((s) => s.name === 'Shape' && s.kind === 'class')!;
    expect(shape.docComment).toBe('A shape.');
    expect(shape.isExported).toBe(true);
    expect(byName.get('Drawable')!.kind).toBe('interface');
    expect(byName.get('Drawable')!.isExported).toBe(false);
    expect(byName.get('draw')!.isExported).toBe(true); // interface member
    expect(byName.get('RED')!.kind).toBe('enum_member');
    // multi-declarator field
    expect(byName.get('id')!.kind).toBe('field');
    expect(byName.get('version')!.kind).toBe('field');
    expect(parentOf(result, byName.get('version')!)).toBe('Shape');
    const ctor = result.symbols.find((s) => s.kind === 'constructor')!;
    expect(ctor.name).toBe('Shape');
    expect(byName.get('log')!.kind).toBe('method');
    expect(byName.get('log')!.isExported).toBe(false);
  });

  it('records extends and implements', async () => {
    const result = await resultP;
    const shape = result.symbols.find((s) => s.name === 'Shape' && s.kind === 'class')!;
    expect(shape.bases).toContainEqual({ name: 'Base', kind: 'extends' });
    expect(shape.bases).toContainEqual({ name: 'Drawable', kind: 'implements' });
    expect(shape.bases).toContainEqual({ name: 'Serializable', kind: 'implements' });
  });

  it('extracts imports including wildcards', async () => {
    const result = await resultP;
    expect(result.imports).toContainEqual({ specifier: 'java.util.List', names: ['List'], startLine: 3 });
    expect(result.imports).toContainEqual({ specifier: 'java.util.*', names: ['*'], startLine: 4 });
  });

  it('captures method invocations and writes', async () => {
    const result = await resultP;
    const calls = result.occurrences.filter((o) => o.role === 'call').map((o) => o.name);
    expect(calls).toContain('area');
    expect(calls).toContain('make');
    expect(calls).toContain('println');
    const writes = result.occurrences.filter((o) => o.role === 'write').map((o) => o.name);
    expect(writes).toContain('a');
  });
});

const CS_SRC = `using System;
using System.Collections.Generic;

namespace Example.Geo;

/// <summary>A shape.</summary>
public abstract class Shape : Base, IDrawable
{
    private int _id;
    public string Name { get; set; }
    public Shape(int id) { _id = id; }
    public abstract double Area();
    protected void Log(string msg) => Console.WriteLine(msg);
}

public interface IDrawable { void Draw(); }
public struct Point { public double X; }
public enum Color { Red, Green }
public delegate void Handler(int x);

class Program
{
    static void Main()
    {
        var s = MakeShape();
        double a = s.Area();
        a = 5;
    }
}
`;

describe('c_sharp extractor', () => {
  const resultP = extractFile(csharpExtractor, CS_SRC);

  it('extracts namespaces, classes, properties, fields, delegates', async () => {
    const result = await resultP;
    const byName = index(result);
    expect(byName.get('Example.Geo')!.kind).toBe('namespace');
    const shape = result.symbols.find((s) => s.name === 'Shape' && s.kind === 'class')!;
    expect(shape.isExported).toBe(true);
    expect(shape.docComment).toContain('A shape.');
    expect(byName.get('Name')!.kind).toBe('property');
    expect(byName.get('_id')!.kind).toBe('field');
    expect(byName.get('_id')!.isExported).toBe(false);
    expect(byName.get('IDrawable')!.kind).toBe('interface');
    expect(byName.get('Draw')!.isExported).toBe(true); // interface member
    expect(byName.get('Point')!.kind).toBe('struct');
    expect(byName.get('Red')!.kind).toBe('enum_member');
    expect(byName.get('Handler')!.kind).toBe('type_alias');
    const ctor = result.symbols.find((s) => s.kind === 'constructor')!;
    expect(ctor.name).toBe('Shape');
    expect(parentOf(result, ctor)).toBe('Shape');
  });

  it('records base list and using directives', async () => {
    const result = await resultP;
    const shape = result.symbols.find((s) => s.name === 'Shape')!;
    expect(shape.bases).toEqual([
      { name: 'Base', kind: 'extends' },
      { name: 'IDrawable', kind: 'extends' },
    ]);
    expect(result.imports).toContainEqual({ specifier: 'System', names: [], startLine: 1 });
    expect(result.imports).toContainEqual({
      specifier: 'System.Collections.Generic',
      names: [],
      startLine: 2,
    });
  });

  it('captures invocations and writes', async () => {
    const result = await resultP;
    const calls = result.occurrences.filter((o) => o.role === 'call').map((o) => o.name);
    expect(calls).toContain('Area');
    expect(calls).toContain('MakeShape');
    expect(calls).toContain('WriteLine');
    const writes = result.occurrences.filter((o) => o.role === 'write').map((o) => o.name);
    expect(writes).toContain('a');
  });
});


const C_SRC = `#include <stdio.h>
#include "util.h"
#define MAX 10
typedef struct Point { double x, y; } Point;
enum Color { RED, GREEN };
static int counter = 0;
/* Adds two ints. */
int add(int a, int b) { return a + b; }
int main(void) {
  int s = add(1, 2);
  counter = s;
  printf("%d", s);
  return 0;
}
`;

describe('c extractor', () => {
  const resultP = extractFile(cExtractor, C_SRC);

  it('extracts structs, enums, typedefs, macros, functions', async () => {
    const result = await resultP;
    const byName = index(result);
    const point = result.symbols.find((s) => s.name === 'Point' && s.kind === 'struct');
    expect(point).toBeDefined();
    const alias = result.symbols.find((s) => s.name === 'Point' && s.kind === 'type_alias');
    expect(alias).toBeDefined();
    // multi-declarator struct fields
    expect(byName.get('x')!.kind).toBe('field');
    expect(byName.get('y')!.kind).toBe('field');
    expect(byName.get('RED')!.kind).toBe('enum_member');
    expect(byName.get('MAX')!.kind).toBe('macro');
    const add = byName.get('add')!;
    expect(add.kind).toBe('function');
    expect(add.docComment).toBe('Adds two ints.');
    expect(add.isExported).toBe(true);
    expect(byName.get('counter')!.isExported).toBe(false); // static
  });

  it('extracts includes and occurrences', async () => {
    const result = await resultP;
    expect(result.imports).toContainEqual({ specifier: '<stdio.h>', names: [], startLine: 1 });
    expect(result.imports).toContainEqual({ specifier: 'util.h', names: [], startLine: 2 });
    const calls = result.occurrences.filter((o) => o.role === 'call').map((o) => o.name);
    expect(calls).toContain('add');
    expect(calls).toContain('printf');
    const writes = result.occurrences.filter((o) => o.role === 'write').map((o) => o.name);
    expect(writes).toContain('counter');
  });
});

const KT_SRC = `package com.example.geo

import java.util.LinkedList
import com.example.util.*

/** A shape. */
abstract class Shape(val id: Int) : Base(), Drawable {
    abstract fun area(): Double
    private fun log(msg: String) { println(msg) }
}

interface Drawable { fun draw() }
enum class Color { RED, GREEN }
object Registry { val items = LinkedList<Shape>() }
typealias Pair2 = Map<Int, Int>

fun helper(x: Int): Int = x * 2

fun main() {
    val h = helper(3)
    var z = 1
    z = h
}
`;

describe('kotlin extractor', () => {
  const resultP = extractFile(kotlinExtractor, KT_SRC);

  it('extracts classes, interfaces, enums, objects, functions', async () => {
    const result = await resultP;
    const byName = index(result);
    const shape = result.symbols.find((s) => s.name === 'Shape' && s.kind === 'class')!;
    expect(shape.docComment).toBe('A shape.');
    expect(shape.isExported).toBe(true);
    expect(byName.get('Drawable')!.kind).toBe('interface');
    expect(byName.get('Color')!.kind).toBe('enum');
    expect(byName.get('RED')!.kind).toBe('enum_member');
    expect(byName.get('Registry')!.kind).toBe('class');
    expect(byName.get('Pair2')!.kind).toBe('type_alias');
    expect(byName.get('helper')!.kind).toBe('function');
    expect(byName.get('id')!.kind).toBe('property'); // primary constructor val
    const area = byName.get('area')!;
    expect(area.kind).toBe('method');
    expect(parentOf(result, area)).toBe('Shape');
    expect(byName.get('log')!.isExported).toBe(false);
    // locals inside function bodies are not indexed
    expect(byName.has('h')).toBe(false);
  });

  it('distinguishes superclass from interfaces in bases', async () => {
    const result = await resultP;
    const shape = result.symbols.find((s) => s.name === 'Shape' && s.kind === 'class')!;
    expect(shape.bases).toEqual([
      { name: 'Base', kind: 'extends' },
      { name: 'Drawable', kind: 'implements' },
    ]);
  });

  it('extracts imports including wildcards', async () => {
    const result = await resultP;
    expect(result.imports).toContainEqual({
      specifier: 'java.util.LinkedList',
      names: ['LinkedList'],
      startLine: 3,
    });
    expect(result.imports).toContainEqual({
      specifier: 'com.example.util.*',
      names: ['*'],
      startLine: 4,
    });
  });

  it('captures calls and writes', async () => {
    const result = await resultP;
    const calls = result.occurrences.filter((o) => o.role === 'call').map((o) => o.name);
    expect(calls).toContain('helper');
    expect(calls).toContain('println');
    const writes = result.occurrences.filter((o) => o.role === 'write').map((o) => o.name);
    expect(writes).toContain('z');
  });
});

const GD_SRC = `## Player controller doc.
class_name Player
extends "res://base/actor.gd"

signal health_changed(new_health, old)

@export var speed: float = 300.0
@onready var sprite = $Sprite2D

enum State { IDLE, RUNNING = 2, DEAD }

const SAVE_PATH := "user://save.dat"

func _init():
    pass

## Applies damage and emits health_changed.
func take_damage(amount: int) -> void:
    var local_thing = amount - 1
    health_changed.emit(local_thing)
    sprite.play("hurt")
    speed = 0
    move_and_slide()

func _get_speed():
    return preload("res://ui/hud.gd").scale(speed)

class Inner extends Node:
    var inner_field := 3
    const INNER_C = 1
    func helper():
        return inner_field
`;

describe('gdscript extractor', () => {
  const resultP = extractFile(gdscriptExtractor, GD_SRC);

  it('extracts class_name, signals, enums, exported vars, consts', async () => {
    const result = await resultP;
    const byName = index(result);
    const player = byName.get('Player')!;
    expect(player.kind).toBe('class');
    expect(player.docComment).toBe('Player controller doc.');
    expect(byName.get('health_changed')!.kind).toBe('signal');
    expect(byName.get('State')!.kind).toBe('enum');
    expect(byName.get('RUNNING')!.kind).toBe('enum_member');
    expect(byName.get('SAVE_PATH')!.kind).toBe('constant');
    const speed = byName.get('speed')!;
    expect(speed.kind).toBe('variable');
    expect(speed.signature).toContain('@export');
    expect(byName.get('sprite')!.signature).toContain('@onready');
    // function-local vars are not symbols
    expect(byName.has('local_thing')).toBe(false);
  });

  it('handles _init constructor, inner classes, methods, privacy', async () => {
    const result = await resultP;
    const byName = index(result);
    expect(byName.get('_init')!.kind).toBe('constructor');
    expect(byName.get('take_damage')!.kind).toBe('function');
    expect(byName.get('take_damage')!.docComment).toBe('Applies damage and emits health_changed.');
    const inner = byName.get('Inner')!;
    expect(inner.kind).toBe('class');
    expect(inner.bases).toEqual([{ name: 'Node', kind: 'extends' }]);
    const helper = byName.get('helper')!;
    expect(helper.kind).toBe('method');
    expect(parentOf(result, helper)).toBe('Inner');
    expect(byName.get('inner_field')!.kind).toBe('field');
    expect(byName.get('INNER_C')!.kind).toBe('constant');
    expect(byName.get('_get_speed')!.isExported).toBe(false);
    expect(byName.get('take_damage')!.isExported).toBe(true);
  });

  it('collects res:// imports from extends and preload', async () => {
    const result = await resultP;
    expect(result.imports).toContainEqual({
      specifier: 'res://base/actor.gd',
      names: [],
      startLine: 3,
    });
    expect(result.imports).toContainEqual({
      specifier: 'res://ui/hud.gd',
      names: [],
      startLine: 26,
    });
  });

  it('captures calls and writes', async () => {
    const result = await resultP;
    const calls = result.occurrences.filter((o) => o.role === 'call').map((o) => o.name);
    expect(calls).toContain('emit');
    expect(calls).toContain('play');
    expect(calls).toContain('move_and_slide');
    const writes = result.occurrences.filter((o) => o.role === 'write').map((o) => o.name);
    expect(writes).toContain('speed');
  });
});

// ---------------------------------------------------------------- php

const PHP_SRC = `<?php
namespace App\\Services;

use App\\Models\\User as UserModel;
use App\\Contracts\\Cache;

/** Manages users. */
class UserService extends BaseService implements Cache, Countable
{
    const MAX = 10;
    private string $name;

    public function __construct(private UserModel $model) {}

    /** Finds one user. */
    public function find(int $id): ?UserModel
    {
        return $this->model->query($id);
    }

    private function internal() {}
}

interface Repo {}
trait Loggable { public function log() {} }
enum Status: string { case Active = 'a'; case Banned = 'b'; }

function helper($x) { return sprintf('%s', $x); }
`;

describe('php extractor', () => {
  const resultP = extractFile(phpExtractor, PHP_SRC);

  it('extracts classes, interfaces, traits, enums, functions with docs', async () => {
    const result = await resultP;
    const byName = index(result);
    expect(byName.get('UserService')!.kind).toBe('class');
    expect(byName.get('UserService')!.docComment).toBe('Manages users.');
    expect(byName.get('Repo')!.kind).toBe('interface');
    expect(byName.get('Loggable')!.kind).toBe('trait');
    expect(byName.get('Status')!.kind).toBe('enum');
    expect(byName.get('Active')!.kind).toBe('enum_member');
    expect(byName.get('helper')!.kind).toBe('function');
    expect(byName.get('MAX')!.kind).toBe('constant');
    expect(byName.get('name')!.kind).toBe('property');
  });

  it('classifies constructors and visibility', async () => {
    const result = await resultP;
    const ctor = result.symbols.find((s) => s.kind === 'constructor')!;
    expect(ctor.name).toBe('__construct');
    expect(parentOf(result, ctor)).toBe('UserService');
    const find = result.symbols.find((s) => s.name === 'find')!;
    expect(find.kind).toBe('method');
    expect(find.isExported).toBe(true);
    expect(find.docComment).toBe('Finds one user.');
    expect(result.symbols.find((s) => s.name === 'internal')!.isExported).toBe(false);
  });

  it('records bases and use imports', async () => {
    const result = await resultP;
    const svc = index(result).get('UserService')!;
    expect(svc.bases).toEqual([
      { name: 'BaseService', kind: 'extends' },
      { name: 'Cache', kind: 'implements' },
      { name: 'Countable', kind: 'implements' },
    ]);
    expect(result.imports).toEqual([
      { specifier: 'App\\Models\\User', names: ['UserModel'], startLine: 4 },
      { specifier: 'App\\Contracts\\Cache', names: ['Cache'], startLine: 5 },
    ]);
  });

  it('captures call occurrences', async () => {
    const result = await resultP;
    const calls = result.occurrences.filter((o) => o.role === 'call').map((o) => o.name);
    expect(calls).toContain('query');
    expect(calls).toContain('sprintf');
  });
});

// ---------------------------------------------------------------- ruby

const RUBY_SRC = `require 'json'
require_relative './util'

# Manages users.
class UserService < BaseService
  include Comparable

  MAX = 10

  def initialize(model)
    @model = model
  end

  # Finds one user.
  def find(id)
    @model.query(id)
  end

  def self.build
    new(nil)
  end
end

module Helpers
  def helper(x)
    x
  end
end

def top_level(y)
  y
end
`;

describe('ruby extractor', () => {
  const resultP = extractFile(rubyExtractor, RUBY_SRC);

  it('extracts classes, modules, methods, constants with docs', async () => {
    const result = await resultP;
    const byName = index(result);
    expect(byName.get('UserService')!.kind).toBe('class');
    expect(byName.get('UserService')!.docComment).toBe('Manages users.');
    expect(byName.get('Helpers')!.kind).toBe('module');
    expect(byName.get('MAX')!.kind).toBe('constant');
    const find = byName.get('find')!;
    expect(find.kind).toBe('method');
    expect(find.docComment).toBe('Finds one user.');
    expect(parentOf(result, find)).toBe('UserService');
    expect(byName.get('build')!.kind).toBe('method');
  });

  it('reclassifies initialize and top-level defs', async () => {
    const result = await resultP;
    const byName = index(result);
    expect(byName.get('initialize')!.kind).toBe('constructor');
    expect(byName.get('top_level')!.kind).toBe('function');
    expect(byName.get('helper')!.kind).toBe('method'); // module method
  });

  it('records superclass and mixins as bases', async () => {
    const result = await resultP;
    const svc = index(result).get('UserService')!;
    expect(svc.bases).toEqual([
      { name: 'BaseService', kind: 'extends' },
      { name: 'Comparable', kind: 'implements' },
    ]);
  });

  it('extracts require / require_relative imports', async () => {
    const result = await resultP;
    expect(result.imports).toEqual([
      { specifier: 'json', names: [], startLine: 1 },
      { specifier: './util', names: [], startLine: 2 },
    ]);
  });

  it('captures call occurrences', async () => {
    const result = await resultP;
    const calls = result.occurrences.filter((o) => o.role === 'call').map((o) => o.name);
    expect(calls).toContain('query');
  });
});

// ---------------------------------------------------------------- lua

const LUA_SRC = `local util = require("app.util")

--- Adds numbers.
local function add(a, b)
  return a + b
end

local M = {}

function M.helper(x)
  return util.trim(x)
end

function M:method(y)
  return self.value + y
end

local MAX = 10
GLOBAL_VAR = 5
`;

describe('lua extractor', () => {
  const resultP = extractFile(luaExtractor, LUA_SRC);

  it('extracts functions, table functions, methods, variables', async () => {
    const result = await resultP;
    const byName = index(result);
    expect(byName.get('add')!.kind).toBe('function');
    expect(byName.get('add')!.docComment).toBe('Adds numbers.');
    expect(byName.get('add')!.isExported).toBe(false); // local
    expect(byName.get('helper')!.kind).toBe('function');
    expect(byName.get('helper')!.signature).toContain('M.helper');
    expect(byName.get('method')!.kind).toBe('method');
    expect(byName.get('MAX')!.kind).toBe('variable');
    expect(byName.get('GLOBAL_VAR')!.isExported).toBe(true);
  });

  it('extracts require imports and call occurrences', async () => {
    const result = await resultP;
    expect(result.imports).toEqual([
      { specifier: 'app.util', names: [], startLine: 1 },
    ]);
    const calls = result.occurrences.filter((o) => o.role === 'call').map((o) => o.name);
    expect(calls).toContain('trim');
  });
});

// ---------------------------------------------------------------- solidity

const SOLIDITY_SRC = `pragma solidity ^0.8.0;
import "./Base.sol";
import {IERC20} from "@openzeppelin/token/IERC20.sol";

/// A token vault.
contract Vault is Base, IERC20 {
    uint256 public totalShares;
    address private owner;

    event Deposited(address indexed who, uint256 amount);
    error NotOwner();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// Deposit funds.
    function deposit(uint256 amount) external returns (uint256) {
        emit Deposited(msg.sender, amount);
        return _mint(amount);
    }

    function _mint(uint256 amount) internal returns (uint256) {
        totalShares += amount;
        return amount;
    }
}

interface IVault { function deposit(uint256) external; }
library MathLib { function min(uint a, uint b) internal pure returns (uint) { return a; } }
enum Side { Long, Short }
`;

describe('solidity extractor', () => {
  const resultP = extractFile(solidityExtractor, SOLIDITY_SRC);

  it('extracts contracts, interfaces, libraries, events, state vars', async () => {
    const result = await resultP;
    const byName = index(result);
    expect(byName.get('Vault')!.kind).toBe('class');
    expect(byName.get('Vault')!.docComment).toBe('A token vault.');
    expect(byName.get('IVault')!.kind).toBe('interface');
    expect(byName.get('MathLib')!.kind).toBe('namespace');
    expect(byName.get('Deposited')!.kind).toBe('signal');
    expect(byName.get('NotOwner')!.kind).toBe('constant');
    expect(byName.get('Side')!.kind).toBe('enum');
    expect(byName.get('Long')!.kind).toBe('enum_member');
    expect(byName.get('totalShares')!.kind).toBe('field');
    expect(byName.get('onlyOwner')!.kind).toBe('method'); // modifier in contract
  });

  it('tracks visibility and bases', async () => {
    const result = await resultP;
    const byName = index(result);
    expect(byName.get('owner')!.isExported).toBe(false); // private
    expect(byName.get('_mint')!.isExported).toBe(false); // internal
    const deposits = result.symbols.filter((s) => s.name === 'deposit');
    expect(deposits.some((s) => s.isExported)).toBe(true); // external
    expect(byName.get('Vault')!.bases).toEqual([
      { name: 'Base', kind: 'extends' },
      { name: 'IERC20', kind: 'extends' },
    ]);
  });

  it('extracts imports and call occurrences', async () => {
    const result = await resultP;
    expect(result.imports).toEqual([
      { specifier: './Base.sol', names: [], startLine: 2 },
      { specifier: '@openzeppelin/token/IERC20.sol', names: ['IERC20'], startLine: 3 },
    ]);
    const calls = result.occurrences.filter((o) => o.role === 'call').map((o) => o.name);
    expect(calls).toContain('_mint');
    expect(calls).toContain('Deposited'); // emit
  });
});

// ---------------------------------------------------------------- zig

const ZIG_SRC = `const std = @import("std");
const util = @import("./util.zig");

/// A point in 2d.
const Point = struct {
    x: f32,
    y: f32,

    pub fn norm(self: Point) f32 {
        return self.x;
    }
};

const Color = enum { red, green };
const MAX: u32 = 10;
var counter: u32 = 0;

pub fn add(a: i32, b: i32) i32 {
    return a + b;
}
`;

describe('zig extractor', () => {
  const resultP = extractFile(zigExtractor, ZIG_SRC);

  it('extracts containers, functions, consts', async () => {
    const result = await resultP;
    const byName = index(result);
    expect(byName.get('Point')!.kind).toBe('struct');
    expect(byName.get('Point')!.docComment).toBe('A point in 2d.');
    expect(byName.get('Color')!.kind).toBe('enum');
    expect(byName.get('red')!.kind).toBe('enum_member');
    expect(byName.get('x')!.kind).toBe('field');
    expect(byName.get('add')!.kind).toBe('function');
    expect(byName.get('add')!.isExported).toBe(true); // pub
    expect(byName.get('norm')!.isExported).toBe(true);
    expect(parentOf(result, byName.get('norm')!)).toBe('Point');
    expect(byName.get('MAX')!.kind).toBe('constant');
    expect(byName.get('counter')!.kind).toBe('variable');
    expect(byName.get('counter')!.isExported).toBe(false);
  });

  it('extracts @import specifiers', async () => {
    const result = await resultP;
    expect(result.imports).toEqual([
      { specifier: 'std', names: [], startLine: 1 },
      { specifier: './util.zig', names: [], startLine: 2 },
    ]);
  });
});

// ---------------------------------------------------------------- nix

const NIX_SRC = `{ pkgs, lib, ... }:

let
  version = "1.2.3";
  mkGreeting = name: "hello " + name;
  helpers = import ./helpers.nix { inherit pkgs; };
in
{
  package = pkgs.stdenv.mkDerivation {
    pname = "demo";
    inherit version;
  };
  greeting = mkGreeting "world";
  other = import ./other;
}
`;

describe('nix extractor', () => {
  const resultP = extractFile(nixExtractor, NIX_SRC);

  it('extracts bindings; function-valued bindings are functions', async () => {
    const result = await resultP;
    const byName = index(result);
    expect(byName.get('version')!.kind).toBe('variable');
    expect(byName.get('mkGreeting')!.kind).toBe('function');
    expect(byName.get('package')!.kind).toBe('variable');
  });

  it('extracts import paths and application calls', async () => {
    const result = await resultP;
    expect(result.imports).toEqual([
      { specifier: './helpers.nix', names: [], startLine: 6 },
      { specifier: './other', names: [], startLine: 14 },
    ]);
    const calls = result.occurrences.filter((o) => o.role === 'call').map((o) => o.name);
    expect(calls).toContain('mkGreeting');
  });
});

// ---------------------------------------------------------------- swift

const SWIFT_SRC = `import Foundation

/// A user of the system.
public class UserService: BaseService, Cacheable {
    let name: String
    private var count: Int = 0

    /// Finds a user.
    public func find(id: Int) -> String? {
        return query(id)
    }
}

protocol Cacheable {
    func cached() -> Bool
}

struct Point { var x: Double; var y: Double }
enum Color { case red, green }
extension UserService {
    func extra() {}
}
typealias Handler = (Int) -> Void
public func topLevel(x: Int) -> Int { return x }
`;

describe('swift extractor', () => {
  const resultP = extractFile(swiftExtractor, SWIFT_SRC);

  it('extracts classes, protocols, structs, enums, extensions', async () => {
    const result = await resultP;
    const byName = index(result);
    const cls = result.symbols.find((s) => s.name === 'UserService' && s.kind === 'class')!;
    expect(cls).toBeDefined();
    expect(cls.docComment).toBe('A user of the system.');
    expect(byName.get('Cacheable')!.kind).toBe('interface');
    expect(byName.get('cached')!.kind).toBe('method');
    expect(byName.get('Point')!.kind).toBe('struct');
    expect(byName.get('Color')!.kind).toBe('enum');
    expect(byName.get('red')!.kind).toBe('enum_member');
    expect(byName.get('Handler')!.kind).toBe('type_alias');
    expect(byName.get('topLevel')!.kind).toBe('function');
    // the extension is an impl block on UserService
    const impls = result.symbols.filter((s) => s.kind === 'impl');
    expect(impls).toHaveLength(1);
    expect(impls[0]!.name).toBe('UserService');
    expect(parentOf(result, byName.get('extra')!)).toBe('UserService');
  });

  it('tracks visibility, methods, properties, bases', async () => {
    const result = await resultP;
    const byName = index(result);
    expect(byName.get('find')!.kind).toBe('method');
    expect(byName.get('find')!.docComment).toBe('Finds a user.');
    expect(byName.get('count')!.isExported).toBe(false); // private
    expect(byName.get('name')!.kind).toBe('property');
    const cls = result.symbols.find((s) => s.name === 'UserService' && s.kind === 'class')!;
    expect(cls.bases).toEqual([
      { name: 'BaseService', kind: 'extends' },
      { name: 'Cacheable', kind: 'extends' },
    ]);
  });

  it('records module imports and calls', async () => {
    const result = await resultP;
    expect(result.imports).toEqual([{ specifier: 'Foundation', names: [], startLine: 1 }]);
    const calls = result.occurrences.filter((o) => o.role === 'call').map((o) => o.name);
    expect(calls).toContain('query');
  });
});

// ---------------------------------------------------------------- scala

const SCALA_SRC = `package app.services

import scala.collection.mutable.Map
import app.models.{User, Role => UserRole}

/** Manages users. */
class UserService(repo: Repo) extends BaseService with Cacheable with Loggable {
  val max: Int = 10
  var count = 0

  /** Finds one. */
  def find(id: Int): Option[User] = repo.query(id)
}

object UserService {
  def apply(): UserService = new UserService(null)
}

trait Cacheable { def cached: Boolean }
case class Point(x: Double, y: Double)
enum Color:
  case Red, Green

type Handler = Int => Unit
def topLevel(y: Int): Int = y
`;

describe('scala extractor', () => {
  const resultP = extractFile(scalaExtractor, SCALA_SRC);

  it('extracts classes, objects, traits, enums (scala 3 syntax)', async () => {
    const result = await resultP;
    const byName = index(result);
    const classes = result.symbols.filter((s) => s.name === 'UserService');
    expect(classes.some((s) => s.kind === 'class')).toBe(true);
    expect(classes.some((s) => s.kind === 'module')).toBe(true); // companion object
    expect(byName.get('Cacheable')!.kind).toBe('trait');
    expect(byName.get('Point')!.kind).toBe('class'); // case class
    expect(byName.get('Color')!.kind).toBe('enum');
    expect(byName.get('Red')!.kind).toBe('enum_member');
    expect(byName.get('Handler')!.kind).toBe('type_alias');
    expect(byName.get('topLevel')!.kind).toBe('function');
  });

  it('classifies members and bases', async () => {
    const result = await resultP;
    const byName = index(result);
    expect(byName.get('find')!.kind).toBe('method');
    expect(byName.get('find')!.docComment).toBe('Finds one.');
    expect(byName.get('max')!.kind).toBe('constant'); // val
    expect(byName.get('count')!.kind).toBe('variable'); // var
    expect(byName.get('apply')!.kind).toBe('method'); // in object
    const svc = result.symbols.find((s) => s.name === 'UserService' && s.kind === 'class')!;
    expect(svc.bases).toEqual([
      { name: 'BaseService', kind: 'extends' },
      { name: 'Cacheable', kind: 'implements' },
      { name: 'Loggable', kind: 'implements' },
    ]);
  });

  it('extracts imports with selectors and renames', async () => {
    const result = await resultP;
    expect(result.imports).toEqual([
      { specifier: 'scala.collection.mutable.Map', names: ['Map'], startLine: 3 },
      { specifier: 'app.models', names: ['User', 'UserRole'], startLine: 4 },
    ]);
  });
});

// ---------------------------------------------------------------- dart

const DART_SRC = `import 'package:app/models/user.dart';
import './util.dart';

/// Manages users.
class UserService extends BaseService with Loggable implements Cacheable {
  final String name;
  int _count = 0;

  UserService(this.name);

  /// Finds one user.
  Future<User?> find(int id) async {
    return query(id);
  }

  int get count => _count;
}

mixin Loggable {
  void log(String m) {}
}

enum Color { red, green }
extension UserX on UserService {
  void extra() {}
}
typedef Handler = void Function(int);
int topLevel(int x) => x;
const maxUsers = 10;
`;

describe('dart extractor', () => {
  const resultP = extractFile(dartExtractor, DART_SRC);

  it('extracts classes, mixins, enums, extensions, typedefs', async () => {
    const result = await resultP;
    const byName = index(result);
    const cls = result.symbols.find((s) => s.name === 'UserService' && s.kind === 'class')!;
    expect(cls).toBeDefined();
    expect(cls.docComment).toBe('Manages users.');
    expect(byName.get('Loggable')!.kind).toBe('trait');
    expect(byName.get('Color')!.kind).toBe('enum');
    expect(byName.get('red')!.kind).toBe('enum_member');
    expect(byName.get('UserX')!.kind).toBe('impl');
    expect(byName.get('Handler')!.kind).toBe('type_alias');
    expect(byName.get('topLevel')!.kind).toBe('function');
    expect(byName.get('maxUsers')!.kind).toBe('constant');
  });

  it('classifies members, constructors, privacy, bases', async () => {
    const result = await resultP;
    const byName = index(result);
    expect(byName.get('find')!.kind).toBe('method');
    expect(byName.get('find')!.docComment).toBe('Finds one user.');
    const ctor = result.symbols.find((s) => s.kind === 'constructor');
    expect(ctor?.name).toBe('UserService');
    expect(byName.get('_count')!.isExported).toBe(false); // underscore = private
    expect(byName.get('name')!.kind).toBe('field');
    expect(byName.get('count')!.kind).toBe('property'); // getter
    const cls = result.symbols.find((s) => s.name === 'UserService' && s.kind === 'class')!;
    expect(cls.bases).toEqual([
      { name: 'BaseService', kind: 'extends' },
      { name: 'Loggable', kind: 'implements' },
      { name: 'Cacheable', kind: 'implements' },
    ]);
  });

  it('extracts uri imports and calls', async () => {
    const result = await resultP;
    expect(result.imports).toEqual([
      { specifier: 'package:app/models/user.dart', names: [], startLine: 1 },
      { specifier: './util.dart', names: [], startLine: 2 },
    ]);
    const calls = result.occurrences.filter((o) => o.role === 'call').map((o) => o.name);
    expect(calls).toContain('query');
  });
});


// ---------------------------------------------------------------- terraform

const TF_SRC = `resource "aws_s3_bucket" "logs" {
  bucket = var.bucket_name
  tags   = local.common_tags
}

data "aws_ami" "ubuntu" {
  most_recent = true
}

module "network" {
  source = "./modules/net"
  cidr   = var.cidr
}

variable "bucket_name" {
  type    = string
  default = "logs"
}

output "bucket_arn" {
  value = aws_s3_bucket.logs.arn
}

locals {
  common_tags = { env = "prod" }
  region      = "us-east-1"
}

provider "aws" {
  region = local.region
}
`;

describe('terraform extractor', () => {
  const resultP = extractFile(terraformExtractor, TF_SRC);

  it('maps blocks to symbols: resource/data/module/variable/output/locals/provider', async () => {
    const result = await resultP;
    const byName = index(result);
    const logs = byName.get('logs')!;
    expect(logs.kind).toBe('struct');
    expect(logs.signature).toContain('aws_s3_bucket'); // type searchable via signature
    expect(byName.get('ubuntu')!.kind).toBe('struct'); // data block
    expect(byName.get('network')!.kind).toBe('module');
    expect(byName.get('bucket_name')!.kind).toBe('variable');
    expect(byName.get('bucket_arn')!.kind).toBe('constant'); // output
    expect(byName.get('common_tags')!.kind).toBe('variable'); // locals entry
    expect(byName.get('region')!.kind).toBe('variable');
    expect(byName.get('aws')!.kind).toBe('namespace'); // provider
  });

  it('module source resolves as an import; var/local refs are occurrences', async () => {
    const result = await resultP;
    expect(result.imports).toEqual([
      { specifier: './modules/net', names: [], startLine: 11 },
    ]);
    const refs = result.occurrences.map((o) => o.name);
    expect(refs).toContain('bucket_name'); // var.bucket_name
    expect(refs).toContain('common_tags'); // local.common_tags
    expect(refs).toContain('logs'); // aws_s3_bucket.logs
  });
});

// ---------------------------------------------------------------- pascal

const PASCAL_SRC = `unit UserService;

interface

uses SysUtils, App.Models;

type
  { Manages users. }
  TUserService = class(TBaseService, ICache)
  private
    FName: string;
  public
    constructor Create(AName: string);
    function Find(Id: Integer): string;
    property Name: string read FName;
  end;

  TPoint = record
    X, Y: Double;
  end;

  TColor = (Red, Green);
  THandler = procedure(X: Integer);

const
  MAX_USERS = 10;

var
  GCounter: Integer;

function TopLevel(Y: Integer): Integer;

implementation

constructor TUserService.Create(AName: string);
begin
  FName := AName;
end;

function TUserService.Find(Id: Integer): string;
begin
  Result := Query(Id);
end;

function TopLevel(Y: Integer): Integer;
begin
  Result := Y;
end;

end.
`;

describe('pascal extractor', () => {
  const resultP = extractFile(pascalExtractor, PASCAL_SRC);

  it('extracts units, classes, records, enums, procs with docs', async () => {
    const result = await resultP;
    const byName = index(result);
    expect(byName.get('UserService')!.kind).toBe('module');
    const cls = result.symbols.find((s) => s.name === 'TUserService' && s.kind === 'class')!;
    expect(cls).toBeDefined();
    expect(cls.docComment).toBe('Manages users.');
    expect(byName.get('TPoint')!.kind).toBe('struct');
    expect(byName.get('TColor')!.kind).toBe('enum');
    expect(byName.get('Red')!.kind).toBe('enum_member');
    expect(byName.get('THandler')!.kind).toBe('type_alias');
    expect(byName.get('MAX_USERS')!.kind).toBe('constant');
    expect(byName.get('GCounter')!.kind).toBe('variable');
    // record fields: both names of `X, Y: Double`
    expect(byName.get('X')!.kind).toBe('field');
    expect(byName.get('Y')!.kind).toBe('field');
  });

  it('classifies constructors, qualified impl names, visibility', async () => {
    const result = await resultP;
    const byName = index(result);
    const ctors = result.symbols.filter((s) => s.kind === 'constructor');
    expect(ctors.length).toBeGreaterThanOrEqual(1);
    expect(ctors.every((s) => s.name === 'Create')).toBe(true);
    // implementation-section `function TUserService.Find` binds the last identifier
    const finds = result.symbols.filter((s) => s.name === 'Find');
    expect(finds.some((s) => s.kind === 'method')).toBe(true);
    expect(byName.get('FName')!.isExported).toBe(false); // private section
    expect(byName.get('Name')!.kind).toBe('property');
    const cls = result.symbols.find((s) => s.name === 'TUserService' && s.kind === 'class')!;
    expect(cls.bases).toEqual([
      { name: 'TBaseService', kind: 'extends' },
      { name: 'ICache', kind: 'implements' },
    ]);
  });

  it('extracts uses clauses and calls', async () => {
    const result = await resultP;
    expect(result.imports).toEqual([
      { specifier: 'SysUtils', names: [], startLine: 5 },
      { specifier: 'App.Models', names: [], startLine: 5 },
    ]);
    const calls = result.occurrences.filter((o) => o.role === 'call').map((o) => o.name);
    expect(calls).toContain('Query');
  });
});

