/** Atomically delete a key only when its value matches the expected token. */
export const COMPARE_AND_DELETE = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`;

/** Atomically renew a lease only when the current token matches. */
export const COMPARE_AND_RENEW = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("SET", KEYS[1], ARGV[2], "PX", ARGV[3])
else
  return 0
end
`;

/**
 * Demote stale daemon socket presence when the Redis lease has expired but
 * meta still marks the server connected (unclean disconnect / crash).
 *
 * KEYS[1] lease key, KEYS[2] meta hash, KEYS[3] online set
 * ARGV[1] serverId, ARGV[2] closedAt, ARGV[3] reason
 */
export const RECONCILE_STALE_SOCKET_PRESENCE = `
if redis.call("GET", KEYS[1]) then
  return 0
end

local connected = redis.call("HGET", KEYS[2], "connected")
local wasOnline = redis.call("SREM", KEYS[3], ARGV[1])

if connected ~= "1" and wasOnline == 0 then
  return 0
end

local connectionId = redis.call("HGET", KEYS[2], "connectionId") or ""

if connected == "1" then
  redis.call("HSET", KEYS[2], "connected", "0")
  if connectionId ~= "" then
    local connKey = "tp:cell:" .. ARGV[1] .. ":conn:" .. connectionId
    redis.call("HSET", connKey, "closedAt", ARGV[2], "reason", ARGV[3])
    redis.call("EXPIRE", connKey, 86400)
  end
end

if connectionId ~= "" then
  return { 1, connectionId }
end
return 1
`;
