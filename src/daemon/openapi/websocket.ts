export const websocketPaths: Record<string, unknown> = {
  '/ws/daemon/v1': {
    get: {
      tags: ['daemon'],
      summary: 'Daemon WebSocket',
      description:
        'WebSocket upgrade endpoint for managed daemons. After the connection opens, ' +
        'send a JSON `hello` message with `hostname`, optional `serverId`, `machineId`, ' +
        'and license credentials (`licenseId`, `licenseToken`). Invalid or revoked licenses ' +
        'close the socket with code 4401.',
      security: [{ licenseAuth: [] }],
      responses: {
        '101': {
          description: 'Switching Protocols — WebSocket upgrade',
        },
      },
    },
  },
}
