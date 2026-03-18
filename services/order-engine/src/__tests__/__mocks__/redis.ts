// Shared in-memory Redis mock for order-engine tests
const store: Record<string, string> = {};
const sets: Record<string, Map<string, number>> = {};
const hashes: Record<string, Record<string, string>> = {};
const redisSets: Record<string, Set<string>> = {};

const redisMock = {
  get:    jest.fn(async (k: string) => store[k] ?? null),
  set:    jest.fn(async (k: string, v: string) => { store[k] = v; return 'OK'; }),
  del:    jest.fn(async (...keys: string[]) => { keys.forEach(k => delete store[k]); return keys.length; }),
  exists: jest.fn(async (k: string) => (store[k] !== undefined ? 1 : 0)),
  incr:   jest.fn(async (k: string) => { store[k] = String((parseInt(store[k] || '0') + 1)); return parseInt(store[k]); }),
  expire: jest.fn(async () => 1),
  zadd:   jest.fn(async (key: string, score: number, member: string) => {
    if (!sets[key]) sets[key] = new Map();
    sets[key].set(member, score);
    return 1;
  }),
  zrem:   jest.fn(async (key: string, member: string) => { sets[key]?.delete(member); return 1; }),
  zrange: jest.fn(async (key: string, start: number, stop: number) => {
    const m = sets[key];
    if (!m) return [];
    const sorted = [...m.entries()].sort((a, b) => a[1] - b[1]);
    return sorted.slice(start, stop === -1 ? undefined : stop + 1).map(([k]) => k);
  }),
  zrevrange: jest.fn(async (key: string, start: number, stop: number) => {
    const m = sets[key];
    if (!m) return [];
    const sorted = [...m.entries()].sort((a, b) => b[1] - a[1]);
    return sorted.slice(start, stop === -1 ? undefined : stop + 1).map(([k]) => k);
  }),
  hset:    jest.fn(async (key: string, data: Record<string, string>) => { hashes[key] = { ...(hashes[key] || {}), ...data }; return 1; }),
  hgetall: jest.fn(async (key: string) => hashes[key] ?? null),
  sadd:    jest.fn(async (key: string, member: string) => { if (!redisSets[key]) redisSets[key] = new Set(); redisSets[key].add(member); return 1; }),
  srem:    jest.fn(async (key: string, member: string) => { redisSets[key]?.delete(member); return 1; }),
  publish: jest.fn(async () => 0),
  pipeline: jest.fn(() => {
    const ops: Array<() => void> = [];
    const p: Record<string, unknown> = {};

    const chain = (fn: () => void) => { ops.push(fn); return p; };

    p.zadd  = jest.fn((key: string, score: number, member: string) =>
      chain(() => { if (!sets[key]) sets[key] = new Map(); sets[key].set(member, score); }));
    p.hset  = jest.fn((key: string, data: Record<string, string>) =>
      chain(() => { hashes[key] = { ...(hashes[key] || {}), ...data }; }));
    p.sadd  = jest.fn((key: string, member: string) =>
      chain(() => { if (!redisSets[key]) redisSets[key] = new Set(); redisSets[key].add(member); }));
    p.zrem  = jest.fn((key: string, member: string) =>
      chain(() => { sets[key]?.delete(member); }));
    p.srem  = jest.fn((key: string, member: string) =>
      chain(() => { redisSets[key]?.delete(member); }));
    p.del   = jest.fn((key: string) =>
      chain(() => { delete store[key]; delete hashes[key]; }));
    p.set   = jest.fn((key: string, val: string) =>
      chain(() => { store[key] = val; }));
    p.lpush = jest.fn((_key: string, _val: string) => chain(() => {}));
    p.ltrim = jest.fn((_key: string, _s: number, _e: number) => chain(() => {}));
    p.exec  = jest.fn(async () => { ops.forEach(fn => fn()); return []; });

    return p;
  }),
  _store:     store,
  _sets:      sets,
  _hashes:    hashes,
  _redisSets: redisSets,
  _reset: () => {
    Object.keys(store).forEach(k => delete store[k]);
    Object.keys(sets).forEach(k => delete sets[k]);
    Object.keys(hashes).forEach(k => delete hashes[k]);
    Object.keys(redisSets).forEach(k => delete redisSets[k]);
  },
};

export function getRedis() { return redisMock; }
export default redisMock;
