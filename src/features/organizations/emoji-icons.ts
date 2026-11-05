/**
 * The organization's emoji icon setting (`organization.is_emoji_icon_allowed`),
 * read by every route that writes an icon. Keys are always allowed; an emoji
 * only while this is true. Turning it off never rewrites stored icons.
 */
import { eq } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { organization } from '../../db/schema.ts'

/** Whether the organization allows emoji icons; true for an organization that does not exist (the caller 404s first). */
export async function isEmojiIconAllowedForOrganization(
  db: Db,
  organizationId: string
): Promise<boolean> {
  const [row] = await db
    .select({ isEmojiIconAllowed: organization.isEmojiIconAllowed })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1)
  return row?.isEmojiIconAllowed ?? true
}
