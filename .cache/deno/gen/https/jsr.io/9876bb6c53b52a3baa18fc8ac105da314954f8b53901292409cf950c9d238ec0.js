import { HonoRequest } from './request.ts';
import { HtmlEscapedCallbackPhase, resolveCallback } from './utils/html.ts';
export const TEXT_PLAIN = 'text/plain; charset=UTF-8';
const setDefaultContentType = (contentType, headers)=>{
  return {
    'Content-Type': contentType,
    ...headers
  };
};
const createResponseInstance = (body, init)=>new Response(body, init);
export class Context {
  #rawRequest;
  #req;
  /**
   * `.env` can get bindings (environment variables, secrets, KV namespaces, D1 database, R2 bucket etc.) in Cloudflare Workers.
   *
   * @see {@link https://hono.dev/docs/api/context#env}
   *
   * @example
   * ```ts
   * // Environment object for Cloudflare Workers
   * app.get('*', async c => {
   *   const counter = c.env.COUNTER
   * })
   * ```
   */ env = {};
  #var;
  finalized = false;
  /**
   * `.error` can get the error object from the middleware if the Handler throws an error.
   *
   * @see {@link https://hono.dev/docs/api/context#error}
   *
   * @example
   * ```ts
   * app.use('*', async (c, next) => {
   *   await next()
   *   if (c.error) {
   *     // do something...
   *   }
   * })
   * ```
   */ error;
  #status;
  #executionCtx;
  #res;
  #layout;
  #renderer;
  #notFoundHandler;
  #preparedHeaders;
  #matchResult;
  #path;
  /**
   * Creates an instance of the Context class.
   *
   * @param req - The Request object.
   * @param options - Optional configuration options for the context.
   */ constructor(req, options){
    this.#rawRequest = req;
    if (options) {
      this.#executionCtx = options.executionCtx;
      this.env = options.env;
      this.#notFoundHandler = options.notFoundHandler;
      this.#path = options.path;
      this.#matchResult = options.matchResult;
    }
  }
  /**
   * `.req` is the instance of {@link HonoRequest}.
   */ get req() {
    this.#req ??= new HonoRequest(this.#rawRequest, this.#path, this.#matchResult);
    return this.#req;
  }
  /**
   * @see {@link https://hono.dev/docs/api/context#event}
   * The FetchEvent associated with the current request.
   *
   * @throws Will throw an error if the context does not have a FetchEvent.
   */ get event() {
    if (this.#executionCtx && 'respondWith' in this.#executionCtx) {
      return this.#executionCtx;
    } else {
      throw Error('This context has no FetchEvent');
    }
  }
  /**
   * @see {@link https://hono.dev/docs/api/context#executionctx}
   * The ExecutionContext associated with the current request.
   *
   * @throws Will throw an error if the context does not have an ExecutionContext.
   */ get executionCtx() {
    if (this.#executionCtx) {
      return this.#executionCtx;
    } else {
      throw Error('This context has no ExecutionContext');
    }
  }
  /**
   * @see {@link https://hono.dev/docs/api/context#res}
   * The Response object for the current request.
   */ get res() {
    return this.#res ||= createResponseInstance(null, {
      headers: this.#preparedHeaders ??= new Headers()
    });
  }
  /**
   * Sets the Response object for the current request.
   *
   * @param _res - The Response object to set.
   */ set res(_res) {
    if (this.#res && _res) {
      _res = createResponseInstance(_res.body, _res);
      for (const [k, v] of this.#res.headers.entries()){
        if (k === 'content-type') {
          continue;
        }
        if (k === 'set-cookie') {
          const cookies = this.#res.headers.getSetCookie();
          _res.headers.delete('set-cookie');
          for (const cookie of cookies){
            _res.headers.append('set-cookie', cookie);
          }
        } else {
          _res.headers.set(k, v);
        }
      }
    }
    this.#res = _res;
    this.finalized = true;
  }
  /**
   * `.render()` can create a response within a layout.
   *
   * @see {@link https://hono.dev/docs/api/context#render-setrenderer}
   *
   * @example
   * ```ts
   * app.get('/', (c) => {
   *   return c.render('Hello!')
   * })
   * ```
   */ render = (...args)=>{
    this.#renderer ??= (content)=>this.html(content);
    return this.#renderer(...args);
  };
  /**
   * Sets the layout for the response.
   *
   * @param layout - The layout to set.
   * @returns The layout function.
   */ setLayout = (layout)=>this.#layout = layout;
  /**
   * Gets the current layout for the response.
   *
   * @returns The current layout function.
   */ getLayout = ()=>this.#layout;
  /**
   * `.setRenderer()` can set the layout in the custom middleware.
   *
   * @see {@link https://hono.dev/docs/api/context#render-setrenderer}
   *
   * @example
   * ```tsx
   * app.use('*', async (c, next) => {
   *   c.setRenderer((content) => {
   *     return c.html(
   *       <html>
   *         <body>
   *           <p>{content}</p>
   *         </body>
   *       </html>
   *     )
   *   })
   *   await next()
   * })
   * ```
   */ setRenderer = (renderer)=>{
    this.#renderer = renderer;
  };
  /**
   * `.header()` can set headers.
   *
   * @see {@link https://hono.dev/docs/api/context#header}
   *
   * @example
   * ```ts
   * app.get('/welcome', (c) => {
   *   // Set headers
   *   c.header('X-Message', 'Hello!')
   *   c.header('Content-Type', 'text/plain')
   *
   *   return c.body('Thank you for coming')
   * })
   * ```
   */ header = (name, value, options)=>{
    if (this.finalized) {
      this.#res = createResponseInstance(this.#res.body, this.#res);
    }
    const headers = this.#res ? this.#res.headers : this.#preparedHeaders ??= new Headers();
    if (value === undefined) {
      headers.delete(name);
    } else if (options?.append) {
      headers.append(name, value);
    } else {
      headers.set(name, value);
    }
  };
  status = (status)=>{
    this.#status = status;
  };
  /**
   * `.set()` can set the value specified by the key.
   *
   * @see {@link https://hono.dev/docs/api/context#set-get}
   *
   * @example
   * ```ts
   * app.use('*', async (c, next) => {
   *   c.set('message', 'Hono is hot!!')
   *   await next()
   * })
   * ```
   */ set = (key, value)=>{
    this.#var ??= new Map();
    this.#var.set(key, value);
  };
  /**
   * `.get()` can use the value specified by the key.
   *
   * @see {@link https://hono.dev/docs/api/context#set-get}
   *
   * @example
   * ```ts
   * app.get('/', (c) => {
   *   const message = c.get('message')
   *   return c.text(`The message is "${message}"`)
   * })
   * ```
   */ get = (key)=>{
    return this.#var ? this.#var.get(key) : undefined;
  };
  /**
   * `.var` can access the value of a variable.
   *
   * @see {@link https://hono.dev/docs/api/context#var}
   *
   * @example
   * ```ts
   * const result = c.var.client.oneMethod()
   * ```
   */ // c.var.propName is a read-only
  get var() {
    if (!this.#var) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return {};
    }
    return Object.fromEntries(this.#var);
  }
  #newResponse(data, arg, headers) {
    const responseHeaders = this.#res ? new Headers(this.#res.headers) : this.#preparedHeaders ?? new Headers();
    if (typeof arg === 'object' && 'headers' in arg) {
      const argHeaders = arg.headers instanceof Headers ? arg.headers : new Headers(arg.headers);
      for (const [key, value] of argHeaders){
        if (key.toLowerCase() === 'set-cookie') {
          responseHeaders.append(key, value);
        } else {
          responseHeaders.set(key, value);
        }
      }
    }
    if (headers) {
      for (const [k, v] of Object.entries(headers)){
        if (typeof v === 'string') {
          responseHeaders.set(k, v);
        } else {
          responseHeaders.delete(k);
          for (const v2 of v){
            responseHeaders.append(k, v2);
          }
        }
      }
    }
    const status = typeof arg === 'number' ? arg : arg?.status ?? this.#status;
    return createResponseInstance(data, {
      status,
      headers: responseHeaders
    });
  }
  newResponse = (...args)=>this.#newResponse(...args);
  /**
   * `.body()` can return the HTTP response.
   * You can set headers with `.header()` and set HTTP status code with `.status`.
   * This can also be set in `.text()`, `.json()` and so on.
   *
   * @see {@link https://hono.dev/docs/api/context#body}
   *
   * @example
   * ```ts
   * app.get('/welcome', (c) => {
   *   // Set headers
   *   c.header('X-Message', 'Hello!')
   *   c.header('Content-Type', 'text/plain')
   *   // Set HTTP status code
   *   c.status(201)
   *
   *   // Return the response body
   *   return c.body('Thank you for coming')
   * })
   * ```
   */ body = (data, arg, headers)=>this.#newResponse(data, arg, headers);
  /**
   * `.text()` can render text as `Content-Type:text/plain`.
   *
   * @see {@link https://hono.dev/docs/api/context#text}
   *
   * @example
   * ```ts
   * app.get('/say', (c) => {
   *   return c.text('Hello!')
   * })
   * ```
   */ text = (text, arg, headers)=>{
    return !this.#preparedHeaders && !this.#status && !arg && !headers && !this.finalized ? new Response(text) : this.#newResponse(text, arg, setDefaultContentType(TEXT_PLAIN, headers));
  };
  /**
   * `.json()` can render JSON as `Content-Type:application/json`.
   *
   * @see {@link https://hono.dev/docs/api/context#json}
   *
   * @example
   * ```ts
   * app.get('/api', (c) => {
   *   return c.json({ message: 'Hello!' })
   * })
   * ```
   */ json = (object, arg, headers)=>{
    return this.#newResponse(JSON.stringify(object), arg, setDefaultContentType('application/json', headers));
  };
  html = (html, arg, headers)=>{
    const res = (html)=>this.#newResponse(html, arg, setDefaultContentType('text/html; charset=UTF-8', headers));
    return typeof html === 'object' ? resolveCallback(html, HtmlEscapedCallbackPhase.Stringify, false, {}).then(res) : res(html);
  };
  /**
   * `.redirect()` can Redirect, default status code is 302.
   *
   * @see {@link https://hono.dev/docs/api/context#redirect}
   *
   * @example
   * ```ts
   * app.get('/redirect', (c) => {
   *   return c.redirect('/')
   * })
   * app.get('/redirect-permanently', (c) => {
   *   return c.redirect('/', 301)
   * })
   * ```
   */ redirect = (location, status)=>{
    const locationString = String(location);
    this.header('Location', // Multibyes should be encoded
    // eslint-disable-next-line no-control-regex
    !/[^\x00-\xFF]/.test(locationString) ? locationString : encodeURI(locationString));
    return this.newResponse(null, status ?? 302);
  };
  /**
   * `.notFound()` can return the Not Found Response.
   *
   * @see {@link https://hono.dev/docs/api/context#notfound}
   *
   * @example
   * ```ts
   * app.get('/notfound', (c) => {
   *   return c.notFound()
   * })
   * ```
   */ notFound = ()=>{
    this.#notFoundHandler ??= ()=>createResponseInstance();
    return this.#notFoundHandler(this);
  };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0Bob25vL2hvbm8vNC4xMi4yMy9zcmMvY29udGV4dC50cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBIb25vUmVxdWVzdCB9IGZyb20gJy4vcmVxdWVzdC50cydcbmltcG9ydCB0eXBlIHsgUmVzdWx0IH0gZnJvbSAnLi9yb3V0ZXIudHMnXG5pbXBvcnQgdHlwZSB7XG4gIEVudixcbiAgRmV0Y2hFdmVudExpa2UsXG4gIEgsXG4gIElucHV0LFxuICBOb3RGb3VuZEhhbmRsZXIsXG4gIFJvdXRlclJvdXRlLFxuICBUeXBlZFJlc3BvbnNlLFxufSBmcm9tICcuL3R5cGVzLnRzJ1xuaW1wb3J0IHR5cGUgeyBSZXNwb25zZUhlYWRlciB9IGZyb20gJy4vdXRpbHMvaGVhZGVycy50cydcbmltcG9ydCB7IEh0bWxFc2NhcGVkQ2FsbGJhY2tQaGFzZSwgcmVzb2x2ZUNhbGxiYWNrIH0gZnJvbSAnLi91dGlscy9odG1sLnRzJ1xuaW1wb3J0IHR5cGUgeyBDb250ZW50ZnVsU3RhdHVzQ29kZSwgUmVkaXJlY3RTdGF0dXNDb2RlLCBTdGF0dXNDb2RlIH0gZnJvbSAnLi91dGlscy9odHRwLXN0YXR1cy50cydcbmltcG9ydCB0eXBlIHsgQmFzZU1pbWUgfSBmcm9tICcuL3V0aWxzL21pbWUudHMnXG5pbXBvcnQgdHlwZSB7IEludmFsaWRKU09OVmFsdWUsIElzQW55LCBKU09OUGFyc2VkLCBKU09OVmFsdWUgfSBmcm9tICcuL3V0aWxzL3R5cGVzLnRzJ1xuXG50eXBlIEhlYWRlclJlY29yZCA9XG4gIHwgUmVjb3JkPCdDb250ZW50LVR5cGUnLCBCYXNlTWltZT5cbiAgfCBSZWNvcmQ8UmVzcG9uc2VIZWFkZXIsIHN0cmluZyB8IHN0cmluZ1tdPlxuICB8IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IHN0cmluZ1tdPlxuXG4vKipcbiAqIERhdGEgdHlwZSBjYW4gYmUgYSBzdHJpbmcsIEFycmF5QnVmZmVyLCBVaW50OEFycmF5IChidWZmZXIpLCBvciBSZWFkYWJsZVN0cmVhbS5cbiAqL1xuZXhwb3J0IHR5cGUgRGF0YSA9IHN0cmluZyB8IEFycmF5QnVmZmVyIHwgUmVhZGFibGVTdHJlYW0gfCBVaW50OEFycmF5PEFycmF5QnVmZmVyPlxuXG4vKipcbiAqIEludGVyZmFjZSBmb3IgdGhlIGV4ZWN1dGlvbiBjb250ZXh0IGluIGEgd2ViIHdvcmtlciBvciBzaW1pbGFyIGVudmlyb25tZW50LlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEV4ZWN1dGlvbkNvbnRleHQge1xuICAvKipcbiAgICogRXh0ZW5kcyB0aGUgbGlmZXRpbWUgb2YgdGhlIGV2ZW50IGNhbGxiYWNrIHVudGlsIHRoZSBwcm9taXNlIGlzIHNldHRsZWQuXG4gICAqXG4gICAqIEBwYXJhbSBwcm9taXNlIC0gQSBwcm9taXNlIHRvIHdhaXQgZm9yLlxuICAgKi9cbiAgd2FpdFVudGlsKHByb21pc2U6IFByb21pc2U8dW5rbm93bj4pOiB2b2lkXG4gIC8qKlxuICAgKiBBbGxvd3MgdGhlIGV2ZW50IHRvIGJlIHBhc3NlZCB0aHJvdWdoIHRvIHN1YnNlcXVlbnQgZXZlbnQgbGlzdGVuZXJzLlxuICAgKi9cbiAgcGFzc1Rocm91Z2hPbkV4Y2VwdGlvbigpOiB2b2lkXG4gIC8qKlxuICAgKiBGb3IgY29tcGF0aWJpbGl0eSB3aXRoIFdyYW5nbGVyIDQueC5cbiAgICovXG4gIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBAdHlwZXNjcmlwdC1lc2xpbnQvbm8tZXhwbGljaXQtYW55XG4gIHByb3BzOiBhbnlcbiAgLyoqXG4gICAqIEZvciBjb21wYXRpYmlsaXR5IHdpdGggV3JhbmdsZXIgNC54LlxuICAgKi9cbiAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIEB0eXBlc2NyaXB0LWVzbGludC9uby1leHBsaWNpdC1hbnlcbiAgZXhwb3J0cz86IGFueVxufVxuXG4vKipcbiAqIEludGVyZmFjZSBmb3IgY29udGV4dCB2YXJpYWJsZSBtYXBwaW5nLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIENvbnRleHRWYXJpYWJsZU1hcCB7fVxuXG4vKipcbiAqIEludGVyZmFjZSBmb3IgY29udGV4dCByZW5kZXJlci5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBDb250ZXh0UmVuZGVyZXIge31cblxuLyoqXG4gKiBJbnRlcmZhY2UgcmVwcmVzZW50aW5nIGEgcmVuZGVyZXIgZm9yIGNvbnRlbnQuXG4gKlxuICogQGludGVyZmFjZSBEZWZhdWx0UmVuZGVyZXJcbiAqIEBwYXJhbSB7c3RyaW5nIHwgUHJvbWlzZTxzdHJpbmc+fSBjb250ZW50IC0gVGhlIGNvbnRlbnQgdG8gYmUgcmVuZGVyZWQsIHdoaWNoIGNhbiBiZSBlaXRoZXIgYSBzdHJpbmcgb3IgYSBQcm9taXNlIHJlc29sdmluZyB0byBhIHN0cmluZy5cbiAqIEByZXR1cm5zIHtSZXNwb25zZSB8IFByb21pc2U8UmVzcG9uc2U+fSAtIFRoZSByZXNwb25zZSBhZnRlciByZW5kZXJpbmcgdGhlIGNvbnRlbnQsIHdoaWNoIGNhbiBiZSBlaXRoZXIgYSBSZXNwb25zZSBvciBhIFByb21pc2UgcmVzb2x2aW5nIHRvIGEgUmVzcG9uc2UuXG4gKi9cbmludGVyZmFjZSBEZWZhdWx0UmVuZGVyZXIge1xuICAoY29udGVudDogc3RyaW5nIHwgUHJvbWlzZTxzdHJpbmc+KTogUmVzcG9uc2UgfCBQcm9taXNlPFJlc3BvbnNlPlxufVxuXG4vKipcbiAqIFJlbmRlcmVyIHR5cGUgd2hpY2ggY2FuIGVpdGhlciBiZSBhIENvbnRleHRSZW5kZXJlciBvciBEZWZhdWx0UmVuZGVyZXIuXG4gKi9cbmV4cG9ydCB0eXBlIFJlbmRlcmVyID0gQ29udGV4dFJlbmRlcmVyIGV4dGVuZHMgRnVuY3Rpb24gPyBDb250ZXh0UmVuZGVyZXIgOiBEZWZhdWx0UmVuZGVyZXJcblxuLyoqXG4gKiBFeHRyYWN0cyB0aGUgcHJvcHMgZm9yIHRoZSByZW5kZXJlci5cbiAqL1xuZXhwb3J0IHR5cGUgUHJvcHNGb3JSZW5kZXJlciA9IFsuLi5SZXF1aXJlZDxQYXJhbWV0ZXJzPFJlbmRlcmVyPj5dIGV4dGVuZHMgW3Vua25vd24sIGluZmVyIFByb3BzXVxuICA/IFByb3BzXG4gIDogdW5rbm93blxuXG4vLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgQHR5cGVzY3JpcHQtZXNsaW50L25vLWV4cGxpY2l0LWFueVxuZXhwb3J0IHR5cGUgTGF5b3V0PFQgPSBSZWNvcmQ8c3RyaW5nLCBhbnk+PiA9IChwcm9wczogVCkgPT4gYW55XG5cbi8qKlxuICogSW50ZXJmYWNlIGZvciBnZXR0aW5nIGNvbnRleHQgdmFyaWFibGVzLlxuICpcbiAqIEB0ZW1wbGF0ZSBFIC0gRW52aXJvbm1lbnQgdHlwZS5cbiAqL1xuaW50ZXJmYWNlIEdldDxFIGV4dGVuZHMgRW52PiB7XG4gIDxLZXkgZXh0ZW5kcyBrZXlvZiBFWydWYXJpYWJsZXMnXT4oa2V5OiBLZXkpOiBFWydWYXJpYWJsZXMnXVtLZXldXG4gIDxLZXkgZXh0ZW5kcyBrZXlvZiBDb250ZXh0VmFyaWFibGVNYXA+KGtleTogS2V5KTogQ29udGV4dFZhcmlhYmxlTWFwW0tleV1cbn1cblxuLyoqXG4gKiBJbnRlcmZhY2UgZm9yIHNldHRpbmcgY29udGV4dCB2YXJpYWJsZXMuXG4gKlxuICogQHRlbXBsYXRlIEUgLSBFbnZpcm9ubWVudCB0eXBlLlxuICovXG5pbnRlcmZhY2UgU2V0PEUgZXh0ZW5kcyBFbnY+IHtcbiAgPEtleSBleHRlbmRzIGtleW9mIEVbJ1ZhcmlhYmxlcyddPihrZXk6IEtleSwgdmFsdWU6IEVbJ1ZhcmlhYmxlcyddW0tleV0pOiB2b2lkXG4gIDxLZXkgZXh0ZW5kcyBrZXlvZiBDb250ZXh0VmFyaWFibGVNYXA+KGtleTogS2V5LCB2YWx1ZTogQ29udGV4dFZhcmlhYmxlTWFwW0tleV0pOiB2b2lkXG59XG5cbi8qKlxuICogSW50ZXJmYWNlIGZvciBjcmVhdGluZyBhIG5ldyByZXNwb25zZS5cbiAqL1xuaW50ZXJmYWNlIE5ld1Jlc3BvbnNlIHtcbiAgKGRhdGE6IERhdGEgfCBudWxsLCBzdGF0dXM/OiBTdGF0dXNDb2RlLCBoZWFkZXJzPzogSGVhZGVyUmVjb3JkKTogUmVzcG9uc2VcbiAgKGRhdGE6IERhdGEgfCBudWxsLCBpbml0PzogUmVzcG9uc2VPckluaXQpOiBSZXNwb25zZVxufVxuXG4vKipcbiAqIEludGVyZmFjZSBmb3IgcmVzcG9uZGluZyB3aXRoIGEgYm9keS5cbiAqL1xuaW50ZXJmYWNlIEJvZHlSZXNwb25kIHtcbiAgLy8gaWYgd2UgcmV0dXJuIGNvbnRlbnQsIG9ubHkgYWxsb3cgdGhlIHN0YXR1cyBjb2RlcyB0aGF0IGFsbG93IGZvciByZXR1cm5pbmcgdGhlIGJvZHlcbiAgPFQgZXh0ZW5kcyBEYXRhLCBVIGV4dGVuZHMgQ29udGVudGZ1bFN0YXR1c0NvZGU+KFxuICAgIGRhdGE6IFQsXG4gICAgc3RhdHVzPzogVSxcbiAgICBoZWFkZXJzPzogSGVhZGVyUmVjb3JkXG4gICk6IFJlc3BvbnNlICYgVHlwZWRSZXNwb25zZTxULCBVLCAnYm9keSc+XG4gIDxUIGV4dGVuZHMgRGF0YSwgVSBleHRlbmRzIENvbnRlbnRmdWxTdGF0dXNDb2RlPihcbiAgICBkYXRhOiBULFxuICAgIGluaXQ/OiBSZXNwb25zZU9ySW5pdDxVPlxuICApOiBSZXNwb25zZSAmIFR5cGVkUmVzcG9uc2U8VCwgVSwgJ2JvZHknPlxuICA8VCBleHRlbmRzIG51bGwsIFUgZXh0ZW5kcyBTdGF0dXNDb2RlPihcbiAgICBkYXRhOiBULFxuICAgIHN0YXR1cz86IFUsXG4gICAgaGVhZGVycz86IEhlYWRlclJlY29yZFxuICApOiBSZXNwb25zZSAmIFR5cGVkUmVzcG9uc2U8bnVsbCwgVSwgJ2JvZHknPlxuICA8VCBleHRlbmRzIG51bGwsIFUgZXh0ZW5kcyBTdGF0dXNDb2RlPihcbiAgICBkYXRhOiBULFxuICAgIGluaXQ/OiBSZXNwb25zZU9ySW5pdDxVPlxuICApOiBSZXNwb25zZSAmIFR5cGVkUmVzcG9uc2U8bnVsbCwgVSwgJ2JvZHknPlxufVxuXG4vKipcbiAqIEludGVyZmFjZSBmb3IgcmVzcG9uZGluZyB3aXRoIHRleHQuXG4gKlxuICogQGludGVyZmFjZSBUZXh0UmVzcG9uZFxuICogQHRlbXBsYXRlIFQgLSBUaGUgdHlwZSBvZiB0aGUgdGV4dCBjb250ZW50LlxuICogQHRlbXBsYXRlIFUgLSBUaGUgdHlwZSBvZiB0aGUgc3RhdHVzIGNvZGUuXG4gKlxuICogQHBhcmFtIHtUfSB0ZXh0IC0gVGhlIHRleHQgY29udGVudCB0byBiZSBpbmNsdWRlZCBpbiB0aGUgcmVzcG9uc2UuXG4gKiBAcGFyYW0ge1V9IFtzdGF0dXNdIC0gQW4gb3B0aW9uYWwgc3RhdHVzIGNvZGUgZm9yIHRoZSByZXNwb25zZS5cbiAqIEBwYXJhbSB7SGVhZGVyUmVjb3JkfSBbaGVhZGVyc10gLSBBbiBvcHRpb25hbCByZWNvcmQgb2YgaGVhZGVycyB0byBpbmNsdWRlIGluIHRoZSByZXNwb25zZS5cbiAqXG4gKiBAcmV0dXJucyB7UmVzcG9uc2UgJiBUeXBlZFJlc3BvbnNlPFQsIFUsICd0ZXh0Jz59IC0gVGhlIHJlc3BvbnNlIGFmdGVyIHJlbmRlcmluZyB0aGUgdGV4dCBjb250ZW50LCB0eXBlZCB3aXRoIHRoZSBwcm92aWRlZCB0ZXh0IGFuZCBzdGF0dXMgY29kZSB0eXBlcy5cbiAqL1xuaW50ZXJmYWNlIFRleHRSZXNwb25kIHtcbiAgPFQgZXh0ZW5kcyBzdHJpbmcsIFUgZXh0ZW5kcyBDb250ZW50ZnVsU3RhdHVzQ29kZSA9IENvbnRlbnRmdWxTdGF0dXNDb2RlPihcbiAgICB0ZXh0OiBULFxuICAgIHN0YXR1cz86IFUsXG4gICAgaGVhZGVycz86IEhlYWRlclJlY29yZFxuICApOiBSZXNwb25zZSAmIFR5cGVkUmVzcG9uc2U8VCwgVSwgJ3RleHQnPlxuICA8VCBleHRlbmRzIHN0cmluZywgVSBleHRlbmRzIENvbnRlbnRmdWxTdGF0dXNDb2RlID0gQ29udGVudGZ1bFN0YXR1c0NvZGU+KFxuICAgIHRleHQ6IFQsXG4gICAgaW5pdD86IFJlc3BvbnNlT3JJbml0PFU+XG4gICk6IFJlc3BvbnNlICYgVHlwZWRSZXNwb25zZTxULCBVLCAndGV4dCc+XG59XG5cbi8qKlxuICogSW50ZXJmYWNlIGZvciByZXNwb25kaW5nIHdpdGggSlNPTi5cbiAqXG4gKiBAaW50ZXJmYWNlIEpTT05SZXNwb25kXG4gKiBAdGVtcGxhdGUgVCAtIFRoZSB0eXBlIG9mIHRoZSBKU09OIHZhbHVlIG9yIHNpbXBsaWZpZWQgdW5rbm93biB0eXBlLlxuICogQHRlbXBsYXRlIFUgLSBUaGUgdHlwZSBvZiB0aGUgc3RhdHVzIGNvZGUuXG4gKlxuICogQHBhcmFtIHtUfSBvYmplY3QgLSBUaGUgSlNPTiBvYmplY3QgdG8gYmUgaW5jbHVkZWQgaW4gdGhlIHJlc3BvbnNlLlxuICogQHBhcmFtIHtVfSBbc3RhdHVzXSAtIEFuIG9wdGlvbmFsIHN0YXR1cyBjb2RlIGZvciB0aGUgcmVzcG9uc2UuXG4gKiBAcGFyYW0ge0hlYWRlclJlY29yZH0gW2hlYWRlcnNdIC0gQW4gb3B0aW9uYWwgcmVjb3JkIG9mIGhlYWRlcnMgdG8gaW5jbHVkZSBpbiB0aGUgcmVzcG9uc2UuXG4gKlxuICogQHJldHVybnMge0pTT05SZXNwb25kUmV0dXJuPFQsIFU+fSAtIFRoZSByZXNwb25zZSBhZnRlciByZW5kZXJpbmcgdGhlIEpTT04gb2JqZWN0LCB0eXBlZCB3aXRoIHRoZSBwcm92aWRlZCBvYmplY3QgYW5kIHN0YXR1cyBjb2RlIHR5cGVzLlxuICovXG5pbnRlcmZhY2UgSlNPTlJlc3BvbmQge1xuICA8XG4gICAgVCBleHRlbmRzIEpTT05WYWx1ZSB8IHt9IHwgSW52YWxpZEpTT05WYWx1ZSxcbiAgICBVIGV4dGVuZHMgQ29udGVudGZ1bFN0YXR1c0NvZGUgPSBDb250ZW50ZnVsU3RhdHVzQ29kZSxcbiAgPihcbiAgICBvYmplY3Q6IFQsXG4gICAgc3RhdHVzPzogVSxcbiAgICBoZWFkZXJzPzogSGVhZGVyUmVjb3JkXG4gICk6IEpTT05SZXNwb25kUmV0dXJuPFQsIFU+XG4gIDxcbiAgICBUIGV4dGVuZHMgSlNPTlZhbHVlIHwge30gfCBJbnZhbGlkSlNPTlZhbHVlLFxuICAgIFUgZXh0ZW5kcyBDb250ZW50ZnVsU3RhdHVzQ29kZSA9IENvbnRlbnRmdWxTdGF0dXNDb2RlLFxuICA+KFxuICAgIG9iamVjdDogVCxcbiAgICBpbml0PzogUmVzcG9uc2VPckluaXQ8VT5cbiAgKTogSlNPTlJlc3BvbmRSZXR1cm48VCwgVT5cbn1cblxuLyoqXG4gKiBAdGVtcGxhdGUgVCAtIFRoZSB0eXBlIG9mIHRoZSBKU09OIHZhbHVlIG9yIHNpbXBsaWZpZWQgdW5rbm93biB0eXBlLlxuICogQHRlbXBsYXRlIFUgLSBUaGUgdHlwZSBvZiB0aGUgc3RhdHVzIGNvZGUuXG4gKlxuICogQHJldHVybnMge1Jlc3BvbnNlICYgVHlwZWRSZXNwb25zZTxKU09OUGFyc2VkPFQ+LCBVLCAnanNvbic+fSAtIFRoZSByZXNwb25zZSBhZnRlciByZW5kZXJpbmcgdGhlIEpTT04gb2JqZWN0LCB0eXBlZCB3aXRoIHRoZSBwcm92aWRlZCBvYmplY3QgYW5kIHN0YXR1cyBjb2RlIHR5cGVzLlxuICovXG50eXBlIEpTT05SZXNwb25kUmV0dXJuPFxuICBUIGV4dGVuZHMgSlNPTlZhbHVlIHwge30gfCBJbnZhbGlkSlNPTlZhbHVlLFxuICBVIGV4dGVuZHMgQ29udGVudGZ1bFN0YXR1c0NvZGUsXG4+ID0gUmVzcG9uc2UgJiBUeXBlZFJlc3BvbnNlPEpTT05QYXJzZWQ8VD4sIFUsICdqc29uJz5cblxuLyoqXG4gKiBJbnRlcmZhY2UgcmVwcmVzZW50aW5nIGEgZnVuY3Rpb24gdGhhdCByZXNwb25kcyB3aXRoIEhUTUwgY29udGVudC5cbiAqXG4gKiBAcGFyYW0gaHRtbCAtIFRoZSBIVE1MIGNvbnRlbnQgdG8gcmVzcG9uZCB3aXRoLCB3aGljaCBjYW4gYmUgYSBzdHJpbmcgb3IgYSBQcm9taXNlIHRoYXQgcmVzb2x2ZXMgdG8gYSBzdHJpbmcuXG4gKiBAcGFyYW0gc3RhdHVzIC0gKE9wdGlvbmFsKSBUaGUgSFRUUCBzdGF0dXMgY29kZSBmb3IgdGhlIHJlc3BvbnNlLlxuICogQHBhcmFtIGhlYWRlcnMgLSAoT3B0aW9uYWwpIEEgcmVjb3JkIG9mIGhlYWRlcnMgdG8gaW5jbHVkZSBpbiB0aGUgcmVzcG9uc2UuXG4gKiBAcGFyYW0gaW5pdCAtIChPcHRpb25hbCkgVGhlIHJlc3BvbnNlIGluaXRpYWxpemF0aW9uIG9iamVjdC5cbiAqXG4gKiBAcmV0dXJucyBBIFJlc3BvbnNlIG9iamVjdCBvciBhIFByb21pc2UgdGhhdCByZXNvbHZlcyB0byBhIFJlc3BvbnNlIG9iamVjdC5cbiAqL1xuaW50ZXJmYWNlIEhUTUxSZXNwb25kIHtcbiAgPFQgZXh0ZW5kcyBzdHJpbmcgfCBQcm9taXNlPHN0cmluZz4+KFxuICAgIGh0bWw6IFQsXG4gICAgc3RhdHVzPzogQ29udGVudGZ1bFN0YXR1c0NvZGUsXG4gICAgaGVhZGVycz86IEhlYWRlclJlY29yZFxuICApOiBUIGV4dGVuZHMgc3RyaW5nID8gUmVzcG9uc2UgOiBQcm9taXNlPFJlc3BvbnNlPlxuICA8VCBleHRlbmRzIHN0cmluZyB8IFByb21pc2U8c3RyaW5nPj4oXG4gICAgaHRtbDogVCxcbiAgICBpbml0PzogUmVzcG9uc2VPckluaXQ8Q29udGVudGZ1bFN0YXR1c0NvZGU+XG4gICk6IFQgZXh0ZW5kcyBzdHJpbmcgPyBSZXNwb25zZSA6IFByb21pc2U8UmVzcG9uc2U+XG59XG5cbi8qKlxuICogT3B0aW9ucyBmb3IgY29uZmlndXJpbmcgdGhlIGNvbnRleHQuXG4gKlxuICogQHRlbXBsYXRlIEUgLSBFbnZpcm9ubWVudCB0eXBlLlxuICovXG50eXBlIENvbnRleHRPcHRpb25zPEUgZXh0ZW5kcyBFbnY+ID0ge1xuICAvKipcbiAgICogQmluZGluZ3MgZm9yIHRoZSBlbnZpcm9ubWVudC5cbiAgICovXG4gIGVudjogRVsnQmluZGluZ3MnXVxuICAvKipcbiAgICogRXhlY3V0aW9uIGNvbnRleHQgZm9yIHRoZSByZXF1ZXN0LlxuICAgKi9cbiAgZXhlY3V0aW9uQ3R4PzogRmV0Y2hFdmVudExpa2UgfCBFeGVjdXRpb25Db250ZXh0IHwgdW5kZWZpbmVkXG4gIC8qKlxuICAgKiBIYW5kbGVyIGZvciBub3QgZm91bmQgcmVzcG9uc2VzLlxuICAgKi9cbiAgbm90Rm91bmRIYW5kbGVyPzogTm90Rm91bmRIYW5kbGVyPEU+XG4gIG1hdGNoUmVzdWx0PzogUmVzdWx0PFtILCBSb3V0ZXJSb3V0ZV0+XG4gIHBhdGg/OiBzdHJpbmdcbn1cblxuaW50ZXJmYWNlIFNldEhlYWRlcnNPcHRpb25zIHtcbiAgYXBwZW5kPzogYm9vbGVhblxufVxuXG5pbnRlcmZhY2UgU2V0SGVhZGVycyB7XG4gIChuYW1lOiAnQ29udGVudC1UeXBlJywgdmFsdWU/OiBCYXNlTWltZSwgb3B0aW9ucz86IFNldEhlYWRlcnNPcHRpb25zKTogdm9pZFxuICAobmFtZTogUmVzcG9uc2VIZWFkZXIsIHZhbHVlPzogc3RyaW5nLCBvcHRpb25zPzogU2V0SGVhZGVyc09wdGlvbnMpOiB2b2lkXG4gIChuYW1lOiBzdHJpbmcsIHZhbHVlPzogc3RyaW5nLCBvcHRpb25zPzogU2V0SGVhZGVyc09wdGlvbnMpOiB2b2lkXG59XG5cbnR5cGUgUmVzcG9uc2VIZWFkZXJzSW5pdCA9XG4gIHwgW3N0cmluZywgc3RyaW5nXVtdXG4gIHwgUmVjb3JkPCdDb250ZW50LVR5cGUnLCBCYXNlTWltZT5cbiAgfCBSZWNvcmQ8UmVzcG9uc2VIZWFkZXIsIHN0cmluZz5cbiAgfCBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+XG4gIHwgSGVhZGVyc1xuXG5pbnRlcmZhY2UgUmVzcG9uc2VJbml0PFQgZXh0ZW5kcyBTdGF0dXNDb2RlID0gU3RhdHVzQ29kZT4ge1xuICBoZWFkZXJzPzogUmVzcG9uc2VIZWFkZXJzSW5pdFxuICBzdGF0dXM/OiBUXG4gIHN0YXR1c1RleHQ/OiBzdHJpbmdcbn1cblxudHlwZSBSZXNwb25zZU9ySW5pdDxUIGV4dGVuZHMgU3RhdHVzQ29kZSA9IFN0YXR1c0NvZGU+ID0gUmVzcG9uc2VJbml0PFQ+IHwgUmVzcG9uc2VcblxuZXhwb3J0IGNvbnN0IFRFWFRfUExBSU4gPSAndGV4dC9wbGFpbjsgY2hhcnNldD1VVEYtOCdcblxuY29uc3Qgc2V0RGVmYXVsdENvbnRlbnRUeXBlID0gKGNvbnRlbnRUeXBlOiBzdHJpbmcsIGhlYWRlcnM/OiBIZWFkZXJSZWNvcmQpOiBIZWFkZXJSZWNvcmQgPT4ge1xuICByZXR1cm4ge1xuICAgICdDb250ZW50LVR5cGUnOiBjb250ZW50VHlwZSxcbiAgICAuLi5oZWFkZXJzLFxuICB9XG59XG5cbmNvbnN0IGNyZWF0ZVJlc3BvbnNlSW5zdGFuY2UgPSAoXG4gIGJvZHk/OiBCb2R5SW5pdCB8IG51bGwgfCB1bmRlZmluZWQsXG4gIGluaXQ/OiBnbG9iYWxUaGlzLlJlc3BvbnNlSW5pdFxuKTogUmVzcG9uc2UgPT4gbmV3IFJlc3BvbnNlKGJvZHksIGluaXQpXG5cbmV4cG9ydCBjbGFzcyBDb250ZXh0PFxuICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgQHR5cGVzY3JpcHQtZXNsaW50L25vLWV4cGxpY2l0LWFueVxuICBFIGV4dGVuZHMgRW52ID0gYW55LFxuICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgQHR5cGVzY3JpcHQtZXNsaW50L25vLWV4cGxpY2l0LWFueVxuICBQIGV4dGVuZHMgc3RyaW5nID0gYW55LFxuICBJIGV4dGVuZHMgSW5wdXQgPSB7fSxcbj4ge1xuICAjcmF3UmVxdWVzdDogUmVxdWVzdFxuICAjcmVxOiBIb25vUmVxdWVzdDxQLCBJWydvdXQnXT4gfCB1bmRlZmluZWRcbiAgLyoqXG4gICAqIGAuZW52YCBjYW4gZ2V0IGJpbmRpbmdzIChlbnZpcm9ubWVudCB2YXJpYWJsZXMsIHNlY3JldHMsIEtWIG5hbWVzcGFjZXMsIEQxIGRhdGFiYXNlLCBSMiBidWNrZXQgZXRjLikgaW4gQ2xvdWRmbGFyZSBXb3JrZXJzLlxuICAgKlxuICAgKiBAc2VlIHtAbGluayBodHRwczovL2hvbm8uZGV2L2RvY3MvYXBpL2NvbnRleHQjZW52fVxuICAgKlxuICAgKiBAZXhhbXBsZVxuICAgKiBgYGB0c1xuICAgKiAvLyBFbnZpcm9ubWVudCBvYmplY3QgZm9yIENsb3VkZmxhcmUgV29ya2Vyc1xuICAgKiBhcHAuZ2V0KCcqJywgYXN5bmMgYyA9PiB7XG4gICAqICAgY29uc3QgY291bnRlciA9IGMuZW52LkNPVU5URVJcbiAgICogfSlcbiAgICogYGBgXG4gICAqL1xuICBlbnY6IEVbJ0JpbmRpbmdzJ10gPSB7fVxuICAjdmFyOiBNYXA8dW5rbm93biwgdW5rbm93bj4gfCB1bmRlZmluZWRcbiAgZmluYWxpemVkOiBib29sZWFuID0gZmFsc2VcbiAgLyoqXG4gICAqIGAuZXJyb3JgIGNhbiBnZXQgdGhlIGVycm9yIG9iamVjdCBmcm9tIHRoZSBtaWRkbGV3YXJlIGlmIHRoZSBIYW5kbGVyIHRocm93cyBhbiBlcnJvci5cbiAgICpcbiAgICogQHNlZSB7QGxpbmsgaHR0cHM6Ly9ob25vLmRldi9kb2NzL2FwaS9jb250ZXh0I2Vycm9yfVxuICAgKlxuICAgKiBAZXhhbXBsZVxuICAgKiBgYGB0c1xuICAgKiBhcHAudXNlKCcqJywgYXN5bmMgKGMsIG5leHQpID0+IHtcbiAgICogICBhd2FpdCBuZXh0KClcbiAgICogICBpZiAoYy5lcnJvcikge1xuICAgKiAgICAgLy8gZG8gc29tZXRoaW5nLi4uXG4gICAqICAgfVxuICAgKiB9KVxuICAgKiBgYGBcbiAgICovXG4gIGVycm9yOiBFcnJvciB8IHVuZGVmaW5lZFxuXG4gICNzdGF0dXM6IFN0YXR1c0NvZGUgfCB1bmRlZmluZWRcbiAgI2V4ZWN1dGlvbkN0eDogRmV0Y2hFdmVudExpa2UgfCBFeGVjdXRpb25Db250ZXh0IHwgdW5kZWZpbmVkXG4gICNyZXM6IFJlc3BvbnNlIHwgdW5kZWZpbmVkXG4gICNsYXlvdXQ6IExheW91dDxQcm9wc0ZvclJlbmRlcmVyICYgeyBMYXlvdXQ6IExheW91dCB9PiB8IHVuZGVmaW5lZFxuICAjcmVuZGVyZXI6IFJlbmRlcmVyIHwgdW5kZWZpbmVkXG4gICNub3RGb3VuZEhhbmRsZXI6IE5vdEZvdW5kSGFuZGxlcjxFPiB8IHVuZGVmaW5lZFxuICAjcHJlcGFyZWRIZWFkZXJzOiBIZWFkZXJzIHwgdW5kZWZpbmVkXG5cbiAgI21hdGNoUmVzdWx0OiBSZXN1bHQ8W0gsIFJvdXRlclJvdXRlXT4gfCB1bmRlZmluZWRcbiAgI3BhdGg6IHN0cmluZyB8IHVuZGVmaW5lZFxuXG4gIC8qKlxuICAgKiBDcmVhdGVzIGFuIGluc3RhbmNlIG9mIHRoZSBDb250ZXh0IGNsYXNzLlxuICAgKlxuICAgKiBAcGFyYW0gcmVxIC0gVGhlIFJlcXVlc3Qgb2JqZWN0LlxuICAgKiBAcGFyYW0gb3B0aW9ucyAtIE9wdGlvbmFsIGNvbmZpZ3VyYXRpb24gb3B0aW9ucyBmb3IgdGhlIGNvbnRleHQuXG4gICAqL1xuICBjb25zdHJ1Y3RvcihyZXE6IFJlcXVlc3QsIG9wdGlvbnM/OiBDb250ZXh0T3B0aW9uczxFPikge1xuICAgIHRoaXMuI3Jhd1JlcXVlc3QgPSByZXFcbiAgICBpZiAob3B0aW9ucykge1xuICAgICAgdGhpcy4jZXhlY3V0aW9uQ3R4ID0gb3B0aW9ucy5leGVjdXRpb25DdHhcbiAgICAgIHRoaXMuZW52ID0gb3B0aW9ucy5lbnZcbiAgICAgIHRoaXMuI25vdEZvdW5kSGFuZGxlciA9IG9wdGlvbnMubm90Rm91bmRIYW5kbGVyXG4gICAgICB0aGlzLiNwYXRoID0gb3B0aW9ucy5wYXRoXG4gICAgICB0aGlzLiNtYXRjaFJlc3VsdCA9IG9wdGlvbnMubWF0Y2hSZXN1bHRcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogYC5yZXFgIGlzIHRoZSBpbnN0YW5jZSBvZiB7QGxpbmsgSG9ub1JlcXVlc3R9LlxuICAgKi9cbiAgZ2V0IHJlcSgpOiBIb25vUmVxdWVzdDxQLCBJWydvdXQnXT4ge1xuICAgIHRoaXMuI3JlcSA/Pz0gbmV3IEhvbm9SZXF1ZXN0KHRoaXMuI3Jhd1JlcXVlc3QsIHRoaXMuI3BhdGgsIHRoaXMuI21hdGNoUmVzdWx0KVxuICAgIHJldHVybiB0aGlzLiNyZXFcbiAgfVxuXG4gIC8qKlxuICAgKiBAc2VlIHtAbGluayBodHRwczovL2hvbm8uZGV2L2RvY3MvYXBpL2NvbnRleHQjZXZlbnR9XG4gICAqIFRoZSBGZXRjaEV2ZW50IGFzc29jaWF0ZWQgd2l0aCB0aGUgY3VycmVudCByZXF1ZXN0LlxuICAgKlxuICAgKiBAdGhyb3dzIFdpbGwgdGhyb3cgYW4gZXJyb3IgaWYgdGhlIGNvbnRleHQgZG9lcyBub3QgaGF2ZSBhIEZldGNoRXZlbnQuXG4gICAqL1xuICBnZXQgZXZlbnQoKTogRmV0Y2hFdmVudExpa2Uge1xuICAgIGlmICh0aGlzLiNleGVjdXRpb25DdHggJiYgJ3Jlc3BvbmRXaXRoJyBpbiB0aGlzLiNleGVjdXRpb25DdHgpIHtcbiAgICAgIHJldHVybiB0aGlzLiNleGVjdXRpb25DdHhcbiAgICB9IGVsc2Uge1xuICAgICAgdGhyb3cgRXJyb3IoJ1RoaXMgY29udGV4dCBoYXMgbm8gRmV0Y2hFdmVudCcpXG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIEBzZWUge0BsaW5rIGh0dHBzOi8vaG9uby5kZXYvZG9jcy9hcGkvY29udGV4dCNleGVjdXRpb25jdHh9XG4gICAqIFRoZSBFeGVjdXRpb25Db250ZXh0IGFzc29jaWF0ZWQgd2l0aCB0aGUgY3VycmVudCByZXF1ZXN0LlxuICAgKlxuICAgKiBAdGhyb3dzIFdpbGwgdGhyb3cgYW4gZXJyb3IgaWYgdGhlIGNvbnRleHQgZG9lcyBub3QgaGF2ZSBhbiBFeGVjdXRpb25Db250ZXh0LlxuICAgKi9cbiAgZ2V0IGV4ZWN1dGlvbkN0eCgpOiBFeGVjdXRpb25Db250ZXh0IHtcbiAgICBpZiAodGhpcy4jZXhlY3V0aW9uQ3R4KSB7XG4gICAgICByZXR1cm4gdGhpcy4jZXhlY3V0aW9uQ3R4IGFzIEV4ZWN1dGlvbkNvbnRleHRcbiAgICB9IGVsc2Uge1xuICAgICAgdGhyb3cgRXJyb3IoJ1RoaXMgY29udGV4dCBoYXMgbm8gRXhlY3V0aW9uQ29udGV4dCcpXG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIEBzZWUge0BsaW5rIGh0dHBzOi8vaG9uby5kZXYvZG9jcy9hcGkvY29udGV4dCNyZXN9XG4gICAqIFRoZSBSZXNwb25zZSBvYmplY3QgZm9yIHRoZSBjdXJyZW50IHJlcXVlc3QuXG4gICAqL1xuICBnZXQgcmVzKCk6IFJlc3BvbnNlIHtcbiAgICByZXR1cm4gKHRoaXMuI3JlcyB8fD0gY3JlYXRlUmVzcG9uc2VJbnN0YW5jZShudWxsLCB7XG4gICAgICBoZWFkZXJzOiAodGhpcy4jcHJlcGFyZWRIZWFkZXJzID8/PSBuZXcgSGVhZGVycygpKSxcbiAgICB9KSlcbiAgfVxuXG4gIC8qKlxuICAgKiBTZXRzIHRoZSBSZXNwb25zZSBvYmplY3QgZm9yIHRoZSBjdXJyZW50IHJlcXVlc3QuXG4gICAqXG4gICAqIEBwYXJhbSBfcmVzIC0gVGhlIFJlc3BvbnNlIG9iamVjdCB0byBzZXQuXG4gICAqL1xuICBzZXQgcmVzKF9yZXM6IFJlc3BvbnNlIHwgdW5kZWZpbmVkKSB7XG4gICAgaWYgKHRoaXMuI3JlcyAmJiBfcmVzKSB7XG4gICAgICBfcmVzID0gY3JlYXRlUmVzcG9uc2VJbnN0YW5jZShfcmVzLmJvZHksIF9yZXMpXG4gICAgICBmb3IgKGNvbnN0IFtrLCB2XSBvZiB0aGlzLiNyZXMuaGVhZGVycy5lbnRyaWVzKCkpIHtcbiAgICAgICAgaWYgKGsgPT09ICdjb250ZW50LXR5cGUnKSB7XG4gICAgICAgICAgY29udGludWVcbiAgICAgICAgfVxuICAgICAgICBpZiAoayA9PT0gJ3NldC1jb29raWUnKSB7XG4gICAgICAgICAgY29uc3QgY29va2llcyA9IHRoaXMuI3Jlcy5oZWFkZXJzLmdldFNldENvb2tpZSgpXG4gICAgICAgICAgX3Jlcy5oZWFkZXJzLmRlbGV0ZSgnc2V0LWNvb2tpZScpXG4gICAgICAgICAgZm9yIChjb25zdCBjb29raWUgb2YgY29va2llcykge1xuICAgICAgICAgICAgX3Jlcy5oZWFkZXJzLmFwcGVuZCgnc2V0LWNvb2tpZScsIGNvb2tpZSlcbiAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgX3Jlcy5oZWFkZXJzLnNldChrLCB2KVxuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICAgIHRoaXMuI3JlcyA9IF9yZXNcbiAgICB0aGlzLmZpbmFsaXplZCA9IHRydWVcbiAgfVxuXG4gIC8qKlxuICAgKiBgLnJlbmRlcigpYCBjYW4gY3JlYXRlIGEgcmVzcG9uc2Ugd2l0aGluIGEgbGF5b3V0LlxuICAgKlxuICAgKiBAc2VlIHtAbGluayBodHRwczovL2hvbm8uZGV2L2RvY3MvYXBpL2NvbnRleHQjcmVuZGVyLXNldHJlbmRlcmVyfVxuICAgKlxuICAgKiBAZXhhbXBsZVxuICAgKiBgYGB0c1xuICAgKiBhcHAuZ2V0KCcvJywgKGMpID0+IHtcbiAgICogICByZXR1cm4gYy5yZW5kZXIoJ0hlbGxvIScpXG4gICAqIH0pXG4gICAqIGBgYFxuICAgKi9cbiAgcmVuZGVyOiBSZW5kZXJlciA9ICguLi5hcmdzKSA9PiB7XG4gICAgdGhpcy4jcmVuZGVyZXIgPz89IChjb250ZW50OiBzdHJpbmcgfCBQcm9taXNlPHN0cmluZz4pID0+IHRoaXMuaHRtbChjb250ZW50KVxuICAgIHJldHVybiB0aGlzLiNyZW5kZXJlciguLi5hcmdzKVxuICB9XG5cbiAgLyoqXG4gICAqIFNldHMgdGhlIGxheW91dCBmb3IgdGhlIHJlc3BvbnNlLlxuICAgKlxuICAgKiBAcGFyYW0gbGF5b3V0IC0gVGhlIGxheW91dCB0byBzZXQuXG4gICAqIEByZXR1cm5zIFRoZSBsYXlvdXQgZnVuY3Rpb24uXG4gICAqL1xuICBzZXRMYXlvdXQgPSAoXG4gICAgbGF5b3V0OiBMYXlvdXQ8UHJvcHNGb3JSZW5kZXJlciAmIHsgTGF5b3V0OiBMYXlvdXQgfT5cbiAgKTogTGF5b3V0PFxuICAgIFByb3BzRm9yUmVuZGVyZXIgJiB7XG4gICAgICBMYXlvdXQ6IExheW91dFxuICAgIH1cbiAgPiA9PiAodGhpcy4jbGF5b3V0ID0gbGF5b3V0KVxuXG4gIC8qKlxuICAgKiBHZXRzIHRoZSBjdXJyZW50IGxheW91dCBmb3IgdGhlIHJlc3BvbnNlLlxuICAgKlxuICAgKiBAcmV0dXJucyBUaGUgY3VycmVudCBsYXlvdXQgZnVuY3Rpb24uXG4gICAqL1xuICBnZXRMYXlvdXQgPSAoKTogTGF5b3V0PFByb3BzRm9yUmVuZGVyZXIgJiB7IExheW91dDogTGF5b3V0IH0+IHwgdW5kZWZpbmVkID0+IHRoaXMuI2xheW91dFxuXG4gIC8qKlxuICAgKiBgLnNldFJlbmRlcmVyKClgIGNhbiBzZXQgdGhlIGxheW91dCBpbiB0aGUgY3VzdG9tIG1pZGRsZXdhcmUuXG4gICAqXG4gICAqIEBzZWUge0BsaW5rIGh0dHBzOi8vaG9uby5kZXYvZG9jcy9hcGkvY29udGV4dCNyZW5kZXItc2V0cmVuZGVyZXJ9XG4gICAqXG4gICAqIEBleGFtcGxlXG4gICAqIGBgYHRzeFxuICAgKiBhcHAudXNlKCcqJywgYXN5bmMgKGMsIG5leHQpID0+IHtcbiAgICogICBjLnNldFJlbmRlcmVyKChjb250ZW50KSA9PiB7XG4gICAqICAgICByZXR1cm4gYy5odG1sKFxuICAgKiAgICAgICA8aHRtbD5cbiAgICogICAgICAgICA8Ym9keT5cbiAgICogICAgICAgICAgIDxwPntjb250ZW50fTwvcD5cbiAgICogICAgICAgICA8L2JvZHk+XG4gICAqICAgICAgIDwvaHRtbD5cbiAgICogICAgIClcbiAgICogICB9KVxuICAgKiAgIGF3YWl0IG5leHQoKVxuICAgKiB9KVxuICAgKiBgYGBcbiAgICovXG4gIHNldFJlbmRlcmVyID0gKHJlbmRlcmVyOiBSZW5kZXJlcik6IHZvaWQgPT4ge1xuICAgIHRoaXMuI3JlbmRlcmVyID0gcmVuZGVyZXJcbiAgfVxuXG4gIC8qKlxuICAgKiBgLmhlYWRlcigpYCBjYW4gc2V0IGhlYWRlcnMuXG4gICAqXG4gICAqIEBzZWUge0BsaW5rIGh0dHBzOi8vaG9uby5kZXYvZG9jcy9hcGkvY29udGV4dCNoZWFkZXJ9XG4gICAqXG4gICAqIEBleGFtcGxlXG4gICAqIGBgYHRzXG4gICAqIGFwcC5nZXQoJy93ZWxjb21lJywgKGMpID0+IHtcbiAgICogICAvLyBTZXQgaGVhZGVyc1xuICAgKiAgIGMuaGVhZGVyKCdYLU1lc3NhZ2UnLCAnSGVsbG8hJylcbiAgICogICBjLmhlYWRlcignQ29udGVudC1UeXBlJywgJ3RleHQvcGxhaW4nKVxuICAgKlxuICAgKiAgIHJldHVybiBjLmJvZHkoJ1RoYW5rIHlvdSBmb3IgY29taW5nJylcbiAgICogfSlcbiAgICogYGBgXG4gICAqL1xuICBoZWFkZXI6IFNldEhlYWRlcnMgPSAobmFtZSwgdmFsdWUsIG9wdGlvbnMpOiB2b2lkID0+IHtcbiAgICBpZiAodGhpcy5maW5hbGl6ZWQpIHtcbiAgICAgIHRoaXMuI3JlcyA9IGNyZWF0ZVJlc3BvbnNlSW5zdGFuY2UoKHRoaXMuI3JlcyBhcyBSZXNwb25zZSkuYm9keSwgdGhpcy4jcmVzKVxuICAgIH1cbiAgICBjb25zdCBoZWFkZXJzID0gdGhpcy4jcmVzID8gdGhpcy4jcmVzLmhlYWRlcnMgOiAodGhpcy4jcHJlcGFyZWRIZWFkZXJzID8/PSBuZXcgSGVhZGVycygpKVxuICAgIGlmICh2YWx1ZSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICBoZWFkZXJzLmRlbGV0ZShuYW1lKVxuICAgIH0gZWxzZSBpZiAob3B0aW9ucz8uYXBwZW5kKSB7XG4gICAgICBoZWFkZXJzLmFwcGVuZChuYW1lLCB2YWx1ZSlcbiAgICB9IGVsc2Uge1xuICAgICAgaGVhZGVycy5zZXQobmFtZSwgdmFsdWUpXG4gICAgfVxuICB9XG5cbiAgc3RhdHVzID0gKHN0YXR1czogU3RhdHVzQ29kZSk6IHZvaWQgPT4ge1xuICAgIHRoaXMuI3N0YXR1cyA9IHN0YXR1c1xuICB9XG5cbiAgLyoqXG4gICAqIGAuc2V0KClgIGNhbiBzZXQgdGhlIHZhbHVlIHNwZWNpZmllZCBieSB0aGUga2V5LlxuICAgKlxuICAgKiBAc2VlIHtAbGluayBodHRwczovL2hvbm8uZGV2L2RvY3MvYXBpL2NvbnRleHQjc2V0LWdldH1cbiAgICpcbiAgICogQGV4YW1wbGVcbiAgICogYGBgdHNcbiAgICogYXBwLnVzZSgnKicsIGFzeW5jIChjLCBuZXh0KSA9PiB7XG4gICAqICAgYy5zZXQoJ21lc3NhZ2UnLCAnSG9ubyBpcyBob3QhIScpXG4gICAqICAgYXdhaXQgbmV4dCgpXG4gICAqIH0pXG4gICAqIGBgYFxuICAgKi9cbiAgc2V0OiBTZXQ8XG4gICAgSXNBbnk8RT4gZXh0ZW5kcyB0cnVlXG4gICAgICA/IHtcbiAgICAgICAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgQHR5cGVzY3JpcHQtZXNsaW50L25vLWV4cGxpY2l0LWFueVxuICAgICAgICAgIFZhcmlhYmxlczogQ29udGV4dFZhcmlhYmxlTWFwICYgUmVjb3JkPHN0cmluZywgYW55PlxuICAgICAgICB9XG4gICAgICA6IEVcbiAgPiA9IChrZXk6IHN0cmluZywgdmFsdWU6IHVua25vd24pID0+IHtcbiAgICB0aGlzLiN2YXIgPz89IG5ldyBNYXAoKVxuICAgIHRoaXMuI3Zhci5zZXQoa2V5LCB2YWx1ZSlcbiAgfVxuXG4gIC8qKlxuICAgKiBgLmdldCgpYCBjYW4gdXNlIHRoZSB2YWx1ZSBzcGVjaWZpZWQgYnkgdGhlIGtleS5cbiAgICpcbiAgICogQHNlZSB7QGxpbmsgaHR0cHM6Ly9ob25vLmRldi9kb2NzL2FwaS9jb250ZXh0I3NldC1nZXR9XG4gICAqXG4gICAqIEBleGFtcGxlXG4gICAqIGBgYHRzXG4gICAqIGFwcC5nZXQoJy8nLCAoYykgPT4ge1xuICAgKiAgIGNvbnN0IG1lc3NhZ2UgPSBjLmdldCgnbWVzc2FnZScpXG4gICAqICAgcmV0dXJuIGMudGV4dChgVGhlIG1lc3NhZ2UgaXMgXCIke21lc3NhZ2V9XCJgKVxuICAgKiB9KVxuICAgKiBgYGBcbiAgICovXG4gIGdldDogR2V0PFxuICAgIElzQW55PEU+IGV4dGVuZHMgdHJ1ZVxuICAgICAgPyB7XG4gICAgICAgICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIEB0eXBlc2NyaXB0LWVzbGludC9uby1leHBsaWNpdC1hbnlcbiAgICAgICAgICBWYXJpYWJsZXM6IENvbnRleHRWYXJpYWJsZU1hcCAmIFJlY29yZDxzdHJpbmcsIGFueT5cbiAgICAgICAgfVxuICAgICAgOiBFXG4gID4gPSAoa2V5OiBzdHJpbmcpID0+IHtcbiAgICByZXR1cm4gdGhpcy4jdmFyID8gdGhpcy4jdmFyLmdldChrZXkpIDogdW5kZWZpbmVkXG4gIH1cblxuICAvKipcbiAgICogYC52YXJgIGNhbiBhY2Nlc3MgdGhlIHZhbHVlIG9mIGEgdmFyaWFibGUuXG4gICAqXG4gICAqIEBzZWUge0BsaW5rIGh0dHBzOi8vaG9uby5kZXYvZG9jcy9hcGkvY29udGV4dCN2YXJ9XG4gICAqXG4gICAqIEBleGFtcGxlXG4gICAqIGBgYHRzXG4gICAqIGNvbnN0IHJlc3VsdCA9IGMudmFyLmNsaWVudC5vbmVNZXRob2QoKVxuICAgKiBgYGBcbiAgICovXG4gIC8vIGMudmFyLnByb3BOYW1lIGlzIGEgcmVhZC1vbmx5XG4gIGdldCB2YXIoKTogUmVhZG9ubHk8XG4gICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIEB0eXBlc2NyaXB0LWVzbGludC9uby1leHBsaWNpdC1hbnlcbiAgICBDb250ZXh0VmFyaWFibGVNYXAgJiAoSXNBbnk8RVsnVmFyaWFibGVzJ10+IGV4dGVuZHMgdHJ1ZSA/IFJlY29yZDxzdHJpbmcsIGFueT4gOiBFWydWYXJpYWJsZXMnXSlcbiAgPiB7XG4gICAgaWYgKCF0aGlzLiN2YXIpIHtcbiAgICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBAdHlwZXNjcmlwdC1lc2xpbnQvbm8tZXhwbGljaXQtYW55XG4gICAgICByZXR1cm4ge30gYXMgYW55XG4gICAgfVxuICAgIHJldHVybiBPYmplY3QuZnJvbUVudHJpZXModGhpcy4jdmFyKVxuICB9XG5cbiAgI25ld1Jlc3BvbnNlKFxuICAgIGRhdGE6IERhdGEgfCBudWxsLFxuICAgIGFyZz86IFN0YXR1c0NvZGUgfCBSZXNwb25zZU9ySW5pdCxcbiAgICBoZWFkZXJzPzogSGVhZGVyUmVjb3JkXG4gICk6IFJlc3BvbnNlIHtcbiAgICBjb25zdCByZXNwb25zZUhlYWRlcnMgPSB0aGlzLiNyZXNcbiAgICAgID8gbmV3IEhlYWRlcnModGhpcy4jcmVzLmhlYWRlcnMpXG4gICAgICA6ICh0aGlzLiNwcmVwYXJlZEhlYWRlcnMgPz8gbmV3IEhlYWRlcnMoKSlcblxuICAgIGlmICh0eXBlb2YgYXJnID09PSAnb2JqZWN0JyAmJiAnaGVhZGVycycgaW4gYXJnKSB7XG4gICAgICBjb25zdCBhcmdIZWFkZXJzID0gYXJnLmhlYWRlcnMgaW5zdGFuY2VvZiBIZWFkZXJzID8gYXJnLmhlYWRlcnMgOiBuZXcgSGVhZGVycyhhcmcuaGVhZGVycylcbiAgICAgIGZvciAoY29uc3QgW2tleSwgdmFsdWVdIG9mIGFyZ0hlYWRlcnMpIHtcbiAgICAgICAgaWYgKGtleS50b0xvd2VyQ2FzZSgpID09PSAnc2V0LWNvb2tpZScpIHtcbiAgICAgICAgICByZXNwb25zZUhlYWRlcnMuYXBwZW5kKGtleSwgdmFsdWUpXG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgcmVzcG9uc2VIZWFkZXJzLnNldChrZXksIHZhbHVlKVxuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKGhlYWRlcnMpIHtcbiAgICAgIGZvciAoY29uc3QgW2ssIHZdIG9mIE9iamVjdC5lbnRyaWVzKGhlYWRlcnMpKSB7XG4gICAgICAgIGlmICh0eXBlb2YgdiA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgICByZXNwb25zZUhlYWRlcnMuc2V0KGssIHYpXG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgcmVzcG9uc2VIZWFkZXJzLmRlbGV0ZShrKVxuICAgICAgICAgIGZvciAoY29uc3QgdjIgb2Ygdikge1xuICAgICAgICAgICAgcmVzcG9uc2VIZWFkZXJzLmFwcGVuZChrLCB2MilcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG5cbiAgICBjb25zdCBzdGF0dXMgPSB0eXBlb2YgYXJnID09PSAnbnVtYmVyJyA/IGFyZyA6IChhcmc/LnN0YXR1cyA/PyB0aGlzLiNzdGF0dXMpXG4gICAgcmV0dXJuIGNyZWF0ZVJlc3BvbnNlSW5zdGFuY2UoZGF0YSwgeyBzdGF0dXMsIGhlYWRlcnM6IHJlc3BvbnNlSGVhZGVycyB9KVxuICB9XG5cbiAgbmV3UmVzcG9uc2U6IE5ld1Jlc3BvbnNlID0gKC4uLmFyZ3MpID0+IHRoaXMuI25ld1Jlc3BvbnNlKC4uLihhcmdzIGFzIFBhcmFtZXRlcnM8TmV3UmVzcG9uc2U+KSlcblxuICAvKipcbiAgICogYC5ib2R5KClgIGNhbiByZXR1cm4gdGhlIEhUVFAgcmVzcG9uc2UuXG4gICAqIFlvdSBjYW4gc2V0IGhlYWRlcnMgd2l0aCBgLmhlYWRlcigpYCBhbmQgc2V0IEhUVFAgc3RhdHVzIGNvZGUgd2l0aCBgLnN0YXR1c2AuXG4gICAqIFRoaXMgY2FuIGFsc28gYmUgc2V0IGluIGAudGV4dCgpYCwgYC5qc29uKClgIGFuZCBzbyBvbi5cbiAgICpcbiAgICogQHNlZSB7QGxpbmsgaHR0cHM6Ly9ob25vLmRldi9kb2NzL2FwaS9jb250ZXh0I2JvZHl9XG4gICAqXG4gICAqIEBleGFtcGxlXG4gICAqIGBgYHRzXG4gICAqIGFwcC5nZXQoJy93ZWxjb21lJywgKGMpID0+IHtcbiAgICogICAvLyBTZXQgaGVhZGVyc1xuICAgKiAgIGMuaGVhZGVyKCdYLU1lc3NhZ2UnLCAnSGVsbG8hJylcbiAgICogICBjLmhlYWRlcignQ29udGVudC1UeXBlJywgJ3RleHQvcGxhaW4nKVxuICAgKiAgIC8vIFNldCBIVFRQIHN0YXR1cyBjb2RlXG4gICAqICAgYy5zdGF0dXMoMjAxKVxuICAgKlxuICAgKiAgIC8vIFJldHVybiB0aGUgcmVzcG9uc2UgYm9keVxuICAgKiAgIHJldHVybiBjLmJvZHkoJ1RoYW5rIHlvdSBmb3IgY29taW5nJylcbiAgICogfSlcbiAgICogYGBgXG4gICAqL1xuICBib2R5OiBCb2R5UmVzcG9uZCA9IChcbiAgICBkYXRhOiBEYXRhIHwgbnVsbCxcbiAgICBhcmc/OiBTdGF0dXNDb2RlIHwgUmVxdWVzdEluaXQsXG4gICAgaGVhZGVycz86IEhlYWRlclJlY29yZFxuICApOiBSZXR1cm5UeXBlPEJvZHlSZXNwb25kPiA9PiB0aGlzLiNuZXdSZXNwb25zZShkYXRhLCBhcmcsIGhlYWRlcnMpIGFzIFJldHVyblR5cGU8Qm9keVJlc3BvbmQ+XG5cbiAgLyoqXG4gICAqIGAudGV4dCgpYCBjYW4gcmVuZGVyIHRleHQgYXMgYENvbnRlbnQtVHlwZTp0ZXh0L3BsYWluYC5cbiAgICpcbiAgICogQHNlZSB7QGxpbmsgaHR0cHM6Ly9ob25vLmRldi9kb2NzL2FwaS9jb250ZXh0I3RleHR9XG4gICAqXG4gICAqIEBleGFtcGxlXG4gICAqIGBgYHRzXG4gICAqIGFwcC5nZXQoJy9zYXknLCAoYykgPT4ge1xuICAgKiAgIHJldHVybiBjLnRleHQoJ0hlbGxvIScpXG4gICAqIH0pXG4gICAqIGBgYFxuICAgKi9cbiAgdGV4dDogVGV4dFJlc3BvbmQgPSAoXG4gICAgdGV4dDogc3RyaW5nLFxuICAgIGFyZz86IENvbnRlbnRmdWxTdGF0dXNDb2RlIHwgUmVzcG9uc2VPckluaXQsXG4gICAgaGVhZGVycz86IEhlYWRlclJlY29yZFxuICApOiBSZXR1cm5UeXBlPFRleHRSZXNwb25kPiA9PiB7XG4gICAgcmV0dXJuICF0aGlzLiNwcmVwYXJlZEhlYWRlcnMgJiYgIXRoaXMuI3N0YXR1cyAmJiAhYXJnICYmICFoZWFkZXJzICYmICF0aGlzLmZpbmFsaXplZFxuICAgICAgPyAobmV3IFJlc3BvbnNlKHRleHQpIGFzIFJldHVyblR5cGU8VGV4dFJlc3BvbmQ+KVxuICAgICAgOiAodGhpcy4jbmV3UmVzcG9uc2UoXG4gICAgICAgICAgdGV4dCxcbiAgICAgICAgICBhcmcsXG4gICAgICAgICAgc2V0RGVmYXVsdENvbnRlbnRUeXBlKFRFWFRfUExBSU4sIGhlYWRlcnMpXG4gICAgICAgICkgYXMgUmV0dXJuVHlwZTxUZXh0UmVzcG9uZD4pXG4gIH1cblxuICAvKipcbiAgICogYC5qc29uKClgIGNhbiByZW5kZXIgSlNPTiBhcyBgQ29udGVudC1UeXBlOmFwcGxpY2F0aW9uL2pzb25gLlxuICAgKlxuICAgKiBAc2VlIHtAbGluayBodHRwczovL2hvbm8uZGV2L2RvY3MvYXBpL2NvbnRleHQjanNvbn1cbiAgICpcbiAgICogQGV4YW1wbGVcbiAgICogYGBgdHNcbiAgICogYXBwLmdldCgnL2FwaScsIChjKSA9PiB7XG4gICAqICAgcmV0dXJuIGMuanNvbih7IG1lc3NhZ2U6ICdIZWxsbyEnIH0pXG4gICAqIH0pXG4gICAqIGBgYFxuICAgKi9cbiAganNvbjogSlNPTlJlc3BvbmQgPSA8XG4gICAgVCBleHRlbmRzIEpTT05WYWx1ZSB8IHt9IHwgSW52YWxpZEpTT05WYWx1ZSxcbiAgICBVIGV4dGVuZHMgQ29udGVudGZ1bFN0YXR1c0NvZGUgPSBDb250ZW50ZnVsU3RhdHVzQ29kZSxcbiAgPihcbiAgICBvYmplY3Q6IFQsXG4gICAgYXJnPzogVSB8IFJlc3BvbnNlT3JJbml0PFU+LFxuICAgIGhlYWRlcnM/OiBIZWFkZXJSZWNvcmRcbiAgKTogSlNPTlJlc3BvbmRSZXR1cm48VCwgVT4gPT4ge1xuICAgIHJldHVybiB0aGlzLiNuZXdSZXNwb25zZShcbiAgICAgIEpTT04uc3RyaW5naWZ5KG9iamVjdCksXG4gICAgICBhcmcsXG4gICAgICBzZXREZWZhdWx0Q29udGVudFR5cGUoJ2FwcGxpY2F0aW9uL2pzb24nLCBoZWFkZXJzKVxuICAgICkgLyogZXNsaW50LWRpc2FibGUgQHR5cGVzY3JpcHQtZXNsaW50L25vLWV4cGxpY2l0LWFueSAqLyBhcyBhbnlcbiAgfVxuXG4gIGh0bWw6IEhUTUxSZXNwb25kID0gKFxuICAgIGh0bWw6IHN0cmluZyB8IFByb21pc2U8c3RyaW5nPixcbiAgICBhcmc/OiBDb250ZW50ZnVsU3RhdHVzQ29kZSB8IFJlc3BvbnNlT3JJbml0PENvbnRlbnRmdWxTdGF0dXNDb2RlPixcbiAgICBoZWFkZXJzPzogSGVhZGVyUmVjb3JkXG4gICk6IFJlc3BvbnNlIHwgUHJvbWlzZTxSZXNwb25zZT4gPT4ge1xuICAgIGNvbnN0IHJlcyA9IChodG1sOiBzdHJpbmcpID0+XG4gICAgICB0aGlzLiNuZXdSZXNwb25zZShodG1sLCBhcmcsIHNldERlZmF1bHRDb250ZW50VHlwZSgndGV4dC9odG1sOyBjaGFyc2V0PVVURi04JywgaGVhZGVycykpXG4gICAgcmV0dXJuIHR5cGVvZiBodG1sID09PSAnb2JqZWN0J1xuICAgICAgPyByZXNvbHZlQ2FsbGJhY2soaHRtbCwgSHRtbEVzY2FwZWRDYWxsYmFja1BoYXNlLlN0cmluZ2lmeSwgZmFsc2UsIHt9KS50aGVuKHJlcylcbiAgICAgIDogcmVzKGh0bWwpXG4gIH1cblxuICAvKipcbiAgICogYC5yZWRpcmVjdCgpYCBjYW4gUmVkaXJlY3QsIGRlZmF1bHQgc3RhdHVzIGNvZGUgaXMgMzAyLlxuICAgKlxuICAgKiBAc2VlIHtAbGluayBodHRwczovL2hvbm8uZGV2L2RvY3MvYXBpL2NvbnRleHQjcmVkaXJlY3R9XG4gICAqXG4gICAqIEBleGFtcGxlXG4gICAqIGBgYHRzXG4gICAqIGFwcC5nZXQoJy9yZWRpcmVjdCcsIChjKSA9PiB7XG4gICAqICAgcmV0dXJuIGMucmVkaXJlY3QoJy8nKVxuICAgKiB9KVxuICAgKiBhcHAuZ2V0KCcvcmVkaXJlY3QtcGVybWFuZW50bHknLCAoYykgPT4ge1xuICAgKiAgIHJldHVybiBjLnJlZGlyZWN0KCcvJywgMzAxKVxuICAgKiB9KVxuICAgKiBgYGBcbiAgICovXG4gIHJlZGlyZWN0ID0gPFQgZXh0ZW5kcyBSZWRpcmVjdFN0YXR1c0NvZGUgPSAzMDI+KFxuICAgIGxvY2F0aW9uOiBzdHJpbmcgfCBVUkwsXG4gICAgc3RhdHVzPzogVFxuICApOiBSZXNwb25zZSAmIFR5cGVkUmVzcG9uc2U8dW5kZWZpbmVkLCBULCAncmVkaXJlY3QnPiA9PiB7XG4gICAgY29uc3QgbG9jYXRpb25TdHJpbmcgPSBTdHJpbmcobG9jYXRpb24pXG4gICAgdGhpcy5oZWFkZXIoXG4gICAgICAnTG9jYXRpb24nLFxuICAgICAgLy8gTXVsdGlieWVzIHNob3VsZCBiZSBlbmNvZGVkXG4gICAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgbm8tY29udHJvbC1yZWdleFxuICAgICAgIS9bXlxceDAwLVxceEZGXS8udGVzdChsb2NhdGlvblN0cmluZykgPyBsb2NhdGlvblN0cmluZyA6IGVuY29kZVVSSShsb2NhdGlvblN0cmluZylcbiAgICApXG4gICAgcmV0dXJuIHRoaXMubmV3UmVzcG9uc2UobnVsbCwgc3RhdHVzID8/IDMwMikgYXMgYW55XG4gIH1cblxuICAvKipcbiAgICogYC5ub3RGb3VuZCgpYCBjYW4gcmV0dXJuIHRoZSBOb3QgRm91bmQgUmVzcG9uc2UuXG4gICAqXG4gICAqIEBzZWUge0BsaW5rIGh0dHBzOi8vaG9uby5kZXYvZG9jcy9hcGkvY29udGV4dCNub3Rmb3VuZH1cbiAgICpcbiAgICogQGV4YW1wbGVcbiAgICogYGBgdHNcbiAgICogYXBwLmdldCgnL25vdGZvdW5kJywgKGMpID0+IHtcbiAgICogICByZXR1cm4gYy5ub3RGb3VuZCgpXG4gICAqIH0pXG4gICAqIGBgYFxuICAgKi9cbiAgbm90Rm91bmQgPSAoKTogUmV0dXJuVHlwZTxOb3RGb3VuZEhhbmRsZXI+ID0+IHtcbiAgICB0aGlzLiNub3RGb3VuZEhhbmRsZXIgPz89ICgpID0+IGNyZWF0ZVJlc3BvbnNlSW5zdGFuY2UoKVxuICAgIHJldHVybiB0aGlzLiNub3RGb3VuZEhhbmRsZXIodGhpcylcbiAgfVxufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLFNBQVMsV0FBVyxRQUFRLGVBQWM7QUFZMUMsU0FBUyx3QkFBd0IsRUFBRSxlQUFlLFFBQVEsa0JBQWlCO0FBMFEzRSxPQUFPLE1BQU0sYUFBYSw0QkFBMkI7QUFFckQsTUFBTSx3QkFBd0IsQ0FBQyxhQUFxQjtFQUNsRCxPQUFPO0lBQ0wsZ0JBQWdCO0lBQ2hCLEdBQUcsT0FBTztFQUNaO0FBQ0Y7QUFFQSxNQUFNLHlCQUF5QixDQUM3QixNQUNBLE9BQ2EsSUFBSSxTQUFTLE1BQU07QUFFbEMsT0FBTyxNQUFNO0VBT1gsQ0FBQSxVQUFXLENBQVM7RUFDcEIsQ0FBQSxHQUFJLENBQXNDO0VBQzFDOzs7Ozs7Ozs7Ozs7R0FZ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
// denoCacheMetadata=3425666199559039583,13324519247567543378