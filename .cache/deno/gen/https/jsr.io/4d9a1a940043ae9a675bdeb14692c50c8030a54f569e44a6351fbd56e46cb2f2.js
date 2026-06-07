/**
 * @module
 * This module is the base module for the Hono object.
 */ /* eslint-disable @typescript-eslint/no-explicit-any */ import { compose } from './compose.ts';
import { Context } from './context.ts';
import { METHODS, METHOD_NAME_ALL, METHOD_NAME_ALL_LOWERCASE } from './router.ts';
import { COMPOSED_HANDLER } from './utils/constants.ts';
import { getPath, getPathNoStrict, mergePath } from './utils/url.ts';
const notFoundHandler = (c)=>{
  return c.text('404 Not Found', 404);
};
const errorHandler = (err, c)=>{
  if ('getResponse' in err) {
    const res = err.getResponse();
    return c.newResponse(res.body, res);
  }
  console.error(err);
  return c.text('Internal Server Error', 500);
};
class Hono {
  get;
  post;
  put;
  delete;
  options;
  patch;
  all;
  on;
  use;
  /*
    This class is like an abstract class and does not have a router.
    To use it, inherit the class and implement router in the constructor.
  */ router;
  getPath;
  // Cannot use `#` because it requires visibility at JavaScript runtime.
  _basePath = '/';
  #path = '/';
  routes = [];
  constructor(options = {}){
    // Implementation of app.get(...handlers[]) or app.get(path, ...handlers[])
    const allMethods = [
      ...METHODS,
      METHOD_NAME_ALL_LOWERCASE
    ];
    allMethods.forEach((method)=>{
      this[method] = (args1, ...args)=>{
        if (typeof args1 === 'string') {
          this.#path = args1;
        } else {
          this.#addRoute(method, this.#path, args1);
        }
        args.forEach((handler)=>{
          this.#addRoute(method, this.#path, handler);
        });
        return this;
      };
    });
    // Implementation of app.on(method, path, ...handlers[])
    this.on = (method, path, ...handlers)=>{
      for (const p of [
        path
      ].flat()){
        this.#path = p;
        for (const m of [
          method
        ].flat()){
          handlers.map((handler)=>{
            this.#addRoute(m.toUpperCase(), this.#path, handler);
          });
        }
      }
      return this;
    };
    // Implementation of app.use(...handlers[]) or app.use(path, ...handlers[])
    this.use = (arg1, ...handlers)=>{
      if (typeof arg1 === 'string') {
        this.#path = arg1;
      } else {
        this.#path = '*';
        handlers.unshift(arg1);
      }
      handlers.forEach((handler)=>{
        this.#addRoute(METHOD_NAME_ALL, this.#path, handler);
      });
      return this;
    };
    const { strict, ...optionsWithoutStrict } = options;
    Object.assign(this, optionsWithoutStrict);
    this.getPath = strict ?? true ? options.getPath ?? getPath : getPathNoStrict;
  }
  #clone() {
    const clone = new Hono({
      router: this.router,
      getPath: this.getPath
    });
    clone.errorHandler = this.errorHandler;
    clone.#notFoundHandler = this.#notFoundHandler;
    clone.routes = this.routes;
    return clone;
  }
  #notFoundHandler = notFoundHandler;
  // Cannot use `#` because it requires visibility at JavaScript runtime.
  errorHandler = errorHandler;
  /**
   * `.route()` allows grouping other Hono instance in routes.
   *
   * @see {@link https://hono.dev/docs/api/routing#grouping}
   *
   * @param {string} path - base Path
   * @param {Hono} app - other Hono instance
   * @returns {Hono} routed Hono instance
   *
   * @example
   * ```ts
   * const app = new Hono()
   * const app2 = new Hono()
   *
   * app2.get("/user", (c) => c.text("user"))
   * app.route("/api", app2) // GET /api/user
   * ```
   */ route(path, app) {
    const subApp = this.basePath(path);
    app.routes.map((r)=>{
      let handler;
      if (app.errorHandler === errorHandler) {
        handler = r.handler;
      } else {
        handler = async (c, next)=>(await compose([], app.errorHandler)(c, ()=>r.handler(c, next))).res;
        handler[COMPOSED_HANDLER] = r.handler;
      }
      subApp.#addRoute(r.method, r.path, handler, r.basePath);
    });
    return this;
  }
  /**
   * `.basePath()` allows base paths to be specified.
   *
   * @see {@link https://hono.dev/docs/api/routing#base-path}
   *
   * @param {string} path - base Path
   * @returns {Hono} changed Hono instance
   *
   * @example
   * ```ts
   * const api = new Hono().basePath('/api')
   * ```
   */ basePath(path) {
    const subApp = this.#clone();
    subApp._basePath = mergePath(this._basePath, path);
    return subApp;
  }
  /**
   * `.onError()` handles an error and returns a customized Response.
   *
   * @see {@link https://hono.dev/docs/api/hono#error-handling}
   *
   * @param {ErrorHandler} handler - request Handler for error
   * @returns {Hono} changed Hono instance
   *
   * @example
   * ```ts
   * app.onError((err, c) => {
   *   console.error(`${err}`)
   *   return c.text('Custom Error Message', 500)
   * })
   * ```
   */ onError = (handler)=>{
    this.errorHandler = handler;
    return this;
  };
  /**
   * `.notFound()` allows you to customize a Not Found Response.
   *
   * @see {@link https://hono.dev/docs/api/hono#not-found}
   *
   * @param {NotFoundHandler} handler - request handler for not-found
   * @returns {Hono} changed Hono instance
   *
   * @example
   * ```ts
   * app.notFound((c) => {
   *   return c.text('Custom 404 Message', 404)
   * })
   * ```
   */ notFound = (handler)=>{
    this.#notFoundHandler = handler;
    return this;
  };
  /**
   * `.mount()` allows you to mount applications built with other frameworks into your Hono application.
   *
   * @see {@link https://hono.dev/docs/api/hono#mount}
   *
   * @param {string} path - base Path
   * @param {Function} applicationHandler - other Request Handler
   * @param {MountOptions} [options] - options of `.mount()`
   * @returns {Hono} mounted Hono instance
   *
   * @example
   * ```ts
   * import { Router as IttyRouter } from 'itty-router'
   * import { Hono } from 'hono'
   * // Create itty-router application
   * const ittyRouter = IttyRouter()
   * // GET /itty-router/hello
   * ittyRouter.get('/hello', () => new Response('Hello from itty-router'))
   *
   * const app = new Hono()
   * app.mount('/itty-router', ittyRouter.handle)
   * ```
   *
   * @example
   * ```ts
   * const app = new Hono()
   * // Send the request to another application without modification.
   * app.mount('/app', anotherApp, {
   *   replaceRequest: (req) => req,
   * })
   * ```
   */ mount(path, applicationHandler, options) {
    // handle options
    let replaceRequest;
    let optionHandler;
    if (options) {
      if (typeof options === 'function') {
        optionHandler = options;
      } else {
        optionHandler = options.optionHandler;
        if (options.replaceRequest === false) {
          replaceRequest = (request)=>request;
        } else {
          replaceRequest = options.replaceRequest;
        }
      }
    }
    // prepare handlers for request
    const getOptions = optionHandler ? (c)=>{
      const options = optionHandler(c);
      return Array.isArray(options) ? options : [
        options
      ];
    } : (c)=>{
      let executionContext = undefined;
      try {
        executionContext = c.executionCtx;
      } catch  {} // Do nothing
      return [
        c.env,
        executionContext
      ];
    };
    replaceRequest ||= (()=>{
      const mergedPath = mergePath(this._basePath, path);
      const pathPrefixLength = mergedPath === '/' ? 0 : mergedPath.length;
      return (request)=>{
        const url = new URL(request.url);
        url.pathname = this.getPath(request).slice(pathPrefixLength) || '/';
        return new Request(url, request);
      };
    })();
    const handler = async (c, next)=>{
      const res = await applicationHandler(replaceRequest(c.req.raw), ...getOptions(c));
      if (res) {
        return res;
      }
      await next();
    };
    this.#addRoute(METHOD_NAME_ALL, mergePath(path, '*'), handler);
    return this;
  }
  #addRoute(method, path, handler, baseRoutePath) {
    method = method.toUpperCase();
    path = mergePath(this._basePath, path);
    const r = {
      basePath: baseRoutePath !== undefined ? mergePath(this._basePath, baseRoutePath) : this._basePath,
      path,
      method,
      handler
    };
    this.router.add(method, path, [
      handler,
      r
    ]);
    this.routes.push(r);
  }
  #handleError(err, c) {
    if (err instanceof Error) {
      return this.errorHandler(err, c);
    }
    throw err;
  }
  #dispatch(request, executionCtx, env, method) {
    // Handle HEAD method
    if (method === 'HEAD') {
      return (async ()=>new Response(null, await this.#dispatch(request, executionCtx, env, 'GET')))();
    }
    const path = this.getPath(request, {
      env
    });
    const matchResult = this.router.match(method, path);
    const c = new Context(request, {
      path,
      matchResult,
      env,
      executionCtx,
      notFoundHandler: this.#notFoundHandler
    });
    // Do not `compose` if it has only one handler
    if (matchResult[0].length === 1) {
      let res;
      try {
        res = matchResult[0][0][0][0](c, async ()=>{
          c.res = await this.#notFoundHandler(c);
        });
      } catch (err) {
        return this.#handleError(err, c);
      }
      return res instanceof Promise ? res.then((resolved)=>resolved || (c.finalized ? c.res : this.#notFoundHandler(c))).catch((err)=>this.#handleError(err, c)) : res ?? this.#notFoundHandler(c);
    }
    const composed = compose(matchResult[0], this.errorHandler, this.#notFoundHandler);
    return (async ()=>{
      try {
        const context = await composed(c);
        if (!context.finalized) {
          throw new Error('Context is not finalized. Did you forget to return a Response object or `await next()`?');
        }
        return context.res;
      } catch (err) {
        return this.#handleError(err, c);
      }
    })();
  }
  /**
   * `.fetch()` will be entry point of your app.
   *
   * @see {@link https://hono.dev/docs/api/hono#fetch}
   *
   * @param {Request} request - request Object of request
   * @param {Env} Env - env Object
   * @param {ExecutionContext} - context of execution
   * @returns {Response | Promise<Response>} response of request
   *
   */ fetch = (request, ...rest)=>{
    return this.#dispatch(request, rest[1], rest[0], request.method);
  };
  /**
   * `.request()` is a useful method for testing.
   * You can pass a URL or pathname to send a GET request.
   * app will return a Response object.
   * ```ts
   * test('GET /hello is ok', async () => {
   *   const res = await app.request('/hello')
   *   expect(res.status).toBe(200)
   * })
   * ```
   * @see https://hono.dev/docs/api/hono#request
   */ request = (input, requestInit, Env, executionCtx)=>{
    if (input instanceof Request) {
      return this.fetch(requestInit ? new Request(input, requestInit) : input, Env, executionCtx);
    }
    input = input.toString();
    return this.fetch(new Request(/^https?:\/\//.test(input) ? input : `http://localhost${mergePath('/', input)}`, requestInit), Env, executionCtx);
  };
  /**
   * `.fire()` automatically adds a global fetch event listener.
   * This can be useful for environments that adhere to the Service Worker API, such as non-ES module Cloudflare Workers.
   * @deprecated
   * Use `fire` from `hono/service-worker` instead.
   * ```ts
   * import { Hono } from 'hono'
   * import { fire } from 'hono/service-worker'
   *
   * const app = new Hono()
   * // ...
   * fire(app)
   * ```
   * @see https://hono.dev/docs/api/hono#fire
   * @see https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API
   * @see https://developers.cloudflare.com/workers/reference/migrate-to-module-workers/
   */ fire = ()=>{
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    addEventListener('fetch', (event)=>{
      event.respondWith(this.#dispatch(event.request, event, undefined, event.request.method));
    });
  };
}
export { Hono as HonoBase };
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0Bob25vL2hvbm8vNC4xMi4yMy9zcmMvaG9uby1iYXNlLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogQG1vZHVsZVxuICogVGhpcyBtb2R1bGUgaXMgdGhlIGJhc2UgbW9kdWxlIGZvciB0aGUgSG9ubyBvYmplY3QuXG4gKi9cblxuLyogZXNsaW50LWRpc2FibGUgQHR5cGVzY3JpcHQtZXNsaW50L25vLWV4cGxpY2l0LWFueSAqL1xuaW1wb3J0IHsgY29tcG9zZSB9IGZyb20gJy4vY29tcG9zZS50cydcbmltcG9ydCB7IENvbnRleHQgfSBmcm9tICcuL2NvbnRleHQudHMnXG5pbXBvcnQgdHlwZSB7IEV4ZWN1dGlvbkNvbnRleHQgfSBmcm9tICcuL2NvbnRleHQudHMnXG5pbXBvcnQgdHlwZSB7IFJvdXRlciB9IGZyb20gJy4vcm91dGVyLnRzJ1xuaW1wb3J0IHsgTUVUSE9EUywgTUVUSE9EX05BTUVfQUxMLCBNRVRIT0RfTkFNRV9BTExfTE9XRVJDQVNFIH0gZnJvbSAnLi9yb3V0ZXIudHMnXG5pbXBvcnQgdHlwZSB7XG4gIEVudixcbiAgRXJyb3JIYW5kbGVyLFxuICBGZXRjaEV2ZW50TGlrZSxcbiAgSCxcbiAgSGFuZGxlckludGVyZmFjZSxcbiAgTWVyZ2VQYXRoLFxuICBNZXJnZVNjaGVtYVBhdGgsXG4gIE1pZGRsZXdhcmVIYW5kbGVyLFxuICBNaWRkbGV3YXJlSGFuZGxlckludGVyZmFjZSxcbiAgTmV4dCxcbiAgTm90Rm91bmRIYW5kbGVyLFxuICBPbkhhbmRsZXJJbnRlcmZhY2UsXG4gIFJvdXRlclJvdXRlLFxuICBTY2hlbWEsXG59IGZyb20gJy4vdHlwZXMudHMnXG5pbXBvcnQgeyBDT01QT1NFRF9IQU5ETEVSIH0gZnJvbSAnLi91dGlscy9jb25zdGFudHMudHMnXG5pbXBvcnQgeyBnZXRQYXRoLCBnZXRQYXRoTm9TdHJpY3QsIG1lcmdlUGF0aCB9IGZyb20gJy4vdXRpbHMvdXJsLnRzJ1xuXG5jb25zdCBub3RGb3VuZEhhbmRsZXI6IE5vdEZvdW5kSGFuZGxlciA9IChjKSA9PiB7XG4gIHJldHVybiBjLnRleHQoJzQwNCBOb3QgRm91bmQnLCA0MDQpXG59XG5cbmNvbnN0IGVycm9ySGFuZGxlcjogRXJyb3JIYW5kbGVyID0gKGVyciwgYykgPT4ge1xuICBpZiAoJ2dldFJlc3BvbnNlJyBpbiBlcnIpIHtcbiAgICBjb25zdCByZXMgPSBlcnIuZ2V0UmVzcG9uc2UoKVxuICAgIHJldHVybiBjLm5ld1Jlc3BvbnNlKHJlcy5ib2R5LCByZXMpXG4gIH1cbiAgY29uc29sZS5lcnJvcihlcnIpXG4gIHJldHVybiBjLnRleHQoJ0ludGVybmFsIFNlcnZlciBFcnJvcicsIDUwMClcbn1cblxudHlwZSBHZXRQYXRoPEUgZXh0ZW5kcyBFbnY+ID0gKHJlcXVlc3Q6IFJlcXVlc3QsIG9wdGlvbnM/OiB7IGVudj86IEVbJ0JpbmRpbmdzJ10gfSkgPT4gc3RyaW5nXG5cbmV4cG9ydCB0eXBlIEhvbm9PcHRpb25zPEUgZXh0ZW5kcyBFbnY+ID0ge1xuICAvKipcbiAgICogYHN0cmljdGAgb3B0aW9uIHNwZWNpZmllcyB3aGV0aGVyIHRvIGRpc3Rpbmd1aXNoIHdoZXRoZXIgdGhlIGxhc3QgcGF0aCBpcyBhIGRpcmVjdG9yeSBvciBub3QuXG4gICAqXG4gICAqIEBzZWUge0BsaW5rIGh0dHBzOi8vaG9uby5kZXYvZG9jcy9hcGkvaG9ubyNzdHJpY3QtbW9kZX1cbiAgICpcbiAgICogQGRlZmF1bHQgdHJ1ZVxuICAgKi9cbiAgc3RyaWN0PzogYm9vbGVhblxuICAvKipcbiAgICogYHJvdXRlcmAgb3B0aW9uIHNwZWNpZmllcyB3aGljaCByb3V0ZXIgdG8gdXNlLlxuICAgKlxuICAgKiBAc2VlIHtAbGluayBodHRwczovL2hvbm8uZGV2L2RvY3MvYXBpL2hvbm8jcm91dGVyLW9wdGlvbn1cbiAgICpcbiAgICogQGV4YW1wbGVcbiAgICogYGBgdHNcbiAgICogY29uc3QgYXBwID0gbmV3IEhvbm8oeyByb3V0ZXI6IG5ldyBSZWdFeHBSb3V0ZXIoKSB9KVxuICAgKiBgYGBcbiAgICovXG4gIHJvdXRlcj86IFJvdXRlcjxbSCwgUm91dGVyUm91dGVdPlxuICAvKipcbiAgICogYGdldFBhdGhgIGNhbiBoYW5kbGUgdGhlIGhvc3QgaGVhZGVyIHZhbHVlLlxuICAgKlxuICAgKiBAc2VlIHtAbGluayBodHRwczovL2hvbm8uZGV2L2RvY3MvYXBpL3JvdXRpbmcjcm91dGluZy13aXRoLWhvc3QtaGVhZGVyLXZhbHVlfVxuICAgKlxuICAgKiBAZXhhbXBsZVxuICAgKiBgYGB0c1xuICAgKiBjb25zdCBhcHAgPSBuZXcgSG9ubyh7XG4gICAqICBnZXRQYXRoOiAocmVxKSA9PlxuICAgKiAgICcvJyArIHJlcS5oZWFkZXJzLmdldCgnaG9zdCcpICsgcmVxLnVybC5yZXBsYWNlKC9eaHR0cHM/OlxcL1xcL1teL10rKFxcL1teP10qKS8sICckMScpLFxuICAgKiB9KVxuICAgKlxuICAgKiBhcHAuZ2V0KCcvd3d3MS5leGFtcGxlLmNvbS9oZWxsbycsICgpID0+IGMudGV4dCgnaGVsbG8gd3d3MScpKVxuICAgKlxuICAgKiAvLyBBIGZvbGxvd2luZyByZXF1ZXN0IHdpbGwgbWF0Y2ggdGhlIHJvdXRlOlxuICAgKiAvLyBuZXcgUmVxdWVzdCgnaHR0cDovL3d3dzEuZXhhbXBsZS5jb20vaGVsbG8nLCB7XG4gICAqIC8vICBoZWFkZXJzOiB7IGhvc3Q6ICd3d3cxLmV4YW1wbGUuY29tJyB9LFxuICAgKiAvLyB9KVxuICAgKiBgYGBcbiAgICovXG4gIGdldFBhdGg/OiBHZXRQYXRoPEU+XG59XG5cbnR5cGUgTW91bnRPcHRpb25IYW5kbGVyID0gKGM6IENvbnRleHQpID0+IHVua25vd25cbnR5cGUgTW91bnRSZXBsYWNlUmVxdWVzdCA9IChvcmlnaW5hbFJlcXVlc3Q6IFJlcXVlc3QpID0+IFJlcXVlc3RcbnR5cGUgTW91bnRPcHRpb25zID1cbiAgfCBNb3VudE9wdGlvbkhhbmRsZXJcbiAgfCB7XG4gICAgICBvcHRpb25IYW5kbGVyPzogTW91bnRPcHRpb25IYW5kbGVyXG4gICAgICByZXBsYWNlUmVxdWVzdD86IE1vdW50UmVwbGFjZVJlcXVlc3QgfCBmYWxzZVxuICAgIH1cblxuY2xhc3MgSG9ubzxcbiAgRSBleHRlbmRzIEVudiA9IEVudixcbiAgUyBleHRlbmRzIFNjaGVtYSA9IHt9LFxuICBCYXNlUGF0aCBleHRlbmRzIHN0cmluZyA9ICcvJyxcbiAgQ3VycmVudFBhdGggZXh0ZW5kcyBzdHJpbmcgPSBCYXNlUGF0aCxcbj4ge1xuICBnZXQhOiBIYW5kbGVySW50ZXJmYWNlPEUsICdnZXQnLCBTLCBCYXNlUGF0aCwgQ3VycmVudFBhdGg+XG4gIHBvc3QhOiBIYW5kbGVySW50ZXJmYWNlPEUsICdwb3N0JywgUywgQmFzZVBhdGgsIEN1cnJlbnRQYXRoPlxuICBwdXQhOiBIYW5kbGVySW50ZXJmYWNlPEUsICdwdXQnLCBTLCBCYXNlUGF0aCwgQ3VycmVudFBhdGg+XG4gIGRlbGV0ZSE6IEhhbmRsZXJJbnRlcmZhY2U8RSwgJ2RlbGV0ZScsIFMsIEJhc2VQYXRoLCBDdXJyZW50UGF0aD5cbiAgb3B0aW9ucyE6IEhhbmRsZXJJbnRlcmZhY2U8RSwgJ29wdGlvbnMnLCBTLCBCYXNlUGF0aCwgQ3VycmVudFBhdGg+XG4gIHBhdGNoITogSGFuZGxlckludGVyZmFjZTxFLCAncGF0Y2gnLCBTLCBCYXNlUGF0aCwgQ3VycmVudFBhdGg+XG4gIGFsbCE6IEhhbmRsZXJJbnRlcmZhY2U8RSwgJ2FsbCcsIFMsIEJhc2VQYXRoLCBDdXJyZW50UGF0aD5cbiAgb246IE9uSGFuZGxlckludGVyZmFjZTxFLCBTLCBCYXNlUGF0aD5cbiAgdXNlOiBNaWRkbGV3YXJlSGFuZGxlckludGVyZmFjZTxFLCBTLCBCYXNlUGF0aD5cblxuICAvKlxuICAgIFRoaXMgY2xhc3MgaXMgbGlrZSBhbiBhYnN0cmFjdCBjbGFzcyBhbmQgZG9lcyBub3QgaGF2ZSBhIHJvdXRlci5cbiAgICBUbyB1c2UgaXQsIGluaGVyaXQgdGhlIGNsYXNzIGFuZCBpbXBsZW1lbnQgcm91dGVyIGluIHRoZSBjb25zdHJ1Y3Rvci5cbiAgKi9cbiAgcm91dGVyITogUm91dGVyPFtILCBSb3V0ZXJSb3V0ZV0+XG4gIHJlYWRvbmx5IGdldFBhdGg6IEdldFBhdGg8RT5cbiAgLy8gQ2Fubm90IHVzZSBgI2AgYmVjYXVzZSBpdCByZXF1aXJlcyB2aXNpYmlsaXR5IGF0IEphdmFTY3JpcHQgcnVudGltZS5cbiAgcHJpdmF0ZSBfYmFzZVBhdGg6IHN0cmluZyA9ICcvJ1xuICAjcGF0aDogc3RyaW5nID0gJy8nXG5cbiAgcm91dGVzOiBSb3V0ZXJSb3V0ZVtdID0gW11cblxuICBjb25zdHJ1Y3RvcihvcHRpb25zOiBIb25vT3B0aW9uczxFPiA9IHt9KSB7XG4gICAgLy8gSW1wbGVtZW50YXRpb24gb2YgYXBwLmdldCguLi5oYW5kbGVyc1tdKSBvciBhcHAuZ2V0KHBhdGgsIC4uLmhhbmRsZXJzW10pXG4gICAgY29uc3QgYWxsTWV0aG9kcyA9IFsuLi5NRVRIT0RTLCBNRVRIT0RfTkFNRV9BTExfTE9XRVJDQVNFXVxuICAgIGFsbE1ldGhvZHMuZm9yRWFjaCgobWV0aG9kKSA9PiB7XG4gICAgICB0aGlzW21ldGhvZF0gPSAoYXJnczE6IHN0cmluZyB8IEgsIC4uLmFyZ3M6IEhbXSkgPT4ge1xuICAgICAgICBpZiAodHlwZW9mIGFyZ3MxID09PSAnc3RyaW5nJykge1xuICAgICAgICAgIHRoaXMuI3BhdGggPSBhcmdzMVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHRoaXMuI2FkZFJvdXRlKG1ldGhvZCwgdGhpcy4jcGF0aCwgYXJnczEpXG4gICAgICAgIH1cbiAgICAgICAgYXJncy5mb3JFYWNoKChoYW5kbGVyKSA9PiB7XG4gICAgICAgICAgdGhpcy4jYWRkUm91dGUobWV0aG9kLCB0aGlzLiNwYXRoLCBoYW5kbGVyKVxuICAgICAgICB9KVxuICAgICAgICByZXR1cm4gdGhpcyBhcyBhbnlcbiAgICAgIH1cbiAgICB9KVxuXG4gICAgLy8gSW1wbGVtZW50YXRpb24gb2YgYXBwLm9uKG1ldGhvZCwgcGF0aCwgLi4uaGFuZGxlcnNbXSlcbiAgICB0aGlzLm9uID0gKG1ldGhvZDogc3RyaW5nIHwgc3RyaW5nW10sIHBhdGg6IHN0cmluZyB8IHN0cmluZ1tdLCAuLi5oYW5kbGVyczogSFtdKSA9PiB7XG4gICAgICBmb3IgKGNvbnN0IHAgb2YgW3BhdGhdLmZsYXQoKSkge1xuICAgICAgICB0aGlzLiNwYXRoID0gcFxuICAgICAgICBmb3IgKGNvbnN0IG0gb2YgW21ldGhvZF0uZmxhdCgpKSB7XG4gICAgICAgICAgaGFuZGxlcnMubWFwKChoYW5kbGVyKSA9PiB7XG4gICAgICAgICAgICB0aGlzLiNhZGRSb3V0ZShtLnRvVXBwZXJDYXNlKCksIHRoaXMuI3BhdGgsIGhhbmRsZXIpXG4gICAgICAgICAgfSlcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgcmV0dXJuIHRoaXMgYXMgYW55XG4gICAgfVxuXG4gICAgLy8gSW1wbGVtZW50YXRpb24gb2YgYXBwLnVzZSguLi5oYW5kbGVyc1tdKSBvciBhcHAudXNlKHBhdGgsIC4uLmhhbmRsZXJzW10pXG4gICAgdGhpcy51c2UgPSAoYXJnMTogc3RyaW5nIHwgTWlkZGxld2FyZUhhbmRsZXI8YW55PiwgLi4uaGFuZGxlcnM6IE1pZGRsZXdhcmVIYW5kbGVyPGFueT5bXSkgPT4ge1xuICAgICAgaWYgKHR5cGVvZiBhcmcxID09PSAnc3RyaW5nJykge1xuICAgICAgICB0aGlzLiNwYXRoID0gYXJnMVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhpcy4jcGF0aCA9ICcqJ1xuICAgICAgICBoYW5kbGVycy51bnNoaWZ0KGFyZzEpXG4gICAgICB9XG4gICAgICBoYW5kbGVycy5mb3JFYWNoKChoYW5kbGVyKSA9PiB7XG4gICAgICAgIHRoaXMuI2FkZFJvdXRlKE1FVEhPRF9OQU1FX0FMTCwgdGhpcy4jcGF0aCwgaGFuZGxlcilcbiAgICAgIH0pXG4gICAgICByZXR1cm4gdGhpcyBhcyBhbnlcbiAgICB9XG5cbiAgICBjb25zdCB7IHN0cmljdCwgLi4ub3B0aW9uc1dpdGhvdXRTdHJpY3QgfSA9IG9wdGlvbnNcbiAgICBPYmplY3QuYXNzaWduKHRoaXMsIG9wdGlvbnNXaXRob3V0U3RyaWN0KVxuICAgIHRoaXMuZ2V0UGF0aCA9IChzdHJpY3QgPz8gdHJ1ZSkgPyAob3B0aW9ucy5nZXRQYXRoID8/IGdldFBhdGgpIDogZ2V0UGF0aE5vU3RyaWN0XG4gIH1cblxuICAjY2xvbmUoKTogSG9ubzxFLCBTLCBCYXNlUGF0aCwgQ3VycmVudFBhdGg+IHtcbiAgICBjb25zdCBjbG9uZSA9IG5ldyBIb25vPEUsIFMsIEJhc2VQYXRoLCBDdXJyZW50UGF0aD4oe1xuICAgICAgcm91dGVyOiB0aGlzLnJvdXRlcixcbiAgICAgIGdldFBhdGg6IHRoaXMuZ2V0UGF0aCxcbiAgICB9KVxuICAgIGNsb25lLmVycm9ySGFuZGxlciA9IHRoaXMuZXJyb3JIYW5kbGVyXG4gICAgY2xvbmUuI25vdEZvdW5kSGFuZGxlciA9IHRoaXMuI25vdEZvdW5kSGFuZGxlclxuICAgIGNsb25lLnJvdXRlcyA9IHRoaXMucm91dGVzXG4gICAgcmV0dXJuIGNsb25lXG4gIH1cblxuICAjbm90Rm91bmRIYW5kbGVyOiBOb3RGb3VuZEhhbmRsZXIgPSBub3RGb3VuZEhhbmRsZXJcbiAgLy8gQ2Fubm90IHVzZSBgI2AgYmVjYXVzZSBpdCByZXF1aXJlcyB2aXNpYmlsaXR5IGF0IEphdmFTY3JpcHQgcnVudGltZS5cbiAgcHJpdmF0ZSBlcnJvckhhbmRsZXI6IEVycm9ySGFuZGxlciA9IGVycm9ySGFuZGxlclxuXG4gIC8qKlxuICAgKiBgLnJvdXRlKClgIGFsbG93cyBncm91cGluZyBvdGhlciBIb25vIGluc3RhbmNlIGluIHJvdXRlcy5cbiAgICpcbiAgICogQHNlZSB7QGxpbmsgaHR0cHM6Ly9ob25vLmRldi9kb2NzL2FwaS9yb3V0aW5nI2dyb3VwaW5nfVxuICAgKlxuICAgKiBAcGFyYW0ge3N0cmluZ30gcGF0aCAtIGJhc2UgUGF0aFxuICAgKiBAcGFyYW0ge0hvbm99IGFwcCAtIG90aGVyIEhvbm8gaW5zdGFuY2VcbiAgICogQHJldHVybnMge0hvbm99IHJvdXRlZCBIb25vIGluc3RhbmNlXG4gICAqXG4gICAqIEBleGFtcGxlXG4gICAqIGBgYHRzXG4gICAqIGNvbnN0IGFwcCA9IG5ldyBIb25vKClcbiAgICogY29uc3QgYXBwMiA9IG5ldyBIb25vKClcbiAgICpcbiAgICogYXBwMi5nZXQoXCIvdXNlclwiLCAoYykgPT4gYy50ZXh0KFwidXNlclwiKSlcbiAgICogYXBwLnJvdXRlKFwiL2FwaVwiLCBhcHAyKSAvLyBHRVQgL2FwaS91c2VyXG4gICAqIGBgYFxuICAgKi9cbiAgcm91dGU8XG4gICAgU3ViUGF0aCBleHRlbmRzIHN0cmluZyxcbiAgICBTdWJFbnYgZXh0ZW5kcyBFbnYsXG4gICAgU3ViU2NoZW1hIGV4dGVuZHMgU2NoZW1hLFxuICAgIFN1YkJhc2VQYXRoIGV4dGVuZHMgc3RyaW5nLFxuICAgIFN1YkN1cnJlbnRQYXRoIGV4dGVuZHMgc3RyaW5nLFxuICA+KFxuICAgIHBhdGg6IFN1YlBhdGgsXG4gICAgYXBwOiBIb25vPFN1YkVudiwgU3ViU2NoZW1hLCBTdWJCYXNlUGF0aCwgU3ViQ3VycmVudFBhdGg+XG4gICk6IEhvbm88RSwgTWVyZ2VTY2hlbWFQYXRoPFN1YlNjaGVtYSwgTWVyZ2VQYXRoPEJhc2VQYXRoLCBTdWJQYXRoPj4gfCBTLCBCYXNlUGF0aCwgQ3VycmVudFBhdGg+IHtcbiAgICBjb25zdCBzdWJBcHAgPSB0aGlzLmJhc2VQYXRoKHBhdGgpXG4gICAgYXBwLnJvdXRlcy5tYXAoKHIpID0+IHtcbiAgICAgIGxldCBoYW5kbGVyXG4gICAgICBpZiAoYXBwLmVycm9ySGFuZGxlciA9PT0gZXJyb3JIYW5kbGVyKSB7XG4gICAgICAgIGhhbmRsZXIgPSByLmhhbmRsZXJcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGhhbmRsZXIgPSBhc3luYyAoYzogQ29udGV4dCwgbmV4dDogTmV4dCkgPT5cbiAgICAgICAgICAoYXdhaXQgY29tcG9zZShbXSwgYXBwLmVycm9ySGFuZGxlcikoYywgKCkgPT4gci5oYW5kbGVyKGMsIG5leHQpKSkucmVzXG4gICAgICAgIDsoaGFuZGxlciBhcyBhbnkpW0NPTVBPU0VEX0hBTkRMRVJdID0gci5oYW5kbGVyXG4gICAgICB9XG5cbiAgICAgIHN1YkFwcC4jYWRkUm91dGUoci5tZXRob2QsIHIucGF0aCwgaGFuZGxlciwgci5iYXNlUGF0aClcbiAgICB9KVxuICAgIHJldHVybiB0aGlzXG4gIH1cblxuICAvKipcbiAgICogYC5iYXNlUGF0aCgpYCBhbGxvd3MgYmFzZSBwYXRocyB0byBiZSBzcGVjaWZpZWQuXG4gICAqXG4gICAqIEBzZWUge0BsaW5rIGh0dHBzOi8vaG9uby5kZXYvZG9jcy9hcGkvcm91dGluZyNiYXNlLXBhdGh9XG4gICAqXG4gICAqIEBwYXJhbSB7c3RyaW5nfSBwYXRoIC0gYmFzZSBQYXRoXG4gICAqIEByZXR1cm5zIHtIb25vfSBjaGFuZ2VkIEhvbm8gaW5zdGFuY2VcbiAgICpcbiAgICogQGV4YW1wbGVcbiAgICogYGBgdHNcbiAgICogY29uc3QgYXBpID0gbmV3IEhvbm8oKS5iYXNlUGF0aCgnL2FwaScpXG4gICAqIGBgYFxuICAgKi9cbiAgYmFzZVBhdGg8U3ViUGF0aCBleHRlbmRzIHN0cmluZz4oXG4gICAgcGF0aDogU3ViUGF0aFxuICApOiBIb25vPEUsIFMsIE1lcmdlUGF0aDxCYXNlUGF0aCwgU3ViUGF0aD4sIE1lcmdlUGF0aDxCYXNlUGF0aCwgU3ViUGF0aD4+IHtcbiAgICBjb25zdCBzdWJBcHAgPSB0aGlzLiNjbG9uZSgpXG4gICAgc3ViQXBwLl9iYXNlUGF0aCA9IG1lcmdlUGF0aCh0aGlzLl9iYXNlUGF0aCwgcGF0aClcbiAgICByZXR1cm4gc3ViQXBwXG4gIH1cblxuICAvKipcbiAgICogYC5vbkVycm9yKClgIGhhbmRsZXMgYW4gZXJyb3IgYW5kIHJldHVybnMgYSBjdXN0b21pemVkIFJlc3BvbnNlLlxuICAgKlxuICAgKiBAc2VlIHtAbGluayBodHRwczovL2hvbm8uZGV2L2RvY3MvYXBpL2hvbm8jZXJyb3ItaGFuZGxpbmd9XG4gICAqXG4gICAqIEBwYXJhbSB7RXJyb3JIYW5kbGVyfSBoYW5kbGVyIC0gcmVxdWVzdCBIYW5kbGVyIGZvciBlcnJvclxuICAgKiBAcmV0dXJucyB7SG9ub30gY2hhbmdlZCBIb25vIGluc3RhbmNlXG4gICAqXG4gICAqIEBleGFtcGxlXG4gICAqIGBgYHRzXG4gICAqIGFwcC5vbkVycm9yKChlcnIsIGMpID0+IHtcbiAgICogICBjb25zb2xlLmVycm9yKGAke2Vycn1gKVxuICAgKiAgIHJldHVybiBjLnRleHQoJ0N1c3RvbSBFcnJvciBNZXNzYWdlJywgNTAwKVxuICAgKiB9KVxuICAgKiBgYGBcbiAgICovXG4gIG9uRXJyb3IgPSAoaGFuZGxlcjogRXJyb3JIYW5kbGVyPEU+KTogSG9ubzxFLCBTLCBCYXNlUGF0aCwgQ3VycmVudFBhdGg+ID0+IHtcbiAgICB0aGlzLmVycm9ySGFuZGxlciA9IGhhbmRsZXJcbiAgICByZXR1cm4gdGhpc1xuICB9XG5cbiAgLyoqXG4gICAqIGAubm90Rm91bmQoKWAgYWxsb3dzIHlvdSB0byBjdXN0b21pemUgYSBOb3QgRm91bmQgUmVzcG9uc2UuXG4gICAqXG4gICAqIEBzZWUge0BsaW5rIGh0dHBzOi8vaG9uby5kZXYvZG9jcy9hcGkvaG9ubyNub3QtZm91bmR9XG4gICAqXG4gICAqIEBwYXJhbSB7Tm90Rm91bmRIYW5kbGVyfSBoYW5kbGVyIC0gcmVxdWVzdCBoYW5kbGVyIGZvciBub3QtZm91bmRcbiAgICogQHJldHVybnMge0hvbm99IGNoYW5nZWQgSG9ubyBpbnN0YW5jZVxuICAgKlxuICAgKiBAZXhhbXBsZVxuICAgKiBgYGB0c1xuICAgKiBhcHAubm90Rm91bmQoKGMpID0+IHtcbiAgICogICByZXR1cm4gYy50ZXh0KCdDdXN0b20gNDA0IE1lc3NhZ2UnLCA0MDQpXG4gICAqIH0pXG4gICAqIGBgYFxuICAgKi9cbiAgbm90Rm91bmQgPSAoaGFuZGxlcjogTm90Rm91bmRIYW5kbGVyPEU+KTogSG9ubzxFLCBTLCBCYXNlUGF0aCwgQ3VycmVudFBhdGg+ID0+IHtcbiAgICB0aGlzLiNub3RGb3VuZEhhbmRsZXIgPSBoYW5kbGVyXG4gICAgcmV0dXJuIHRoaXNcbiAgfVxuXG4gIC8qKlxuICAgKiBgLm1vdW50KClgIGFsbG93cyB5b3UgdG8gbW91bnQgYXBwbGljYXRpb25zIGJ1aWx0IHdpdGggb3RoZXIgZnJhbWV3b3JrcyBpbnRvIHlvdXIgSG9ubyBhcHBsaWNhdGlvbi5cbiAgICpcbiAgICogQHNlZSB7QGxpbmsgaHR0cHM6Ly9ob25vLmRldi9kb2NzL2FwaS9ob25vI21vdW50fVxuICAgKlxuICAgKiBAcGFyYW0ge3N0cmluZ30gcGF0aCAtIGJhc2UgUGF0aFxuICAgKiBAcGFyYW0ge0Z1bmN0aW9ufSBhcHBsaWNhdGlvbkhhbmRsZXIgLSBvdGhlciBSZXF1ZXN0IEhhbmRsZXJcbiAgICogQHBhcmFtIHtNb3VudE9wdGlvbnN9IFtvcHRpb25zXSAtIG9wdGlvbnMgb2YgYC5tb3VudCgpYFxuICAgKiBAcmV0dXJucyB7SG9ub30gbW91bnRlZCBIb25vIGluc3RhbmNlXG4gICAqXG4gICAqIEBleGFtcGxlXG4gICAqIGBgYHRzXG4gICAqIGltcG9ydCB7IFJvdXRlciBhcyBJdHR5Um91dGVyIH0gZnJvbSAnaXR0eS1yb3V0ZXInXG4gICAqIGltcG9ydCB7IEhvbm8gfSBmcm9tICdob25vJ1xuICAgKiAvLyBDcmVhdGUgaXR0eS1yb3V0ZXIgYXBwbGljYXRpb25cbiAgICogY29uc3QgaXR0eVJvdXRlciA9IEl0dHlSb3V0ZXIoKVxuICAgKiAvLyBHRVQgL2l0dHktcm91dGVyL2hlbGxvXG4gICAqIGl0dHlSb3V0ZXIuZ2V0KCcvaGVsbG8nLCAoKSA9PiBuZXcgUmVzcG9uc2UoJ0hlbGxvIGZyb20gaXR0eS1yb3V0ZXInKSlcbiAgICpcbiAgICogY29uc3QgYXBwID0gbmV3IEhvbm8oKVxuICAgKiBhcHAubW91bnQoJy9pdHR5LXJvdXRlcicsIGl0dHlSb3V0ZXIuaGFuZGxlKVxuICAgKiBgYGBcbiAgICpcbiAgICogQGV4YW1wbGVcbiAgICogYGBgdHNcbiAgICogY29uc3QgYXBwID0gbmV3IEhvbm8oKVxuICAgKiAvLyBTZW5kIHRoZSByZXF1ZXN0IHRvIGFub3RoZXIgYXBwbGljYXRpb24gd2l0aG91dCBtb2RpZmljYXRpb24uXG4gICAqIGFwcC5tb3VudCgnL2FwcCcsIGFub3RoZXJBcHAsIHtcbiAgICogICByZXBsYWNlUmVxdWVzdDogKHJlcSkgPT4gcmVxLFxuICAgKiB9KVxuICAgKiBgYGBcbiAgICovXG4gIG1vdW50KFxuICAgIHBhdGg6IHN0cmluZyxcbiAgICBhcHBsaWNhdGlvbkhhbmRsZXI6IChyZXF1ZXN0OiBSZXF1ZXN0LCAuLi5hcmdzOiBhbnkpID0+IFJlc3BvbnNlIHwgUHJvbWlzZTxSZXNwb25zZT4sXG4gICAgb3B0aW9ucz86IE1vdW50T3B0aW9uc1xuICApOiBIb25vPEUsIFMsIEJhc2VQYXRoLCBDdXJyZW50UGF0aD4ge1xuICAgIC8vIGhhbmRsZSBvcHRpb25zXG4gICAgbGV0IHJlcGxhY2VSZXF1ZXN0OiBNb3VudFJlcGxhY2VSZXF1ZXN0IHwgdW5kZWZpbmVkXG4gICAgbGV0IG9wdGlvbkhhbmRsZXI6IE1vdW50T3B0aW9uSGFuZGxlciB8IHVuZGVmaW5lZFxuICAgIGlmIChvcHRpb25zKSB7XG4gICAgICBpZiAodHlwZW9mIG9wdGlvbnMgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgb3B0aW9uSGFuZGxlciA9IG9wdGlvbnNcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIG9wdGlvbkhhbmRsZXIgPSBvcHRpb25zLm9wdGlvbkhhbmRsZXJcbiAgICAgICAgaWYgKG9wdGlvbnMucmVwbGFjZVJlcXVlc3QgPT09IGZhbHNlKSB7XG4gICAgICAgICAgcmVwbGFjZVJlcXVlc3QgPSAocmVxdWVzdCkgPT4gcmVxdWVzdFxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHJlcGxhY2VSZXF1ZXN0ID0gb3B0aW9ucy5yZXBsYWNlUmVxdWVzdFxuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gcHJlcGFyZSBoYW5kbGVycyBmb3IgcmVxdWVzdFxuICAgIGNvbnN0IGdldE9wdGlvbnM6IChjOiBDb250ZXh0KSA9PiB1bmtub3duW10gPSBvcHRpb25IYW5kbGVyXG4gICAgICA/IChjKSA9PiB7XG4gICAgICAgICAgY29uc3Qgb3B0aW9ucyA9IG9wdGlvbkhhbmRsZXIhKGMpXG4gICAgICAgICAgcmV0dXJuIEFycmF5LmlzQXJyYXkob3B0aW9ucykgPyBvcHRpb25zIDogW29wdGlvbnNdXG4gICAgICAgIH1cbiAgICAgIDogKGMpID0+IHtcbiAgICAgICAgICBsZXQgZXhlY3V0aW9uQ29udGV4dDogRXhlY3V0aW9uQ29udGV4dCB8IHVuZGVmaW5lZCA9IHVuZGVmaW5lZFxuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICBleGVjdXRpb25Db250ZXh0ID0gYy5leGVjdXRpb25DdHhcbiAgICAgICAgICB9IGNhdGNoIHt9IC8vIERvIG5vdGhpbmdcbiAgICAgICAgICByZXR1cm4gW2MuZW52LCBleGVjdXRpb25Db250ZXh0XVxuICAgICAgICB9XG4gICAgcmVwbGFjZVJlcXVlc3QgfHw9ICgoKSA9PiB7XG4gICAgICBjb25zdCBtZXJnZWRQYXRoID0gbWVyZ2VQYXRoKHRoaXMuX2Jhc2VQYXRoLCBwYXRoKVxuICAgICAgY29uc3QgcGF0aFByZWZpeExlbmd0aCA9IG1lcmdlZFBhdGggPT09ICcvJyA/IDAgOiBtZXJnZWRQYXRoLmxlbmd0aFxuICAgICAgcmV0dXJuIChyZXF1ZXN0KSA9PiB7XG4gICAgICAgIGNvbnN0IHVybCA9IG5ldyBVUkwocmVxdWVzdC51cmwpXG4gICAgICAgIHVybC5wYXRobmFtZSA9IHRoaXMuZ2V0UGF0aChyZXF1ZXN0KS5zbGljZShwYXRoUHJlZml4TGVuZ3RoKSB8fCAnLydcbiAgICAgICAgcmV0dXJuIG5ldyBSZXF1ZXN0KHVybCwgcmVxdWVzdClcbiAgICAgIH1cbiAgICB9KSgpXG5cbiAgICBjb25zdCBoYW5kbGVyOiBNaWRkbGV3YXJlSGFuZGxlciA9IGFzeW5jIChjLCBuZXh0KSA9PiB7XG4gICAgICBjb25zdCByZXMgPSBhd2FpdCBhcHBsaWNhdGlvbkhhbmRsZXIocmVwbGFjZVJlcXVlc3QoYy5yZXEucmF3KSwgLi4uZ2V0T3B0aW9ucyhjKSlcblxuICAgICAgaWYgKHJlcykge1xuICAgICAgICByZXR1cm4gcmVzXG4gICAgICB9XG5cbiAgICAgIGF3YWl0IG5leHQoKVxuICAgIH1cbiAgICB0aGlzLiNhZGRSb3V0ZShNRVRIT0RfTkFNRV9BTEwsIG1lcmdlUGF0aChwYXRoLCAnKicpLCBoYW5kbGVyKVxuICAgIHJldHVybiB0aGlzXG4gIH1cblxuICAjYWRkUm91dGUobWV0aG9kOiBzdHJpbmcsIHBhdGg6IHN0cmluZywgaGFuZGxlcjogSCwgYmFzZVJvdXRlUGF0aD86IHN0cmluZyk6IHZvaWQge1xuICAgIG1ldGhvZCA9IG1ldGhvZC50b1VwcGVyQ2FzZSgpXG4gICAgcGF0aCA9IG1lcmdlUGF0aCh0aGlzLl9iYXNlUGF0aCwgcGF0aClcbiAgICBjb25zdCByOiBSb3V0ZXJSb3V0ZSA9IHtcbiAgICAgIGJhc2VQYXRoOlxuICAgICAgICBiYXNlUm91dGVQYXRoICE9PSB1bmRlZmluZWQgPyBtZXJnZVBhdGgodGhpcy5fYmFzZVBhdGgsIGJhc2VSb3V0ZVBhdGgpIDogdGhpcy5fYmFzZVBhdGgsXG4gICAgICBwYXRoLFxuICAgICAgbWV0aG9kLFxuICAgICAgaGFuZGxlcixcbiAgICB9XG4gICAgdGhpcy5yb3V0ZXIuYWRkKG1ldGhvZCwgcGF0aCwgW2hhbmRsZXIsIHJdKVxuICAgIHRoaXMucm91dGVzLnB1c2gocilcbiAgfVxuXG4gICNoYW5kbGVFcnJvcihlcnI6IHVua25vd24sIGM6IENvbnRleHQ8RT4pOiBSZXNwb25zZSB8IFByb21pc2U8UmVzcG9uc2U+IHtcbiAgICBpZiAoZXJyIGluc3RhbmNlb2YgRXJyb3IpIHtcbiAgICAgIHJldHVybiB0aGlzLmVycm9ySGFuZGxlcihlcnIsIGMpXG4gICAgfVxuICAgIHRocm93IGVyclxuICB9XG5cbiAgI2Rpc3BhdGNoKFxuICAgIHJlcXVlc3Q6IFJlcXVlc3QsXG4gICAgZXhlY3V0aW9uQ3R4OiBFeGVjdXRpb25Db250ZXh0IHwgRmV0Y2hFdmVudExpa2UgfCB1bmRlZmluZWQsXG4gICAgZW52OiBFWydCaW5kaW5ncyddLFxuICAgIG1ldGhvZDogc3RyaW5nXG4gICk6IFJlc3BvbnNlIHwgUHJvbWlzZTxSZXNwb25zZT4ge1xuICAgIC8vIEhhbmRsZSBIRUFEIG1ldGhvZFxuICAgIGlmIChtZXRob2QgPT09ICdIRUFEJykge1xuICAgICAgcmV0dXJuIChhc3luYyAoKSA9PlxuICAgICAgICBuZXcgUmVzcG9uc2UobnVsbCwgYXdhaXQgdGhpcy4jZGlzcGF0Y2gocmVxdWVzdCwgZXhlY3V0aW9uQ3R4LCBlbnYsICdHRVQnKSkpKClcbiAgICB9XG5cbiAgICBjb25zdCBwYXRoID0gdGhpcy5nZXRQYXRoKHJlcXVlc3QsIHsgZW52IH0pXG4gICAgY29uc3QgbWF0Y2hSZXN1bHQgPSB0aGlzLnJvdXRlci5tYXRjaChtZXRob2QsIHBhdGgpXG5cbiAgICBjb25zdCBjID0gbmV3IENvbnRleHQocmVxdWVzdCwge1xuICAgICAgcGF0aCxcbiAgICAgIG1hdGNoUmVzdWx0LFxuICAgICAgZW52LFxuICAgICAgZXhlY3V0aW9uQ3R4LFxuICAgICAgbm90Rm91bmRIYW5kbGVyOiB0aGlzLiNub3RGb3VuZEhhbmRsZXIsXG4gICAgfSlcblxuICAgIC8vIERvIG5vdCBgY29tcG9zZWAgaWYgaXQgaGFzIG9ubHkgb25lIGhhbmRsZXJcbiAgICBpZiAobWF0Y2hSZXN1bHRbMF0ubGVuZ3RoID09PSAxKSB7XG4gICAgICBsZXQgcmVzOiBSZXR1cm5UeXBlPEg+XG4gICAgICB0cnkge1xuICAgICAgICByZXMgPSBtYXRjaFJlc3VsdFswXVswXVswXVswXShjLCBhc3luYyAoKSA9PiB7XG4gICAgICAgICAgYy5yZXMgPSBhd2FpdCB0aGlzLiNub3RGb3VuZEhhbmRsZXIoYylcbiAgICAgICAgfSlcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICByZXR1cm4gdGhpcy4jaGFuZGxlRXJyb3IoZXJyLCBjKVxuICAgICAgfVxuXG4gICAgICByZXR1cm4gcmVzIGluc3RhbmNlb2YgUHJvbWlzZVxuICAgICAgICA/IHJlc1xuICAgICAgICAgICAgLnRoZW4oXG4gICAgICAgICAgICAgIChyZXNvbHZlZDogUmVzcG9uc2UgfCB1bmRlZmluZWQpID0+XG4gICAgICAgICAgICAgICAgcmVzb2x2ZWQgfHwgKGMuZmluYWxpemVkID8gYy5yZXMgOiB0aGlzLiNub3RGb3VuZEhhbmRsZXIoYykpXG4gICAgICAgICAgICApXG4gICAgICAgICAgICAuY2F0Y2goKGVycjogRXJyb3IpID0+IHRoaXMuI2hhbmRsZUVycm9yKGVyciwgYykpXG4gICAgICAgIDogKHJlcyA/PyB0aGlzLiNub3RGb3VuZEhhbmRsZXIoYykpXG4gICAgfVxuXG4gICAgY29uc3QgY29tcG9zZWQgPSBjb21wb3NlKG1hdGNoUmVzdWx0WzBdLCB0aGlzLmVycm9ySGFuZGxlciwgdGhpcy4jbm90Rm91bmRIYW5kbGVyKVxuXG4gICAgcmV0dXJuIChhc3luYyAoKSA9PiB7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBjb250ZXh0ID0gYXdhaXQgY29tcG9zZWQoYylcbiAgICAgICAgaWYgKCFjb250ZXh0LmZpbmFsaXplZCkge1xuICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgICdDb250ZXh0IGlzIG5vdCBmaW5hbGl6ZWQuIERpZCB5b3UgZm9yZ2V0IHRvIHJldHVybiBhIFJlc3BvbnNlIG9iamVjdCBvciBgYXdhaXQgbmV4dCgpYD8nXG4gICAgICAgICAgKVxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGNvbnRleHQucmVzXG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgcmV0dXJuIHRoaXMuI2hhbmRsZUVycm9yKGVyciwgYylcbiAgICAgIH1cbiAgICB9KSgpXG4gIH1cblxuICAvKipcbiAgICogYC5mZXRjaCgpYCB3aWxsIGJlIGVudHJ5IHBvaW50IG9mIHlvdXIgYXBwLlxuICAgKlxuICAgKiBAc2VlIHtAbGluayBodHRwczovL2hvbm8uZGV2L2RvY3MvYXBpL2hvbm8jZmV0Y2h9XG4gICAqXG4gICAqIEBwYXJhbSB7UmVxdWVzdH0gcmVxdWVzdCAtIHJlcXVlc3QgT2JqZWN0IG9mIHJlcXVlc3RcbiAgICogQHBhcmFtIHtFbnZ9IEVudiAtIGVudiBPYmplY3RcbiAgICogQHBhcmFtIHtFeGVjdXRpb25Db250ZXh0fSAtIGNvbnRleHQgb2YgZXhlY3V0aW9uXG4gICAqIEByZXR1cm5zIHtSZXNwb25zZSB8IFByb21pc2U8UmVzcG9uc2U+fSByZXNwb25zZSBvZiByZXF1ZXN0XG4gICAqXG4gICAqL1xuICBmZXRjaDogKFxuICAgIHJlcXVlc3Q6IFJlcXVlc3QsXG4gICAgRW52PzogRVsnQmluZGluZ3MnXSB8IHt9LFxuICAgIGV4ZWN1dGlvbkN0eD86IEV4ZWN1dGlvbkNvbnRleHRcbiAgKSA9PiBSZXNwb25zZSB8IFByb21pc2U8UmVzcG9uc2U+ID0gKHJlcXVlc3QsIC4uLnJlc3QpID0+IHtcbiAgICByZXR1cm4gdGhpcy4jZGlzcGF0Y2gocmVxdWVzdCwgcmVzdFsxXSwgcmVzdFswXSwgcmVxdWVzdC5tZXRob2QpXG4gIH1cblxuICAvKipcbiAgICogYC5yZXF1ZXN0KClgIGlzIGEgdXNlZnVsIG1ldGhvZCBmb3IgdGVzdGluZy5cbiAgICogWW91IGNhbiBwYXNzIGEgVVJMIG9yIHBhdGhuYW1lIHRvIHNlbmQgYSBHRVQgcmVxdWVzdC5cbiAgICogYXBwIHdpbGwgcmV0dXJuIGEgUmVzcG9uc2Ugb2JqZWN0LlxuICAgKiBgYGB0c1xuICAgKiB0ZXN0KCdHRVQgL2hlbGxvIGlzIG9rJywgYXN5bmMgKCkgPT4ge1xuICAgKiAgIGNvbnN0IHJlcyA9IGF3YWl0IGFwcC5yZXF1ZXN0KCcvaGVsbG8nKVxuICAgKiAgIGV4cGVjdChyZXMuc3RhdHVzKS50b0JlKDIwMClcbiAgICogfSlcbiAgICogYGBgXG4gICAqIEBzZWUgaHR0cHM6Ly9ob25vLmRldi9kb2NzL2FwaS9ob25vI3JlcXVlc3RcbiAgICovXG4gIHJlcXVlc3QgPSAoXG4gICAgaW5wdXQ6IFJlcXVlc3QgfCBzdHJpbmcgfCBVUkwsXG4gICAgcmVxdWVzdEluaXQ/OiBSZXF1ZXN0SW5pdCxcbiAgICBFbnY/OiBFWydCaW5kaW5ncyddIHwge30sXG4gICAgZXhlY3V0aW9uQ3R4PzogRXhlY3V0aW9uQ29udGV4dFxuICApOiBSZXNwb25zZSB8IFByb21pc2U8UmVzcG9uc2U+ID0+IHtcbiAgICBpZiAoaW5wdXQgaW5zdGFuY2VvZiBSZXF1ZXN0KSB7XG4gICAgICByZXR1cm4gdGhpcy5mZXRjaChyZXF1ZXN0SW5pdCA/IG5ldyBSZXF1ZXN0KGlucHV0LCByZXF1ZXN0SW5pdCkgOiBpbnB1dCwgRW52LCBleGVjdXRpb25DdHgpXG4gICAgfVxuICAgIGlucHV0ID0gaW5wdXQudG9TdHJpbmcoKVxuICAgIHJldHVybiB0aGlzLmZldGNoKFxuICAgICAgbmV3IFJlcXVlc3QoXG4gICAgICAgIC9eaHR0cHM/OlxcL1xcLy8udGVzdChpbnB1dCkgPyBpbnB1dCA6IGBodHRwOi8vbG9jYWxob3N0JHttZXJnZVBhdGgoJy8nLCBpbnB1dCl9YCxcbiAgICAgICAgcmVxdWVzdEluaXRcbiAgICAgICksXG4gICAgICBFbnYsXG4gICAgICBleGVjdXRpb25DdHhcbiAgICApXG4gIH1cblxuICAvKipcbiAgICogYC5maXJlKClgIGF1dG9tYXRpY2FsbHkgYWRkcyBhIGdsb2JhbCBmZXRjaCBldmVudCBsaXN0ZW5lci5cbiAgICogVGhpcyBjYW4gYmUgdXNlZnVsIGZvciBlbnZpcm9ubWVudHMgdGhhdCBhZGhlcmUgdG8gdGhlIFNlcnZpY2UgV29ya2VyIEFQSSwgc3VjaCBhcyBub24tRVMgbW9kdWxlIENsb3VkZmxhcmUgV29ya2Vycy5cbiAgICogQGRlcHJlY2F0ZWRcbiAgICogVXNlIGBmaXJlYCBmcm9tIGBob25vL3NlcnZpY2Utd29ya2VyYCBpbnN0ZWFkLlxuICAgKiBgYGB0c1xuICAgKiBpbXBvcnQgeyBIb25vIH0gZnJvbSAnaG9ubydcbiAgICogaW1wb3J0IHsgZmlyZSB9IGZyb20gJ2hvbm8vc2VydmljZS13b3JrZXInXG4gICAqXG4gICAqIGNvbnN0IGFwcCA9IG5ldyBIb25vKClcbiAgICogLy8gLi4uXG4gICAqIGZpcmUoYXBwKVxuICAgKiBgYGBcbiAgICogQHNlZSBodHRwczovL2hvbm8uZGV2L2RvY3MvYXBpL2hvbm8jZmlyZVxuICAgKiBAc2VlIGh0dHBzOi8vZGV2ZWxvcGVyLm1vemlsbGEub3JnL2VuLVVTL2RvY3MvV2ViL0FQSS9TZXJ2aWNlX1dvcmtlcl9BUElcbiAgICogQHNlZSBodHRwczovL2RldmVsb3BlcnMuY2xvdWRmbGFyZS5jb20vd29ya2Vycy9yZWZlcmVuY2UvbWlncmF0ZS10by1tb2R1bGUtd29ya2Vycy9cbiAgICovXG4gIGZpcmUgPSAoKTogdm9pZCA9PiB7XG4gICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIEB0eXBlc2NyaXB0LWVzbGludC9iYW4tdHMtY29tbWVudFxuICAgIC8vIEB0cy1pZ25vcmVcbiAgICBhZGRFdmVudExpc3RlbmVyKCdmZXRjaCcsIChldmVudDogRmV0Y2hFdmVudExpa2UpOiB2b2lkID0+IHtcbiAgICAgIGV2ZW50LnJlc3BvbmRXaXRoKHRoaXMuI2Rpc3BhdGNoKGV2ZW50LnJlcXVlc3QsIGV2ZW50LCB1bmRlZmluZWQsIGV2ZW50LnJlcXVlc3QubWV0aG9kKSlcbiAgICB9KVxuICB9XG59XG5cbmV4cG9ydCB7IEhvbm8gYXMgSG9ub0Jhc2UgfVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Q0FHQyxHQUVELHFEQUFxRCxHQUNyRCxTQUFTLE9BQU8sUUFBUSxlQUFjO0FBQ3RDLFNBQVMsT0FBTyxRQUFRLGVBQWM7QUFHdEMsU0FBUyxPQUFPLEVBQUUsZUFBZSxFQUFFLHlCQUF5QixRQUFRLGNBQWE7QUFpQmpGLFNBQVMsZ0JBQWdCLFFBQVEsdUJBQXNCO0FBQ3ZE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
// denoCacheMetadata=18189455377717253158,746979212885410904