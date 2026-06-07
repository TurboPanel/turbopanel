/**
 * @module
 * URL utility.
 */ export const splitPath = (path)=>{
  const paths = path.split('/');
  if (paths[0] === '') {
    paths.shift();
  }
  return paths;
};
export const splitRoutingPath = (routePath)=>{
  const { groups, path } = extractGroupsFromPath(routePath);
  const paths = splitPath(path);
  return replaceGroupMarks(paths, groups);
};
const extractGroupsFromPath = (path)=>{
  const groups = [];
  path = path.replace(/\{[^}]+\}/g, (match, index)=>{
    const mark = `@${index}`;
    groups.push([
      mark,
      match
    ]);
    return mark;
  });
  return {
    groups,
    path
  };
};
const replaceGroupMarks = (paths, groups)=>{
  for(let i = groups.length - 1; i >= 0; i--){
    const [mark] = groups[i];
    for(let j = paths.length - 1; j >= 0; j--){
      if (paths[j].includes(mark)) {
        paths[j] = paths[j].replace(mark, groups[i][1]);
        break;
      }
    }
  }
  return paths;
};
const patternCache = {};
export const getPattern = (label, next)=>{
  // *            => wildcard
  // :id{[0-9]+}  => ([0-9]+)
  // :id          => (.+)
  if (label === '*') {
    return '*';
  }
  const match = label.match(/^\:([^\{\}]+)(?:\{(.+)\})?$/);
  if (match) {
    const cacheKey = `${label}#${next}`;
    if (!patternCache[cacheKey]) {
      if (match[2]) {
        patternCache[cacheKey] = next && next[0] !== ':' && next[0] !== '*' ? [
          cacheKey,
          match[1],
          new RegExp(`^${match[2]}(?=/${next})`)
        ] : [
          label,
          match[1],
          new RegExp(`^${match[2]}$`)
        ];
      } else {
        patternCache[cacheKey] = [
          label,
          match[1],
          true
        ];
      }
    }
    return patternCache[cacheKey];
  }
  return null;
};
export const tryDecode = (str, decoder)=>{
  try {
    return decoder(str);
  } catch  {
    return str.replace(/(?:%[0-9A-Fa-f]{2})+/g, (match)=>{
      try {
        return decoder(match);
      } catch  {
        return match;
      }
    });
  }
};
/**
 * Try to apply decodeURI() to given string.
 * If it fails, skip invalid percent encoding or invalid UTF-8 sequences, and apply decodeURI() to the rest as much as possible.
 * @param str The string to decode.
 * @returns The decoded string that sometimes contains undecodable percent encoding.
 * @example
 * tryDecodeURI('Hello%20World') // 'Hello World'
 * tryDecodeURI('Hello%20World/%A4%A2') // 'Hello World/%A4%A2'
 */ export const tryDecodeURI = (str)=>tryDecode(str, decodeURI);
