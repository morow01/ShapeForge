import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as THREE from 'three';
const sceneSource = readFileSync(new URL('../src/viewport/scene.ts', import.meta.url), 'utf8');
const tree = ts.createSourceFile('scene.ts', sceneSource, ts.ScriptTarget.Latest, true);
const scene = tree.statements.find(n => ts.isClassDeclaration(n) && n.name.text === 'Scene');
const method = scene.members.find(n => n.name?.getText(tree) === 'saveCameraNow');
const body = ts.transpile(method.body.getText(tree), { target: ts.ScriptTarget.ES2022 });
const persistSource = readFileSync(new URL('../src/document/persist.ts', import.meta.url), 'utf8');
const start = persistSource.indexOf('export function loadCameraState(');
const end = persistSource.indexOf('/** The imported files', start);
const js = ts.transpile(persistSource.slice(start, end).replaceAll('export function', 'function'), { target: ts.ScriptTarget.ES2022 });
let active = 'A'; const values = new Map();
const storage = {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value)};
const api = new Function('localStorage', 'getActiveProjectId', 'loadProject', 'isVec3', 'CAMERA_KEY', js + ';return {loadCameraState,saveCameraState};')(storage, () => active, () => null, v => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite), 'cad.camera');
const save = new Function('THREE', 'saveCameraState', body).bind({
  cameraProjectId: 'A', camera: new THREE.OrthographicCamera(-50,50,30,-30),
  controls: {target: new THREE.Vector3(10,20,30)},
});
// Teardown of project A runs after the active ID has switched to B.
active = 'B'; save(THREE, api.saveCameraState);
assert.equal(api.loadCameraState('B'), null);
const a = api.loadCameraState('A');
assert.equal(a.orthoHeight, 60);
assert.deepEqual(a.target, [10,20,30]);
api.saveCameraState({mode:'perspective', position:[100,-50,70], target:[2,3,4]}, 'B');
assert.equal(api.loadCameraState('A').orthoHeight, 60);
assert.deepEqual(api.loadCameraState('B').position, [100,-50,70]);
// A restarted viewport can restore the exact visible height independently of camera distance.
const restored = new THREE.OrthographicCamera(-50,50,a.orthoHeight/2,-a.orthoHeight/2);
restored.zoom = a.zoom ?? 1;
assert.equal((restored.top-restored.bottom)/restored.zoom, 60);
console.log('Camera persistence: project switch teardown, independent project views, orthographic framing passed.');
