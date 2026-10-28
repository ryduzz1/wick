// Run history: each live run saved as one JSON file with how it ended, its
// stats, its log, and the trace of its last seconds, so a failure can be
// looked at afterwards in the app or by an agent.

import fs from 'node:fs';
import path from 'node:path';

const KEEP_RUNS = 50;
const KEEP_LOGS = 500;
const KEEP_TRACE_MS = 15_000;

const folderName = (id) => String(id || 'unnamed').replace(/[^\w.-]+/g, '_');

export class RunHistory {
  /** @param {string} dir  where runs are kept, one folder per macro id */
  constructor(dir) {
    this.dir = dir;
    this.current = null;
  }

  /** Feed every engine event through here. Returns the saved file when a run ends. */
  onEvent(method, params, target) {
    if (method === 'macro.state' && params.state === 'running') {
      this.current = { id: params.id, target, at: new Date().toISOString(), logs: [], trace: { trackers: [], samples: [], inputs: [] } };
      return null;
    }
    const run = this.current;
    if (!run) return null;
    if (method === 'macro.log') {
      run.logs.push({ at: params.at, text: params.text });
      if (run.logs.length > KEEP_LOGS) run.logs.splice(0, run.logs.length - KEEP_LOGS);
    } else if (method === 'macro.trace') {
      run.trace.trackers = params.trackers ?? run.trace.trackers;
      run.trace.samples.push(...(params.samples ?? []));
      run.trace.inputs.push(...(params.inputs ?? []));
      const last = run.trace.samples.at(-1)?.[0] ?? 0;
      const keep = (list) => {
        const i = list.findIndex((s) => s[0] >= last - KEEP_TRACE_MS);
        if (i > 0) list.splice(0, i);
      };
      keep(run.trace.samples);
      keep(run.trace.inputs);
    } else if (method === 'macro.end') {
      this.current = null;
      return this.save({ ...run, end: params.end, elapsed: params.elapsed, inputs: params.inputs, dropped: params.dropped, loops: params.loops, score: params.score ?? null });
    }
    return null;
  }

  save(run) {
    try {
      const dir = path.join(this.dir, folderName(run.id));
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${run.at.replace(/[:.]/g, '-')}.json`);
      fs.writeFileSync(file, JSON.stringify(run));
      const old = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
      for (const f of old.slice(0, Math.max(0, old.length - KEEP_RUNS))) fs.rmSync(path.join(dir, f), { force: true });
      return file;
    } catch {
      return null;
    }
  }

  /** The most recent runs of a macro, newest first, without logs and traces. */
  list(id, limit = 20) {
    const dir = path.join(this.dir, folderName(id));
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().reverse().slice(0, limit);
    } catch {
      return [];
    }
    return files.flatMap((f) => {
      try {
        const { logs, trace, ...summary } = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        return [{ ...summary, file: f, logLines: logs?.length ?? 0 }];
      } catch {
        return [];
      }
    });
  }

  /** One saved run in full. */
  read(id, file) {
    if (path.basename(file) !== file || !file.endsWith('.json')) throw new Error('Not a run file.');
    return JSON.parse(fs.readFileSync(path.join(this.dir, folderName(id), file), 'utf8'));
  }
}
