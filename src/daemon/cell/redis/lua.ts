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
 * Demote stale daemon socket presence when the Redis lease has expired or
 * inbound activity is older than the sweep threshold.
 *
 * KEYS[1] lease key, KEYS[2] meta hash, KEYS[3] online set
 * ARGV[1] serverId, ARGV[2] closedAt, ARGV[3] reason, ARGV[4] staleBeforeIso
 */
export const RECONCILE_STALE_SOCKET_PRESENCE = `
local connected = redis.call("HGET", KEYS[2], "connected")
local wasOnline = 0

if connected ~= "1" then
  wasOnline = redis.call("SREM", KEYS[3], ARGV[1])
  if wasOnline == 0 then
    return 0
  end
end

local leaseHeld = redis.call("GET", KEYS[1])
if leaseHeld then
  local lastInbound = redis.call("HGET", KEYS[2], "lastInboundAt")
  if not lastInbound or lastInbound == "" then
    lastInbound = redis.call("HGET", KEYS[2], "lastSeenAt")
  end
  if not lastInbound or lastInbound == "" then
    lastInbound = redis.call("HGET", KEYS[2], "connectedAt")
  end
  if lastInbound and lastInbound > ARGV[4] then
    return 0
  end
end

local connectionId = redis.call("HGET", KEYS[2], "connectionId") or ""

if connected == "1" then
  redis.call("HSET", KEYS[2], "connected", "0")
  redis.call("SREM", KEYS[3], ARGV[1])
  if connectionId ~= "" then
    local connKey = "tp:cell:" .. ARGV[1] .. ":conn:" .. connectionId
    redis.call("HSET", connKey, "closedAt", ARGV[2], "reason", ARGV[3])
    redis.call("EXPIRE", connKey, 86400)
  end
elseif wasOnline == 1 then
  redis.call("SREM", KEYS[3], ARGV[1])
end

if connectionId ~= "" then
  return { 1, connectionId }
end
return 1
`;

/**
 * Atomic token-bucket rate limit (mailer-style refill).
 *
 * KEYS[1] bucket hash (`tokens`, `ts`)
 * ARGV[1] capacity, ARGV[2] msPerToken, ARGV[3] nowMs, ARGV[4] ttlMs
 * Returns 1 if a token was consumed, 0 if denied.
 */
export const RATE_LIMIT_TOKEN_BUCKET = `
local capacity = tonumber(ARGV[1])
local msPerToken = tonumber(ARGV[2])
local nowMs = tonumber(ARGV[3])
local ttlMs = tonumber(ARGV[4])

local vals = redis.call("HMGET", KEYS[1], "tokens", "ts")
local tokens = tonumber(vals[1])
local ts = tonumber(vals[2])

if tokens == nil or ts == nil then
  tokens = capacity
  ts = nowMs
else
  local elapsed = nowMs - ts
  if elapsed > 0 then
    tokens = math.min(capacity, tokens + (elapsed / msPerToken))
    ts = nowMs
  end
end

local allowed = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
end

redis.call("HSET", KEYS[1], "tokens", tostring(tokens), "ts", tostring(ts))
redis.call("PEXPIRE", KEYS[1], ttlMs)
return allowed
`;