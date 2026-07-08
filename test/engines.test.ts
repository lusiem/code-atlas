import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/db/store.js';
import { parseScene, parseAutoloads } from '../src/engines/godot.js';
import { Indexer } from '../src/indexer/indexer.js';
import { createServer } from '../src/server.js';

const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'godot-sample');

describe('godot scene parser', () => {
  it('parses nodes, script attachments, instances, connections', () => {
    const scene = parseScene(`[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://a.gd" id="1_x"]
[ext_resource type="PackedScene" path="res://b.tscn" id="2_y"]

[node name="Root" type="Node2D"]
script = ExtResource("1_x")

[node name="Child" type="Sprite2D" parent="."]

[node name="Inst" parent="." instance=ExtResource("2_y")]

[connection signal="pressed" from="Child" to="." method="_on_pressed"]
`);
    expect(scene.nodes).toHaveLength(3);
    expect(scene.nodes[0]).toMatchObject({ name: 'Root', type: 'Node2D', scriptPath: 'res://a.gd' });
    expect(scene.nodes[1]).toMatchObject({ name: 'Child', parent: '.' });
    expect(scene.nodes[2]).toMatchObject({ name: 'Inst', instancePath: 'res://b.tscn' });
    expect(scene.connections).toEqual([
      { signal: 'pressed', from: 'Child', to: '.', method: '_on_pressed' },
    ]);
  });

  it('parses project.godot autoloads', () => {
    const autoloads = parseAutoloads(`config_version=5

[autoload]

GameState="*res://autoload/game_state.gd"
Music="res://music.tscn"

[display]

window/size/width=1280
`);
    expect(autoloads).toEqual([
      { name: 'GameState', path: 'res://autoload/game_state.gd' },
      { name: 'Music', path: 'res://music.tscn' },
    ]);
  });
});

describe('godot project end-to-end', () => {
  let client: Client;
  let store: Store;

  beforeAll(async () => {
    const config = loadConfig(FIXTURE_ROOT);
    store = new Store(':memory:');
    const indexer = new Indexer(config, store);
    await indexer.run();
    const server = createServer({ config, store, indexer });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test-client', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(() => {
    store?.close();
    rmSync(join(FIXTURE_ROOT, '.code-atlas'), { recursive: true, force: true });
  });

  async function callText(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as Array<{ type: string; text: string }>;
    return content.map((c) => c.text).join('\n');
  }

  it('indexes gdscript symbols and engine assets side by side', async () => {
    const overview = await callText('project_overview');
    expect(overview).toContain('gdscript: 2 files');
    expect(overview).toContain('engine assets:');
    expect(overview).toMatch(/godot: .*1 project.*2 scene/);

    const sym = await callText('search_symbols', { query: 'Player' });
    expect(sym).toContain('class Player');
  });

  it('resolves preload() imports to files', async () => {
    const deps = await callText('get_dependencies', { path: 'player.gd' });
    // preload("res://player.tscn") maps to the sibling player.gd? no — itself;
    // the extends res-path in game_state.gd is external (Node), so check level:
    expect(deps).toContain('res://player.tscn');
  });

  it('get_scene_structure renders the node tree with scripts and connections', async () => {
    const out = await callText('get_scene_structure', { path: 'player.tscn' });
    expect(out).toContain('Player (CharacterBody2D)  script=res://player.gd');
    expect(out).toMatch(/\n {2}Sprite \(Sprite2D\)/);
    expect(out).toMatch(/area_entered: Hitbox -> \. :: _on_area_entered\s+\(player\.gd:\d+/);
  });

  it('get_scene_structure shows instanced sub-scenes', async () => {
    const out = await callText('get_scene_structure', { path: 'level.tscn' });
    expect(out).toContain('[instance: res://player.tscn]');
    expect(out).toContain('script=res://autoload/game_state.gd');
  });

  it('find_asset_references answers "which scenes use this script?"', async () => {
    const out = await callText('find_asset_references', { target: 'player.gd' });
    expect(out).toContain('player.tscn (godot scene)  script: res://player.gd  — Player');
  });

  it('find_asset_references finds scene instancing and autoloads', async () => {
    const scenes = await callText('find_asset_references', { target: 'player.tscn' });
    expect(scenes).toContain('level.tscn (godot scene)  scene: res://player.tscn');

    const autoload = await callText('find_asset_references', { target: 'autoload/game_state.gd' });
    expect(autoload).toContain('project.godot (godot project)  autoload: res://autoload/game_state.gd  — GameState');
    expect(autoload).toContain('level.tscn (godot scene)  script: res://autoload/game_state.gd');
  });

  it('find_asset_references locates signal handlers by method name', async () => {
    const out = await callText('find_asset_references', { target: '_on_area_entered' });
    expect(out).toContain('signal_handler: _on_area_entered  — signal area_entered from Hitbox to .');
  });

  it('structural call graph works inside gdscript', async () => {
    const out = await callText('call_hierarchy', { name: 'take_damage', direction: 'in' });
    expect(out).toContain('_on_area_entered');
  });

  it('search_reflection finds @export vars and signals', async () => {
    const exports = await callText('search_reflection', { specifier: '@export' });
    expect(exports).toContain('player.gd:7');
    expect(exports).toContain('speed');
    const signals = await callText('search_reflection', { specifier: 'signal' });
    expect(signals).toContain('signal died');
  });
});

const UNITY_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'unity-sample');

