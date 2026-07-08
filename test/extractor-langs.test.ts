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
