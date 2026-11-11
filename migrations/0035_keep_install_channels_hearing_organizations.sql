-- Control plane channels used to hear every organization's events. They now
-- hear install events only, unless channel.is_all_organizations_notified is on.
-- Switch it on for the control plane channels that exist today so they keep
-- hearing what they heard before; channels made afterwards default to off.
-- Data only, forward-only, touches no other table or column.
UPDATE "channel" SET "is_all_organizations_notified" = true WHERE "scope" = 'instance' AND "is_all_organizations_notified" = false;
