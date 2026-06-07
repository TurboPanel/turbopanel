import { replaceUrlParam } from '../../client/utils.ts';
import { createPool } from '../../utils/concurrent.ts';
import { getExtension } from '../../utils/mime.ts';
import { SSG_CONTEXT, X_HONO_DISABLE_SSG_HEADER_KEY } from './middleware.ts';
import { defaultPlugin } from './plugins.ts';
import { dirname, ensureWithinOutDir, filterStaticGenerateRoutes, isDynamicRoute, joinPaths } from './utils.ts';
const DEFAULT_CONCURRENCY = 2 // default concurrency for ssg
;
// 'default_content_type' is designed according to Bun's performance optimization,
//  which omits Content-Type by default for text responses.
//  This is based on benchmarks showing performance gains without Content-Type.
//  In Hono, using `c.text()` without a Content-Type implicitly assumes 'text/plain; charset=UTF-8'.
//  This approach maintains performance consistency across different environments.
//  For details, see GitHub issues: oven-sh/bun#8530 and https://github.com/honojs/hono/issues/2284.
const DEFAULT_CONTENT_TYPE = 'text/plain';
export const DEFAULT_OUTPUT_DIR = './static';
const generateFilePath = (routePath, outDir, mimeType, extensionMap)=>{
  const extension = determineExtension(mimeType, extensionMap);
  let filePath;
  if (routePath.endsWith(`.${extension}`)) {
    filePath = joinPaths(outDir, routePath);
  } else if (routePath === '/') {
    filePath = joinPaths(outDir, `index.${extension}`);
  } else if (routePath.endsWith('/')) {
    filePath = joinPaths(outDir, routePath, `index.${extension}`);
  } else {
    filePath = joinPaths(outDir, `${routePath}.${extension}`);
  }
  ensureWithinOutDir(outDir, filePath);
  return filePath;
};
const parseResponseContent = async (response)=>{
  const contentType = response.headers.get('Content-Type');
  try {
    if (contentType?.includes('text') || contentType?.includes('json')) {
      return await response.text();
    } else {
      return await response.arrayBuffer();
    }
  } catch (error) {
    throw new Error(`Error processing response: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
};
export const defaultExtensionMap = {
  'text/html': 'html',
  'text/xml': 'xml',
  'application/xml': 'xml',
  'application/atom+xml': 'xml',
  'application/rss+xml': 'xml',
  'application/yaml': 'yaml'
};
const determineExtension = (mimeType, userExtensionMap)=>{
  const extensionMap = userExtensionMap || defaultExtensionMap;
  if (mimeType in extensionMap) {
    return extensionMap[mimeType];
  }
  return getExtension(mimeType) || 'html';
};
export const combineBeforeRequestHooks = (hooks)=>{
  if (!Array.isArray(hooks)) {
    return hooks;
  }
  return async (req)=>{
    let currentReq = req;
    for (const hook of hooks){
      const result = await hook(currentReq);
      if (result === false) {
        return false;
      }
      if (result instanceof Request) {
        currentReq = result;
      }
    }
    return currentReq;
  };
};
export const combineAfterResponseHooks = (hooks)=>{
  if (!Array.isArray(hooks)) {
    return hooks;
  }
  return async (res)=>{
    let currentRes = res;
    for (const hook of hooks){
      const result = await hook(currentRes);
      if (result === false) {
        return false;
      }
      if (result instanceof Response) {
        currentRes = result;
      }
    }
    return currentRes;
  };
};
export const combineAfterGenerateHooks = (hooks, fsModule, options)=>{
  if (!Array.isArray(hooks)) {
    return hooks;
  }
  return async (result)=>{
    for (const hook of hooks){
      await hook(result, fsModule, options);
    }
  };
};
/**
 * @experimental
 * `fetchRoutesContent` is an experimental feature.
 * The API might be changed.
 */ export const fetchRoutesContent = function*(app, beforeRequestHook, afterResponseHook, concurrency) {
  const baseURL = 'http://localhost';
  const pool = createPool({
    concurrency
  });
  for (const route of filterStaticGenerateRoutes(app)){
    // GET Route Info
    const thisRouteBaseURL = new URL(route.path, baseURL).toString();
    let forGetInfoURLRequest = new Request(thisRouteBaseURL);
    // eslint-disable-next-line no-async-promise-executor
    yield new Promise(async (resolveGetInfo, rejectGetInfo)=>{
      try {
        if (beforeRequestHook) {
          const maybeRequest = await beforeRequestHook(forGetInfoURLRequest);
          if (!maybeRequest) {
            resolveGetInfo(undefined);
            return;
          }
          forGetInfoURLRequest = maybeRequest;
        }
        await pool.run(()=>app.fetch(forGetInfoURLRequest, {
            [SSG_CONTEXT]: true
          }));
        if (!forGetInfoURLRequest.ssgParams) {
          if (isDynamicRoute(route.path)) {
            resolveGetInfo(undefined);
            return;
          }
          forGetInfoURLRequest.ssgParams = [
            {}
          ];
        }
        const requestInit = {
          method: forGetInfoURLRequest.method,
          headers: forGetInfoURLRequest.headers
        };
        resolveGetInfo(function*() {
          for (const param of forGetInfoURLRequest.ssgParams){
            // eslint-disable-next-line no-async-promise-executor
            yield new Promise(async (resolveReq, rejectReq)=>{
              try {
                const replacedUrlParam = replaceUrlParam(route.path, param);
                let response = await pool.run(()=>app.request(replacedUrlParam, requestInit, {
                    [SSG_CONTEXT]: true
                  }));
                if (response.headers.get(X_HONO_DISABLE_SSG_HEADER_KEY)) {
                  resolveReq(undefined);
                  return;
                }
                if (afterResponseHook) {
                  const maybeResponse = await afterResponseHook(response);
                  if (!maybeResponse) {
                    resolveReq(undefined);
                    return;
                  }
                  response = maybeResponse;
                }
                const mimeType = response.headers.get('Content-Type')?.split(';')[0] || DEFAULT_CONTENT_TYPE;
                const content = await parseResponseContent(response);
                resolveReq({
                  routePath: replacedUrlParam,
                  mimeType,
                  content
                });
              } catch (error) {
                rejectReq(error);
              }
            });
          }
        }());
      } catch (error) {
        rejectGetInfo(error);
      }
    });
  }
};
/**
 * @experimental
 * `saveContentToFile` is an experimental feature.
 * The API might be changed.
 */ const createdDirs = new Set();
export const saveContentToFile = async (data, fsModule, outDir, extensionMap)=>{
  const awaitedData = await data;
  if (!awaitedData) {
    return;
  }
  const { routePath, content, mimeType } = awaitedData;
  const filePath = generateFilePath(routePath, outDir, mimeType, extensionMap);
  const dirPath = dirname(filePath);
  if (!createdDirs.has(dirPath)) {
    await fsModule.mkdir(dirPath, {
      recursive: true
    });
    createdDirs.add(dirPath);
  }
  if (typeof content === 'string') {
    await fsModule.writeFile(filePath, content);
  } else if (content instanceof ArrayBuffer) {
    await fsModule.writeFile(filePath, new Uint8Array(content));
  }
  return filePath;
};
/**
 * @experimental
 * `toSSG` is an experimental feature.
 * The API might be changed.
 */ export const toSSG = async (app, fs, options)=>{
  let result;
  const getInfoPromises = [];
  const savePromises = [];
  const plugins = options?.plugins || [
    defaultPlugin()
  ];
  const beforeRequestHooks = [];
  const afterResponseHooks = [];
  const afterGenerateHooks = [];
  if (options?.beforeRequestHook) {
    beforeRequestHooks.push(...Array.isArray(options.beforeRequestHook) ? options.beforeRequestHook : [
      options.beforeRequestHook
    ]);
  }
  if (options?.afterResponseHook) {
    afterResponseHooks.push(...Array.isArray(options.afterResponseHook) ? options.afterResponseHook : [
      options.afterResponseHook
    ]);
  }
  if (options?.afterGenerateHook) {
    afterGenerateHooks.push(...Array.isArray(options.afterGenerateHook) ? options.afterGenerateHook : [
      options.afterGenerateHook
    ]);
  }
  for (const plugin of plugins){
    if (plugin.beforeRequestHook) {
      beforeRequestHooks.push(...Array.isArray(plugin.beforeRequestHook) ? plugin.beforeRequestHook : [
        plugin.beforeRequestHook
      ]);
    }
    if (plugin.afterResponseHook) {
      afterResponseHooks.push(...Array.isArray(plugin.afterResponseHook) ? plugin.afterResponseHook : [
        plugin.afterResponseHook
      ]);
    }
    if (plugin.afterGenerateHook) {
      afterGenerateHooks.push(...Array.isArray(plugin.afterGenerateHook) ? plugin.afterGenerateHook : [
        plugin.afterGenerateHook
      ]);
    }
  }
  try {
    const outputDir = options?.dir ?? DEFAULT_OUTPUT_DIR;
    const concurrency = options?.concurrency ?? DEFAULT_CONCURRENCY;
    const combinedBeforeRequestHook = combineBeforeRequestHooks(beforeRequestHooks.length > 0 ? beforeRequestHooks : [
      (req)=>req
    ]);
    const combinedAfterResponseHook = combineAfterResponseHooks(afterResponseHooks.length > 0 ? afterResponseHooks : [
      (req)=>req
    ]);
    const getInfoGen = fetchRoutesContent(app, combinedBeforeRequestHook, combinedAfterResponseHook, concurrency);
    for (const getInfo of getInfoGen){
      getInfoPromises.push(getInfo.then((getContentGen)=>{
        if (!getContentGen) {
          return;
        }
        for (const content of getContentGen){
          savePromises.push(saveContentToFile(content, fs, outputDir, options?.extensionMap).catch((e)=>e));
        }
      }));
    }
    await Promise.all(getInfoPromises);
    const files = [];
    for (const savePromise of savePromises){
      const fileOrError = await savePromise;
      if (typeof fileOrError === 'string') {
        files.push(fileOrError);
      } else if (fileOrError) {
        throw fileOrError;
      }
    }
    result = {
      success: true,
      files
    };
  } catch (error) {
    const errorObj = error instanceof Error ? error : new Error(String(error));
    result = {
      success: false,
      files: [],
      error: errorObj
    };
  }
  if (afterGenerateHooks.length > 0) {
    const combinedAfterGenerateHooks = combineAfterGenerateHooks(afterGenerateHooks, fs, options);
    await combinedAfterGenerateHooks(result, fs, options);
  }
  return result;
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0Bob25vL2hvbm8vNC4xMi4yMy9zcmMvaGVscGVyL3NzZy9zc2cudHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgcmVwbGFjZVVybFBhcmFtIH0gZnJvbSAnLi4vLi4vY2xpZW50L3V0aWxzLnRzJ1xuaW1wb3J0IHR5cGUgeyBIb25vIH0gZnJvbSAnLi4vLi4vaG9uby50cydcbmltcG9ydCB0eXBlIHsgRW52LCBTY2hlbWEgfSBmcm9tICcuLi8uLi90eXBlcy50cydcbmltcG9ydCB7IGNyZWF0ZVBvb2wgfSBmcm9tICcuLi8uLi91dGlscy9jb25jdXJyZW50LnRzJ1xuaW1wb3J0IHsgZ2V0RXh0ZW5zaW9uIH0gZnJvbSAnLi4vLi4vdXRpbHMvbWltZS50cydcbmltcG9ydCB0eXBlIHsgQWRkZWRTU0dEYXRhUmVxdWVzdCwgU1NHUGFyYW1zIH0gZnJvbSAnLi9taWRkbGV3YXJlLnRzJ1xuaW1wb3J0IHsgU1NHX0NPTlRFWFQsIFhfSE9OT19ESVNBQkxFX1NTR19IRUFERVJfS0VZIH0gZnJvbSAnLi9taWRkbGV3YXJlLnRzJ1xuaW1wb3J0IHsgZGVmYXVsdFBsdWdpbiB9IGZyb20gJy4vcGx1Z2lucy50cydcbmltcG9ydCB7XG4gIGRpcm5hbWUsXG4gIGVuc3VyZVdpdGhpbk91dERpcixcbiAgZmlsdGVyU3RhdGljR2VuZXJhdGVSb3V0ZXMsXG4gIGlzRHluYW1pY1JvdXRlLFxuICBqb2luUGF0aHMsXG59IGZyb20gJy4vdXRpbHMudHMnXG5cbmNvbnN0IERFRkFVTFRfQ09OQ1VSUkVOQ1kgPSAyIC8vIGRlZmF1bHQgY29uY3VycmVuY3kgZm9yIHNzZ1xuXG4vLyAnZGVmYXVsdF9jb250ZW50X3R5cGUnIGlzIGRlc2lnbmVkIGFjY29yZGluZyB0byBCdW4ncyBwZXJmb3JtYW5jZSBvcHRpbWl6YXRpb24sXG4vLyAgd2hpY2ggb21pdHMgQ29udGVudC1UeXBlIGJ5IGRlZmF1bHQgZm9yIHRleHQgcmVzcG9uc2VzLlxuLy8gIFRoaXMgaXMgYmFzZWQgb24gYmVuY2htYXJrcyBzaG93aW5nIHBlcmZvcm1hbmNlIGdhaW5zIHdpdGhvdXQgQ29udGVudC1UeXBlLlxuLy8gIEluIEhvbm8sIHVzaW5nIGBjLnRleHQoKWAgd2l0aG91dCBhIENvbnRlbnQtVHlwZSBpbXBsaWNpdGx5IGFzc3VtZXMgJ3RleHQvcGxhaW47IGNoYXJzZXQ9VVRGLTgnLlxuLy8gIFRoaXMgYXBwcm9hY2ggbWFpbnRhaW5zIHBlcmZvcm1hbmNlIGNvbnNpc3RlbmN5IGFjcm9zcyBkaWZmZXJlbnQgZW52aXJvbm1lbnRzLlxuLy8gIEZvciBkZXRhaWxzLCBzZWUgR2l0SHViIGlzc3Vlczogb3Zlbi1zaC9idW4jODUzMCBhbmQgaHR0cHM6Ly9naXRodWIuY29tL2hvbm9qcy9ob25vL2lzc3Vlcy8yMjg0LlxuY29uc3QgREVGQVVMVF9DT05URU5UX1RZUEUgPSAndGV4dC9wbGFpbidcblxuZXhwb3J0IGNvbnN0IERFRkFVTFRfT1VUUFVUX0RJUiA9ICcuL3N0YXRpYydcblxuLyoqXG4gKiBAZXhwZXJpbWVudGFsXG4gKiBgRmlsZVN5c3RlbU1vZHVsZWAgaXMgYW4gZXhwZXJpbWVudGFsIGZlYXR1cmUuXG4gKiBUaGUgQVBJIG1pZ2h0IGJlIGNoYW5nZWQuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgRmlsZVN5c3RlbU1vZHVsZSB7XG4gIHdyaXRlRmlsZShwYXRoOiBzdHJpbmcsIGRhdGE6IHN0cmluZyB8IFVpbnQ4QXJyYXkpOiBQcm9taXNlPHZvaWQ+XG4gIG1rZGlyKHBhdGg6IHN0cmluZywgb3B0aW9uczogeyByZWN1cnNpdmU6IGJvb2xlYW4gfSk6IFByb21pc2U8dm9pZCB8IHN0cmluZz5cbn1cblxuLyoqXG4gKiBAZXhwZXJpbWVudGFsXG4gKiBgVG9TU0dSZXN1bHRgIGlzIGFuIGV4cGVyaW1lbnRhbCBmZWF0dXJlLlxuICogVGhlIEFQSSBtaWdodCBiZSBjaGFuZ2VkLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIFRvU1NHUmVzdWx0IHtcbiAgc3VjY2VzczogYm9vbGVhblxuICBmaWxlczogc3RyaW5nW11cbiAgZXJyb3I/OiBFcnJvclxufVxuXG5jb25zdCBnZW5lcmF0ZUZpbGVQYXRoID0gKFxuICByb3V0ZVBhdGg6IHN0cmluZyxcbiAgb3V0RGlyOiBzdHJpbmcsXG4gIG1pbWVUeXBlOiBzdHJpbmcsXG4gIGV4dGVuc2lvbk1hcD86IFJlY29yZDxzdHJpbmcsIHN0cmluZz5cbik6IHN0cmluZyA9PiB7XG4gIGNvbnN0IGV4dGVuc2lvbiA9IGRldGVybWluZUV4dGVuc2lvbihtaW1lVHlwZSwgZXh0ZW5zaW9uTWFwKVxuXG4gIGxldCBmaWxlUGF0aDogc3RyaW5nXG4gIGlmIChyb3V0ZVBhdGguZW5kc1dpdGgoYC4ke2V4dGVuc2lvbn1gKSkge1xuICAgIGZpbGVQYXRoID0gam9pblBhdGhzKG91dERpciwgcm91dGVQYXRoKVxuICB9IGVsc2UgaWYgKHJvdXRlUGF0aCA9PT0gJy8nKSB7XG4gICAgZmlsZVBhdGggPSBqb2luUGF0aHMob3V0RGlyLCBgaW5kZXguJHtleHRlbnNpb259YClcbiAgfSBlbHNlIGlmIChyb3V0ZVBhdGguZW5kc1dpdGgoJy8nKSkge1xuICAgIGZpbGVQYXRoID0gam9pblBhdGhzKG91dERpciwgcm91dGVQYXRoLCBgaW5kZXguJHtleHRlbnNpb259YClcbiAgfSBlbHNlIHtcbiAgICBmaWxlUGF0aCA9IGpvaW5QYXRocyhvdXREaXIsIGAke3JvdXRlUGF0aH0uJHtleHRlbnNpb259YClcbiAgfVxuXG4gIGVuc3VyZVdpdGhpbk91dERpcihvdXREaXIsIGZpbGVQYXRoKVxuXG4gIHJldHVybiBmaWxlUGF0aFxufVxuXG5jb25zdCBwYXJzZVJlc3BvbnNlQ29udGVudCA9IGFzeW5jIChyZXNwb25zZTogUmVzcG9uc2UpOiBQcm9taXNlPHN0cmluZyB8IEFycmF5QnVmZmVyPiA9PiB7XG4gIGNvbnN0IGNvbnRlbnRUeXBlID0gcmVzcG9uc2UuaGVhZGVycy5nZXQoJ0NvbnRlbnQtVHlwZScpXG5cbiAgdHJ5IHtcbiAgICBpZiAoY29udGVudFR5cGU/LmluY2x1ZGVzKCd0ZXh0JykgfHwgY29udGVudFR5cGU/LmluY2x1ZGVzKCdqc29uJykpIHtcbiAgICAgIHJldHVybiBhd2FpdCByZXNwb25zZS50ZXh0KClcbiAgICB9IGVsc2Uge1xuICAgICAgcmV0dXJuIGF3YWl0IHJlc3BvbnNlLmFycmF5QnVmZmVyKClcbiAgICB9XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYEVycm9yIHByb2Nlc3NpbmcgcmVzcG9uc2U6ICR7ZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiAnVW5rbm93biBlcnJvcid9YFxuICAgIClcbiAgfVxufVxuXG5leHBvcnQgY29uc3QgZGVmYXVsdEV4dGVuc2lvbk1hcDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgJ3RleHQvaHRtbCc6ICdodG1sJyxcbiAgJ3RleHQveG1sJzogJ3htbCcsXG4gICdhcHBsaWNhdGlvbi94bWwnOiAneG1sJyxcbiAgJ2FwcGxpY2F0aW9uL2F0b20reG1sJzogJ3htbCcsXG4gICdhcHBsaWNhdGlvbi9yc3MreG1sJzogJ3htbCcsXG4gICdhcHBsaWNhdGlvbi95YW1sJzogJ3lhbWwnLFxufVxuXG5jb25zdCBkZXRlcm1pbmVFeHRlbnNpb24gPSAoXG4gIG1pbWVUeXBlOiBzdHJpbmcsXG4gIHVzZXJFeHRlbnNpb25NYXA/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+XG4pOiBzdHJpbmcgPT4ge1xuICBjb25zdCBleHRlbnNpb25NYXAgPSB1c2VyRXh0ZW5zaW9uTWFwIHx8IGRlZmF1bHRFeHRlbnNpb25NYXBcbiAgaWYgKG1pbWVUeXBlIGluIGV4dGVuc2lvbk1hcCkge1xuICAgIHJldHVybiBleHRlbnNpb25NYXBbbWltZVR5cGVdXG4gIH1cbiAgcmV0dXJuIGdldEV4dGVuc2lvbihtaW1lVHlwZSkgfHwgJ2h0bWwnXG59XG5cbmV4cG9ydCB0eXBlIEJlZm9yZVJlcXVlc3RIb29rID0gKHJlcTogUmVxdWVzdCkgPT4gUmVxdWVzdCB8IGZhbHNlIHwgUHJvbWlzZTxSZXF1ZXN0IHwgZmFsc2U+XG5leHBvcnQgdHlwZSBBZnRlclJlc3BvbnNlSG9vayA9IChyZXM6IFJlc3BvbnNlKSA9PiBSZXNwb25zZSB8IGZhbHNlIHwgUHJvbWlzZTxSZXNwb25zZSB8IGZhbHNlPlxuZXhwb3J0IHR5cGUgQWZ0ZXJHZW5lcmF0ZUhvb2sgPSAoXG4gIHJlc3VsdDogVG9TU0dSZXN1bHQsXG4gIGZzTW9kdWxlOiBGaWxlU3lzdGVtTW9kdWxlLFxuICBvcHRpb25zPzogVG9TU0dPcHRpb25zXG4pID0+IHZvaWQgfCBQcm9taXNlPHZvaWQ+XG5cbmV4cG9ydCBjb25zdCBjb21iaW5lQmVmb3JlUmVxdWVzdEhvb2tzID0gKFxuICBob29rczogQmVmb3JlUmVxdWVzdEhvb2sgfCBCZWZvcmVSZXF1ZXN0SG9va1tdXG4pOiBCZWZvcmVSZXF1ZXN0SG9vayA9PiB7XG4gIGlmICghQXJyYXkuaXNBcnJheShob29rcykpIHtcbiAgICByZXR1cm4gaG9va3NcbiAgfVxuICByZXR1cm4gYXN5bmMgKHJlcTogUmVxdWVzdCk6IFByb21pc2U8UmVxdWVzdCB8IGZhbHNlPiA9PiB7XG4gICAgbGV0IGN1cnJlbnRSZXEgPSByZXFcbiAgICBmb3IgKGNvbnN0IGhvb2sgb2YgaG9va3MpIHtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGhvb2soY3VycmVudFJlcSlcbiAgICAgIGlmIChyZXN1bHQgPT09IGZhbHNlKSB7XG4gICAgICAgIHJldHVybiBmYWxzZVxuICAgICAgfVxuICAgICAgaWYgKHJlc3VsdCBpbnN0YW5jZW9mIFJlcXVlc3QpIHtcbiAgICAgICAgY3VycmVudFJlcSA9IHJlc3VsdFxuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gY3VycmVudFJlcVxuICB9XG59XG5cbmV4cG9ydCBjb25zdCBjb21iaW5lQWZ0ZXJSZXNwb25zZUhvb2tzID0gKFxuICBob29rczogQWZ0ZXJSZXNwb25zZUhvb2sgfCBBZnRlclJlc3BvbnNlSG9va1tdXG4pOiBBZnRlclJlc3BvbnNlSG9vayA9PiB7XG4gIGlmICghQXJyYXkuaXNBcnJheShob29rcykpIHtcbiAgICByZXR1cm4gaG9va3NcbiAgfVxuICByZXR1cm4gYXN5bmMgKHJlczogUmVzcG9uc2UpOiBQcm9taXNlPFJlc3BvbnNlIHwgZmFsc2U+ID0+IHtcbiAgICBsZXQgY3VycmVudFJlcyA9IHJlc1xuICAgIGZvciAoY29uc3QgaG9vayBvZiBob29rcykge1xuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgaG9vayhjdXJyZW50UmVzKVxuICAgICAgaWYgKHJlc3VsdCA9PT0gZmFsc2UpIHtcbiAgICAgICAgcmV0dXJuIGZhbHNlXG4gICAgICB9XG4gICAgICBpZiAocmVzdWx0IGluc3RhbmNlb2YgUmVzcG9uc2UpIHtcbiAgICAgICAgY3VycmVudFJlcyA9IHJlc3VsdFxuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gY3VycmVudFJlc1xuICB9XG59XG5cbmV4cG9ydCBjb25zdCBjb21iaW5lQWZ0ZXJHZW5lcmF0ZUhvb2tzID0gKFxuICBob29rczogQWZ0ZXJHZW5lcmF0ZUhvb2sgfCBBZnRlckdlbmVyYXRlSG9va1tdLFxuICBmc01vZHVsZTogRmlsZVN5c3RlbU1vZHVsZSxcbiAgb3B0aW9ucz86IFRvU1NHT3B0aW9uc1xuKTogQWZ0ZXJHZW5lcmF0ZUhvb2sgPT4ge1xuICBpZiAoIUFycmF5LmlzQXJyYXkoaG9va3MpKSB7XG4gICAgcmV0dXJuIGhvb2tzXG4gIH1cbiAgcmV0dXJuIGFzeW5jIChyZXN1bHQ6IFRvU1NHUmVzdWx0KTogUHJvbWlzZTx2b2lkPiA9PiB7XG4gICAgZm9yIChjb25zdCBob29rIG9mIGhvb2tzKSB7XG4gICAgICBhd2FpdCBob29rKHJlc3VsdCwgZnNNb2R1bGUsIG9wdGlvbnMpXG4gICAgfVxuICB9XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgU1NHUGx1Z2luIHtcbiAgYmVmb3JlUmVxdWVzdEhvb2s/OiBCZWZvcmVSZXF1ZXN0SG9vayB8IEJlZm9yZVJlcXVlc3RIb29rW11cbiAgYWZ0ZXJSZXNwb25zZUhvb2s/OiBBZnRlclJlc3BvbnNlSG9vayB8IEFmdGVyUmVzcG9uc2VIb29rW11cbiAgYWZ0ZXJHZW5lcmF0ZUhvb2s/OiBBZnRlckdlbmVyYXRlSG9vayB8IEFmdGVyR2VuZXJhdGVIb29rW11cbn1cblxuZXhwb3J0IGludGVyZmFjZSBUb1NTR09wdGlvbnMge1xuICBkaXI/OiBzdHJpbmdcbiAgLyoqXG4gICAqIEBkZXByZWNhdGVkIFVzZSBwbHVnaW5zW10uYmVmb3JlUmVxdWVzdEhvb2sgaW5zdGVhZC5cbiAgICovXG4gIGJlZm9yZVJlcXVlc3RIb29rPzogQmVmb3JlUmVxdWVzdEhvb2sgfCBCZWZvcmVSZXF1ZXN0SG9va1tdXG4gIC8qKlxuICAgKiBAZGVwcmVjYXRlZCBVc2UgcGx1Z2luc1tdLmFmdGVyUmVzcG9uc2VIb29rIGluc3RlYWQuXG4gICAqL1xuICBhZnRlclJlc3BvbnNlSG9vaz86IEFmdGVyUmVzcG9uc2VIb29rIHwgQWZ0ZXJSZXNwb25zZUhvb2tbXVxuICAvKipcbiAgICogQGRlcHJlY2F0ZWQgVXNlIHBsdWdpbnNbXS5hZnRlckdlbmVyYXRlSG9vayBpbnN0ZWFkLlxuICAgKi9cbiAgYWZ0ZXJHZW5lcmF0ZUhvb2s/OiBBZnRlckdlbmVyYXRlSG9vayB8IEFmdGVyR2VuZXJhdGVIb29rW11cbiAgY29uY3VycmVuY3k/OiBudW1iZXJcbiAgZXh0ZW5zaW9uTWFwPzogUmVjb3JkPHN0cmluZywgc3RyaW5nPlxuICBwbHVnaW5zPzogU1NHUGx1Z2luW11cbn1cblxuLyoqXG4gKiBAZXhwZXJpbWVudGFsXG4gKiBgZmV0Y2hSb3V0ZXNDb250ZW50YCBpcyBhbiBleHBlcmltZW50YWwgZmVhdHVyZS5cbiAqIFRoZSBBUEkgbWlnaHQgYmUgY2hhbmdlZC5cbiAqL1xuZXhwb3J0IGNvbnN0IGZldGNoUm91dGVzQ29udGVudCA9IGZ1bmN0aW9uKiA8XG4gIEUgZXh0ZW5kcyBFbnYgPSBFbnYsXG4gIFMgZXh0ZW5kcyBTY2hlbWEgPSB7fSxcbiAgQmFzZVBhdGggZXh0ZW5kcyBzdHJpbmcgPSAnLycsXG4+KFxuICBhcHA6IEhvbm88RSwgUywgQmFzZVBhdGg+LFxuICBiZWZvcmVSZXF1ZXN0SG9vaz86IEJlZm9yZVJlcXVlc3RIb29rLFxuICBhZnRlclJlc3BvbnNlSG9vaz86IEFmdGVyUmVzcG9uc2VIb29rLFxuICBjb25jdXJyZW5jeT86IG51bWJlclxuKTogR2VuZXJhdG9yPFxuICBQcm9taXNlPFxuICAgIHwgR2VuZXJhdG9yPFxuICAgICAgICBQcm9taXNlPHsgcm91dGVQYXRoOiBzdHJpbmc7IG1pbWVUeXBlOiBzdHJpbmc7IGNvbnRlbnQ6IHN0cmluZyB8IEFycmF5QnVmZmVyIH0gfCB1bmRlZmluZWQ+XG4gICAgICA+XG4gICAgfCB1bmRlZmluZWRcbiAgPlxuPiB7XG4gIGNvbnN0IGJhc2VVUkwgPSAnaHR0cDovL2xvY2FsaG9zdCdcbiAgY29uc3QgcG9vbCA9IGNyZWF0ZVBvb2woeyBjb25jdXJyZW5jeSB9KVxuXG4gIGZvciAoY29uc3Qgcm91dGUgb2YgZmlsdGVyU3RhdGljR2VuZXJhdGVSb3V0ZXMoYXBwKSkge1xuICAgIC8vIEdFVCBSb3V0ZSBJbmZvXG4gICAgY29uc3QgdGhpc1JvdXRlQmFzZVVSTCA9IG5ldyBVUkwocm91dGUucGF0aCwgYmFzZVVSTCkudG9TdHJpbmcoKVxuXG4gICAgbGV0IGZvckdldEluZm9VUkxSZXF1ZXN0ID0gbmV3IFJlcXVlc3QodGhpc1JvdXRlQmFzZVVSTCkgYXMgQWRkZWRTU0dEYXRhUmVxdWVzdFxuXG4gICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIG5vLWFzeW5jLXByb21pc2UtZXhlY3V0b3JcbiAgICB5aWVsZCBuZXcgUHJvbWlzZShhc3luYyAocmVzb2x2ZUdldEluZm8sIHJlamVjdEdldEluZm8pID0+IHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGlmIChiZWZvcmVSZXF1ZXN0SG9vaykge1xuICAgICAgICAgIGNvbnN0IG1heWJlUmVxdWVzdCA9IGF3YWl0IGJlZm9yZVJlcXVlc3RIb29rKGZvckdldEluZm9VUkxSZXF1ZXN0KVxuICAgICAgICAgIGlmICghbWF5YmVSZXF1ZXN0KSB7XG4gICAgICAgICAgICByZXNvbHZlR2V0SW5mbyh1bmRlZmluZWQpXG4gICAgICAgICAgICByZXR1cm5cbiAgICAgICAgICB9XG4gICAgICAgICAgZm9yR2V0SW5mb1VSTFJlcXVlc3QgPSBtYXliZVJlcXVlc3QgYXMgdW5rbm93biBhcyBBZGRlZFNTR0RhdGFSZXF1ZXN0XG4gICAgICAgIH1cblxuICAgICAgICBhd2FpdCBwb29sLnJ1bigoKSA9PiBhcHAuZmV0Y2goZm9yR2V0SW5mb1VSTFJlcXVlc3QsIHsgW1NTR19DT05URVhUXTogdHJ1ZSB9KSlcblxuICAgICAgICBpZiAoIWZvckdldEluZm9VUkxSZXF1ZXN0LnNzZ1BhcmFtcykge1xuICAgICAgICAgIGlmIChpc0R5bmFtaWNSb3V0ZShyb3V0ZS5wYXRoKSkge1xuICAgICAgICAgICAgcmVzb2x2ZUdldEluZm8odW5kZWZpbmVkKVxuICAgICAgICAgICAgcmV0dXJuXG4gICAgICAgICAgfVxuICAgICAgICAgIGZvckdldEluZm9VUkxSZXF1ZXN0LnNzZ1BhcmFtcyA9IFt7fV1cbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHJlcXVlc3RJbml0ID0ge1xuICAgICAgICAgIG1ldGhvZDogZm9yR2V0SW5mb1VSTFJlcXVlc3QubWV0aG9kLFxuICAgICAgICAgIGhlYWRlcnM6IGZvckdldEluZm9VUkxSZXF1ZXN0LmhlYWRlcnMsXG4gICAgICAgIH1cblxuICAgICAgICByZXNvbHZlR2V0SW5mbyhcbiAgICAgICAgICAoZnVuY3Rpb24qICgpIHtcbiAgICAgICAgICAgIGZvciAoY29uc3QgcGFyYW0gb2YgZm9yR2V0SW5mb1VSTFJlcXVlc3Quc3NnUGFyYW1zIGFzIFNTR1BhcmFtcykge1xuICAgICAgICAgICAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgbm8tYXN5bmMtcHJvbWlzZS1leGVjdXRvclxuICAgICAgICAgICAgICB5aWVsZCBuZXcgUHJvbWlzZShhc3luYyAocmVzb2x2ZVJlcSwgcmVqZWN0UmVxKSA9PiB7XG4gICAgICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICAgIGNvbnN0IHJlcGxhY2VkVXJsUGFyYW0gPSByZXBsYWNlVXJsUGFyYW0ocm91dGUucGF0aCwgcGFyYW0pXG4gICAgICAgICAgICAgICAgICBsZXQgcmVzcG9uc2UgPSBhd2FpdCBwb29sLnJ1bigoKSA9PlxuICAgICAgICAgICAgICAgICAgICBhcHAucmVxdWVzdChyZXBsYWNlZFVybFBhcmFtLCByZXF1ZXN0SW5pdCwge1xuICAgICAgICAgICAgICAgICAgICAgIFtTU0dfQ09OVEVYVF06IHRydWUsXG4gICAgICAgICAgICAgICAgICAgIH0pXG4gICAgICAgICAgICAgICAgICApXG4gICAgICAgICAgICAgICAgICBpZiAocmVzcG9uc2UuaGVhZGVycy5nZXQoWF9IT05PX0RJU0FCTEVfU1NHX0hFQURFUl9LRVkpKSB7XG4gICAgICAgICAgICAgICAgICAgIHJlc29sdmVSZXEodW5kZWZpbmVkKVxuICAgICAgICAgICAgICAgICAgICByZXR1cm5cbiAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgIGlmIChhZnRlclJlc3BvbnNlSG9vaykge1xuICAgICAgICAgICAgICAgICAgICBjb25zdCBtYXliZVJlc3BvbnNlID0gYXdhaXQgYWZ0ZXJSZXNwb25zZUhvb2socmVzcG9uc2UpXG4gICAgICAgICAgICAgICAgICAgIGlmICghbWF5YmVSZXNwb25zZSkge1xuICAgICAgICAgICAgICAgICAgICAgIHJlc29sdmVSZXEodW5kZWZpbmVkKVxuICAgICAgICAgICAgICAgICAgICAgIHJldHVyblxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIHJlc3BvbnNlID0gbWF5YmVSZXNwb25zZVxuICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgY29uc3QgbWltZVR5cGUgPVxuICAgICAgICAgICAgICAgICAgICByZXNwb25zZS5oZWFkZXJzLmdldCgnQ29udGVudC1UeXBlJyk/LnNwbGl0KCc7JylbMF0gfHwgREVGQVVMVF9DT05URU5UX1RZUEVcbiAgICAgICAgICAgICAgICAgIGNvbnN0IGNvbnRlbnQgPSBhd2FpdCBwYXJzZVJlc3BvbnNlQ29udGVudChyZXNwb25zZSlcbiAgICAgICAgICAgICAgICAgIHJlc29sdmVSZXEoe1xuICAgICAgICAgICAgICAgICAgICByb3V0ZVBhdGg6IHJlcGxhY2VkVXJsUGFyYW0sXG4gICAgICAgICAgICAgICAgICAgIG1pbWVUeXBlLFxuICAgICAgICAgICAgICAgICAgICBjb250ZW50LFxuICAgICAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgICAgICAgcmVqZWN0UmVxKGVycm9yKVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9KSgpXG4gICAgICAgIClcbiAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIHJlamVjdEdldEluZm8oZXJyb3IpXG4gICAgICB9XG4gICAgfSlcbiAgfVxufVxuXG4vKipcbiAqIEBleHBlcmltZW50YWxcbiAqIGBzYXZlQ29udGVudFRvRmlsZWAgaXMgYW4gZXhwZXJpbWVudGFsIGZlYXR1cmUuXG4gKiBUaGUgQVBJIG1pZ2h0IGJlIGNoYW5nZWQuXG4gKi9cbmNvbnN0IGNyZWF0ZWREaXJzOiBTZXQ8c3RyaW5nPiA9IG5ldyBTZXQoKVxuZXhwb3J0IGNvbnN0IHNhdmVDb250ZW50VG9GaWxlID0gYXN5bmMgKFxuICBkYXRhOiBQcm9taXNlPHsgcm91dGVQYXRoOiBzdHJpbmc7IGNvbnRlbnQ6IHN0cmluZyB8IEFycmF5QnVmZmVyOyBtaW1lVHlwZTogc3RyaW5nIH0gfCB1bmRlZmluZWQ+LFxuICBmc01vZHVsZTogRmlsZVN5c3RlbU1vZHVsZSxcbiAgb3V0RGlyOiBzdHJpbmcsXG4gIGV4dGVuc2lvbk1hcD86IFJlY29yZDxzdHJpbmcsIHN0cmluZz5cbik6IFByb21pc2U8c3RyaW5nIHwgdW5kZWZpbmVkPiA9PiB7XG4gIGNvbnN0IGF3YWl0ZWREYXRhID0gYXdhaXQgZGF0YVxuICBpZiAoIWF3YWl0ZWREYXRhKSB7XG4gICAgcmV0dXJuXG4gIH1cbiAgY29uc3QgeyByb3V0ZVBhdGgsIGNvbnRlbnQsIG1pbWVUeXBlIH0gPSBhd2FpdGVkRGF0YVxuICBjb25zdCBmaWxlUGF0aCA9IGdlbmVyYXRlRmlsZVBhdGgocm91dGVQYXRoLCBvdXREaXIsIG1pbWVUeXBlLCBleHRlbnNpb25NYXApXG4gIGNvbnN0IGRpclBhdGggPSBkaXJuYW1lKGZpbGVQYXRoKVxuXG4gIGlmICghY3JlYXRlZERpcnMuaGFzKGRpclBhdGgpKSB7XG4gICAgYXdhaXQgZnNNb2R1bGUubWtkaXIoZGlyUGF0aCwgeyByZWN1cnNpdmU6IHRydWUgfSlcbiAgICBjcmVhdGVkRGlycy5hZGQoZGlyUGF0aClcbiAgfVxuICBpZiAodHlwZW9mIGNvbnRlbnQgPT09ICdzdHJpbmcnKSB7XG4gICAgYXdhaXQgZnNNb2R1bGUud3JpdGVGaWxlKGZpbGVQYXRoLCBjb250ZW50KVxuICB9IGVsc2UgaWYgKGNvbnRlbnQgaW5zdGFuY2VvZiBBcnJheUJ1ZmZlcikge1xuICAgIGF3YWl0IGZzTW9kdWxlLndyaXRlRmlsZShmaWxlUGF0aCwgbmV3IFVpbnQ4QXJyYXkoY29udGVudCkpXG4gIH1cbiAgcmV0dXJuIGZpbGVQYXRoXG59XG5cbi8qKlxuICogQGV4cGVyaW1lbnRhbFxuICogYFRvU1NHSW50ZXJmYWNlYCBpcyBhbiBleHBlcmltZW50YWwgZmVhdHVyZS5cbiAqIFRoZSBBUEkgbWlnaHQgYmUgY2hhbmdlZC5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBUb1NTR0ludGVyZmFjZSB7XG4gIChcbiAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgQHR5cGVzY3JpcHQtZXNsaW50L25vLWV4cGxpY2l0LWFueVxuICAgIGFwcDogSG9ubzxhbnksIGFueSwgYW55PixcbiAgICBmc01vZHVsZTogRmlsZVN5c3RlbU1vZHVsZSxcbiAgICBvcHRpb25zPzogVG9TU0dPcHRpb25zXG4gICk6IFByb21pc2U8VG9TU0dSZXN1bHQ+XG59XG5cbi8qKlxuICogQGV4cGVyaW1lbnRhbFxuICogYFRvU1NHQWRhcHRvckludGVyZmFjZWAgaXMgYW4gZXhwZXJpbWVudGFsIGZlYXR1cmUuXG4gKiBUaGUgQVBJIG1pZ2h0IGJlIGNoYW5nZWQuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgVG9TU0dBZGFwdG9ySW50ZXJmYWNlPFxuICBFIGV4dGVuZHMgRW52ID0gRW52LFxuICBTIGV4dGVuZHMgU2NoZW1hID0ge30sXG4gIEJhc2VQYXRoIGV4dGVuZHMgc3RyaW5nID0gJy8nLFxuPiB7XG4gIChhcHA6IEhvbm88RSwgUywgQmFzZVBhdGg+LCBvcHRpb25zPzogVG9TU0dPcHRpb25zKTogUHJvbWlzZTxUb1NTR1Jlc3VsdD5cbn1cblxuLyoqXG4gKiBAZXhwZXJpbWVudGFsXG4gKiBgdG9TU0dgIGlzIGFuIGV4cGVyaW1lbnRhbCBmZWF0dXJlLlxuICogVGhlIEFQSSBtaWdodCBiZSBjaGFuZ2VkLlxuICovXG5leHBvcnQgY29uc3QgdG9TU0c6IFRvU1NHSW50ZXJmYWNlID0gYXN5bmMgKGFwcCwgZnMsIG9wdGlvbnMpID0+IHtcbiAgbGV0IHJlc3VsdDogVG9TU0dSZXN1bHQgfCB1bmRlZmluZWRcbiAgY29uc3QgZ2V0SW5mb1Byb21pc2VzOiBQcm9taXNlPHVua25vd24+W10gPSBbXVxuICBjb25zdCBzYXZlUHJvbWlzZXM6IFByb21pc2U8c3RyaW5nIHwgdW5kZWZpbmVkPltdID0gW11cbiAgY29uc3QgcGx1Z2lucyA9IG9wdGlvbnM/LnBsdWdpbnMgfHwgW2RlZmF1bHRQbHVnaW4oKV1cbiAgY29uc3QgYmVmb3JlUmVxdWVzdEhvb2tzOiBCZWZvcmVSZXF1ZXN0SG9va1tdID0gW11cbiAgY29uc3QgYWZ0ZXJSZXNwb25zZUhvb2tzOiBBZnRlclJlc3BvbnNlSG9va1tdID0gW11cbiAgY29uc3QgYWZ0ZXJHZW5lcmF0ZUhvb2tzOiBBZnRlckdlbmVyYXRlSG9va1tdID0gW11cbiAgaWYgKG9wdGlvbnM/LmJlZm9yZVJlcXVlc3RIb29rKSB7XG4gICAgYmVmb3JlUmVxdWVzdEhvb2tzLnB1c2goXG4gICAgICAuLi4oQXJyYXkuaXNBcnJheShvcHRpb25zLmJlZm9yZVJlcXVlc3RIb29rKVxuICAgICAgICA/IG9wdGlvbnMuYmVmb3JlUmVxdWVzdEhvb2tcbiAgICAgICAgOiBbb3B0aW9ucy5iZWZvcmVSZXF1ZXN0SG9va10pXG4gICAgKVxuICB9XG4gIGlmIChvcHRpb25zPy5hZnRlclJlc3BvbnNlSG9vaykge1xuICAgIGFmdGVyUmVzcG9uc2VIb29rcy5wdXNoKFxuICAgICAgLi4uKEFycmF5LmlzQXJyYXkob3B0aW9ucy5hZnRlclJlc3BvbnNlSG9vaylcbiAgICAgICAgPyBvcHRpb25zLmFmdGVyUmVzcG9uc2VIb29rXG4gICAgICAgIDogW29wdGlvbnMuYWZ0ZXJSZXNwb25zZUhvb2tdKVxuICAgIClcbiAgfVxuICBpZiAob3B0aW9ucz8uYWZ0ZXJHZW5lcmF0ZUhvb2spIHtcbiAgICBhZnRlckdlbmVyYXRlSG9va3MucHVzaChcbiAgICAgIC4uLihBcnJheS5pc0FycmF5KG9wdGlvbnMuYWZ0ZXJHZW5lcmF0ZUhvb2spXG4gICAgICAgID8gb3B0aW9ucy5hZnRlckdlbmVyYXRlSG9va1xuICAgICAgICA6IFtvcHRpb25zLmFmdGVyR2VuZXJhdGVIb29rXSlcbiAgICApXG4gIH1cbiAgZm9yIChjb25zdCBwbHVnaW4gb2YgcGx1Z2lucykge1xuICAgIGlmIChwbHVnaW4uYmVmb3JlUmVxdWVzdEhvb2spIHtcbiAgICAgIGJlZm9yZVJlcXVlc3RIb29rcy5wdXNoKFxuICAgICAgICAuLi4oQXJyYXkuaXNBcnJheShwbHVnaW4uYmVmb3JlUmVxdWVzdEhvb2spXG4gICAgICAgICAgPyBwbHVnaW4uYmVmb3JlUmVxdWVzdEhvb2tcbiAgICAgICAgICA6IFtwbHVnaW4uYmVmb3JlUmVxdWVzdEhvb2tdKVxuICAgICAgKVxuICAgIH1cbiAgICBpZiAocGx1Z2luLmFmdGVyUmVzcG9uc2VIb29rKSB7XG4gICAgICBhZnRlclJlc3BvbnNlSG9va3MucHVzaChcbiAgICAgICAgLi4uKEFycmF5LmlzQXJyYXkocGx1Z2luLmFmdGVyUmVzcG9uc2VIb29rKVxuICAgICAgICAgID8gcGx1Z2luLmFmdGVyUmVzcG9uc2VIb29rXG4gICAgICAgICAgOiBbcGx1Z2luLmFmdGVyUmVzcG9uc2VIb29rXSlcbiAgICAgIClcbiAgICB9XG4gICAgaWYgKHBsdWdpbi5hZnRlckdlbmVyYXRlSG9vaykge1xuICAgICAgYWZ0ZXJHZW5lcmF0ZUhvb2tzLnB1c2goXG4gICAgICAgIC4uLihBcnJheS5pc0FycmF5KHBsdWdpbi5hZnRlckdlbmVyYXRlSG9vaylcbiAgICAgICAgICA/IHBsdWdpbi5hZnRlckdlbmVyYXRlSG9va1xuICAgICAgICAgIDogW3BsdWdpbi5hZnRlckdlbmVyYXRlSG9va10pXG4gICAgICApXG4gICAgfVxuICB9XG4gIHRyeSB7XG4gICAgY29uc3Qgb3V0cHV0RGlyID0gb3B0aW9ucz8uZGlyID8/IERFRkFVTFRfT1VUUFVUX0RJUlxuICAgIGNvbnN0IGNvbmN1cnJlbmN5ID0gb3B0aW9ucz8uY29uY3VycmVuY3kgPz8gREVGQVVMVF9DT05DVVJSRU5DWVxuXG4gICAgY29uc3QgY29tYmluZWRCZWZvcmVSZXF1ZXN0SG9vayA9IGNvbWJpbmVCZWZvcmVSZXF1ZXN0SG9va3MoXG4gICAgICBiZWZvcmVSZXF1ZXN0SG9va3MubGVuZ3RoID4gMCA/IGJlZm9yZVJlcXVlc3RIb29rcyA6IFsocmVxKSA9PiByZXFdXG4gICAgKVxuICAgIGNvbnN0IGNvbWJpbmVkQWZ0ZXJSZXNwb25zZUhvb2sgPSBjb21iaW5lQWZ0ZXJSZXNwb25zZUhvb2tzKFxuICAgICAgYWZ0ZXJSZXNwb25zZUhvb2tzLmxlbmd0aCA+IDAgPyBhZnRlclJlc3BvbnNlSG9va3MgOiBbKHJlcSkgPT4gcmVxXVxuICAgIClcbiAgICBjb25zdCBnZXRJbmZvR2VuID0gZmV0Y2hSb3V0ZXNDb250ZW50KFxuICAgICAgYXBwLFxuICAgICAgY29tYmluZWRCZWZvcmVSZXF1ZXN0SG9vayxcbiAgICAgIGNvbWJpbmVkQWZ0ZXJSZXNwb25zZUhvb2ssXG4gICAgICBjb25jdXJyZW5jeVxuICAgIClcbiAgICBmb3IgKGNvbnN0IGdldEluZm8gb2YgZ2V0SW5mb0dlbikge1xuICAgICAgZ2V0SW5mb1Byb21pc2VzLnB1c2goXG4gICAgICAgIGdldEluZm8udGhlbigoZ2V0Q29udGVudEdlbikgPT4ge1xuICAgICAgICAgIGlmICghZ2V0Q29udGVudEdlbikge1xuICAgICAgICAgICAgcmV0dXJuXG4gICAgICAgICAgfVxuICAgICAgICAgIGZvciAoY29uc3QgY29udGVudCBvZiBnZXRDb250ZW50R2VuKSB7XG4gICAgICAgICAgICBzYXZlUHJvbWlzZXMucHVzaChcbiAgICAgICAgICAgICAgc2F2ZUNvbnRlbnRUb0ZpbGUoY29udGVudCwgZnMsIG91dHB1dERpciwgb3B0aW9ucz8uZXh0ZW5zaW9uTWFwKS5jYXRjaCgoZSkgPT4gZSlcbiAgICAgICAgICAgIClcbiAgICAgICAgICB9XG4gICAgICAgIH0pXG4gICAgICApXG4gICAgfVxuICAgIGF3YWl0IFByb21pc2UuYWxsKGdldEluZm9Qcm9taXNlcylcbiAgICBjb25zdCBmaWxlczogc3RyaW5nW10gPSBbXVxuICAgIGZvciAoY29uc3Qgc2F2ZVByb21pc2Ugb2Ygc2F2ZVByb21pc2VzKSB7XG4gICAgICBjb25zdCBmaWxlT3JFcnJvciA9IGF3YWl0IHNhdmVQcm9taXNlXG4gICAgICBpZiAodHlwZW9mIGZpbGVPckVycm9yID09PSAnc3RyaW5nJykge1xuICAgICAgICBmaWxlcy5wdXNoKGZpbGVPckVycm9yKVxuICAgICAgfSBlbHNlIGlmIChmaWxlT3JFcnJvcikge1xuICAgICAgICB0aHJvdyBmaWxlT3JFcnJvclxuICAgICAgfVxuICAgIH1cbiAgICByZXN1bHQgPSB7IHN1Y2Nlc3M6IHRydWUsIGZpbGVzIH1cbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBjb25zdCBlcnJvck9iaiA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvciA6IG5ldyBFcnJvcihTdHJpbmcoZXJyb3IpKVxuICAgIHJlc3VsdCA9IHsgc3VjY2VzczogZmFsc2UsIGZpbGVzOiBbXSwgZXJyb3I6IGVycm9yT2JqIH1cbiAgfVxuICBpZiAoYWZ0ZXJHZW5lcmF0ZUhvb2tzLmxlbmd0aCA+IDApIHtcbiAgICBjb25zdCBjb21iaW5lZEFmdGVyR2VuZXJhdGVIb29rcyA9IGNvbWJpbmVBZnRlckdlbmVyYXRlSG9va3MoYWZ0ZXJHZW5lcmF0ZUhvb2tzLCBmcywgb3B0aW9ucylcbiAgICBhd2FpdCBjb21iaW5lZEFmdGVyR2VuZXJhdGVIb29rcyhyZXN1bHQsIGZzLCBvcHRpb25zKVxuICB9XG4gIHJldHVybiByZXN1bHRcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxTQUFTLGVBQWUsUUFBUSx3QkFBdUI7QUFHdkQsU0FBUyxVQUFVLFFBQVEsNEJBQTJCO0FBQ3RELFNBQVMsWUFBWSxRQUFRLHNCQUFxQjtBQUVsRCxTQUFTLFdBQVcsRUFBRSw2QkFBNkIsUUFBUSxrQkFBaUI7QUFDNUUsU0FBUyxhQUFhLFFBQVEsZUFBYztBQUM1QyxTQUNFLE9BQU8sRUFDUCxrQkFBa0IsRUFDbEIsMEJBQTBCLEVBQzFCLGNBQWMsRUFDZCxTQUFTLFFBQ0osYUFBWTtBQUVuQixNQUFNLHNCQUFzQixFQUFFLDhCQUE4Qjs7QUFFNUQsa0ZBQWtGO0FBQ2xGLDJEQUEyRDtBQUMzRCwrRUFBK0U7QUFDL0Usb0dBQW9HO0FBQ3BHLGtGQUFrRjtBQUNsRixvR0FBb0c7QUFDcEcsTUFBTSx1QkFBdUI7QUFFN0IsT0FBTyxNQUFNLHFCQUFxQixXQUFVO0FBdUI1QyxNQUFNLG1CQUFtQixD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
// denoCacheMetadata=8840265599599644613,14415049689680843964