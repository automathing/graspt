import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { Atlas, Importance } from '../../packages/core/types';

// The global Mathlib atlas is offline provisioning output: generated once by
// `graspt setup`, fingerprinted to its exact inputs, and validated by parsing
// before anything trusts it. A cache that merely exists is never evidence.

/** Parameters of `lean/Graspt/AtlasMain.lean` — keep in lockstep with that file. */
export const ATLAS_FORMAT_VERSION = 1;
export const ATLAS_ROOTS = ['Mathlib'];
export const ATLAS_TOP_N = 4000;
export const ATLAS_AREA_DEPTH = 1;
export const ATLAS_MIN_EDGE_WEIGHT = 20;

export function atlasDir(storeDir: string): string {
  return path.join(storeDir, 'atlas');
}

export interface AtlasFingerprintInput {
  toolchain: string;
  mathlibRevision: string;
  /** Full source text of the atlas generator (AtlasMain.lean). */
  atlasSource: string;
}

/** SHA-256 over every input that can change the atlas output. */
export function computeAtlasFingerprint(input: AtlasFingerprintInput): string {
  const params = JSON.stringify({
    format: ATLAS_FORMAT_VERSION,
    roots: ATLAS_ROOTS,
    topN: ATLAS_TOP_N,
    areaDepth: ATLAS_AREA_DEPTH,
    minEdgeWeight: ATLAS_MIN_EDGE_WEIGHT,
  });
  const sourceHash = crypto.createHash('sha256').update(input.atlasSource).digest('hex');
  return crypto
    .createHash('sha256')
    .update([input.toolchain, input.mathlibRevision, sourceHash, params].join('|'))
    .digest('hex');
}

export interface AtlasValidation {
  ok: boolean;
  reason: string;
  declarations?: number;
  areas?: number;
  landmarks?: number;
  importanceEntries?: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function fail(reason: string): AtlasValidation {
  return { ok: false, reason };
}

/** Parse and structurally validate the cached atlas. Fails closed on any defect. */
export function validateAtlasCache(storeDir: string): AtlasValidation {
  const dir = atlasDir(storeDir);
  let atlas: unknown;
  let imp: unknown;
  try {
    atlas = JSON.parse(fs.readFileSync(path.join(dir, 'atlas.json'), 'utf8'));
  } catch (e) {
    return fail(`atlas.json missing or unparseable (${e instanceof Error ? e.message : String(e)})`);
  }
  try {
    imp = JSON.parse(fs.readFileSync(path.join(dir, 'importance.json'), 'utf8'));
  } catch (e) {
    return fail(`importance.json missing or unparseable (${e instanceof Error ? e.message : String(e)})`);
  }
  if (!isRecord(atlas)) return fail('atlas.json is not an object');
  if (!Number.isFinite(atlas.declarations) || (atlas.declarations as number) <= 0) {
    return fail('atlas.json has no positive declaration count');
  }
  if (!Array.isArray(atlas.areas) || atlas.areas.length === 0) return fail('atlas.json has no areas');
  for (const a of atlas.areas) {
    if (!isRecord(a) || typeof a.id !== 'string' || !a.id || !Number.isFinite(a.decls)) {
      return fail('atlas.json has a malformed area entry');
    }
  }
  if (!Array.isArray(atlas.landmarks) || atlas.landmarks.length === 0) return fail('atlas.json has no landmarks');
  for (const l of atlas.landmarks) {
    if (!isRecord(l) || typeof l.name !== 'string' || !l.name || typeof l.area !== 'string' || !l.area || !Number.isFinite(l.uses)) {
      return fail('atlas.json has a malformed landmark entry');
    }
  }
  if (!Array.isArray(atlas.areaEdges)) return fail('atlas.json areaEdges is not an array');

  if (!isRecord(imp)) return fail('importance.json is not an object');
  if (!Array.isArray(imp.areas) || imp.areas.length === 0 || !imp.areas.every((a) => typeof a === 'string' && a)) {
    return fail('importance.json has no area names');
  }
  if (!isRecord(imp.table)) return fail('importance.json table is not an object');
  const entries = Object.entries(imp.table);
  if (entries.length === 0) return fail('importance.json table is empty');
  for (const [name, v] of entries) {
    if (!Array.isArray(v) || v.length !== 2 || !Number.isFinite(v[0]) || !Number.isInteger(v[1]) || v[1] < 0 || v[1] >= imp.areas.length) {
      return fail(`importance.json entry for ${name} is not [uses, areaIndex] within the area list`);
    }
  }
  return {
    ok: true,
    reason: 'atlas cache parses and is structurally consistent',
    declarations: atlas.declarations as number,
    areas: atlas.areas.length,
    landmarks: atlas.landmarks.length,
    importanceEntries: entries.length,
  };
}

/** Load the validated cache for use. Returns undefined when validation fails. */
export function loadAtlasFiles(storeDir: string): { atlas: Atlas; importance: Importance } | undefined {
  if (!validateAtlasCache(storeDir).ok) return undefined;
  try {
    const dir = atlasDir(storeDir);
    const atlas = JSON.parse(fs.readFileSync(path.join(dir, 'atlas.json'), 'utf8')) as Atlas;
    const importance = JSON.parse(fs.readFileSync(path.join(dir, 'importance.json'), 'utf8')) as Importance;
    return { atlas, importance };
  } catch {
    return undefined;
  }
}
