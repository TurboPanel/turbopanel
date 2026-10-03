import { assertEquals } from '@std/assert'
import { describe, it } from '@std/testing/bdd'
import {
  listPriceCost,
  pointsPerMonth,
  rowsFor,
  SAMPLES_PER_MONTH,
  SHAPES,
} from './metrics-tier-model.ts'

describe('metrics tier model', () => {
  it('derives row counts from the v7 layout fixture, not re-derived packing', () => {
    assertEquals(rowsFor('S1', 'vps/preset/plain'), 4)
    assertEquals(rowsFor('S1', 'vps/preset/docker+db'), 5)
    assertEquals(rowsFor('S1', 'phys/single/docker'), 5)
    assertEquals(rowsFor('S1', 'phys/preset/docker'), 6)
  })

  it('prices a row per 60 s sample as 43,200 points a month at list price', () => {
    assertEquals(SAMPLES_PER_MONTH, 43_200)
    assertEquals(pointsPerMonth(4), 172_800)
    assertEquals(listPriceCost(1_000_000), 0.25)
  })

  it('has a fixture case for every priced shape on every plan', () => {
    for (const plan of ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'SX']) {
      for (const shape of SHAPES) assertEquals(rowsFor(plan, shape.suffix) > 0, true)
    }
  })
})