describe('unity project end-to-end', () => {
  let client: Client;
  let store: Store;

  beforeAll(async () => {
    const config = loadConfig(UNITY_ROOT);
    store = new Store(':memory:');
    const indexer = new Indexer(config, store);
    await indexer.run();
    const server = createServer({ config, store, indexer });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test-client', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(() => {
    store?.close();
    rmSync(join(UNITY_ROOT, '.code-atlas'), { recursive: true, force: true });
  });

  async function callText(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as Array<{ type: string; text: string }>;
    return content.map((c) => c.text).join('\n');
  }

  it('builds the guid map from .meta files', () => {
    expect(store.guidForPath('Assets/PlayerController.cs')).toBe('aaaa1111bbbb2222cccc3333dddd4444');
    expect(store.pathForGuid('9999aaaa8888bbbb7777cccc6666dddd')).toBe('Assets/Player.prefab');
  });

  it('answers "which prefabs use this MonoBehaviour?" through the guid map', async () => {
    const out = await callText('find_asset_references', { target: 'Assets/PlayerController.cs' });
    expect(out).toContain('Assets/Player.prefab (unity prefab)');
    expect(out).toContain('script: Assets/PlayerController.cs (guid aaaa1111…)');
    expect(out).toContain('— Player'); // GameObject name
  });

  it('finds scenes instancing a prefab and serialized asset refs', async () => {
    const scenes = await callText('find_asset_references', { target: 'Assets/Player.prefab' });
    expect(scenes).toContain('Assets/Main.unity (unity unity_scene)  prefab:');

    // the serialized material reference (guid has no .meta here, stays raw)
    const rows = store.assetsReferencing(['eeee5555ffff6666aaaa7777bbbb8888']);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ targetKind: 'asset', detail: 'weaponMaterial' });
  });

  it('search_reflection finds [SerializeField] members', async () => {
    const out = await callText('search_reflection', { specifier: '[SerializeField]' });
    expect(out).toContain('moveSpeed');
    expect(out).toContain('Assets/PlayerController.cs:4');
  });
});

const UNREAL_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'unreal-sample');

describe('unreal project end-to-end', () => {
  let client: Client;
  let store: Store;

  beforeAll(async () => {
    const config = loadConfig(UNREAL_ROOT);
    store = new Store(':memory:');
    const indexer = new Indexer(config, store);
    await indexer.run();
    const server = createServer({ config, store, indexer });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test-client', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(() => {
    store?.close();
    rmSync(join(UNREAL_ROOT, '.code-atlas'), { recursive: true, force: true });
  });

  async function callText(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as Array<{ type: string; text: string }>;
    return content.map((c) => c.text).join('\n');
  }

  it('extracts the module graph from .uproject and Build.cs', async () => {
    const modules = await callText('find_asset_references', { target: 'Engine' });
    expect(modules).toContain('Source/Game/Game.Build.cs (unreal buildcs)  module: Engine  — public');

    const game = await callText('find_asset_references', { target: 'Game' });
    expect(game).toContain('Game.uproject (unreal uproject)  module: Game  — Runtime');

    const rows = store.assetsReferencing(['SlateCore']);
    expect(rows[0]).toMatchObject({ detail: 'private' });
    // disabled plugins are not recorded
    expect(store.assetsReferencing(['DisabledThing'])).toHaveLength(0);
  });

  it('search_reflection finds UPROPERTY/UFUNCTION specifiers in headers', async () => {
    const callable = await callText('search_reflection', { specifier: 'BlueprintCallable' });
    expect(callable).toContain('Source/Game/MyActor.h:18');
    expect(callable).toContain('UFUNCTION(BlueprintCallable, Category = "Combat")');
    expect(callable).toContain('void Fire();');

    const replicated = await callText('search_reflection', { specifier: 'Replicated' });
    expect(replicated).toContain('UPROPERTY(Replicated)');
    expect(replicated).toContain('int32 Ammo;');

    const allProps = await callText('search_reflection', { specifier: 'UPROPERTY' });
    expect(allProps).toContain('Health');
    expect(allProps).toContain('Ammo');
  });
});
