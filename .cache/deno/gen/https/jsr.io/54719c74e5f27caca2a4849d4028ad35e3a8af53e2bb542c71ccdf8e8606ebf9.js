import { html } from '../html/index.ts';
/**
 * The default plugin that defines the recommended behavior.
 *
 * @experimental
 * `defaultPlugin` is an experimental feature.
 * The API might be changed.
 */ export const defaultPlugin = ()=>{
  return {
    afterResponseHook: (res)=>{
      if (res.status !== 200) {
        return false;
      }
      return res;
    }
  };
};
const REDIRECT_STATUS_CODES = new Set([
  301,
  302,
  303,
  307,
  308
]);
const generateRedirectHtml = (location)=>{
  // prettier-ignore
  const content = html`<!DOCTYPE html>
<title>Redirecting to: ${location}</title>
<meta http-equiv="refresh" content="0;url=${location}" />
<meta name="robots" content="noindex" />
<link rel="canonical" href="${location}" />
<body>
<a href="${location}">Redirecting to <code>${location}</code></a>
</body>
`;
  return content.toString().replace(/\n/g, '');
};
/**
 * The redirect plugin that generates HTML redirect pages for HTTP redirect responses for status codes 301, 302, 303, 307 and 308.
 *
 * When used with `defaultPlugin`, place `redirectPlugin` before it, because `defaultPlugin` skips non-200 responses.
 *
 * ```ts
 * // ✅ Will work as expected
 * toSSG(app, fs, { plugins: [redirectPlugin(), defaultPlugin()] })
 *
 * // ❌ Will not work as expected
 * toSSG(app, fs, { plugins: [defaultPlugin(), redirectPlugin()] })
 * ```
 *
 * @experimental
 * `redirectPlugin` is an experimental feature.
 * The API might be changed.
 */ export const redirectPlugin = ()=>{
  return {
    afterResponseHook: (res)=>{
      if (REDIRECT_STATUS_CODES.has(res.status)) {
        const location = res.headers.get('Location');
        if (!location) {
          return false;
        }
        const htmlBody = generateRedirectHtml(location);
        return new Response(htmlBody, {
          status: 200,
          headers: {
            'Content-Type': 'text/html; charset=utf-8'
          }
        });
      }
      return res;
    }
  };
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0Bob25vL2hvbm8vNC4xMi4yMy9zcmMvaGVscGVyL3NzZy9wbHVnaW5zLnRzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IGh0bWwgfSBmcm9tICcuLi9odG1sL2luZGV4LnRzJ1xuaW1wb3J0IHR5cGUgeyBTU0dQbHVnaW4gfSBmcm9tICcuL3NzZy50cydcblxuLyoqXG4gKiBUaGUgZGVmYXVsdCBwbHVnaW4gdGhhdCBkZWZpbmVzIHRoZSByZWNvbW1lbmRlZCBiZWhhdmlvci5cbiAqXG4gKiBAZXhwZXJpbWVudGFsXG4gKiBgZGVmYXVsdFBsdWdpbmAgaXMgYW4gZXhwZXJpbWVudGFsIGZlYXR1cmUuXG4gKiBUaGUgQVBJIG1pZ2h0IGJlIGNoYW5nZWQuXG4gKi9cbmV4cG9ydCBjb25zdCBkZWZhdWx0UGx1Z2luID0gKCk6IFNTR1BsdWdpbiA9PiB7XG4gIHJldHVybiB7XG4gICAgYWZ0ZXJSZXNwb25zZUhvb2s6IChyZXMpID0+IHtcbiAgICAgIGlmIChyZXMuc3RhdHVzICE9PSAyMDApIHtcbiAgICAgICAgcmV0dXJuIGZhbHNlXG4gICAgICB9XG4gICAgICByZXR1cm4gcmVzXG4gICAgfSxcbiAgfVxufVxuXG5jb25zdCBSRURJUkVDVF9TVEFUVVNfQ09ERVMgPSBuZXcgU2V0KFszMDEsIDMwMiwgMzAzLCAzMDcsIDMwOF0pXG5cbmNvbnN0IGdlbmVyYXRlUmVkaXJlY3RIdG1sID0gKGxvY2F0aW9uOiBzdHJpbmcpID0+IHtcbiAgLy8gcHJldHRpZXItaWdub3JlXG4gIGNvbnN0IGNvbnRlbnQgPSBodG1sYDwhRE9DVFlQRSBodG1sPlxuPHRpdGxlPlJlZGlyZWN0aW5nIHRvOiAke2xvY2F0aW9ufTwvdGl0bGU+XG48bWV0YSBodHRwLWVxdWl2PVwicmVmcmVzaFwiIGNvbnRlbnQ9XCIwO3VybD0ke2xvY2F0aW9ufVwiIC8+XG48bWV0YSBuYW1lPVwicm9ib3RzXCIgY29udGVudD1cIm5vaW5kZXhcIiAvPlxuPGxpbmsgcmVsPVwiY2Fub25pY2FsXCIgaHJlZj1cIiR7bG9jYXRpb259XCIgLz5cbjxib2R5PlxuPGEgaHJlZj1cIiR7bG9jYXRpb259XCI+UmVkaXJlY3RpbmcgdG8gPGNvZGU+JHtsb2NhdGlvbn08L2NvZGU+PC9hPlxuPC9ib2R5PlxuYFxuICByZXR1cm4gY29udGVudC50b1N0cmluZygpLnJlcGxhY2UoL1xcbi9nLCAnJylcbn1cblxuLyoqXG4gKiBUaGUgcmVkaXJlY3QgcGx1Z2luIHRoYXQgZ2VuZXJhdGVzIEhUTUwgcmVkaXJlY3QgcGFnZXMgZm9yIEhUVFAgcmVkaXJlY3QgcmVzcG9uc2VzIGZvciBzdGF0dXMgY29kZXMgMzAxLCAzMDIsIDMwMywgMzA3IGFuZCAzMDguXG4gKlxuICogV2hlbiB1c2VkIHdpdGggYGRlZmF1bHRQbHVnaW5gLCBwbGFjZSBgcmVkaXJlY3RQbHVnaW5gIGJlZm9yZSBpdCwgYmVjYXVzZSBgZGVmYXVsdFBsdWdpbmAgc2tpcHMgbm9uLTIwMCByZXNwb25zZXMuXG4gKlxuICogYGBgdHNcbiAqIC8vIOKchSBXaWxsIHdvcmsgYXMgZXhwZWN0ZWRcbiAqIHRvU1NHKGFwcCwgZnMsIHsgcGx1Z2luczogW3JlZGlyZWN0UGx1Z2luKCksIGRlZmF1bHRQbHVnaW4oKV0gfSlcbiAqXG4gKiAvLyDinYwgV2lsbCBub3Qgd29yayBhcyBleHBlY3RlZFxuICogdG9TU0coYXBwLCBmcywgeyBwbHVnaW5zOiBbZGVmYXVsdFBsdWdpbigpLCByZWRpcmVjdFBsdWdpbigpXSB9KVxuICogYGBgXG4gKlxuICogQGV4cGVyaW1lbnRhbFxuICogYHJlZGlyZWN0UGx1Z2luYCBpcyBhbiBleHBlcmltZW50YWwgZmVhdHVyZS5cbiAqIFRoZSBBUEkgbWlnaHQgYmUgY2hhbmdlZC5cbiAqL1xuZXhwb3J0IGNvbnN0IHJlZGlyZWN0UGx1Z2luID0gKCk6IFNTR1BsdWdpbiA9PiB7XG4gIHJldHVybiB7XG4gICAgYWZ0ZXJSZXNwb25zZUhvb2s6IChyZXMpID0+IHtcbiAgICAgIGlmIChSRURJUkVDVF9TVEFUVVNfQ09ERVMuaGFzKHJlcy5zdGF0dXMpKSB7XG4gICAgICAgIGNvbnN0IGxvY2F0aW9uID0gcmVzLmhlYWRlcnMuZ2V0KCdMb2NhdGlvbicpXG4gICAgICAgIGlmICghbG9jYXRpb24pIHtcbiAgICAgICAgICByZXR1cm4gZmFsc2VcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBodG1sQm9keSA9IGdlbmVyYXRlUmVkaXJlY3RIdG1sKGxvY2F0aW9uKVxuICAgICAgICByZXR1cm4gbmV3IFJlc3BvbnNlKGh0bWxCb2R5LCB7XG4gICAgICAgICAgc3RhdHVzOiAyMDAsXG4gICAgICAgICAgaGVhZGVyczogeyAnQ29udGVudC1UeXBlJzogJ3RleHQvaHRtbDsgY2hhcnNldD11dGYtOCcgfSxcbiAgICAgICAgfSlcbiAgICAgIH1cbiAgICAgIHJldHVybiByZXNcbiAgICB9LFxuICB9XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsU0FBUyxJQUFJLFFBQVEsbUJBQWtCO0FBR3ZDOzs7Ozs7Q0FNQyxHQUNELE9BQU8sTUFBTSxnQkFBZ0I7RUFDM0IsT0FBTztJQUNMLG1CQUFtQixDQUFDO01BQ2xCLElBQUksSUFBSSxNQUFNLEtBQUssS0FBSztRQUN0QixPQUFPO01BQ1Q7TUFDQSxPQUFPO0lBQ1Q7RUFDRjtBQUNGLEVBQUM7QUFFRCxNQUFNLHdCQUF3QixJQUFJLElBQUk7RUFBQztFQUFLO0VBQUs7RUFBSztFQUFLO0NBQUk7QUFFL0QsTUFBTSx1QkFBdUIsQ0FBQztFQUM1QixrQkFBa0I7RUFDbEIsTUFBTSxVQUFVLElBQUksQ0FBQzt1QkFDQSxFQUFFLFNBQVM7MENBQ1EsRUFBRSxTQUFTOzs0QkFFekIsRUFBRSxTQUFTOztTQUU5QixFQUFFLFNBQVMsdUJBQXVCLEVBQUUsU0FBUzs7QUFFdEQsQ0FBQztFQUNDLE9BQU8sUUFBUSxRQUFRLEdBQUcsT0FBTyxDQUFDLE9BQU87QUFDM0M7QUFFQTs7Ozs7Ozs7Ozs7Ozs7OztDQWdCQyxHQUNELE9BQU8sTUFBTSxpQkFBaUI7RUFDNUIsT0FBTztJQUNMLG1CQUFtQixDQUFDO01BQ2xCLElBQUksc0JBQXNCLEdBQUcsQ0FBQyxJQUFJLE1BQU0sR0FBRztRQUN6QyxNQUFNLFdBQVcsSUFBSSxPQUFPLENBQUMsR0FBRyxDQUFDO1FBQ2pDLElBQUksQ0FBQyxVQUFVO1VBQ2IsT0FBTztRQUNUO1FBQ0EsTUFBTSxXQUFXLHFCQUFxQjtRQUN0QyxPQUFPLElBQUksU0FBUyxVQUFVO1VBQzVCLFFBQVE7VUFDUixTQUFTO1lBQUUsZ0JBQWdCO1VBQTJCO1FBQ3hEO01BQ0Y7TUFDQSxPQUFPO0lBQ1Q7RUFDRjtBQUNGLEVBQUMifQ==
// denoCacheMetadata=2507859942405413092,10278405626581493451