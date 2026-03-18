/**
 * Mock for ../lib/db — returns a fake pg Pool whose query() method
 * can be overridden per-test via poolMock.query.mockResolvedValueOnce(...)
 */

const poolMock = {
  query: jest.fn().mockResolvedValue({ rows: [] as unknown[], rowCount: 0 }),
};

export function getPool() {
  return poolMock;
}

export { poolMock };
export default poolMock;
