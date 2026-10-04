import { assertEquals, assertThrows } from '@std/assert'
import {
  databaseRequired,
  redisRequired,
  skipWithoutDatabase,
  skipWithoutRedis,
} from './require-service.ts'

function withEnv(name: string, value: string | undefined, fn: () => void): void {
  const prior = Deno.env.get(name)
  if (value === undefined) Deno.env.delete(name)
  else Deno.env.set(name, value)
  try {
    fn()
  } finally {
    if (prior === undefined) Deno.env.delete(name)
    else Deno.env.set(name, prior)
  }
}

function quietly(fn: () => void): void {
  const warn = console.warn
  console.warn = () => {}
  try {
    fn()
  } finally {
    console.warn = warn
  }
}

Deno.test('a missing database skips locally and fails when TURBOPANEL_REQUIRE_DB=1', () => {
  withEnv('TURBOPANEL_REQUIRE_DB', undefined, () => {
    assertEquals(databaseRequired(), false)
    quietly(() => skipWithoutDatabase('example suite'))
  })
  withEnv('TURBOPANEL_REQUIRE_DB', '1', () => {
    assertEquals(databaseRequired(), true)
    assertThrows(() => skipWithoutDatabase('example suite'), Error, 'TURBOPANEL_REQUIRE_DB=1')
  })
})

Deno.test('a missing Redis socket skips locally and fails when TURBOPANEL_REQUIRE_REDIS=1', () => {
  withEnv('TURBOPANEL_REQUIRE_REDIS', undefined, () => {
    assertEquals(redisRequired(), false)
    quietly(() => skipWithoutRedis('example suite', '/nope.sock'))
  })
  withEnv('TURBOPANEL_REQUIRE_REDIS', '1', () => {
    assertThrows(() => skipWithoutRedis('example suite', '/nope.sock'), Error, '/nope.sock')
  })
})
