import { assertEquals } from '@std/assert'
import { oldReceiverMessage, oldReceiversOf } from './old-receivers.ts'

/** Sonar only recognises `test()`; see the note in the other suites. */
const test = Deno.test.bind(Deno)

const tunnel = (carrying: string[], doorways: [string, string[]][]) => ({
  carrying,
  doorways: doorways.map(([hostname, siteServerIds]) => ({
    hostname,
    siteServerIds,
    isLocalOnly: true,
  })),
})

test('a site server without the feature is an old receiver when a server that has it would send to it', () => {
  const found = oldReceiversOf(
    [
      tunnel(
        ['a', 'b'],
        [
          ['z.example.com', ['old']],
          ['a.example.com', ['old', 'new']],
        ]
      ),
    ],
    new Set(['a', 'b', 'new'])
  )
  assertEquals(found, new Map([['old', ['a.example.com', 'z.example.com']]]))
})

test('nothing is reported when no sender has the feature, or the only carrier is the site server itself', () => {
  assertEquals(oldReceiversOf([tunnel(['a'], [['x.example.com', ['old']]])], new Set()), new Map())
  assertEquals(
    oldReceiversOf([tunnel(['old'], [['x.example.com', ['old']]])], new Set(['old'])),
    new Map()
  )
  assertEquals(
    oldReceiversOf([tunnel(['new'], [['x.example.com', ['old']]])], new Set(['new'])),
    new Map([['old', ['x.example.com']]])
  )
  assertEquals(
    oldReceiversOf([tunnel(['old'], [['x.example.com', ['old']]])], new Set()),
    new Map()
  )
})

test('the message names the server and every affected hostname', () => {
  assertEquals(
    oldReceiverMessage('Web 1', ['a.example.com']),
    'Web 1 needs a daemon update before tunnels can reach it: visitors to the name a.example.com get an error until it is updated.'
  )
  assertEquals(
    oldReceiverMessage('Web 1', ['a.example.com', 'b.example.com']).includes(
      'these names a.example.com, b.example.com'
    ),
    true
  )
})
