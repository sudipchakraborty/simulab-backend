/** @brief Bound and authorize compiler-work telemetry independently of downloadable job identifiers. */
export function createCompileProgress({ now = Date.now, limit = 64 } = {}) {
  const records = new Map();
  const durations = new Map();
  const prune = () => {
    for (const [id, record] of records) if (now() - record.started > 3600000) records.delete(id);
    while (records.size >= limit) {
      const oldest = [...records].find(([, value]) => value.finished);
      if (!oldest) throw Object.assign(new Error('Compiler progress limit reached'), { status: 429 });
      records.delete(oldest[0]);
    }
  };
  return {
    start(id, owner, board) {
      if (id === undefined) return undefined;
      if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) throw Object.assign(new Error('Invalid compile requestId'), { status: 400 });
      prune();
      if (records.has(id)) throw Object.assign(new Error('Compile requestId already used'), { status: 409 });
      const record = { owner, board, started: now(), percent: null, stage: 'Preparing compiler', finished: false };
      records.set(id, record);
      return record;
    },
    update(record, value) {
      if (!record || record.finished) return;
      if (typeof value?.percent === 'number' && Number.isFinite(value.percent) && value.percent >= 0 && value.percent <= 100)
        record.percent = Math.max(record.percent ?? 0, value.percent);
      if (typeof value?.stage === 'string') record.stage = value.stage.slice(0, 120);
    },
    finish(record, success, cached = false) {
      if (!record) return;
      record.finished = true;
      record.ended = now();
      record.stage = success ? cached ? 'Cached build complete' : 'Compilation complete' : 'Compilation failed';
      if (success) record.percent = 100;
      if (success && !cached) {
        const samples = durations.get(record.board) ?? [];
        samples.push(record.ended - record.started);
        durations.set(record.board, samples.slice(-5));
      }
    },
    get(id, owner) {
      if (!/^[a-f0-9]{32}$/.test(id)) throw Object.assign(new Error('Invalid compile requestId'), { status: 400 });
      const record = records.get(id);
      if (!record || now() - record.started > 3600000 || (owner && record.owner !== owner)) throw Object.assign(new Error('Compile progress unavailable'), { status: 404 });
      const elapsedMs = Math.max(0, (record.ended ?? now()) - record.started);
      const samples = durations.get(record.board) ?? [];
      const average = samples.length ? samples.reduce((sum, value) => sum + value, 0) / samples.length : undefined;
      return { percent: record.percent, stage: record.stage, elapsedMs,
        ...(!record.finished && average !== undefined && average > elapsedMs ? { estimatedRemainingMs: Math.round(average - elapsedMs) } : {}) };
    },
  };
}
