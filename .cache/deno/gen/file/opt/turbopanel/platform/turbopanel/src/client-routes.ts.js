import { Hono } from 'hono';
import { CLIENT_API_PREFIX } from './surfaces.ts';
/**
 * Client (end-user UI) surface. Greenfield — no client features exist yet, so
 * this only exposes a stub status endpoint to establish the namespace.
 * Mounted under {@link CLIENT_API_PREFIX} (`/api/client/v1`).
 */ export function registerClientRoutes(app) {
  const client = new Hono();
  client.get('/status', (c)=>c.json({
      ok: true,
      surface: 'client'
    }));
  app.route(CLIENT_API_PREFIX, client);
  return app;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vb3B0L3R1cmJvcGFuZWwvcGxhdGZvcm0vdHVyYm9wYW5lbC9zcmMvY2xpZW50LXJvdXRlcy50cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBIb25vIH0gZnJvbSAnaG9ubydcbmltcG9ydCB7IENMSUVOVF9BUElfUFJFRklYIH0gZnJvbSAnLi9zdXJmYWNlcy50cydcblxuLyoqXG4gKiBDbGllbnQgKGVuZC11c2VyIFVJKSBzdXJmYWNlLiBHcmVlbmZpZWxkIOKAlCBubyBjbGllbnQgZmVhdHVyZXMgZXhpc3QgeWV0LCBzb1xuICogdGhpcyBvbmx5IGV4cG9zZXMgYSBzdHViIHN0YXR1cyBlbmRwb2ludCB0byBlc3RhYmxpc2ggdGhlIG5hbWVzcGFjZS5cbiAqIE1vdW50ZWQgdW5kZXIge0BsaW5rIENMSUVOVF9BUElfUFJFRklYfSAoYC9hcGkvY2xpZW50L3YxYCkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZWdpc3RlckNsaWVudFJvdXRlcyhhcHA6IEhvbm8pIHtcbiAgY29uc3QgY2xpZW50ID0gbmV3IEhvbm8oKVxuXG4gIGNsaWVudC5nZXQoJy9zdGF0dXMnLCAoYykgPT4gYy5qc29uKHsgb2s6IHRydWUsIHN1cmZhY2U6ICdjbGllbnQnIH0pKVxuXG4gIGFwcC5yb3V0ZShDTElFTlRfQVBJX1BSRUZJWCwgY2xpZW50KVxuICByZXR1cm4gYXBwXG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsU0FBUyxJQUFJLFFBQVEsT0FBTTtBQUMzQixTQUFTLGlCQUFpQixRQUFRLGdCQUFlO0FBRWpEOzs7O0NBSUMsR0FDRCxPQUFPLFNBQVMscUJBQXFCLEdBQVM7RUFDNUMsTUFBTSxTQUFTLElBQUk7RUFFbkIsT0FBTyxHQUFHLENBQUMsV0FBVyxDQUFDLElBQU0sRUFBRSxJQUFJLENBQUM7TUFBRSxJQUFJO01BQU0sU0FBUztJQUFTO0VBRWxFLElBQUksS0FBSyxDQUFDLG1CQUFtQjtFQUM3QixPQUFPO0FBQ1QifQ==
// denoCacheMetadata=10507743731097963971,9546656740836865481