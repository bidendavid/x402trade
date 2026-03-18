// PostgreSQL pool mock for order-engine tests
const queryMock = jest.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [], rowCount: 0 }));

const poolMock = {
  query: queryMock,
  connect: jest.fn(async () => ({
    query: queryMock,
    release: jest.fn(),
  })),
  _queryMock: queryMock,
};

export function getPool() { return poolMock; }
export default poolMock;
