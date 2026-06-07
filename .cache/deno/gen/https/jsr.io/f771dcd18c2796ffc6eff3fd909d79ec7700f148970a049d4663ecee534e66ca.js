/* eslint-disable @typescript-eslint/no-explicit-any */ import { HTTPException } from './http-exception.ts';
import { GET_MATCH_RESULT } from './request/constants.ts';
import { parseBody } from './utils/body.ts';
import { decodeURIComponent_, getQueryParam, getQueryParams, tryDecode } from './utils/url.ts';
const tryDecodeURIComponent = (str)=>tryDecode(str, decodeURIComponent_);
export class HonoRequest {
  /**
   * `.raw` can get the raw Request object.
   *
   * @see {@link https://hono.dev/docs/api/request#raw}
   *
   * @example
   * ```ts
   * // For Cloudflare Workers
   * app.post('/', async (c) => {
   *   const metadata = c.req.raw.cf?.hostMetadata?
   *   ...
   * })
   * ```
   */ raw;
  #validatedData;
  #matchResult;
  routeIndex = 0;
  /**
   * `.path` can get the pathname of the request.
   *
   * @see {@link https://hono.dev/docs/api/request#path}
   *
   * @example
   * ```ts
   * app.get('/about/me', (c) => {
   *   const pathname = c.req.path // `/about/me`
   * })
   * ```
   */ path;
  bodyCache = {};
  constructor(request, path = '/', matchResult = [
    []
  ]){
    this.raw = request;
    this.path = path;
    this.#matchResult = matchResult;
    this.#validatedData = {};
  }
  param(key) {
    return key ? this.#getDecodedParam(key) : this.#getAllDecodedParams();
  }
  #getDecodedParam(key) {
    const paramKey = this.#matchResult[0][this.routeIndex][1][key];
    const param = this.#getParamValue(paramKey);
    return param && /\%/.test(param) ? tryDecodeURIComponent(param) : param;
  }
  #getAllDecodedParams() {
    const decoded = {};
    const keys = Object.keys(this.#matchResult[0][this.routeIndex][1]);
    for (const key of keys){
      const value = this.#getParamValue(this.#matchResult[0][this.routeIndex][1][key]);
      if (value !== undefined) {
        decoded[key] = /\%/.test(value) ? tryDecodeURIComponent(value) : value;
      }
    }
    return decoded;
  }
  #getParamValue(paramKey) {
    return this.#matchResult[1] ? this.#matchResult[1][paramKey] : paramKey;
  }
  query(key) {
    return getQueryParam(this.url, key);
  }
  queries(key) {
    return getQueryParams(this.url, key);
  }
  header(name) {
    if (name) {
      return this.raw.headers.get(name) ?? undefined;
    }
    const headerData = {};
    this.raw.headers.forEach((value, key)=>{
      headerData[key] = value;
    });
    return headerData;
  }
  async parseBody(options) {
    return parseBody(this, options);
  }
  #cachedBody = (key)=>{
    const { bodyCache, raw } = this;
    const cachedBody = bodyCache[key];
    if (cachedBody) {
      return cachedBody;
    }
    const anyCachedKey = Object.keys(bodyCache)[0];
    if (anyCachedKey) {
      return bodyCache[anyCachedKey].then((body)=>{
        if (anyCachedKey === 'json') {
          body = JSON.stringify(body);
        }
        return new Response(body)[key]();
      });
    }
    return bodyCache[key] = raw[key]();
  };
  /**
   * `.json()` can parse Request body of type `application/json`
   *
   * @see {@link https://hono.dev/docs/api/request#json}
   *
   * @example
   * ```ts
   * app.post('/entry', async (c) => {
   *   const body = await c.req.json()
   * })
   * ```
   */ json() {
    return this.#cachedBody('text').then((text)=>JSON.parse(text));
  }
  /**
   * `.text()` can parse Request body of type `text/plain`
   *
   * @see {@link https://hono.dev/docs/api/request#text}
   *
   * @example
   * ```ts
   * app.post('/entry', async (c) => {
   *   const body = await c.req.text()
   * })
   * ```
   */ text() {
    return this.#cachedBody('text');
  }
  /**
   * `.arrayBuffer()` parse Request body as an `ArrayBuffer`
   *
   * @see {@link https://hono.dev/docs/api/request#arraybuffer}
   *
   * @example
   * ```ts
   * app.post('/entry', async (c) => {
   *   const body = await c.req.arrayBuffer()
   * })
   * ```
   */ arrayBuffer() {
    return this.#cachedBody('arrayBuffer');
  }
  /**
   * `.bytes()` parses the request body as a `Uint8Array`.
   *
   * @see {@link https://hono.dev/docs/api/request#bytes}
   *
   * @example
   * ```ts
   * app.post('/entry', async (c) => {
   *   const body = await c.req.bytes()
   * })
   * ```
   */ bytes() {
    return this.#cachedBody('arrayBuffer').then((buffer)=>new Uint8Array(buffer));
  }
  /**
   * Parses the request body as a `Blob`.
   * @example
   * ```ts
   * app.post('/entry', async (c) => {
   *   const body = await c.req.blob();
   * });
   * ```
   * @see https://hono.dev/docs/api/request#blob
   */ blob() {
    return this.#cachedBody('blob');
  }
  /**
   * Parses the request body as `FormData`.
   * @example
   * ```ts
   * app.post('/entry', async (c) => {
   *   const body = await c.req.formData();
   * });
   * ```
   * @see https://hono.dev/docs/api/request#formdata
   */ formData() {
    return this.#cachedBody('formData');
  }
  /**
   * Adds validated data to the request.
   *
   * @param target - The target of the validation.
   * @param data - The validated data to add.
   */ addValidatedData(target, data) {
    this.#validatedData[target] = data;
  }
  valid(target) {
    return this.#validatedData[target];
  }
  /**
   * `.url()` can get the request url strings.
   *
   * @see {@link https://hono.dev/docs/api/request#url}
   *
   * @example
   * ```ts
   * app.get('/about/me', (c) => {
   *   const url = c.req.url // `http://localhost:8787/about/me`
   *   ...
   * })
   * ```
   */ get url() {
    return this.raw.url;
  }
  /**
   * `.method()` can get the method name of the request.
   *
   * @see {@link https://hono.dev/docs/api/request#method}
   *
   * @example
   * ```ts
   * app.get('/about/me', (c) => {
   *   const method = c.req.method // `GET`
   * })
   * ```
   */ get method() {
    return this.raw.method;
  }
  get [GET_MATCH_RESULT]() {
    return this.#matchResult;
  }
  /**
   * `.matchedRoutes()` can return a matched route in the handler
   *
   * @deprecated
   *
   * Use matchedRoutes helper defined in "hono/route" instead.
   *
   * @see {@link https://hono.dev/docs/api/request#matchedroutes}
   *
   * @example
   * ```ts
   * app.use('*', async function logger(c, next) {
   *   await next()
   *   c.req.matchedRoutes.forEach(({ handler, method, path }, i) => {
   *     const name = handler.name || (handler.length < 2 ? '[handler]' : '[middleware]')
   *     console.log(
   *       method,
   *       ' ',
   *       path,
   *       ' '.repeat(Math.max(10 - path.length, 0)),
   *       name,
   *       i === c.req.routeIndex ? '<- respond from here' : ''
   *     )
   *   })
   * })
   * ```
   */ get matchedRoutes() {
    return this.#matchResult[0].map(([[, route]])=>route);
  }
  /**
   * `routePath()` can retrieve the path registered within the handler
   *
   * @deprecated
   *
   * Use routePath helper defined in "hono/route" instead.
   *
   * @see {@link https://hono.dev/docs/api/request#routepath}
   *
   * @example
   * ```ts
   * app.get('/posts/:id', (c) => {
   *   return c.json({ path: c.req.routePath })
   * })
   * ```
   */ get routePath() {
    return this.#matchResult[0].map(([[, route]])=>route)[this.routeIndex].path;
  }
}
/**
 * Clones a HonoRequest's underlying raw Request object.
 *
 * This utility handles both consumed and unconsumed request bodies:
 * - If the request body hasn't been consumed, it uses the native `clone()` method
 * - If the request body has been consumed, it reconstructs a new Request using cached body data
 *
 * This is particularly useful when you need to:
 * - Process the same request body multiple times
 * - Pass requests to external services after validation
 *
 * @param req - The HonoRequest object to clone
 * @returns A Promise that resolves to a new Request object with the same properties
 * @throws {HTTPException} If the request body was consumed directly via `req.raw`
 *   without using HonoRequest methods (e.g., `req.json()`, `req.text()`), making it
 *   impossible to reconstruct the body from cache
 *
 * @example
 * ```ts
 * // Clone after consuming the body (e.g., after validation)
 * app.post('/forward',
 *   validator('json', (data) => data),
 *   async (c) => {
 *     const validated = c.req.valid('json')
 *     // Body has been consumed, but cloneRawRequest still works
 *     const clonedReq = await cloneRawRequest(c.req)
 *     return fetch('http://backend-service.com', clonedReq)
 *   }
 * )
 * ```
 */ export const cloneRawRequest = async (req)=>{
  if (!req.raw.bodyUsed) {
    return req.raw.clone();
  }
  const cacheKey = Object.keys(req.bodyCache)[0];
  if (!cacheKey) {
    throw new HTTPException(500, {
      message: 'Cannot clone request: body was already consumed and not cached. Please use HonoRequest methods (e.g., req.json(), req.text()) instead of consuming req.raw directly.'
    });
  }
  const requestInit = {
    body: await req[cacheKey](),
    cache: req.raw.cache,
    credentials: req.raw.credentials,
    headers: req.header(),
    integrity: req.raw.integrity,
    keepalive: req.raw.keepalive,
    method: req.method,
    mode: req.raw.mode,
    redirect: req.raw.redirect,
    referrer: req.raw.referrer,
    referrerPolicy: req.raw.referrerPolicy,
    signal: req.raw.signal
  };
  return new Request(req.url, requestInit);
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0Bob25vL2hvbm8vNC4xMi4yMy9zcmMvcmVxdWVzdC50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKiBlc2xpbnQtZGlzYWJsZSBAdHlwZXNjcmlwdC1lc2xpbnQvbm8tZXhwbGljaXQtYW55ICovXG5pbXBvcnQgeyBIVFRQRXhjZXB0aW9uIH0gZnJvbSAnLi9odHRwLWV4Y2VwdGlvbi50cydcbmltcG9ydCB7IEdFVF9NQVRDSF9SRVNVTFQgfSBmcm9tICcuL3JlcXVlc3QvY29uc3RhbnRzLnRzJ1xuaW1wb3J0IHR5cGUgeyBSZXN1bHQgfSBmcm9tICcuL3JvdXRlci50cydcbmltcG9ydCB0eXBlIHtcbiAgSW5wdXQsXG4gIElucHV0VG9EYXRhQnlUYXJnZXQsXG4gIFBhcmFtS2V5VG9SZWNvcmQsXG4gIFBhcmFtS2V5cyxcbiAgUmVtb3ZlUXVlc3Rpb24sXG4gIFJvdXRlclJvdXRlLFxuICBWYWxpZGF0aW9uVGFyZ2V0cyxcbn0gZnJvbSAnLi90eXBlcy50cydcbmltcG9ydCB7IHBhcnNlQm9keSB9IGZyb20gJy4vdXRpbHMvYm9keS50cydcbmltcG9ydCB0eXBlIHsgQm9keURhdGEsIFBhcnNlQm9keU9wdGlvbnMgfSBmcm9tICcuL3V0aWxzL2JvZHkudHMnXG5pbXBvcnQgdHlwZSB7IEN1c3RvbUhlYWRlciwgUmVxdWVzdEhlYWRlciB9IGZyb20gJy4vdXRpbHMvaGVhZGVycy50cydcbmltcG9ydCB0eXBlIHsgU2ltcGxpZnksIFVuaW9uVG9JbnRlcnNlY3Rpb24gfSBmcm9tICcuL3V0aWxzL3R5cGVzLnRzJ1xuaW1wb3J0IHsgZGVjb2RlVVJJQ29tcG9uZW50XywgZ2V0UXVlcnlQYXJhbSwgZ2V0UXVlcnlQYXJhbXMsIHRyeURlY29kZSB9IGZyb20gJy4vdXRpbHMvdXJsLnRzJ1xuXG50eXBlIEJvZHkgPSB7XG4gIGpzb246IGFueVxuICB0ZXh0OiBzdHJpbmdcbiAgYXJyYXlCdWZmZXI6IEFycmF5QnVmZmVyXG4gIGJsb2I6IEJsb2JcbiAgZm9ybURhdGE6IEZvcm1EYXRhXG59XG50eXBlIEJvZHlDYWNoZSA9IFBhcnRpYWw8Qm9keT5cblxudHlwZSBPcHRpb25hbFJlcXVlc3RJbml0UHJvcGVydGllcyA9ICd3aW5kb3cnIHwgJ3ByaW9yaXR5J1xudHlwZSBSZXF1aXJlZFJlcXVlc3RJbml0ID0gUmVxdWlyZWQ8T21pdDxSZXF1ZXN0SW5pdCwgT3B0aW9uYWxSZXF1ZXN0SW5pdFByb3BlcnRpZXM+PiAmIHtcbiAgW0tleSBpbiBPcHRpb25hbFJlcXVlc3RJbml0UHJvcGVydGllc10/OiBSZXF1ZXN0SW5pdFtLZXldXG59XG5cbmNvbnN0IHRyeURlY29kZVVSSUNvbXBvbmVudCA9IChzdHI6IHN0cmluZykgPT4gdHJ5RGVjb2RlKHN0ciwgZGVjb2RlVVJJQ29tcG9uZW50XylcblxuZXhwb3J0IGNsYXNzIEhvbm9SZXF1ZXN0PFAgZXh0ZW5kcyBzdHJpbmcgPSAnLycsIEkgZXh0ZW5kcyBJbnB1dFsnb3V0J10gPSB7fT4ge1xuICAvKipcbiAgICogYC5yYXdgIGNhbiBnZXQgdGhlIHJhdyBSZXF1ZXN0IG9iamVjdC5cbiAgICpcbiAgICogQHNlZSB7QGxpbmsgaHR0cHM6Ly9ob25vLmRldi9kb2NzL2FwaS9yZXF1ZXN0I3Jhd31cbiAgICpcbiAgICogQGV4YW1wbGVcbiAgICogYGBgdHNcbiAgICogLy8gRm9yIENsb3VkZmxhcmUgV29ya2Vyc1xuICAgKiBhcHAucG9zdCgnLycsIGFzeW5jIChjKSA9PiB7XG4gICAqICAgY29uc3QgbWV0YWRhdGEgPSBjLnJlcS5yYXcuY2Y/Lmhvc3RNZXRhZGF0YT9cbiAgICogICAuLi5cbiAgICogfSlcbiAgICogYGBgXG4gICAqL1xuICByYXc6IFJlcXVlc3RcblxuICAjdmFsaWRhdGVkRGF0YTogeyBbSyBpbiBrZXlvZiBWYWxpZGF0aW9uVGFyZ2V0c10/OiB7fSB9IC8vIFNob3J0IG5hbWUgb2YgdmFsaWRhdGVkRGF0YVxuICAjbWF0Y2hSZXN1bHQ6IFJlc3VsdDxbdW5rbm93biwgUm91dGVyUm91dGVdPlxuICByb3V0ZUluZGV4OiBudW1iZXIgPSAwXG4gIC8qKlxuICAgKiBgLnBhdGhgIGNhbiBnZXQgdGhlIHBhdGhuYW1lIG9mIHRoZSByZXF1ZXN0LlxuICAgKlxuICAgKiBAc2VlIHtAbGluayBodHRwczovL2hvbm8uZGV2L2RvY3MvYXBpL3JlcXVlc3QjcGF0aH1cbiAgICpcbiAgICogQGV4YW1wbGVcbiAgICogYGBgdHNcbiAgICogYXBwLmdldCgnL2Fib3V0L21lJywgKGMpID0+IHtcbiAgICogICBjb25zdCBwYXRobmFtZSA9IGMucmVxLnBhdGggLy8gYC9hYm91dC9tZWBcbiAgICogfSlcbiAgICogYGBgXG4gICAqL1xuICBwYXRoOiBzdHJpbmdcbiAgYm9keUNhY2hlOiBCb2R5Q2FjaGUgPSB7fVxuXG4gIGNvbnN0cnVjdG9yKFxuICAgIHJlcXVlc3Q6IFJlcXVlc3QsXG4gICAgcGF0aDogc3RyaW5nID0gJy8nLFxuICAgIG1hdGNoUmVzdWx0OiBSZXN1bHQ8W3Vua25vd24sIFJvdXRlclJvdXRlXT4gPSBbW11dXG4gICkge1xuICAgIHRoaXMucmF3ID0gcmVxdWVzdFxuICAgIHRoaXMucGF0aCA9IHBhdGhcbiAgICB0aGlzLiNtYXRjaFJlc3VsdCA9IG1hdGNoUmVzdWx0XG4gICAgdGhpcy4jdmFsaWRhdGVkRGF0YSA9IHt9XG4gIH1cblxuICAvKipcbiAgICogYC5yZXEucGFyYW0oKWAgZ2V0cyB0aGUgcGF0aCBwYXJhbWV0ZXJzLlxuICAgKlxuICAgKiBAc2VlIHtAbGluayBodHRwczovL2hvbm8uZGV2L2RvY3MvYXBpL3JvdXRpbmcjcGF0aC1wYXJhbWV0ZXJ9XG4gICAqXG4gICAqIEBleGFtcGxlXG4gICAqIGBgYHRzXG4gICAqIGNvbnN0IG5hbWUgPSBjLnJlcS5wYXJhbSgnbmFtZScpXG4gICAqIC8vIG9yIGFsbCBwYXJhbWV0ZXJzIGF0IG9uY2VcbiAgICogY29uc3QgeyBpZCwgY29tbWVudF9pZCB9ID0gYy5yZXEucGFyYW0oKVxuICAgKiBgYGBcbiAgICovXG4gIHBhcmFtPFAyIGV4dGVuZHMgUGFyYW1LZXlzPFA+ID0gUGFyYW1LZXlzPFA+PihcbiAgICBrZXk6IHN0cmluZyBleHRlbmRzIFAgPyBuZXZlciA6IFAyIGV4dGVuZHMgYCR7aW5mZXIgX30/YCA/IG5ldmVyIDogUDJcbiAgKTogc3RyaW5nXG4gIHBhcmFtPFAyIGV4dGVuZHMgUmVtb3ZlUXVlc3Rpb248UGFyYW1LZXlzPFA+PiA9IFJlbW92ZVF1ZXN0aW9uPFBhcmFtS2V5czxQPj4+KFxuICAgIGtleTogUDJcbiAgKTogc3RyaW5nIHwgdW5kZWZpbmVkXG4gIHBhcmFtKGtleTogc3RyaW5nKTogc3RyaW5nIHwgdW5kZWZpbmVkXG4gIHBhcmFtPFAyIGV4dGVuZHMgc3RyaW5nID0gUD4oKTogU2ltcGxpZnk8VW5pb25Ub0ludGVyc2VjdGlvbjxQYXJhbUtleVRvUmVjb3JkPFBhcmFtS2V5czxQMj4+Pj5cbiAgcGFyYW0oa2V5Pzogc3RyaW5nKTogdW5rbm93biB7XG4gICAgcmV0dXJuIGtleSA/IHRoaXMuI2dldERlY29kZWRQYXJhbShrZXkpIDogdGhpcy4jZ2V0QWxsRGVjb2RlZFBhcmFtcygpXG4gIH1cblxuICAjZ2V0RGVjb2RlZFBhcmFtKGtleTogc3RyaW5nKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgICBjb25zdCBwYXJhbUtleSA9IHRoaXMuI21hdGNoUmVzdWx0WzBdW3RoaXMucm91dGVJbmRleF1bMV1ba2V5XVxuICAgIGNvbnN0IHBhcmFtID0gdGhpcy4jZ2V0UGFyYW1WYWx1ZShwYXJhbUtleSlcbiAgICByZXR1cm4gcGFyYW0gJiYgL1xcJS8udGVzdChwYXJhbSkgPyB0cnlEZWNvZGVVUklDb21wb25lbnQocGFyYW0pIDogcGFyYW1cbiAgfVxuXG4gICNnZXRBbGxEZWNvZGVkUGFyYW1zKCk6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4ge1xuICAgIGNvbnN0IGRlY29kZWQ6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fVxuXG4gICAgY29uc3Qga2V5cyA9IE9iamVjdC5rZXlzKHRoaXMuI21hdGNoUmVzdWx0WzBdW3RoaXMucm91dGVJbmRleF1bMV0pXG4gICAgZm9yIChjb25zdCBrZXkgb2Yga2V5cykge1xuICAgICAgY29uc3QgdmFsdWUgPSB0aGlzLiNnZXRQYXJhbVZhbHVlKHRoaXMuI21hdGNoUmVzdWx0WzBdW3RoaXMucm91dGVJbmRleF1bMV1ba2V5XSlcbiAgICAgIGlmICh2YWx1ZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIGRlY29kZWRba2V5XSA9IC9cXCUvLnRlc3QodmFsdWUpID8gdHJ5RGVjb2RlVVJJQ29tcG9uZW50KHZhbHVlKSA6IHZhbHVlXG4gICAgICB9XG4gICAgfVxuXG4gICAgcmV0dXJuIGRlY29kZWRcbiAgfVxuXG4gICNnZXRQYXJhbVZhbHVlKHBhcmFtS2V5OiBhbnkpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICAgIHJldHVybiB0aGlzLiNtYXRjaFJlc3VsdFsxXSA/IHRoaXMuI21hdGNoUmVzdWx0WzFdW3BhcmFtS2V5IGFzIGFueV0gOiBwYXJhbUtleVxuICB9XG5cbiAgLyoqXG4gICAqIGAucXVlcnkoKWAgY2FuIGdldCBxdWVyeXN0cmluZyBwYXJhbWV0ZXJzLlxuICAgKlxuICAgKiBAc2VlIHtAbGluayBodHRwczovL2hvbm8uZGV2L2RvY3MvYXBpL3JlcXVlc3QjcXVlcnl9XG4gICAqXG4gICAqIEBleGFtcGxlXG4gICAqIGBgYHRzXG4gICAqIC8vIFF1ZXJ5IHBhcmFtc1xuICAgKiBhcHAuZ2V0KCcvc2VhcmNoJywgKGMpID0+IHtcbiAgICogICBjb25zdCBxdWVyeSA9IGMucmVxLnF1ZXJ5KCdxJylcbiAgICogfSlcbiAgICpcbiAgICogLy8gR2V0IGFsbCBwYXJhbXMgYXQgb25jZVxuICAgKiBhcHAuZ2V0KCcvc2VhcmNoJywgKGMpID0+IHtcbiAgICogICBjb25zdCB7IHEsIGxpbWl0LCBvZmZzZXQgfSA9IGMucmVxLnF1ZXJ5KClcbiAgICogfSlcbiAgICogYGBgXG4gICAqL1xuICBxdWVyeShrZXk6IHN0cmluZyk6IHN0cmluZyB8IHVuZGVmaW5lZFxuICBxdWVyeSgpOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+XG4gIHF1ZXJ5KGtleT86IHN0cmluZykge1xuICAgIHJldHVybiBnZXRRdWVyeVBhcmFtKHRoaXMudXJsLCBrZXkpXG4gIH1cblxuICAvKipcbiAgICogYC5xdWVyaWVzKClgIGNhbiBnZXQgbXVsdGlwbGUgcXVlcnlzdHJpbmcgcGFyYW1ldGVyIHZhbHVlcywgZS5nLiAvc2VhcmNoP3RhZ3M9QSZ0YWdzPUJcbiAgICpcbiAgICogQHNlZSB7QGxpbmsgaHR0cHM6Ly9ob25vLmRldi9kb2NzL2FwaS9yZXF1ZXN0I3F1ZXJpZXN9XG4gICAqXG4gICAqIEBleGFtcGxlXG4gICAqIGBgYHRzXG4gICAqIGFwcC5nZXQoJy9zZWFyY2gnLCAoYykgPT4ge1xuICAgKiAgIC8vIHRhZ3Mgd2lsbCBiZSBzdHJpbmdbXVxuICAgKiAgIGNvbnN0IHRhZ3MgPSBjLnJlcS5xdWVyaWVzKCd0YWdzJylcbiAgICogfSlcbiAgICogYGBgXG4gICAqL1xuICBxdWVyaWVzKGtleTogc3RyaW5nKTogc3RyaW5nW10gfCB1bmRlZmluZWRcbiAgcXVlcmllcygpOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmdbXT5cbiAgcXVlcmllcyhrZXk/OiBzdHJpbmcpIHtcbiAgICByZXR1cm4gZ2V0UXVlcnlQYXJhbXModGhpcy51cmwsIGtleSlcbiAgfVxuXG4gIC8qKlxuICAgKiBgLmhlYWRlcigpYCBjYW4gZ2V0IHRoZSByZXF1ZXN0IGhlYWRlciB2YWx1ZS5cbiAgICpcbiAgICogQHNlZSB7QGxpbmsgaHR0cHM6Ly9ob25vLmRldi9kb2NzL2FwaS9yZXF1ZXN0I2hlYWRlcn1cbiAgICpcbiAgICogQGV4YW1wbGVcbiAgICogYGBgdHNcbiAgICogYXBwLmdldCgnLycsIChjKSA9PiB7XG4gICAqICAgY29uc3QgdXNlckFnZW50ID0gYy5yZXEuaGVhZGVyKCdVc2VyLUFnZW50JylcbiAgICogfSlcbiAgICogYGBgXG4gICAqL1xuICBoZWFkZXIobmFtZTogUmVxdWVzdEhlYWRlcik6IHN0cmluZyB8IHVuZGVmaW5lZFxuICBoZWFkZXIobmFtZTogc3RyaW5nKTogc3RyaW5nIHwgdW5kZWZpbmVkXG4gIGhlYWRlcigpOiBSZWNvcmQ8UmVxdWVzdEhlYWRlciB8IChzdHJpbmcgJiBDdXN0b21IZWFkZXIpLCBzdHJpbmc+XG4gIGhlYWRlcihuYW1lPzogc3RyaW5nKSB7XG4gICAgaWYgKG5hbWUpIHtcbiAgICAgIHJldHVybiB0aGlzLnJhdy5oZWFkZXJzLmdldChuYW1lKSA/PyB1bmRlZmluZWRcbiAgICB9XG5cbiAgICBjb25zdCBoZWFkZXJEYXRhOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCB1bmRlZmluZWQ+ID0ge31cbiAgICB0aGlzLnJhdy5oZWFkZXJzLmZvckVhY2goKHZhbHVlLCBrZXkpID0+IHtcbiAgICAgIGhlYWRlckRhdGFba2V5XSA9IHZhbHVlXG4gICAgfSlcbiAgICByZXR1cm4gaGVhZGVyRGF0YVxuICB9XG5cbiAgLyoqXG4gICAqIGAucGFyc2VCb2R5KClgIGNhbiBwYXJzZSBSZXF1ZXN0IGJvZHkgb2YgdHlwZSBgbXVsdGlwYXJ0L2Zvcm0tZGF0YWAgb3IgYGFwcGxpY2F0aW9uL3gtd3d3LWZvcm0tdXJsZW5jb2RlZGBcbiAgICpcbiAgICogQHNlZSB7QGxpbmsgaHR0cHM6Ly9ob25vLmRldi9kb2NzL2FwaS9yZXF1ZXN0I3BhcnNlYm9keX1cbiAgICpcbiAgICogQGV4YW1wbGVcbiAgICogYGBgdHNcbiAgICogYXBwLnBvc3QoJy9lbnRyeScsIGFzeW5jIChjKSA9PiB7XG4gICAqICAgY29uc3QgYm9keSA9IGF3YWl0IGMucmVxLnBhcnNlQm9keSgpXG4gICAqIH0pXG4gICAqIGBgYFxuICAgKi9cbiAgYXN5bmMgcGFyc2VCb2R5PE9wdGlvbnMgZXh0ZW5kcyBQYXJ0aWFsPFBhcnNlQm9keU9wdGlvbnM+LCBUIGV4dGVuZHMgQm9keURhdGE8T3B0aW9ucz4+KFxuICAgIG9wdGlvbnM/OiBPcHRpb25zXG4gICk6IFByb21pc2U8VD5cbiAgYXN5bmMgcGFyc2VCb2R5PFQgZXh0ZW5kcyBCb2R5RGF0YT4ob3B0aW9ucz86IFBhcnRpYWw8UGFyc2VCb2R5T3B0aW9ucz4pOiBQcm9taXNlPFQ+XG4gIGFzeW5jIHBhcnNlQm9keShvcHRpb25zPzogUGFydGlhbDxQYXJzZUJvZHlPcHRpb25zPikge1xuICAgIHJldHVybiBwYXJzZUJvZHkodGhpcywgb3B0aW9ucylcbiAgfVxuXG4gICNjYWNoZWRCb2R5ID0gKGtleToga2V5b2YgQm9keSkgPT4ge1xuICAgIGNvbnN0IHsgYm9keUNhY2hlLCByYXcgfSA9IHRoaXNcbiAgICBjb25zdCBjYWNoZWRCb2R5ID0gYm9keUNhY2hlW2tleV1cblxuICAgIGlmIChjYWNoZWRCb2R5KSB7XG4gICAgICByZXR1cm4gY2FjaGVkQm9keVxuICAgIH1cblxuICAgIGNvbnN0IGFueUNhY2hlZEtleSA9IE9iamVjdC5rZXlzKGJvZHlDYWNoZSlbMF1cbiAgICBpZiAoYW55Q2FjaGVkS2V5KSB7XG4gICAgICByZXR1cm4gKGJvZHlDYWNoZVthbnlDYWNoZWRLZXkgYXMga2V5b2YgQm9keV0gYXMgUHJvbWlzZTxCb2R5SW5pdD4pLnRoZW4oKGJvZHkpID0+IHtcbiAgICAgICAgaWYgKGFueUNhY2hlZEtleSA9PT0gJ2pzb24nKSB7XG4gICAgICAgICAgYm9keSA9IEpTT04uc3RyaW5naWZ5KGJvZHkpXG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIG5ldyBSZXNwb25zZShib2R5KVtrZXldKClcbiAgICAgIH0pXG4gICAgfVxuXG4gICAgcmV0dXJuIChib2R5Q2FjaGVba2V5XSA9IHJhd1trZXldKCkpXG4gIH1cblxuICAvKipcbiAgICogYC5qc29uKClgIGNhbiBwYXJzZSBSZXF1ZXN0IGJvZHkgb2YgdHlwZSBgYXBwbGljYXRpb24vanNvbmBcbiAgICpcbiAgICogQHNlZSB7QGxpbmsgaHR0cHM6Ly9ob25vLmRldi9kb2NzL2FwaS9yZXF1ZXN0I2pzb259XG4gICAqXG4gICAqIEBleGFtcGxlXG4gICAqIGBgYHRzXG4gICAqIGFwcC5wb3N0KCcvZW50cnknLCBhc3luYyAoYykgPT4ge1xuICAgKiAgIGNvbnN0IGJvZHkgPSBhd2FpdCBjLnJlcS5qc29uKClcbiAgICogfSlcbiAgICogYGBgXG4gICAqL1xuICBqc29uPFQgPSBhbnk+KCk6IFByb21pc2U8VD4ge1xuICAgIHJldHVybiB0aGlzLiNjYWNoZWRCb2R5KCd0ZXh0JykudGhlbigodGV4dDogc3RyaW5nKSA9PiBKU09OLnBhcnNlKHRleHQpKVxuICB9XG5cbiAgLyoqXG4gICAqIGAudGV4dCgpYCBjYW4gcGFyc2UgUmVxdWVzdCBib2R5IG9mIHR5cGUgYHRleHQvcGxhaW5gXG4gICAqXG4gICAqIEBzZWUge0BsaW5rIGh0dHBzOi8vaG9uby5kZXYvZG9jcy9hcGkvcmVxdWVzdCN0ZXh0fVxuICAgKlxuICAgKiBAZXhhbXBsZVxuICAgKiBgYGB0c1xuICAgKiBhcHAucG9zdCgnL2VudHJ5JywgYXN5bmMgKGMpID0+IHtcbiAgICogICBjb25zdCBib2R5ID0gYXdhaXQgYy5yZXEudGV4dCgpXG4gICAqIH0pXG4gICAqIGBgYFxuICAgKi9cbiAgdGV4dCgpOiBQcm9taXNlPHN0cmluZz4ge1xuICAgIHJldHVybiB0aGlzLiNjYWNoZWRCb2R5KCd0ZXh0JylcbiAgfVxuXG4gIC8qKlxuICAgKiBgLmFycmF5QnVmZmVyKClgIHBhcnNlIFJlcXVlc3QgYm9keSBhcyBhbiBgQXJyYXlCdWZmZXJgXG4gICAqXG4gICAqIEBzZWUge0BsaW5rIGh0dHBzOi8vaG9uby5kZXYvZG9jcy9hcGkvcmVxdWVzdCNhcnJheWJ1ZmZlcn1cbiAgICpcbiAgICogQGV4YW1wbGVcbiAgICogYGBgdHNcbiAgICogYXBwLnBvc3QoJy9lbnRyeScsIGFzeW5jIChjKSA9PiB7XG4gICAqICAgY29uc3QgYm9keSA9IGF3YWl0IGMucmVxLmFycmF5QnVmZmVyKClcbiAgICogfSlcbiAgICogYGBgXG4gICAqL1xuICBhcnJheUJ1ZmZlcigpOiBQcm9taXNlPEFycmF5QnVmZmVyPiB7XG4gICAgcmV0dXJuIHRoaXMuI2NhY2hlZEJvZHkoJ2FycmF5QnVmZmVyJylcbiAgfVxuXG4gIC8qKlxuICAgKiBgLmJ5dGVzKClgIHBhcnNlcyB0aGUgcmVxdWVzdCBib2R5IGFzIGEgYFVpbnQ4QXJyYXlgLlxuICAgKlxuICAgKiBAc2VlIHtAbGluayBodHRwczovL2hvbm8uZGV2L2RvY3MvYXBpL3JlcXVlc3QjYnl0ZXN9XG4gICAqXG4gICAqIEBleGFtcGxlXG4gICAqIGBgYHRzXG4gICAqIGFwcC5wb3N0KCcvZW50cnknLCBhc3luYyAoYykgPT4ge1xuICAgKiAgIGNvbnN0IGJvZHkgPSBhd2FpdCBjLnJlcS5ieXRlcygpXG4gICAqIH0pXG4gICAqIGBgYFxuICAgKi9cbiAgYnl0ZXMoKTogUHJvbWlzZTxVaW50OEFycmF5PiB7XG4gICAgcmV0dXJuIHRoaXMuI2NhY2hlZEJvZHkoJ2FycmF5QnVmZmVyJykudGhlbigoYnVmZmVyOiBBcnJheUJ1ZmZlcikgPT4gbmV3IFVpbnQ4QXJyYXkoYnVmZmVyKSlcbiAgfVxuXG4gIC8qKlxuICAgKiBQYXJzZXMgdGhlIHJlcXVlc3QgYm9keSBhcyBhIGBCbG9iYC5cbiAgICogQGV4YW1wbGVcbiAgICogYGBgdHNcbiAgICogYXBwLnBvc3QoJy9lbnRyeScsIGFzeW5jIChjKSA9PiB7XG4gICAqICAgY29uc3QgYm9keSA9IGF3YWl0IGMucmVxLmJsb2IoKTtcbiAgICogfSk7XG4gICAqIGBgYFxuICAgKiBAc2VlIGh0dHBzOi8vaG9uby5kZXYvZG9jcy9hcGkvcmVxdWVzdCNibG9iXG4gICAqL1xuICBibG9iKCk6IFByb21pc2U8QmxvYj4ge1xuICAgIHJldHVybiB0aGlzLiNjYWNoZWRCb2R5KCdibG9iJylcbiAgfVxuXG4gIC8qKlxuICAgKiBQYXJzZXMgdGhlIHJlcXVlc3QgYm9keSBhcyBgRm9ybURhdGFgLlxuICAgKiBAZXhhbXBsZVxuICAgKiBgYGB0c1xuICAgKiBhcHAucG9zdCgnL2VudHJ5JywgYXN5bmMgKGMpID0+IHtcbiAgICogICBjb25zdCBib2R5ID0gYXdhaXQgYy5yZXEuZm9ybURhdGEoKTtcbiAgICogfSk7XG4gICAqIGBgYFxuICAgKiBAc2VlIGh0dHBzOi8vaG9uby5kZXYvZG9jcy9hcGkvcmVxdWVzdCNmb3JtZGF0YVxuICAgKi9cbiAgZm9ybURhdGEoKTogUHJvbWlzZTxGb3JtRGF0YT4ge1xuICAgIHJldHVybiB0aGlzLiNjYWNoZWRCb2R5KCdmb3JtRGF0YScpXG4gIH1cblxuICAvKipcbiAgICogQWRkcyB2YWxpZGF0ZWQgZGF0YSB0byB0aGUgcmVxdWVzdC5cbiAgICpcbiAgICogQHBhcmFtIHRhcmdldCAtIFRoZSB0YXJnZXQgb2YgdGhlIHZhbGlkYXRpb24uXG4gICAqIEBwYXJhbSBkYXRhIC0gVGhlIHZhbGlkYXRlZCBkYXRhIHRvIGFkZC5cbiAgICovXG4gIGFkZFZhbGlkYXRlZERhdGEodGFyZ2V0OiBrZXlvZiBWYWxpZGF0aW9uVGFyZ2V0cywgZGF0YToge30pIHtcbiAgICB0aGlzLiN2YWxpZGF0ZWREYXRhW3RhcmdldF0gPSBkYXRhXG4gIH1cblxuICAvKipcbiAgICogR2V0cyB2YWxpZGF0ZWQgZGF0YSBmcm9tIHRoZSByZXF1ZXN0LlxuICAgKlxuICAgKiBAcGFyYW0gdGFyZ2V0IC0gVGhlIHRhcmdldCBvZiB0aGUgdmFsaWRhdGlvbi5cbiAgICogQHJldHVybnMgVGhlIHZhbGlkYXRlZCBkYXRhLlxuICAgKlxuICAgKiBAc2VlIGh0dHBzOi8vaG9uby5kZXYvZG9jcy9hcGkvcmVxdWVzdCN2YWxpZFxuICAgKi9cbiAgdmFsaWQ8VCBleHRlbmRzIGtleW9mIEkgJiBrZXlvZiBWYWxpZGF0aW9uVGFyZ2V0cz4odGFyZ2V0OiBUKTogSW5wdXRUb0RhdGFCeVRhcmdldDxJLCBUPlxuICB2YWxpZCh0YXJnZXQ6IGtleW9mIFZhbGlkYXRpb25UYXJnZXRzKSB7XG4gICAgcmV0dXJuIHRoaXMuI3ZhbGlkYXRlZERhdGFbdGFyZ2V0XSBhcyB1bmtub3duXG4gIH1cblxuICAvKipcbiAgICogYC51cmwoKWAgY2FuIGdldCB0aGUgcmVxdWVzdCB1cmwgc3RyaW5ncy5cbiAgICpcbiAgICogQHNlZSB7QGxpbmsgaHR0cHM6Ly9ob25vLmRldi9kb2NzL2FwaS9yZXF1ZXN0I3VybH1cbiAgICpcbiAgICogQGV4YW1wbGVcbiAgICogYGBgdHNcbiAgICogYXBwLmdldCgnL2Fib3V0L21lJywgKGMpID0+IHtcbiAgICogICBjb25zdCB1cmwgPSBjLnJlcS51cmwgLy8gYGh0dHA6Ly9sb2NhbGhvc3Q6ODc4Ny9hYm91dC9tZWBcbiAgICogICAuLi5cbiAgICogfSlcbiAgICogYGBgXG4gICAqL1xuICBnZXQgdXJsKCk6IHN0cmluZyB7XG4gICAgcmV0dXJuIHRoaXMucmF3LnVybFxuICB9XG5cbiAgLyoqXG4gICAqIGAubWV0aG9kKClgIGNhbiBnZXQgdGhlIG1ldGhvZCBuYW1lIG9mIHRoZSByZXF1ZXN0LlxuICAgKlxuICAgKiBAc2VlIHtAbGluayBodHRwczovL2hvbm8uZGV2L2RvY3MvYXBpL3JlcXVlc3QjbWV0aG9kfVxuICAgKlxuICAgKiBAZXhhbXBsZVxuICAgKiBgYGB0c1xuICAgKiBhcHAuZ2V0KCcvYWJvdXQvbWUnLCAoYykgPT4ge1xuICAgKiAgIGNvbnN0IG1ldGhvZCA9IGMucmVxLm1ldGhvZCAvLyBgR0VUYFxuICAgKiB9KVxuICAgKiBgYGBcbiAgICovXG4gIGdldCBtZXRob2QoKTogc3RyaW5nIHtcbiAgICByZXR1cm4gdGhpcy5yYXcubWV0aG9kXG4gIH1cblxuICBnZXQgW0dFVF9NQVRDSF9SRVNVTFRdKCk6IFJlc3VsdDxbdW5rbm93biwgUm91dGVyUm91dGVdPiB7XG4gICAgcmV0dXJuIHRoaXMuI21hdGNoUmVzdWx0XG4gIH1cblxuICAvKipcbiAgICogYC5tYXRjaGVkUm91dGVzKClgIGNhbiByZXR1cm4gYSBtYXRjaGVkIHJvdXRlIGluIHRoZSBoYW5kbGVyXG4gICAqXG4gICAqIEBkZXByZWNhdGVkXG4gICAqXG4gICAqIFVzZSBtYXRjaGVkUm91dGVzIGhlbHBlciBkZWZpbmVkIGluIFwiaG9uby9yb3V0ZVwiIGluc3RlYWQuXG4gICAqXG4gICAqIEBzZWUge0BsaW5rIGh0dHBzOi8vaG9uby5kZXYvZG9jcy9hcGkvcmVxdWVzdCNtYXRjaGVkcm91dGVzfVxuICAgKlxuICAgKiBAZXhhbXBsZVxuICAgKiBgYGB0c1xuICAgKiBhcHAudXNlKCcqJywgYXN5bmMgZnVuY3Rpb24gbG9nZ2VyKGMsIG5leHQpIHtcbiAgICogICBhd2FpdCBuZXh0KClcbiAgICogICBjLnJlcS5tYXRjaGVkUm91dGVzLmZvckVhY2goKHsgaGFuZGxlciwgbWV0aG9kLCBwYXRoIH0sIGkpID0+IHtcbiAgICogICAgIGNvbnN0IG5hbWUgPSBoYW5kbGVyLm5hbWUgfHwgKGhhbmRsZXIubGVuZ3RoIDwgMiA/ICdbaGFuZGxlcl0nIDogJ1ttaWRkbGV3YXJlXScpXG4gICAqICAgICBjb25zb2xlLmxvZyhcbiAgICogICAgICAgbWV0aG9kLFxuICAgKiAgICAgICAnICcsXG4gICAqICAgICAgIHBhdGgsXG4gICAqICAgICAgICcgJy5yZXBlYXQoTWF0aC5tYXgoMTAgLSBwYXRoLmxlbmd0aCwgMCkpLFxuICAgKiAgICAgICBuYW1lLFxuICAgKiAgICAgICBpID09PSBjLnJlcS5yb3V0ZUluZGV4ID8gJzwtIHJlc3BvbmQgZnJvbSBoZXJlJyA6ICcnXG4gICAqICAgICApXG4gICAqICAgfSlcbiAgICogfSlcbiAgICogYGBgXG4gICAqL1xuICBnZXQgbWF0Y2hlZFJvdXRlcygpOiBSb3V0ZXJSb3V0ZVtdIHtcbiAgICByZXR1cm4gdGhpcy4jbWF0Y2hSZXN1bHRbMF0ubWFwKChbWywgcm91dGVdXSkgPT4gcm91dGUpXG4gIH1cblxuICAvKipcbiAgICogYHJvdXRlUGF0aCgpYCBjYW4gcmV0cmlldmUgdGhlIHBhdGggcmVnaXN0ZXJlZCB3aXRoaW4gdGhlIGhhbmRsZXJcbiAgICpcbiAgICogQGRlcHJlY2F0ZWRcbiAgICpcbiAgICogVXNlIHJvdXRlUGF0aCBoZWxwZXIgZGVmaW5lZCBpbiBcImhvbm8vcm91dGVcIiBpbnN0ZWFkLlxuICAgKlxuICAgKiBAc2VlIHtAbGluayBodHRwczovL2hvbm8uZGV2L2RvY3MvYXBpL3JlcXVlc3Qjcm91dGVwYXRofVxuICAgKlxuICAgKiBAZXhhbXBsZVxuICAgKiBgYGB0c1xuICAgKiBhcHAuZ2V0KCcvcG9zdHMvOmlkJywgKGMpID0+IHtcbiAgICogICByZXR1cm4gYy5qc29uKHsgcGF0aDogYy5yZXEucm91dGVQYXRoIH0pXG4gICAqIH0pXG4gICAqIGBgYFxuICAgKi9cbiAgZ2V0IHJvdXRlUGF0aCgpOiBzdHJpbmcge1xuICAgIHJldHVybiB0aGlzLiNtYXRjaFJlc3VsdFswXS5tYXAoKFtbLCByb3V0ZV1dKSA9PiByb3V0ZSlbdGhpcy5yb3V0ZUluZGV4XS5wYXRoXG4gIH1cbn1cblxuLyoqXG4gKiBDbG9uZXMgYSBIb25vUmVxdWVzdCdzIHVuZGVybHlpbmcgcmF3IFJlcXVlc3Qgb2JqZWN0LlxuICpcbiAqIFRoaXMgdXRpbGl0eSBoYW5kbGVzIGJvdGggY29uc3VtZWQgYW5kIHVuY29uc3VtZWQgcmVxdWVzdCBib2RpZXM6XG4gKiAtIElmIHRoZSByZXF1ZXN0IGJvZHkgaGFzbid0IGJlZW4gY29uc3VtZWQsIGl0IHVzZXMgdGhlIG5hdGl2ZSBgY2xvbmUoKWAgbWV0aG9kXG4gKiAtIElmIHRoZSByZXF1ZXN0IGJvZHkgaGFzIGJlZW4gY29uc3VtZWQsIGl0IHJlY29uc3RydWN0cyBhIG5ldyBSZXF1ZXN0IHVzaW5nIGNhY2hlZCBib2R5IGRhdGFcbiAqXG4gKiBUaGlzIGlzIHBhcnRpY3VsYXJseSB1c2VmdWwgd2hlbiB5b3UgbmVlZCB0bzpcbiAqIC0gUHJvY2VzcyB0aGUgc2FtZSByZXF1ZXN0IGJvZHkgbXVsdGlwbGUgdGltZXNcbiAqIC0gUGFzcyByZXF1ZXN0cyB0byBleHRlcm5hbCBzZXJ2aWNlcyBhZnRlciB2YWxpZGF0aW9uXG4gKlxuICogQHBhcmFtIHJlcSAtIFRoZSBIb25vUmVxdWVzdCBvYmplY3QgdG8gY2xvbmVcbiAqIEByZXR1cm5zIEEgUHJvbWlzZSB0aGF0IHJlc29sdmVzIHRvIGEgbmV3IFJlcXVlc3Qgb2JqZWN0IHdpdGggdGhlIHNhbWUgcHJvcGVydGllc1xuICogQHRocm93cyB7SFRUUEV4Y2VwdGlvbn0gSWYgdGhlIHJlcXVlc3QgYm9keSB3YXMgY29uc3VtZWQgZGlyZWN0bHkgdmlhIGByZXEucmF3YFxuICogICB3aXRob3V0IHVzaW5nIEhvbm9SZXF1ZXN0IG1ldGhvZHMgKGUuZy4sIGByZXEuanNvbigpYCwgYHJlcS50ZXh0KClgKSwgbWFraW5nIGl0XG4gKiAgIGltcG9zc2libGUgdG8gcmVjb25zdHJ1Y3QgdGhlIGJvZHkgZnJvbSBjYWNoZVxuICpcbiAqIEBleGFtcGxlXG4gKiBgYGB0c1xuICogLy8gQ2xvbmUgYWZ0ZXIgY29uc3VtaW5nIHRoZSBib2R5IChlLmcuLCBhZnRlciB2YWxpZGF0aW9uKVxuICogYXBwLnBvc3QoJy9mb3J3YXJkJyxcbiAqICAgdmFsaWRhdG9yKCdqc29uJywgKGRhdGEpID0+IGRhdGEpLFxuICogICBhc3luYyAoYykgPT4ge1xuICogICAgIGNvbnN0IHZhbGlkYXRlZCA9IGMucmVxLnZhbGlkKCdqc29uJylcbiAqICAgICAvLyBCb2R5IGhhcyBiZWVuIGNvbnN1bWVkLCBidXQgY2xvbmVSYXdSZXF1ZXN0IHN0aWxsIHdvcmtzXG4gKiAgICAgY29uc3QgY2xvbmVkUmVxID0gYXdhaXQgY2xvbmVSYXdSZXF1ZXN0KGMucmVxKVxuICogICAgIHJldHVybiBmZXRjaCgnaHR0cDovL2JhY2tlbmQtc2VydmljZS5jb20nLCBjbG9uZWRSZXEpXG4gKiAgIH1cbiAqIClcbiAqIGBgYFxuICovXG5leHBvcnQgY29uc3QgY2xvbmVSYXdSZXF1ZXN0ID0gYXN5bmMgKHJlcTogSG9ub1JlcXVlc3QpOiBQcm9taXNlPFJlcXVlc3Q+ID0+IHtcbiAgaWYgKCFyZXEucmF3LmJvZHlVc2VkKSB7XG4gICAgcmV0dXJuIHJlcS5yYXcuY2xvbmUoKVxuICB9XG5cbiAgY29uc3QgY2FjaGVLZXkgPSAoT2JqZWN0LmtleXMocmVxLmJvZHlDYWNoZSkgYXMgQXJyYXk8a2V5b2YgQm9keT4pWzBdXG4gIGlmICghY2FjaGVLZXkpIHtcbiAgICB0aHJvdyBuZXcgSFRUUEV4Y2VwdGlvbig1MDAsIHtcbiAgICAgIG1lc3NhZ2U6XG4gICAgICAgICdDYW5ub3QgY2xvbmUgcmVxdWVzdDogYm9keSB3YXMgYWxyZWFkeSBjb25zdW1lZCBhbmQgbm90IGNhY2hlZC4gUGxlYXNlIHVzZSBIb25vUmVxdWVzdCBtZXRob2RzIChlLmcuLCByZXEuanNvbigpLCByZXEudGV4dCgpKSBpbnN0ZWFkIG9mIGNvbnN1bWluZyByZXEucmF3IGRpcmVjdGx5LicsXG4gICAgfSlcbiAgfVxuXG4gIGNvbnN0IHJlcXVlc3RJbml0OiBSZXF1aXJlZFJlcXVlc3RJbml0ID0ge1xuICAgIGJvZHk6IGF3YWl0IHJlcVtjYWNoZUtleV0oKSxcbiAgICBjYWNoZTogcmVxLnJhdy5jYWNoZSxcbiAgICBjcmVkZW50aWFsczogcmVxLnJhdy5jcmVkZW50aWFscyxcbiAgICBoZWFkZXJzOiByZXEuaGVhZGVyKCksXG4gICAgaW50ZWdyaXR5OiByZXEucmF3LmludGVncml0eSxcbiAgICBrZWVwYWxpdmU6IHJlcS5yYXcua2VlcGFsaXZlLFxuICAgIG1ldGhvZDogcmVxLm1ldGhvZCxcbiAgICBtb2RlOiByZXEucmF3Lm1vZGUsXG4gICAgcmVkaXJlY3Q6IHJlcS5yYXcucmVkaXJlY3QsXG4gICAgcmVmZXJyZXI6IHJlcS5yYXcucmVmZXJyZXIsXG4gICAgcmVmZXJyZXJQb2xpY3k6IHJlcS5yYXcucmVmZXJyZXJQb2xpY3ksXG4gICAgc2lnbmFsOiByZXEucmF3LnNpZ25hbCxcbiAgfVxuXG4gIHJldHVybiBuZXcgUmVxdWVzdChyZXEudXJsLCByZXF1ZXN0SW5pdClcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxxREFBcUQsR0FDckQsU0FBUyxhQUFhLFFBQVEsc0JBQXFCO0FBQ25ELFNBQVMsZ0JBQWdCLFFBQVEseUJBQXdCO0FBV3pELFNBQVMsU0FBUyxR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
// denoCacheMetadata=2273020972264828309,14107800207386668627