export const getPath = (request)=>{
  const url = request.url;
  const start = url.indexOf('/', url.indexOf(':') + 4);
  let i = start;
  for(; i < url.length; i++){
    const charCode = url.charCodeAt(i);
    if (charCode === 37) {
      // '%'
      // If the path contains percent encoding, use `indexOf()` to find '?' or '#' and return the result immediately.
      // Although this is a performance disadvantage, it is acceptable since we prefer cases that do not include percent encoding.
      const queryIndex = url.indexOf('?', i);
      const hashIndex = url.indexOf('#', i);
      const end = queryIndex === -1 ? hashIndex === -1 ? undefined : hashIndex : hashIndex === -1 ? queryIndex : Math.min(queryIndex, hashIndex);
      const path = url.slice(start, end);
      return tryDecodeURI(path.includes('%25') ? path.replace(/%25/g, '%2525') : path);
    } else if (charCode === 63 || charCode === 35) {
      break;
    }
  }
  return url.slice(start, i);
};
export const getQueryStrings = (url)=>{
  const queryIndex = url.indexOf('?', 8);
  return queryIndex === -1 ? '' : '?' + url.slice(queryIndex + 1);
};
export const getPathNoStrict = (request)=>{
  const result = getPath(request);
  // if strict routing is false => `/hello/hey/` and `/hello/hey` are treated the same
  return result.length > 1 && result.at(-1) === '/' ? result.slice(0, -1) : result;
};
/**
 * Merge paths.
 * @param {string[]} ...paths - The paths to merge.
 * @returns {string} The merged path.
 * @example
 * mergePath('/api', '/users') // '/api/users'
 * mergePath('/api/', '/users') // '/api/users'
 * mergePath('/api', '/') // '/api'
 * mergePath('/api/', '/') // '/api/'
 */ export const mergePath = (base, sub, ...rest)=>{
  if (rest.length) {
    sub = mergePath(sub, ...rest);
  }
  return `${base?.[0] === '/' ? '' : '/'}${base}${sub === '/' ? '' : `${base?.at(-1) === '/' ? '' : '/'}${sub?.[0] === '/' ? sub.slice(1) : sub}`}`;
};
export const checkOptionalParameter = (path)=>{
  /*
    If path is `/api/animals/:type?` it will return:
    [`/api/animals`, `/api/animals/:type`]
    in other cases it will return null
  */ if (path.charCodeAt(path.length - 1) !== 63 || !path.includes(':')) {
    return null;
  }
  const segments = path.split('/');
  const results = [];
  let basePath = '';
  segments.forEach((segment)=>{
    if (segment !== '' && !/\:/.test(segment)) {
      basePath += '/' + segment;
    } else if (/\:/.test(segment)) {
      if (/\?/.test(segment)) {
        if (results.length === 0 && basePath === '') {
          results.push('/');
        } else {
          results.push(basePath);
        }
        const optionalSegment = segment.replace('?', '');
        basePath += '/' + optionalSegment;
        results.push(basePath);
      } else {
        basePath += '/' + segment;
      }
    }
  });
  return results.filter((v, i, a)=>a.indexOf(v) === i);
};
// Optimized
const _decodeURI = (value)=>{
  if (!/[%+]/.test(value)) {
    return value;
  }
  if (value.indexOf('+') !== -1) {
    value = value.replace(/\+/g, ' ');
  }
  return value.indexOf('%') !== -1 ? tryDecode(value, decodeURIComponent_) : value;
};
const _getQueryParam = (url, key, multiple)=>{
  let encoded;
  if (!multiple && key && !/[%+]/.test(key)) {
    // optimized for unencoded key
    let keyIndex = url.indexOf('?', 8);
    if (keyIndex === -1) {
      return undefined;
    }
    if (!url.startsWith(key, keyIndex + 1)) {
      keyIndex = url.indexOf(`&${key}`, keyIndex + 1);
    }
    while(keyIndex !== -1){
      const trailingKeyCode = url.charCodeAt(keyIndex + key.length + 1);
      if (trailingKeyCode === 61) {
        const valueIndex = keyIndex + key.length + 2;
        const endIndex = url.indexOf('&', valueIndex);
        return _decodeURI(url.slice(valueIndex, endIndex === -1 ? undefined : endIndex));
      } else if (trailingKeyCode == 38 || isNaN(trailingKeyCode)) {
        return '';
      }
      keyIndex = url.indexOf(`&${key}`, keyIndex + 1);
    }
    encoded = /[%+]/.test(url);
    if (!encoded) {
      return undefined;
    }
  // fallback to default routine
  }
  const results = {};
  encoded ??= /[%+]/.test(url);
  let keyIndex = url.indexOf('?', 8);
  while(keyIndex !== -1){
    const nextKeyIndex = url.indexOf('&', keyIndex + 1);
    let valueIndex = url.indexOf('=', keyIndex);
    if (valueIndex > nextKeyIndex && nextKeyIndex !== -1) {
      valueIndex = -1;
    }
    let name = url.slice(keyIndex + 1, valueIndex === -1 ? nextKeyIndex === -1 ? undefined : nextKeyIndex : valueIndex);
    if (encoded) {
      name = _decodeURI(name);
    }
    keyIndex = nextKeyIndex;
    if (name === '') {
      continue;
    }
    let value;
    if (valueIndex === -1) {
      value = '';
    } else {
      value = url.slice(valueIndex + 1, nextKeyIndex === -1 ? undefined : nextKeyIndex);
      if (encoded) {
        value = _decodeURI(value);
      }
    }
    if (multiple) {
      if (!(results[name] && Array.isArray(results[name]))) {
        results[name] = [];
      }
      ;
      results[name].push(value);
    } else {
      results[name] ??= value;
    }
  }
  return key ? results[key] : results;
};
export const getQueryParam = _getQueryParam;
export const getQueryParams = (url, key)=>{
  return _getQueryParam(url, key, true);
};
// `decodeURIComponent` is a long name.
// By making it a function, we can use it commonly when minified, reducing the amount of code.
export const decodeURIComponent_ = decodeURIComponent;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0Bob25vL2hvbm8vNC4xMi4yMy9zcmMvdXRpbHMvdXJsLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogQG1vZHVsZVxuICogVVJMIHV0aWxpdHkuXG4gKi9cblxuZXhwb3J0IHR5cGUgUGF0dGVybiA9IHJlYWRvbmx5IFtzdHJpbmcsIHN0cmluZywgUmVnRXhwIHwgdHJ1ZV0gfCAnKidcblxuZXhwb3J0IGNvbnN0IHNwbGl0UGF0aCA9IChwYXRoOiBzdHJpbmcpOiBzdHJpbmdbXSA9PiB7XG4gIGNvbnN0IHBhdGhzID0gcGF0aC5zcGxpdCgnLycpXG4gIGlmIChwYXRoc1swXSA9PT0gJycpIHtcbiAgICBwYXRocy5zaGlmdCgpXG4gIH1cbiAgcmV0dXJuIHBhdGhzXG59XG5cbmV4cG9ydCBjb25zdCBzcGxpdFJvdXRpbmdQYXRoID0gKHJvdXRlUGF0aDogc3RyaW5nKTogc3RyaW5nW10gPT4ge1xuICBjb25zdCB7IGdyb3VwcywgcGF0aCB9ID0gZXh0cmFjdEdyb3Vwc0Zyb21QYXRoKHJvdXRlUGF0aClcblxuICBjb25zdCBwYXRocyA9IHNwbGl0UGF0aChwYXRoKVxuICByZXR1cm4gcmVwbGFjZUdyb3VwTWFya3MocGF0aHMsIGdyb3Vwcylcbn1cblxuY29uc3QgZXh0cmFjdEdyb3Vwc0Zyb21QYXRoID0gKHBhdGg6IHN0cmluZyk6IHsgZ3JvdXBzOiBbc3RyaW5nLCBzdHJpbmddW107IHBhdGg6IHN0cmluZyB9ID0+IHtcbiAgY29uc3QgZ3JvdXBzOiBbc3RyaW5nLCBzdHJpbmddW10gPSBbXVxuXG4gIHBhdGggPSBwYXRoLnJlcGxhY2UoL1xce1tefV0rXFx9L2csIChtYXRjaCwgaW5kZXgpID0+IHtcbiAgICBjb25zdCBtYXJrID0gYEAke2luZGV4fWBcbiAgICBncm91cHMucHVzaChbbWFyaywgbWF0Y2hdKVxuICAgIHJldHVybiBtYXJrXG4gIH0pXG5cbiAgcmV0dXJuIHsgZ3JvdXBzLCBwYXRoIH1cbn1cblxuY29uc3QgcmVwbGFjZUdyb3VwTWFya3MgPSAocGF0aHM6IHN0cmluZ1tdLCBncm91cHM6IFtzdHJpbmcsIHN0cmluZ11bXSk6IHN0cmluZ1tdID0+IHtcbiAgZm9yIChsZXQgaSA9IGdyb3Vwcy5sZW5ndGggLSAxOyBpID49IDA7IGktLSkge1xuICAgIGNvbnN0IFttYXJrXSA9IGdyb3Vwc1tpXVxuXG4gICAgZm9yIChsZXQgaiA9IHBhdGhzLmxlbmd0aCAtIDE7IGogPj0gMDsgai0tKSB7XG4gICAgICBpZiAocGF0aHNbal0uaW5jbHVkZXMobWFyaykpIHtcbiAgICAgICAgcGF0aHNbal0gPSBwYXRoc1tqXS5yZXBsYWNlKG1hcmssIGdyb3Vwc1tpXVsxXSlcbiAgICAgICAgYnJlYWtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICByZXR1cm4gcGF0aHNcbn1cblxuY29uc3QgcGF0dGVybkNhY2hlOiB7IFtrZXk6IHN0cmluZ106IFBhdHRlcm4gfSA9IHt9XG5leHBvcnQgY29uc3QgZ2V0UGF0dGVybiA9IChsYWJlbDogc3RyaW5nLCBuZXh0Pzogc3RyaW5nKTogUGF0dGVybiB8IG51bGwgPT4ge1xuICAvLyAqICAgICAgICAgICAgPT4gd2lsZGNhcmRcbiAgLy8gOmlke1swLTldK30gID0+IChbMC05XSspXG4gIC8vIDppZCAgICAgICAgICA9PiAoLispXG5cbiAgaWYgKGxhYmVsID09PSAnKicpIHtcbiAgICByZXR1cm4gJyonXG4gIH1cblxuICBjb25zdCBtYXRjaCA9IGxhYmVsLm1hdGNoKC9eXFw6KFteXFx7XFx9XSspKD86XFx7KC4rKVxcfSk/JC8pXG4gIGlmIChtYXRjaCkge1xuICAgIGNvbnN0IGNhY2hlS2V5ID0gYCR7bGFiZWx9IyR7bmV4dH1gXG4gICAgaWYgKCFwYXR0ZXJuQ2FjaGVbY2FjaGVLZXldKSB7XG4gICAgICBpZiAobWF0Y2hbMl0pIHtcbiAgICAgICAgcGF0dGVybkNhY2hlW2NhY2hlS2V5XSA9XG4gICAgICAgICAgbmV4dCAmJiBuZXh0WzBdICE9PSAnOicgJiYgbmV4dFswXSAhPT0gJyonXG4gICAgICAgICAgICA/IFtjYWNoZUtleSwgbWF0Y2hbMV0sIG5ldyBSZWdFeHAoYF4ke21hdGNoWzJdfSg/PS8ke25leHR9KWApXVxuICAgICAgICAgICAgOiBbbGFiZWwsIG1hdGNoWzFdLCBuZXcgUmVnRXhwKGBeJHttYXRjaFsyXX0kYCldXG4gICAgICB9IGVsc2Uge1xuICAgICAgICBwYXR0ZXJuQ2FjaGVbY2FjaGVLZXldID0gW2xhYmVsLCBtYXRjaFsxXSwgdHJ1ZV1cbiAgICAgIH1cbiAgICB9XG5cbiAgICByZXR1cm4gcGF0dGVybkNhY2hlW2NhY2hlS2V5XVxuICB9XG5cbiAgcmV0dXJuIG51bGxcbn1cblxudHlwZSBEZWNvZGVyID0gKHN0cjogc3RyaW5nKSA9PiBzdHJpbmdcbmV4cG9ydCBjb25zdCB0cnlEZWNvZGUgPSAoc3RyOiBzdHJpbmcsIGRlY29kZXI6IERlY29kZXIpOiBzdHJpbmcgPT4ge1xuICB0cnkge1xuICAgIHJldHVybiBkZWNvZGVyKHN0cilcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIHN0ci5yZXBsYWNlKC8oPzolWzAtOUEtRmEtZl17Mn0pKy9nLCAobWF0Y2gpID0+IHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHJldHVybiBkZWNvZGVyKG1hdGNoKVxuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIHJldHVybiBtYXRjaFxuICAgICAgfVxuICAgIH0pXG4gIH1cbn1cblxuLyoqXG4gKiBUcnkgdG8gYXBwbHkgZGVjb2RlVVJJKCkgdG8gZ2l2ZW4gc3RyaW5nLlxuICogSWYgaXQgZmFpbHMsIHNraXAgaW52YWxpZCBwZXJjZW50IGVuY29kaW5nIG9yIGludmFsaWQgVVRGLTggc2VxdWVuY2VzLCBhbmQgYXBwbHkgZGVjb2RlVVJJKCkgdG8gdGhlIHJlc3QgYXMgbXVjaCBhcyBwb3NzaWJsZS5cbiAqIEBwYXJhbSBzdHIgVGhlIHN0cmluZyB0byBkZWNvZGUuXG4gKiBAcmV0dXJucyBUaGUgZGVjb2RlZCBzdHJpbmcgdGhhdCBzb21ldGltZXMgY29udGFpbnMgdW5kZWNvZGFibGUgcGVyY2VudCBlbmNvZGluZy5cbiAqIEBleGFtcGxlXG4gKiB0cnlEZWNvZGVVUkkoJ0hlbGxvJTIwV29ybGQnKSAvLyAnSGVsbG8gV29ybGQnXG4gKiB0cnlEZWNvZGVVUkkoJ0hlbGxvJTIwV29ybGQvJUE0JUEyJykgLy8gJ0hlbGxvIFdvcmxkLyVBNCVBMidcbiAqL1xuZXhwb3J0IGNvbnN0IHRyeURlY29kZVVSSSA9IChzdHI6IHN0cmluZyk6IHN0cmluZyA9PiB0cnlEZWNvZGUoc3RyLCBkZWNvZGVVUkkpXG5cbmV4cG9ydCBjb25zdCBnZXRQYXRoID0gKHJlcXVlc3Q6IFJlcXVlc3QpOiBzdHJpbmcgPT4ge1xuICBjb25zdCB1cmwgPSByZXF1ZXN0LnVybFxuICBjb25zdCBzdGFydCA9IHVybC5pbmRleE9mKCcvJywgdXJsLmluZGV4T2YoJzonKSArIDQpXG4gIGxldCBpID0gc3RhcnRcbiAgZm9yICg7IGkgPCB1cmwubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCBjaGFyQ29kZSA9IHVybC5jaGFyQ29kZUF0KGkpXG4gICAgaWYgKGNoYXJDb2RlID09PSAzNykge1xuICAgICAgLy8gJyUnXG4gICAgICAvLyBJZiB0aGUgcGF0aCBjb250YWlucyBwZXJjZW50IGVuY29kaW5nLCB1c2UgYGluZGV4T2YoKWAgdG8gZmluZCAnPycgb3IgJyMnIGFuZCByZXR1cm4gdGhlIHJlc3VsdCBpbW1lZGlhdGVseS5cbiAgICAgIC8vIEFsdGhvdWdoIHRoaXMgaXMgYSBwZXJmb3JtYW5jZSBkaXNhZHZhbnRhZ2UsIGl0IGlzIGFjY2VwdGFibGUgc2luY2Ugd2UgcHJlZmVyIGNhc2VzIHRoYXQgZG8gbm90IGluY2x1ZGUgcGVyY2VudCBlbmNvZGluZy5cbiAgICAgIGNvbnN0IHF1ZXJ5SW5kZXggPSB1cmwuaW5kZXhPZignPycsIGkpXG4gICAgICBjb25zdCBoYXNoSW5kZXggPSB1cmwuaW5kZXhPZignIycsIGkpXG4gICAgICBjb25zdCBlbmQgPVxuICAgICAgICBxdWVyeUluZGV4ID09PSAtMVxuICAgICAgICAgID8gaGFzaEluZGV4ID09PSAtMVxuICAgICAgICAgICAgPyB1bmRlZmluZWRcbiAgICAgICAgICAgIDogaGFzaEluZGV4XG4gICAgICAgICAgOiBoYXNoSW5kZXggPT09IC0xXG4gICAgICAgICAgICA/IHF1ZXJ5SW5kZXhcbiAgICAgICAgICAgIDogTWF0aC5taW4ocXVlcnlJbmRleCwgaGFzaEluZGV4KVxuICAgICAgY29uc3QgcGF0aCA9IHVybC5zbGljZShzdGFydCwgZW5kKVxuICAgICAgcmV0dXJuIHRyeURlY29kZVVSSShwYXRoLmluY2x1ZGVzKCclMjUnKSA/IHBhdGgucmVwbGFjZSgvJTI1L2csICclMjUyNScpIDogcGF0aClcbiAgICB9IGVsc2UgaWYgKGNoYXJDb2RlID09PSA2MyB8fCBjaGFyQ29kZSA9PT0gMzUpIHtcbiAgICAgIC8vICc/JyBvciAnIydcbiAgICAgIGJyZWFrXG4gICAgfVxuICB9XG4gIHJldHVybiB1cmwuc2xpY2Uoc3RhcnQsIGkpXG59XG5cbmV4cG9ydCBjb25zdCBnZXRRdWVyeVN0cmluZ3MgPSAodXJsOiBzdHJpbmcpOiBzdHJpbmcgPT4ge1xuICBjb25zdCBxdWVyeUluZGV4ID0gdXJsLmluZGV4T2YoJz8nLCA4KVxuICByZXR1cm4gcXVlcnlJbmRleCA9PT0gLTEgPyAnJyA6ICc/JyArIHVybC5zbGljZShxdWVyeUluZGV4ICsgMSlcbn1cblxuZXhwb3J0IGNvbnN0IGdldFBhdGhOb1N0cmljdCA9IChyZXF1ZXN0OiBSZXF1ZXN0KTogc3RyaW5nID0+IHtcbiAgY29uc3QgcmVzdWx0ID0gZ2V0UGF0aChyZXF1ZXN0KVxuXG4gIC8vIGlmIHN0cmljdCByb3V0aW5nIGlzIGZhbHNlID0+IGAvaGVsbG8vaGV5L2AgYW5kIGAvaGVsbG8vaGV5YCBhcmUgdHJlYXRlZCB0aGUgc2FtZVxuICByZXR1cm4gcmVzdWx0Lmxlbmd0aCA+IDEgJiYgcmVzdWx0LmF0KC0xKSA9PT0gJy8nID8gcmVzdWx0LnNsaWNlKDAsIC0xKSA6IHJlc3VsdFxufVxuXG4vKipcbiAqIE1lcmdlIHBhdGhzLlxuICogQHBhcmFtIHtzdHJpbmdbXX0gLi4ucGF0aHMgLSBUaGUgcGF0aHMgdG8gbWVyZ2UuXG4gKiBAcmV0dXJucyB7c3RyaW5nfSBUaGUgbWVyZ2VkIHBhdGguXG4gKiBAZXhhbXBsZVxuICogbWVyZ2VQYXRoKCcvYXBpJywgJy91c2VycycpIC8vICcvYXBpL3VzZXJzJ1xuICogbWVyZ2VQYXRoKCcvYXBpLycsICcvdXNlcnMnKSAvLyAnL2FwaS91c2VycydcbiAqIG1lcmdlUGF0aCgnL2FwaScsICcvJykgLy8gJy9hcGknXG4gKiBtZXJnZVBhdGgoJy9hcGkvJywgJy8nKSAvLyAnL2FwaS8nXG4gKi9cbmV4cG9ydCBjb25zdCBtZXJnZVBhdGg6ICguLi5wYXRoczogc3RyaW5nW10pID0+IHN0cmluZyA9IChcbiAgYmFzZTogc3RyaW5nIHwgdW5kZWZpbmVkLFxuICBzdWI6IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgLi4ucmVzdDogc3RyaW5nW11cbik6IHN0cmluZyA9PiB7XG4gIGlmIChyZXN0Lmxlbmd0aCkge1xuICAgIHN1YiA9IG1lcmdlUGF0aChzdWIgYXMgc3RyaW5nLCAuLi5yZXN0KVxuICB9XG4gIHJldHVybiBgJHtiYXNlPy5bMF0gPT09ICcvJyA/ICcnIDogJy8nfSR7YmFzZX0ke1xuICAgIHN1YiA9PT0gJy8nID8gJycgOiBgJHtiYXNlPy5hdCgtMSkgPT09ICcvJyA/ICcnIDogJy8nfSR7c3ViPy5bMF0gPT09ICcvJyA/IHN1Yi5zbGljZSgxKSA6IHN1Yn1gXG4gIH1gXG59XG5cbmV4cG9ydCBjb25zdCBjaGVja09wdGlvbmFsUGFyYW1ldGVyID0gKHBhdGg6IHN0cmluZyk6IHN0cmluZ1tdIHwgbnVsbCA9PiB7XG4gIC8qXG4gICAgSWYgcGF0aCBpcyBgL2FwaS9hbmltYWxzLzp0eXBlP2AgaXQgd2lsbCByZXR1cm46XG4gICAgW2AvYXBpL2FuaW1hbHNgLCBgL2FwaS9hbmltYWxzLzp0eXBlYF1cbiAgICBpbiBvdGhlciBjYXNlcyBpdCB3aWxsIHJldHVybiBudWxsXG4gICovXG5cbiAgaWYgKHBhdGguY2hhckNvZGVBdChwYXRoLmxlbmd0aCAtIDEpICE9PSA2MyB8fCAhcGF0aC5pbmNsdWRlcygnOicpKSB7XG4gICAgcmV0dXJuIG51bGxcbiAgfVxuXG4gIGNvbnN0IHNlZ21lbnRzID0gcGF0aC5zcGxpdCgnLycpXG4gIGNvbnN0IHJlc3VsdHM6IHN0cmluZ1tdID0gW11cbiAgbGV0IGJhc2VQYXRoID0gJydcblxuICBzZWdtZW50cy5mb3JFYWNoKChzZWdtZW50KSA9PiB7XG4gICAgaWYgKHNlZ21lbnQgIT09ICcnICYmICEvXFw6Ly50ZXN0KHNlZ21lbnQpKSB7XG4gICAgICBiYXNlUGF0aCArPSAnLycgKyBzZWdtZW50XG4gICAgfSBlbHNlIGlmICgvXFw6Ly50ZXN0KHNlZ21lbnQpKSB7XG4gICAgICBpZiAoL1xcPy8udGVzdChzZWdtZW50KSkge1xuICAgICAgICBpZiAocmVzdWx0cy5sZW5ndGggPT09IDAgJiYgYmFzZVBhdGggPT09ICcnKSB7XG4gICAgICAgICAgcmVzdWx0cy5wdXNoKCcvJylcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICByZXN1bHRzLnB1c2goYmFzZVBhdGgpXG4gICAgICAgIH1cbiAgICAgICAgY29uc3Qgb3B0aW9uYWxTZWdtZW50ID0gc2VnbWVudC5yZXBsYWNlKCc/JywgJycpXG4gICAgICAgIGJhc2VQYXRoICs9ICcvJyArIG9wdGlvbmFsU2VnbWVudFxuICAgICAgICByZXN1bHRzLnB1c2goYmFzZVBhdGgpXG4gICAgICB9IGVsc2Uge1xuICAgICAgICBiYXNlUGF0aCArPSAnLycgKyBzZWdtZW50XG4gICAgICB9XG4gICAgfVxuICB9KVxuXG4gIHJldHVybiByZXN1bHRzLmZpbHRlcigodiwgaSwgYSkgPT4gYS5pbmRleE9mKHYpID09PSBpKVxufVxuXG4vLyBPcHRpbWl6ZWRcbmNvbnN0IF9kZWNvZGVVUkkgPSAodmFsdWU6IHN0cmluZykgPT4ge1xuICBpZiAoIS9bJStdLy50ZXN0KHZhbHVlKSkge1xuICAgIHJldHVybiB2YWx1ZVxuICB9XG4gIGlmICh2YWx1ZS5pbmRleE9mKCcrJykgIT09IC0xKSB7XG4gICAgdmFsdWUgPSB2YWx1ZS5yZXBsYWNlKC9cXCsvZywgJyAnKVxuICB9XG4gIHJldHVybiB2YWx1ZS5pbmRleE9mKCclJykgIT09IC0xID8gdHJ5RGVjb2RlKHZhbHVlLCBkZWNvZGVVUklDb21wb25lbnRfKSA6IHZhbHVlXG59XG5cbmNvbnN0IF9nZXRRdWVyeVBhcmFtID0gKFxuICB1cmw6IHN0cmluZyxcbiAga2V5Pzogc3RyaW5nLFxuICBtdWx0aXBsZT86IGJvb2xlYW5cbik6IHN0cmluZyB8IHVuZGVmaW5lZCB8IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gfCBzdHJpbmdbXSB8IFJlY29yZDxzdHJpbmcsIHN0cmluZ1tdPiA9PiB7XG4gIGxldCBlbmNvZGVkXG5cbiAgaWYgKCFtdWx0aXBsZSAmJiBrZXkgJiYgIS9bJStdLy50ZXN0KGtleSkpIHtcbiAgICAvLyBvcHRpbWl6ZWQgZm9yIHVuZW5jb2RlZCBrZXlcblxuICAgIGxldCBrZXlJbmRleCA9IHVybC5pbmRleE9mKCc/JywgOClcbiAgICBpZiAoa2V5SW5kZXggPT09IC0xKSB7XG4gICAgICByZXR1cm4gdW5kZWZpbmVkXG4gICAgfVxuICAgIGlmICghdXJsLnN0YXJ0c1dpdGgoa2V5LCBrZXlJbmRleCArIDEpKSB7XG4gICAgICBrZXlJbmRleCA9IHVybC5pbmRleE9mKGAmJHtrZXl9YCwga2V5SW5kZXggKyAxKVxuICAgIH1cbiAgICB3aGlsZSAoa2V5SW5kZXggIT09IC0xKSB7XG4gICAgICBjb25zdCB0cmFpbGluZ0tleUNvZGUgPSB1cmwuY2hhckNvZGVBdChrZXlJbmRleCArIGtleS5sZW5ndGggKyAxKVxuICAgICAgaWYgKHRyYWlsaW5nS2V5Q29kZSA9PT0gNjEpIHtcbiAgICAgICAgY29uc3QgdmFsdWVJbmRleCA9IGtleUluZGV4ICsga2V5Lmxlbmd0aCArIDJcbiAgICAgICAgY29uc3QgZW5kSW5kZXggPSB1cmwuaW5kZXhPZignJicsIHZhbHVlSW5kZXgpXG4gICAgICAgIHJldHVybiBfZGVjb2RlVVJJKHVybC5zbGljZSh2YWx1ZUluZGV4LCBlbmRJbmRleCA9PT0gLTEgPyB1bmRlZmluZWQgOiBlbmRJbmRleCkpXG4gICAgICB9IGVsc2UgaWYgKHRyYWlsaW5nS2V5Q29kZSA9PSAzOCB8fCBpc05hTih0cmFpbGluZ0tleUNvZGUpKSB7XG4gICAgICAgIHJldHVybiAnJ1xuICAgICAgfVxuICAgICAga2V5SW5kZXggPSB1cmwuaW5kZXhPZihgJiR7a2V5fWAsIGtleUluZGV4ICsgMSlcbiAgICB9XG5cbiAgICBlbmNvZGVkID0gL1slK10vLnRlc3QodXJsKVxuICAgIGlmICghZW5jb2RlZCkge1xuICAgICAgcmV0dXJuIHVuZGVmaW5lZFxuICAgIH1cbiAgICAvLyBmYWxsYmFjayB0byBkZWZhdWx0IHJvdXRpbmVcbiAgfVxuXG4gIGNvbnN0IHJlc3VsdHM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gfCBSZWNvcmQ8c3RyaW5nLCBzdHJpbmdbXT4gPSB7fVxuICBlbmNvZGVkID8/PSAvWyUrXS8udGVzdCh1cmwpXG5cbiAgbGV0IGtleUluZGV4ID0gdXJsLmluZGV4T2YoJz8nLCA4KVxuICB3aGlsZSAoa2V5SW5kZXggIT09IC0xKSB7XG4gICAgY29uc3QgbmV4dEtleUluZGV4ID0gdXJsLmluZGV4T2YoJyYnLCBrZXlJbmRleCArIDEpXG4gICAgbGV0IHZhbHVlSW5kZXggPSB1cmwuaW5kZXhPZignPScsIGtleUluZGV4KVxuICAgIGlmICh2YWx1ZUluZGV4ID4gbmV4dEtleUluZGV4ICYmIG5leHRLZXlJbmRleCAhPT0gLTEpIHtcbiAgICAgIHZhbHVlSW5kZXggPSAtMVxuICAgIH1cbiAgICBsZXQgbmFtZSA9IHVybC5zbGljZShcbiAgICAgIGtleUluZGV4ICsgMSxcbiAgICAgIHZhbHVlSW5kZXggPT09IC0xID8gKG5leHRLZXlJbmRleCA9PT0gLTEgPyB1bmRlZmluZWQgOiBuZXh0S2V5SW5kZXgpIDogdmFsdWVJbmRleFxuICAgIClcbiAgICBpZiAoZW5jb2RlZCkge1xuICAgICAgbmFtZSA9IF9kZWNvZGVVUkkobmFtZSlcbiAgICB9XG5cbiAgICBrZXlJbmRleCA9IG5leHRLZXlJbmRleFxuXG4gICAgaWYgKG5hbWUgPT09ICcnKSB7XG4gICAgICBjb250aW51ZVxuICAgIH1cblxuICAgIGxldCB2YWx1ZVxuICAgIGlmICh2YWx1ZUluZGV4ID09PSAtMSkge1xuICAgICAgdmFsdWUgPSAnJ1xuICAgIH0gZWxzZSB7XG4gICAgICB2YWx1ZSA9IHVybC5zbGljZSh2YWx1ZUluZGV4ICsgMSwgbmV4dEtleUluZGV4ID09PSAtMSA/IHVuZGVmaW5lZCA6IG5leHRLZXlJbmRleClcbiAgICAgIGlmIChlbmNvZGVkKSB7XG4gICAgICAgIHZhbHVlID0gX2RlY29kZVVSSSh2YWx1ZSlcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAobXVsdGlwbGUpIHtcbiAgICAgIGlmICghKHJlc3VsdHNbbmFtZV0gJiYgQXJyYXkuaXNBcnJheShyZXN1bHRzW25hbWVdKSkpIHtcbiAgICAgICAgcmVzdWx0c1tuYW1lXSA9IFtdXG4gICAgICB9XG4gICAgICA7KHJlc3VsdHNbbmFtZV0gYXMgc3RyaW5nW10pLnB1c2godmFsdWUpXG4gICAgfSBlbHNlIHtcbiAgICAgIHJlc3VsdHNbbmFtZV0gPz89IHZhbHVlXG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIGtleSA/IHJlc3VsdHNba2V5XSA6IHJlc3VsdHNcbn1cblxuZXhwb3J0IGNvbnN0IGdldFF1ZXJ5UGFyYW06IChcbiAgdXJsOiBzdHJpbmcsXG4gIGtleT86IHN0cmluZ1xuKSA9PiBzdHJpbmcgfCB1bmRlZmluZWQgfCBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0gX2dldFF1ZXJ5UGFyYW0gYXMgKFxuICB1cmw6IHN0cmluZyxcbiAga2V5Pzogc3RyaW5nXG4pID0+IHN0cmluZyB8IHVuZGVmaW5lZCB8IFJlY29yZDxzdHJpbmcsIHN0cmluZz5cblxuZXhwb3J0IGNvbnN0IGdldFF1ZXJ5UGFyYW1zID0gKFxuICB1cmw6IHN0cmluZyxcbiAga2V5Pzogc3RyaW5nXG4pOiBzdHJpbmdbXSB8IHVuZGVmaW5lZCB8IFJlY29yZDxzdHJpbmcsIHN0cmluZ1tdPiA9PiB7XG4gIHJldHVybiBfZ2V0UXVlcnlQYXJhbSh1cmwsIGtleSwgdHJ1ZSkgYXMgc3RyaW5nW10gfCB1bmRlZmluZWQgfCBSZWNvcmQ8c3RyaW5nLCBzdHJpbmdbXT5cbn1cblxuLy8gYGRlY29kZVVSSUNvbXBvbmVudGAgaXMgYSBsb25nIG5hbWUuXG4vLyBCeSBtYWtpbmcgaXQgYSBmdW5jdGlvbiwgd2UgY2FuIHVzZSBpdCBjb21tb25seSB3aGVuIG1pbmlmaWVkLCByZWR1Y2luZyB0aGUgYW1vdW50IG9mIGNvZGUuXG5leHBvcnQgY29uc3QgZGVjb2RlVVJJQ29tcG9uZW50XyA9IGRlY29kZVVSSUNvbXBvbmVudFxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Q0FHQyxHQUlELE9BQU8sTUFBTSxZQUFZLENBQUM7RUFDeEIsTUFBTSxRQUFRLEtBQUssS0FBSyxDQUFDO0VBQ3pCLElBQUksS0FBSyxDQUFDLEVBQUUsS0FBSyxJQUFJO0lBQ25CLE1BQU0sS0FBSztFQUNiO0VBQ0EsT0FBTztBQUNULEVBQUM7QUFFRCxPQUFPLE1BQU0sbUJBQW1CLENBQUM7RUFDL0IsTUFBTSxFQUFFLE1BQU0sRUFBRSxJQUFJLEVBQUUsR0FBRyxzQkFBc0I7RUFFL0MsTUFBTSxRQUFRLFVBQVU7RUFDeEIsT0FBTyxrQkFBa0IsT0FBTztBQUNsQyxFQUFDO0FBRUQsTUFBTSx3QkFBd0IsQ0FBQztFQUM3QixNQUFNLFNBQTZCLEVBQUU7RUFFckMsT0FBTyxLQUFLLE9BQU8sQ0FBQyxjQUFjLENBQUMsT0FBTztJQUN4QyxNQUFNLE9BQU8sQ0FBQyxDQUFDLEVBQUUsT0FBTztJQUN4QixPQUFPLElBQUksQ0FBQztNQUFDO01BQU07S0FBTTtJQUN6QixPQUFPO0VBQ1Q7RUFF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
// denoCacheMetadata=8531614870275014375,17121110495551759840