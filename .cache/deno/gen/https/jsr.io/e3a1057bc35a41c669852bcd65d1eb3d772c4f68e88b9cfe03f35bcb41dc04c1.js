/**
 * `defaultJoin` does not support Windows paths and always uses `/` separators.
 * If you need Windows path support, please use `join` exported from `node:path` etc. instead.
 */ export const defaultJoin = (...paths)=>{
  // Join non-empty paths with '/'
  let result = paths.filter((p)=>p !== '').join('/');
  // Normalize multiple slashes to single slash
  result = result.replace(/(?<=\/)\/+/g, '');
  // Handle path resolution (. and ..)
  const segments = result.split('/');
  const resolved = [];
  for (const segment of segments){
    if (segment === '..' && resolved.length > 0 && resolved.at(-1) !== '..') {
      resolved.pop();
    } else if (segment !== '.') {
      resolved.push(segment);
    }
  }
  return resolved.join('/') || '.';
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0Bob25vL2hvbm8vNC4xMi4yMy9zcmMvbWlkZGxld2FyZS9zZXJ2ZS1zdGF0aWMvcGF0aC50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIGBkZWZhdWx0Sm9pbmAgZG9lcyBub3Qgc3VwcG9ydCBXaW5kb3dzIHBhdGhzIGFuZCBhbHdheXMgdXNlcyBgL2Agc2VwYXJhdG9ycy5cbiAqIElmIHlvdSBuZWVkIFdpbmRvd3MgcGF0aCBzdXBwb3J0LCBwbGVhc2UgdXNlIGBqb2luYCBleHBvcnRlZCBmcm9tIGBub2RlOnBhdGhgIGV0Yy4gaW5zdGVhZC5cbiAqL1xuZXhwb3J0IGNvbnN0IGRlZmF1bHRKb2luID0gKC4uLnBhdGhzOiBzdHJpbmdbXSk6IHN0cmluZyA9PiB7XG4gIC8vIEpvaW4gbm9uLWVtcHR5IHBhdGhzIHdpdGggJy8nXG4gIGxldCByZXN1bHQgPSBwYXRocy5maWx0ZXIoKHApID0+IHAgIT09ICcnKS5qb2luKCcvJylcblxuICAvLyBOb3JtYWxpemUgbXVsdGlwbGUgc2xhc2hlcyB0byBzaW5nbGUgc2xhc2hcbiAgcmVzdWx0ID0gcmVzdWx0LnJlcGxhY2UoLyg/PD1cXC8pXFwvKy9nLCAnJylcblxuICAvLyBIYW5kbGUgcGF0aCByZXNvbHV0aW9uICguIGFuZCAuLilcbiAgY29uc3Qgc2VnbWVudHMgPSByZXN1bHQuc3BsaXQoJy8nKVxuICBjb25zdCByZXNvbHZlZCA9IFtdXG5cbiAgZm9yIChjb25zdCBzZWdtZW50IG9mIHNlZ21lbnRzKSB7XG4gICAgaWYgKHNlZ21lbnQgPT09ICcuLicgJiYgcmVzb2x2ZWQubGVuZ3RoID4gMCAmJiByZXNvbHZlZC5hdCgtMSkgIT09ICcuLicpIHtcbiAgICAgIHJlc29sdmVkLnBvcCgpXG4gICAgfSBlbHNlIGlmIChzZWdtZW50ICE9PSAnLicpIHtcbiAgICAgIHJlc29sdmVkLnB1c2goc2VnbWVudClcbiAgICB9XG4gIH1cblxuICByZXR1cm4gcmVzb2x2ZWQuam9pbignLycpIHx8ICcuJ1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Q0FHQyxHQUNELE9BQU8sTUFBTSxjQUFjLENBQUMsR0FBRztFQUM3QixnQ0FBZ0M7RUFDaEMsSUFBSSxTQUFTLE1BQU0sTUFBTSxDQUFDLENBQUMsSUFBTSxNQUFNLElBQUksSUFBSSxDQUFDO0VBRWhELDZDQUE2QztFQUM3QyxTQUFTLE9BQU8sT0FBTyxDQUFDLGVBQWU7RUFFdkMsb0NBQW9DO0VBQ3BDLE1BQU0sV0FBVyxPQUFPLEtBQUssQ0FBQztFQUM5QixNQUFNLFdBQVcsRUFBRTtFQUVuQixLQUFLLE1BQU0sV0FBVyxTQUFVO0lBQzlCLElBQUksWUFBWSxRQUFRLFNBQVMsTUFBTSxHQUFHLEtBQUssU0FBUyxFQUFFLENBQUMsQ0FBQyxPQUFPLE1BQU07TUFDdkUsU0FBUyxHQUFHO0lBQ2QsT0FBTyxJQUFJLFlBQVksS0FBSztNQUMxQixTQUFTLElBQUksQ0FBQztJQUNoQjtFQUNGO0VBRUEsT0FBTyxTQUFTLElBQUksQ0FBQyxRQUFRO0FBQy9CLEVBQUMifQ==
// denoCacheMetadata=5304570884398082982,493183797762120945