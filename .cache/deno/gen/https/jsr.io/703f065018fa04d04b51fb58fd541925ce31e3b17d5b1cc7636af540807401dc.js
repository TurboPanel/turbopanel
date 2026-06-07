import { HonoBase } from './hono-base.ts';
import { RegExpRouter } from './router/reg-exp-router/index.ts';
import { SmartRouter } from './router/smart-router/index.ts';
import { TrieRouter } from './router/trie-router/index.ts';
/**
 * The Hono class extends the functionality of the HonoBase class.
 * It sets up routing and allows for custom options to be passed.
 *
 * @template E - The environment type.
 * @template S - The schema type.
 * @template BasePath - The base path type.
 */ export class Hono extends HonoBase {
  /**
   * Creates an instance of the Hono class.
   *
   * @param options - Optional configuration options for the Hono instance.
   */ constructor(options = {}){
    super(options);
    this.router = options.router ?? new SmartRouter({
      routers: [
        new RegExpRouter(),
        new TrieRouter()
      ]
    });
  }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0Bob25vL2hvbm8vNC4xMi4yMy9zcmMvaG9uby50cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBIb25vQmFzZSB9IGZyb20gJy4vaG9uby1iYXNlLnRzJ1xuaW1wb3J0IHR5cGUgeyBIb25vT3B0aW9ucyB9IGZyb20gJy4vaG9uby1iYXNlLnRzJ1xuaW1wb3J0IHsgUmVnRXhwUm91dGVyIH0gZnJvbSAnLi9yb3V0ZXIvcmVnLWV4cC1yb3V0ZXIvaW5kZXgudHMnXG5pbXBvcnQgeyBTbWFydFJvdXRlciB9IGZyb20gJy4vcm91dGVyL3NtYXJ0LXJvdXRlci9pbmRleC50cydcbmltcG9ydCB7IFRyaWVSb3V0ZXIgfSBmcm9tICcuL3JvdXRlci90cmllLXJvdXRlci9pbmRleC50cydcbmltcG9ydCB0eXBlIHsgQmxhbmtFbnYsIEJsYW5rU2NoZW1hLCBFbnYsIFNjaGVtYSB9IGZyb20gJy4vdHlwZXMudHMnXG5cbi8qKlxuICogVGhlIEhvbm8gY2xhc3MgZXh0ZW5kcyB0aGUgZnVuY3Rpb25hbGl0eSBvZiB0aGUgSG9ub0Jhc2UgY2xhc3MuXG4gKiBJdCBzZXRzIHVwIHJvdXRpbmcgYW5kIGFsbG93cyBmb3IgY3VzdG9tIG9wdGlvbnMgdG8gYmUgcGFzc2VkLlxuICpcbiAqIEB0ZW1wbGF0ZSBFIC0gVGhlIGVudmlyb25tZW50IHR5cGUuXG4gKiBAdGVtcGxhdGUgUyAtIFRoZSBzY2hlbWEgdHlwZS5cbiAqIEB0ZW1wbGF0ZSBCYXNlUGF0aCAtIFRoZSBiYXNlIHBhdGggdHlwZS5cbiAqL1xuZXhwb3J0IGNsYXNzIEhvbm88XG4gIEUgZXh0ZW5kcyBFbnYgPSBCbGFua0VudixcbiAgUyBleHRlbmRzIFNjaGVtYSA9IEJsYW5rU2NoZW1hLFxuICBCYXNlUGF0aCBleHRlbmRzIHN0cmluZyA9ICcvJyxcbj4gZXh0ZW5kcyBIb25vQmFzZTxFLCBTLCBCYXNlUGF0aD4ge1xuICAvKipcbiAgICogQ3JlYXRlcyBhbiBpbnN0YW5jZSBvZiB0aGUgSG9ubyBjbGFzcy5cbiAgICpcbiAgICogQHBhcmFtIG9wdGlvbnMgLSBPcHRpb25hbCBjb25maWd1cmF0aW9uIG9wdGlvbnMgZm9yIHRoZSBIb25vIGluc3RhbmNlLlxuICAgKi9cbiAgY29uc3RydWN0b3Iob3B0aW9uczogSG9ub09wdGlvbnM8RT4gPSB7fSkge1xuICAgIHN1cGVyKG9wdGlvbnMpXG4gICAgdGhpcy5yb3V0ZXIgPVxuICAgICAgb3B0aW9ucy5yb3V0ZXIgPz9cbiAgICAgIG5ldyBTbWFydFJvdXRlcih7XG4gICAgICAgIHJvdXRlcnM6IFtuZXcgUmVnRXhwUm91dGVyKCksIG5ldyBUcmllUm91dGVyKCldLFxuICAgICAgfSlcbiAgfVxufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLFNBQVMsUUFBUSxRQUFRLGlCQUFnQjtBQUV6QyxTQUFTLFlBQVksUUFBUSxtQ0FBa0M7QUFDL0QsU0FBUyxXQUFXLFFBQVEsaUNBQWdDO0FBQzVELFNBQVMsVUFBVSxRQUFRLGdDQUErQjtBQUcxRDs7Ozs7OztDQU9DLEdBQ0QsT0FBTyxNQUFNLGFBSUg7RUFDUjs7OztHQUlDLEdBQ0QsWUFBWSxVQUEwQixDQUFDLENBQUMsQ0FBRTtJQUN4QyxLQUFLLENBQUM7SUFDTixJQUFJLENBQUMsTUFBTSxHQUNULFFBQVEsTUFBTSxJQUNkLElBQUksWUFBWTtNQUNkLFNBQVM7UUFBQyxJQUFJO1FBQWdCLElBQUk7T0FBYTtJQUNqRDtFQUNKO0FBQ0YifQ==
// denoCacheMetadata=10611597658206322557,8833542327111229776