// Calibration: one user's corrections to a shared macro, kept in Wick's app
// data by macro id, never in the macro's folder. Region corrections replace
// the macro's own regions by name; color corrections swap a color the macro
// tracks for the one this user's game actually shows. Exports leave them
// out and updates keep them.

import fs from 'node:fs';
import path from 'node:path';

const fileName = (id) => `${String(id || 'unnamed').replace(/[^\w.-]+/g, '_')}.json`;
const HEX = /#[0-9a-f]{6}\b/gi;

export class Calibrations {
  /** @param {string} dir  where calibrations are kept, one file per macro id */
  constructor(dir) {
    this.dir = dir;
  }

  get(id) {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(this.dir, fileName(id)), 'utf8'));
      return { regions: c.regions ?? {}, colors: c.colors ?? {} };
    } catch {
      return { regions: {}, colors: {} };
    }
  }

  save(id, calibration) {
    const next = { regions: calibration.regions ?? {}, colors: calibration.colors ?? {} };
    fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, fileName(id));
    if (!Object.keys(next.regions).length && !Object.keys(next.colors).length) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  }

  /** Keeps the regions that differ from the macro's own as corrections. */
  setRegions(id, regions, original = {}) {
    const corrections = {};
    for (const [name, spec] of Object.entries(regions)) {
      if (JSON.stringify(spec) !== JSON.stringify(original[name])) corrections[name] = spec;
    }
    return this.save(id, { ...this.get(id), regions: corrections });
  }

  /** Maps one of the macro's colors to this user's; the same color clears it. */
  setColor(id, from, to) {
    const colors = { ...this.get(id).colors };
    const key = String(from).toLowerCase();
    if (!to || String(to).toLowerCase() === key) delete colors[key];
    else colors[key] = String(to).toLowerCase();
    return this.save(id, { ...this.get(id), colors });
  }

  reset(id) {
    return this.save(id, {});
  }
}

/** The macro as this user runs it: corrected regions, and colors to swap. */
export function applyCalibration(spec, calibration) {
  if (!calibration) return spec;
  return { ...spec, regions: { ...spec.regions, ...calibration.regions }, colors: { ...calibration.colors } };
}

/** The colors written in a macro's code, for the calibration list. */
export function colorsIn(files) {
  const found = new Set();
  for (const [name, source] of Object.entries(files)) {
    if (!/\.(ts|js|mjs)$/.test(name)) continue;
    for (const m of source.matchAll(HEX)) found.add(m[0].toLowerCase());
  }
  return [...found].sort();
}
