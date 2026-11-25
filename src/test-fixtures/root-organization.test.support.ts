import { eq } from 'drizzle-orm'
import type { Db } from '../db/connection.ts'
import { setting } from '../db/schema.ts'
import { ROOT_ORGANIZATION_SETTING_KEY } from '../client/authn/install-state.ts'

/**
 * Make `organizationId` the instance's root organization for one test and hand back the
 * function that puts the previous marker (or its absence) back. A shared test database
 * may already be installed, so a test that needs a known root pins its own.
 */
export async function pinRootOrganizationForTest(
  db: Db,
  organizationId: string
): Promise<() => Promise<void>> {
  const [previous] = await db
    .select({ value: setting.value })
    .from(setting)
    .where(eq(setting.key, ROOT_ORGANIZATION_SETTING_KEY))
    .limit(1)
  await db
    .insert(setting)
    .values({ key: ROOT_ORGANIZATION_SETTING_KEY, value: { organizationId } })
    .onConflictDoUpdate({ target: setting.key, set: { value: { organizationId } } })
  return async () => {
    if (previous) {
      await db
        .update(setting)
        .set({ value: previous.value })
        .where(eq(setting.key, ROOT_ORGANIZATION_SETTING_KEY))
    } else {
      await db.delete(setting).where(eq(setting.key, ROOT_ORGANIZATION_SETTING_KEY))
    }
  }
}
