export function resolveStub(env: { DAEMON_CELL: { getByName: (name: string) => unknown } }) {
  const id = crypto.randomUUID();
  return env.DAEMON_CELL.getByName(id);
}
