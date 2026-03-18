const queryMock = jest.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [], rowCount: 0 }));

const poolMock = {
  query: queryMock,
  _queryMock: queryMock,
};

export function getPool() { return poolMock; }
export default poolMock;
