const store: Record<string, string> = {};

const redisMock = {
  get:    jest.fn(async (k: string) => store[k] ?? null),
  set:    jest.fn(async (k: string, v: string) => { store[k] = v; return 'OK'; }),
  del:    jest.fn(async (k: string) => { delete store[k]; return 1; }),
  exists: jest.fn(async (k: string) => (store[k] !== undefined ? 1 : 0)),
  incr:   jest.fn(async (k: string) => { store[k] = String((parseInt(store[k] || '0') + 1)); return parseInt(store[k]); }),
  expire: jest.fn(async () => 1),
  _store: store,
  _reset: () => { Object.keys(store).forEach(k => delete store[k]); },
  _set:   (k: string, v: string) => { store[k] = v; },
};

export function getRedis() { return redisMock; }
export default redisMock;
