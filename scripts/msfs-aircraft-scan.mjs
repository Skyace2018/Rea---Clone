#!/usr/bin/env node
/**
 * REA Flight Diagnostics - Phase 1A, read-only MSFS aircraft inventory.
 * Uses Node.js built-ins only. No network, simulator control, or file mutation.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_WASM_PARSE_BYTES = 64 * 1024 * 1024;
const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 100_000;
const normalize = value => String(value).replaceAll('\\', '/').replace(/^\/+/, '').toLowerCase();

function readU32(bytes, state, limit = bytes.length) {
  let value = 0;
  for (let shift = 0; shift <= 28; shift += 7) {
    if (state.offset >= limit) throw new Error('truncated unsigned LEB128');
    const byte = bytes[state.offset++];
    value += (byte & 0x7f) * (2 ** shift);
    if ((byte & 0x80) === 0) {
      if (value > 0xffffffff) throw new Error('unsigned LEB128 overflow');
      return value;
    }
  }
  throw new Error('unsigned LEB128 exceeds 32 bits');
}

function readName(bytes, state, limit) {
  const length = readU32(bytes, state, limit);
  if (length > limit - state.offset) throw new Error('truncated name');
  const result = bytes.toString('utf8', state.offset, state.offset + length);
  state.offset += length;
  return result;
}

function skipLimits(bytes, state, limit) {
  const flags = readU32(bytes, state, limit);
  if ((flags & 0x04) !== 0) throw new Error('memory64 limits not supported in Phase 1A');
  readU32(bytes, state, limit);
  if ((flags & 0x01) !== 0) readU32(bytes, state, limit);
}

function parseImportSection(bytes, start, end) {
  const state = { offset: start };
  const count = readU32(bytes, state, end);
  if (count > 100_000) throw new Error('import count exceeds safety limit');
  const entries = [];
  for (let i = 0; i < count; i++) {
    const module = readName(bytes, state, end);
    const name = readName(bytes, state, end);
    if (state.offset >= end) throw new Error('truncated import descriptor');
    const kind = bytes[state.offset++];
    if (kind === 0) readU32(bytes, state, end);
    else if (kind === 1) {
      if (state.offset >= end) throw new Error('truncated table reference type');
      state.offset++;
      skipLimits(bytes, state, end);
    } else if (kind === 2) skipLimits(bytes, state, end);
    else if (kind === 3) {
      if (state.offset + 2 > end) throw new Error('truncated global type');
      state.offset += 2;
    } else if (kind === 4) { readU32(bytes, state, end); readU32(bytes, state, end); }
    else throw new Error('unsupported import descriptor kind ' + kind);
    entries.push({ module, name, kind });
  }
  if (state.offset !== end) throw new Error('unconsumed bytes in import section');
  return entries;
}

function parseExportSection(bytes, start, end) {
  const state = { offset: start };
  const count = readU32(bytes, state, end);
  if (count > 100_000) throw new Error('export count exceeds safety limit');
  const entries = [];
  for (let i = 0; i < count; i++) {
    const name = readName(bytes, state, end);
    if (state.offset >= end) throw new Error('truncated export descriptor');
    const kind = bytes[state.offset++];
    const index = readU32(bytes, state, end);
    entries.push({ name, kind, index });
  }
  if (state.offset !== end) throw new Error('unconsumed bytes in export section');
  return entries;
}

export function inspectWasm(bytes) {
  const result = { validHeader: false, version: null, sections: [], imports: [], exports: [], parsingNotes: [] };
  if (bytes.length < 8 || bytes.subarray(0, 4).toString('hex') !== '0061736d') {
    result.parsingNotes.push('Not a WebAssembly binary (missing magic header)');
    return result;
  }
  result.validHeader = true;
  result.version = bytes.readUInt32LE(4);
  if (result.version !== 1) {
    result.parsingNotes.push('WASM version ' + result.version + ' is not supported by this parser');
    return result;
  }
  const state = { offset: 8 };
  try {
    while (state.offset < bytes.length) {
      const sectionId = bytes[state.offset++];
      const size = readU32(bytes, state);
      const start = state.offset;
      const end = start + size;
      if (end > bytes.length) throw new Error('truncated section ' + sectionId);
      result.sections.push({ id: sectionId, bytes: size });
      if (sectionId === 2) {
        try { result.imports.push(...parseImportSection(bytes, start, end)); }
        catch (error) { result.parsingNotes.push('Import parsing incomplete: ' + error.message); }
      }
      if (sectionId === 7) {
        try { result.exports.push(...parseExportSection(bytes, start, end)); }
        catch (error) { result.parsingNotes.push('Export parsing incomplete: ' + error.message); }
      }
      state.offset = end;
    }
  } catch (error) { result.parsingNotes.push('Section parsing incomplete: ' + error.message); }
  return result;
}

export function parseCfg(content) {
  const sections = [];
  let current = null;
  for (const rawLine of content.replace(/^\uFEFF/, '').split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';') || line.startsWith('//')) continue;
    const heading = /^\[([^\]]+)\]$/u.exec(line);
    if (heading) {
      current = { name: heading[1], values: {} };
      sections.push(current);
      continue;
    }
    const equals = line.indexOf('=');
    if (current && equals > 0) {
      const key = line.slice(0, equals).trim().toLowerCase();
      current.values[key] = line.slice(equals + 1).trim();
    }
  }
  return sections;
}

export function resolveModuleReference(reference, wasmFiles) {
  const cleaned = normalize(reference.replace(/^['"]|['"]$/gu, '').trim());
  const normalizedFiles = wasmFiles.map(file => ({ path: file, normalized: normalize(file) }));
  const exact = normalizedFiles.filter(file => file.normalized === cleaned);
  if (exact.length === 1) return { status: 'exact', matches: [exact[0].path] };
  const suffix = normalizedFiles.filter(file => cleaned.endsWith('/' + file.normalized) || file.normalized.endsWith('/' + cleaned));
  if (suffix.length === 1) return { status: 'suffix', matches: [suffix[0].path] };
  if (suffix.length > 1 || exact.length > 1) return { status: 'ambiguous', matches: suffix.map(x => x.path) };
  const name = path.posix.basename(cleaned);
  const basename = normalizedFiles.filter(file => path.posix.basename(file.normalized) === name);
  if (basename.length === 1) return { status: 'basename-only', matches: [basename[0].path] };
  if (basename.length > 1) return { status: 'ambiguous', matches: basename.map(x => x.path) };
  return { status: 'unresolved', matches: [] };
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function readTextSmall(absolute) {
  const info = await stat(absolute);
  if (info.size > MAX_CONFIG_BYTES) throw new Error('configuration exceeds 2 MiB limit');
  return readFile(absolute, 'utf8');
}

export async function scanAircraft(root) {
  const resolvedRoot = path.resolve(root);
  if (!(await stat(resolvedRoot)).isDirectory()) throw new Error('Target must be a directory');
  const files = [];
  const skipped = [];
  const queue = [resolvedRoot];
  while (queue.length) {
    const dir = queue.pop();
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(resolvedRoot, absolute).split(path.sep).join('/');
      if (entry.isSymbolicLink()) { skipped.push({ path: relative, reason: 'symbolic link not followed' }); continue; }
      if (entry.isDirectory()) { queue.push(absolute); continue; }
      if (!entry.isFile()) { skipped.push({ path: relative, reason: 'not a regular file' }); continue; }
      if (files.length >= MAX_FILES) throw new Error('Safety limit: more than 100,000 files');
      const detail = await lstat(absolute);
      files.push({ path: relative, size: detail.size, extension: path.extname(entry.name).toLowerCase() || '(none)' });
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const wasmFiles = files.filter(file => file.extension === '.wasm');
  const modules = [];
  const observations = [];
  const warnings = [];
  for (const file of wasmFiles) {
    const absolute = path.join(resolvedRoot, ...file.path.split('/'));
    const info = { path: file.path, size: file.size, sha256: await sha256(absolute) };
    if (file.size > MAX_WASM_PARSE_BYTES) {
      modules.push({ ...info, inspection: 'skipped', reason: 'WASM larger than 64 MiB inspection limit' });
      continue;
    }
    const binary = await readFile(absolute);
    modules.push({ ...info, inspection: inspectWasm(binary) });
  }
  for (const file of files) {
    const name = path.posix.basename(file.path).toLowerCase();
    if (!['systems.cfg', 'panel.cfg', 'layout.json', 'manifest.json'].includes(name)) continue;
    const absolute = path.join(resolvedRoot, ...file.path.split('/'));
    try {
      const content = await readTextSmall(absolute);
      if (name === 'systems.cfg') {
        for (const section of parseCfg(content)) {
          if (!/^WASM_SYSTEM\.\d+$/iu.test(section.name)) continue;
          const reference = section.values.modulepath;
          observations.push({ source: file.path, section: section.name,
            systemName: section.values.systemname ?? null,
            moduleReference: reference ?? null,
            resolution: reference ? resolveModuleReference(reference, wasmFiles.map(f => f.path)) : { status: 'no-module-reference', matches: [] } });
        }
      } else if (name === 'panel.cfg') {
        const regex = /wasm_module=([^&\s,]+\.wasm)/giu;
        for (const match of content.matchAll(regex)) {
          observations.push({ source: file.path, type: 'gauge-module', moduleReference: match[1],
            resolution: resolveModuleReference(match[1], wasmFiles.map(f => f.path)) });
        }
      } else {
        const json = JSON.parse(content);
        observations.push({ source: file.path, type: name,
          packageName: typeof json.title === 'string' ? json.title : null,
          packageVersion: typeof json.package_version === 'string' ? json.package_version : null,
          contentEntries: Array.isArray(json.content) ? json.content.length : null });
      }
    } catch (error) { warnings.push({ source: file.path, message: error.message }); }
  }
  const extensionCounts = Object.fromEntries([...new Set(files.map(file => file.extension))].sort().map(ext => [ext, files.filter(f => f.extension === ext).length]));
  return { schemaVersion: 'phase-1a-1', scanMode: 'read-only', generatedAt: new Date().toISOString(),
    target: resolvedRoot, summary: { fileCount: files.length, wasmCount: wasmFiles.length, extensionCounts },
    files, wasmModules: modules, moduleReferences: observations, skipped, warnings,
    notes: [
      'This scanner provides structural observations, not verified aircraft defects.',
      'Unresolved references may point outside the selected directory or use virtual package paths.',
      'A WASM module is not necessarily compiled from Rust; language attribution requires separate evidence.',
      'No simulator or aircraft files were changed.'
    ] };
}

async function main(argv) {
  if (argv.includes('--help') || argv.length === 0) {
    console.log('Usage: node scripts/msfs-aircraft-scan.mjs <aircraft-folder> [--out report.json]');
    console.log('Read-only local inventory; does not execute aircraft modules or connect to MSFS.');
    return;
  }
  const target = argv[0];
  const outIndex = argv.indexOf('--out');
  if (outIndex >= 0 && (!argv[outIndex + 1] || outIndex !== 1 || argv.length !== 3)) throw new Error('Usage: <aircraft-folder> --out <report.json>');
  if (outIndex < 0 && argv.length !== 1) throw new Error('Unexpected arguments; see --help');
  const report = await scanAircraft(target);
  const json = JSON.stringify(report, null, 2) + '\n';
  if (outIndex >= 0) {
    await writeFile(argv[outIndex + 1], json, { flag: 'wx' });
    console.log('Created read-only analysis report: ' + argv[outIndex + 1]);
  } else console.log(json);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error('MSFS scanner: ' + error.message); process.exitCode = 1; });
}
