# REA Flight Diagnostics — Phase 1A

This document describes a prototype **read-only aircraft package inventory** for Microsoft Flight Simulator 2024. MSFS 2020 support and richer SDK-specific diagnostics are planned separately. The scanner is experimental and is **not** integrated into the main REA MCP/CLI command catalog yet.

## Goal

Start with one **unprotected, authorized, locally accessible** aircraft package. Record the files and the available static relationships between WASM systems/gauges and their binaries. Preserve evidence without modifying anything in the aircraft package.

This initial version does **not** verify aircraft defects, distinguish Rust from C/C++ with certainty, decode WASM function logic, use simulator APIs, defeat DRM, or generate patches.

## Requirements

- Node.js compatible with this repository (see root `package.json`; 22.19+, 24.11+, or 26+).
- A local folder containing an aircraft package **you have permission to inspect**. We recommend a developer-mode sample, self-developed, or open-source aircraft for initial validation.
- No native analysis engine, network access, npm package installation, simulator, or developer mode is required for the first scan.

## Run on Windows (PowerShell)

From your clone of `Skyace2018/Rea---Clone`:

```powershell
node .\scripts\msfs-aircraft-scan.mjs "C:\Path\To\AircraftFolder" --out ".\aircraft-report.json"
```

Use a package folder containing the relevant `systems.cfg`, `panel.cfg`, and `.wasm` files when possible. If your selected folder only includes part of a package, references may legitimately remain unresolved.

Alternatively, print JSON to the terminal:

```powershell
node .\scripts\msfs-aircraft-scan.mjs "C:\Path\To\AircraftFolder"
```

`--out` creates a **new** JSON report; the scanner refuses to overwrite an existing report. Save reports privately until you have reviewed the file paths, module names, and other included package metadata.

## Report fields

| Field | Meaning |
| --- | --- |
| `summary` | File counts, WASM count, and file-extension histogram |
| `files` | Relative filenames and byte sizes |
| `wasmModules` | SHA-256 hashes; WASM header/version; section inventory; basic imports and exports; parse limitations |
| `moduleReferences` | WASM references observed in `systems.cfg` and `panel.cfg`; module matching outcomes |
| `warnings` | Config parsing or file size issues |
| `skipped` | File system entries intentionally not followed |
| `notes` | Limitations on how findings must be interpreted |

Reference matching is deliberately conservative:

- `exact`: same normalized relative path.
- `suffix`: compatible virtual-package or parent-directory suffix.
- `basename-only`: filename matches but path identity is not confirmed.
- `ambiguous`: multiple candidates.
- `unresolved`: selected folder has no apparent candidate. **This is not proof of a broken aircraft.**
- `no-module-reference`: a matching config section has no module path.

## Test the scanner

```powershell
node --test .\scripts\tests\msfs-aircraft-scan.test.mjs
```

The Phase 1A synthetic tests cover valid/invalid WASM headers, imports and exports, config extraction, virtual-path resolution, ambiguity, and end-to-end local inventory. Passing these tests does not establish compatibility with a real MSFS aircraft or successful aircraft diagnosis.

## Phase 1A acceptance checklist

- [x] Implement a standalone, read-only scanner on a feature branch.
- [x] Unit tests pass on synthetic input.
- [ ] Test with Microsoft's authorized `GaugeAndSystemsAircraft` sample or an open-source aircraft.
- [ ] Review accuracy of system and gauge references for the chosen sample.
- [ ] Review any parsing limitations and update fixtures from an authorized case.
- [ ] Decide whether to integrate into REA's `src/artifacts` provider or expose a dedicated aircraft domain workflow.

## Phase 1B and beyond

1. **Validated package inventory:** strengthen platform-aware package path resolution, SDK-specific config references, package metadata checks, and real-aircraft fixtures.
2. **WASM investigation:** optionally integrate WABT for structured disassembly and Ghidra-WASM for analysis; preserve evidence, parsing unknowns, and module hashes.
3. **Runtime evidence:** collect exported, user-controlled simulator debug records and (where useful) read-only SimConnect observations in a separately authorized local helper.
4. **Developer report:** reproduce issue, environment, observed/expected behavior, evidence links, confidence and possible investigation steps.
5. **Authorized fix path:** inspect available source and licenses, add regression tests, propose minimal patches, and validate in the simulator; avoid changing or redistributing protected vendor binaries.

## Relevant official MSFS documentation

- [Creating WASM Systems (MSFS 2024)](https://docs.flightsimulator.com/msfs2024/flighting/programming-apis/wasm/creating-wasm-systems/)
- [WASM Debug window](https://docs.flightsimulator.com/msfs2024/html/2_DevMode/Menus/Debug/WASM_Debug.htm)
- [GaugeAndSystemsAircraft sample](https://docs.flightsimulator.com/msfs2024/html/7_Samples_Tutorials/Samples/SimObjects_Aircraft/ModularAircraft/GaugeAndSystemsAircraft.htm)
- [SimConnect SDK](https://docs.flightsimulator.com/msfs2024/retail/programming-apis/simconnect/simconnect-sdk/)
