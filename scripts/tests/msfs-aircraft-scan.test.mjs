import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inspectWasm, parseCfg, resolveModuleReference, scanAircraft } from '../msfs-aircraft-scan.mjs';

// Minimal valid WASM with one import (env.test, function type 0) and one export (go, function 0).
const wasm = Buffer.from([
  0x00,0x61,0x73,0x6d, 0x01,0x00,0x00,0x00,
  0x02,0x0c,0x01,0x03,0x65,0x6e,0x76,0x04,0x74,0x65,0x73,0x74,0x00,0x00,
  0x07,0x06,0x01,0x02,0x67,0x6f,0x00,0x00
]);

test('WASM parser reads section metadata, imports and exports', () => {
  const result = inspectWasm(wasm);
  assert.equal(result.validHeader, true);
  assert.equal(result.version, 1);
  assert.deepEqual(result.imports, [{ module: 'env', name: 'test', kind: 0 }]);
  assert.deepEqual(result.exports, [{ name: 'go', kind: 0, index: 0 }]);
  assert.deepEqual(result.parsingNotes, []);
});

test('invalid WASM is treated as observation, not an exception', () => {
  const result = inspectWasm(Buffer.from('not-a-wasm'));
  assert.equal(result.validHeader, false);
  assert.ok(result.parsingNotes.length);
});

test('config keys and section names are case insensitive', () => {
  const sections = parseCfg('[WASM_SYSTEM.0]\r\nModulePath=SimObjects/Airplanes/Foo/wasm/core.wasm\r\nSystemName=nav\r\n');
  assert.equal(sections[0].values.modulepath, 'SimObjects/Airplanes/Foo/wasm/core.wasm');
});

test('virtual MSFS path resolves without claiming confirmed exact match', () => {
  const resolution = resolveModuleReference('SimObjects/Airplanes/Foo/wasm/core.wasm', ['wasm/core.wasm']);
  assert.equal(resolution.status, 'suffix');
});

test('ambiguous modules stay ambiguous', () => {
  const resolution = resolveModuleReference('core.wasm', ['foo/core.wasm', 'bar/core.wasm']);
  assert.equal(resolution.status, 'ambiguous');
});

test('scanner inventory links systems.cfg and panel.cfg modules without changing files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rea-flight-'));
  try {
    await mkdir(path.join(root, 'wasm'));
    await writeFile(path.join(root, 'wasm', 'core.wasm'), wasm);
    await writeFile(path.join(root, 'systems.cfg'), '[WASM_SYSTEM.0]\nModulePath=SimObjects/Airplanes/Foo/wasm/core.wasm\nSystemName=nav\n');
    await writeFile(path.join(root, 'panel.cfg'), '[VCockpit01]\nhtmlgauge00=WasmInstrument/WasmInstrument.html?wasm_module=core.wasm&wasm_gauge=TEST,0,0,1,1\n');
    await writeFile(path.join(root, 'manifest.json'), '{"title":"Test aircraft","package_version":"1.0.0"}');
    const report = await scanAircraft(root);
    assert.equal(report.summary.fileCount, 4);
    assert.equal(report.summary.wasmCount, 1);
    assert.equal(report.wasmModules[0].inspection.imports[0].name, 'test');
    assert.equal(report.moduleReferences.length, 3);
    assert.equal(report.moduleReferences[1].resolution.status, 'suffix'); // panel, sorted by path
    assert.equal(report.moduleReferences[2].resolution.status, 'suffix'); // systems
    assert.equal(report.warnings.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
