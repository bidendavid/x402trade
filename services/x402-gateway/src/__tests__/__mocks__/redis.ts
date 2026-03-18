const store: Record<string, string> = {};
const hashes: Record<string, Record<string, string>> = {};
const zsets: Record<string, Map<string, number>> = {};

const redisMock = {
  get:    jest.fn(async (k: string) => store[k] ?? null),
  set:    jest.fn(async (k: string, v: string) => { store[k] = v; return 'OK'; }),
  del:    jest.fn(async (...keys: string[]) => { keys.forEach(k => { delete store[k]; delete hashes[k]; }); return keys.length; }),
  exists: jest.fn(async (k: string) => (store[k] !== undefined || hashes[k] !== undefined ? 1 : 0)),
  expire: jest.fn(async () => 1),
  hset:   jest.fn(async (k: string, data: Record<string, string>) => { hashes[k] = { ...(hashes[k] || {}), ...data }; return 1; }),
  hgetall: jest.fn(async (k: string) => hashes[k] ?? null),
  zrevrange: jest.fn(async (key: string, start: number, stop: number) => {
    const m = zsets[key];
    if (!m) return [];
    const sorted = [...m.entries()].sort((a, b) => b[1] - a[1]);
    return sorted.slice(start, stop === -1 ? undefined : stop + 1).map(([k]) => k);
  }),
  zrange: jest.fn(async (key: string, start: number, stop: number) => {
    const m = zsets[key];
    if (!m) return [];
    const sorted = [...m.entries()].sort((a, b) => a[1] - b[1]);
    return sorted.slice(start, stop === -1 ? undefined : stop + 1).map(([k]) => k);
  }),
  zrem:  jest.fn(async () => 1),
  srem:  jest.fn(async () => 1),
  lrange: jest.fn(async () => []),
  _store: store,
  _hashes: hashes,
  _reset: () => {
    Object.keys(store).forEach(k => delete store[k]);
    Object.keys(hashes).forEach(k => delete hashes[k]);
    Object.keys(zsets).forEach(k => delete zsets[k]);
  },
  _set:   (k: string, v: string) => { store[k] = v; },
};

export function getRedis() { return redisMock; }
export default redisMock;
