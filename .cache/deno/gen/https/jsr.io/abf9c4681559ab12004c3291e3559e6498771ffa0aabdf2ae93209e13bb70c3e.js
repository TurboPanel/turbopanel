/**
 * @module
 * MIME utility.
 */ export const getMimeType = (filename, mimes = baseMimes)=>{
  const regexp = /\.([a-zA-Z0-9]+?)$/;
  const match = filename.match(regexp);
  if (!match) {
    return;
  }
  return mimes[match[1].toLowerCase()];
};
export const getExtension = (mimeType)=>{
  const baseType = mimeType.split(';', 1)[0].trim();
  for(const ext in baseMimes){
    const stored = baseMimes[ext];
    if (stored === mimeType || stored.split(';', 1)[0].trim() === baseType) {
      return ext;
    }
  }
};
export { baseMimes as mimes };
const _baseMimes = {
  aac: 'audio/aac',
  avi: 'video/x-msvideo',
  avif: 'image/avif',
  av1: 'video/av1',
  bin: 'application/octet-stream',
  bmp: 'image/bmp',
  css: 'text/css; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  eot: 'application/vnd.ms-fontobject',
  epub: 'application/epub+zip',
  gif: 'image/gif',
  gz: 'application/gzip',
  htm: 'text/html; charset=utf-8',
  html: 'text/html; charset=utf-8',
  ico: 'image/x-icon',
  ics: 'text/calendar; charset=utf-8',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  js: 'text/javascript; charset=utf-8',
  json: 'application/json',
  jsonld: 'application/ld+json',
  map: 'application/json',
  mid: 'audio/x-midi',
  midi: 'audio/x-midi',
  mjs: 'text/javascript; charset=utf-8',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  mpeg: 'video/mpeg',
  oga: 'audio/ogg',
  ogv: 'video/ogg',
  ogx: 'application/ogg',
  opus: 'audio/opus',
  otf: 'font/otf',
  pdf: 'application/pdf',
  png: 'image/png',
  rtf: 'application/rtf',
  svg: 'image/svg+xml; charset=utf-8',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  ts: 'video/mp2t',
  ttf: 'font/ttf',
  txt: 'text/plain; charset=utf-8',
  wasm: 'application/wasm',
  webm: 'video/webm',
  weba: 'audio/webm',
  webmanifest: 'application/manifest+json',
  webp: 'image/webp',
  woff: 'font/woff',
  woff2: 'font/woff2',
  xhtml: 'application/xhtml+xml; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  zip: 'application/zip',
  '3gp': 'video/3gpp',
  '3g2': 'video/3gpp2',
  gltf: 'model/gltf+json',
  glb: 'model/gltf-binary'
};
const baseMimes = _baseMimes;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0Bob25vL2hvbm8vNC4xMi4yMy9zcmMvdXRpbHMvbWltZS50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIEBtb2R1bGVcbiAqIE1JTUUgdXRpbGl0eS5cbiAqL1xuXG5leHBvcnQgY29uc3QgZ2V0TWltZVR5cGUgPSAoXG4gIGZpbGVuYW1lOiBzdHJpbmcsXG4gIG1pbWVzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0gYmFzZU1pbWVzXG4pOiBzdHJpbmcgfCB1bmRlZmluZWQgPT4ge1xuICBjb25zdCByZWdleHAgPSAvXFwuKFthLXpBLVowLTldKz8pJC9cbiAgY29uc3QgbWF0Y2ggPSBmaWxlbmFtZS5tYXRjaChyZWdleHApXG4gIGlmICghbWF0Y2gpIHtcbiAgICByZXR1cm5cbiAgfVxuICByZXR1cm4gbWltZXNbbWF0Y2hbMV0udG9Mb3dlckNhc2UoKV1cbn1cblxuZXhwb3J0IGNvbnN0IGdldEV4dGVuc2lvbiA9IChtaW1lVHlwZTogc3RyaW5nKTogc3RyaW5nIHwgdW5kZWZpbmVkID0+IHtcbiAgY29uc3QgYmFzZVR5cGUgPSBtaW1lVHlwZS5zcGxpdCgnOycsIDEpWzBdLnRyaW0oKVxuICBmb3IgKGNvbnN0IGV4dCBpbiBiYXNlTWltZXMpIHtcbiAgICBjb25zdCBzdG9yZWQgPSBiYXNlTWltZXNbZXh0XVxuICAgIGlmIChzdG9yZWQgPT09IG1pbWVUeXBlIHx8IHN0b3JlZC5zcGxpdCgnOycsIDEpWzBdLnRyaW0oKSA9PT0gYmFzZVR5cGUpIHtcbiAgICAgIHJldHVybiBleHRcbiAgICB9XG4gIH1cbn1cblxuZXhwb3J0IHsgYmFzZU1pbWVzIGFzIG1pbWVzIH1cblxuLyoqXG4gKiBVbmlvbiB0eXBlcyBmb3IgQmFzZU1pbWVcbiAqL1xuZXhwb3J0IHR5cGUgQmFzZU1pbWUgPSAodHlwZW9mIF9iYXNlTWltZXMpW2tleW9mIHR5cGVvZiBfYmFzZU1pbWVzXVxuXG5jb25zdCBfYmFzZU1pbWVzID0ge1xuICBhYWM6ICdhdWRpby9hYWMnLFxuICBhdmk6ICd2aWRlby94LW1zdmlkZW8nLFxuICBhdmlmOiAnaW1hZ2UvYXZpZicsXG4gIGF2MTogJ3ZpZGVvL2F2MScsXG4gIGJpbjogJ2FwcGxpY2F0aW9uL29jdGV0LXN0cmVhbScsXG4gIGJtcDogJ2ltYWdlL2JtcCcsXG4gIGNzczogJ3RleHQvY3NzOyBjaGFyc2V0PXV0Zi04JyxcbiAgY3N2OiAndGV4dC9jc3Y7IGNoYXJzZXQ9dXRmLTgnLFxuICBlb3Q6ICdhcHBsaWNhdGlvbi92bmQubXMtZm9udG9iamVjdCcsXG4gIGVwdWI6ICdhcHBsaWNhdGlvbi9lcHViK3ppcCcsXG4gIGdpZjogJ2ltYWdlL2dpZicsXG4gIGd6OiAnYXBwbGljYXRpb24vZ3ppcCcsXG4gIGh0bTogJ3RleHQvaHRtbDsgY2hhcnNldD11dGYtOCcsXG4gIGh0bWw6ICd0ZXh0L2h0bWw7IGNoYXJzZXQ9dXRmLTgnLFxuICBpY286ICdpbWFnZS94LWljb24nLFxuICBpY3M6ICd0ZXh0L2NhbGVuZGFyOyBjaGFyc2V0PXV0Zi04JyxcbiAganBlZzogJ2ltYWdlL2pwZWcnLFxuICBqcGc6ICdpbWFnZS9qcGVnJyxcbiAganM6ICd0ZXh0L2phdmFzY3JpcHQ7IGNoYXJzZXQ9dXRmLTgnLFxuICBqc29uOiAnYXBwbGljYXRpb24vanNvbicsXG4gIGpzb25sZDogJ2FwcGxpY2F0aW9uL2xkK2pzb24nLFxuICBtYXA6ICdhcHBsaWNhdGlvbi9qc29uJyxcbiAgbWlkOiAnYXVkaW8veC1taWRpJyxcbiAgbWlkaTogJ2F1ZGlvL3gtbWlkaScsXG4gIG1qczogJ3RleHQvamF2YXNjcmlwdDsgY2hhcnNldD11dGYtOCcsXG4gIG1wMzogJ2F1ZGlvL21wZWcnLFxuICBtcDQ6ICd2aWRlby9tcDQnLFxuICBtcGVnOiAndmlkZW8vbXBlZycsXG4gIG9nYTogJ2F1ZGlvL29nZycsXG4gIG9ndjogJ3ZpZGVvL29nZycsXG4gIG9neDogJ2FwcGxpY2F0aW9uL29nZycsXG4gIG9wdXM6ICdhdWRpby9vcHVzJyxcbiAgb3RmOiAnZm9udC9vdGYnLFxuICBwZGY6ICdhcHBsaWNhdGlvbi9wZGYnLFxuICBwbmc6ICdpbWFnZS9wbmcnLFxuICBydGY6ICdhcHBsaWNhdGlvbi9ydGYnLFxuICBzdmc6ICdpbWFnZS9zdmcreG1sOyBjaGFyc2V0PXV0Zi04JyxcbiAgdGlmOiAnaW1hZ2UvdGlmZicsXG4gIHRpZmY6ICdpbWFnZS90aWZmJyxcbiAgdHM6ICd2aWRlby9tcDJ0JyxcbiAgdHRmOiAnZm9udC90dGYnLFxuICB0eHQ6ICd0ZXh0L3BsYWluOyBjaGFyc2V0PXV0Zi04JyxcbiAgd2FzbTogJ2FwcGxpY2F0aW9uL3dhc20nLFxuICB3ZWJtOiAndmlkZW8vd2VibScsXG4gIHdlYmE6ICdhdWRpby93ZWJtJyxcbiAgd2VibWFuaWZlc3Q6ICdhcHBsaWNhdGlvbi9tYW5pZmVzdCtqc29uJyxcbiAgd2VicDogJ2ltYWdlL3dlYnAnLFxuICB3b2ZmOiAnZm9udC93b2ZmJyxcbiAgd29mZjI6ICdmb250L3dvZmYyJyxcbiAgeGh0bWw6ICdhcHBsaWNhdGlvbi94aHRtbCt4bWw7IGNoYXJzZXQ9dXRmLTgnLFxuICB4bWw6ICdhcHBsaWNhdGlvbi94bWw7IGNoYXJzZXQ9dXRmLTgnLFxuICB6aXA6ICdhcHBsaWNhdGlvbi96aXAnLFxuICAnM2dwJzogJ3ZpZGVvLzNncHAnLFxuICAnM2cyJzogJ3ZpZGVvLzNncHAyJyxcbiAgZ2x0ZjogJ21vZGVsL2dsdGYranNvbicsXG4gIGdsYjogJ21vZGVsL2dsdGYtYmluYXJ5Jyxcbn0gYXMgY29uc3RcblxuY29uc3QgYmFzZU1pbWVzOiBSZWNvcmQ8c3RyaW5nLCBCYXNlTWltZT4gPSBfYmFzZU1pbWVzXG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7OztDQUdDLEdBRUQsT0FBTyxNQUFNLGNBQWMsQ0FDekIsVUFDQSxRQUFnQyxTQUFTO0VBRXpDLE1BQU0sU0FBUztFQUNmLE1BQU0sUUFBUSxTQUFTLEtBQUssQ0FBQztFQUM3QixJQUFJLENBQUMsT0FBTztJQUNWO0VBQ0Y7RUFDQSxPQUFPLEtBQUssQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDLFdBQVcsR0FBRztBQUN0QyxFQUFDO0FBRUQsT0FBTyxNQUFNLGVBQWUsQ0FBQztFQUMzQixNQUFNLFdBQVcsU0FBUyxLQUFLLENBQUMsS0FBSyxFQUFFLENBQUMsRUFBRSxDQUFDLElBQUk7RUFDL0MsSUFBSyxNQUFNLE9BQU8sVUFBVztJQUMzQixNQUFNLFNBQVMsU0FBUyxDQUFDLElBQUk7SUFDN0IsSUFBSSxXQUFXLFlBQVksT0FBTyxLQUFLLENBQUMsS0FBSyxFQUFFLENBQUMsRUFBRSxDQUFDLElBQUksT0FBTyxVQUFVO01BQ3RFLE9BQU87SUFDVDtFQUNGO0FBQ0YsRUFBQztBQUVELFNBQVMsYUFBYSxLQUFLLEdBQUU7QUFPN0IsTUFBTSxhQUFhO0VBQ2pCLEtBQUs7RUFDTCxLQUFLO0VBQ0wsTUFBTTtFQUNOLEtBQUs7RUFDTCxLQUFLO0VBQ0wsS0FBSztFQUNMLEtBQUs7RUFDTCxLQUFLO0VBQ0wsS0FBSztFQUNMLE1BQU07RUFDTixLQUFLO0VBQ0wsSUFBSTtFQUNKLEtBQUs7RUFDTCxNQUFNO0VBQ04sS0FBSztFQUNMLEtBQUs7RUFDTCxNQUFNO0VBQ04sS0FBSztFQUNMLElBQUk7RUFDSixNQUFNO0VBQ04sUUFBUTtFQUNSLEtBQUs7RUFDTCxLQUFLO0VBQ0wsTUFBTTtFQUNOLEtBQUs7RUFDTCxLQUFLO0VBQ0wsS0FBSztFQUNMLE1BQU07RUFDTixLQUFLO0VBQ0wsS0FBSztFQUNMLEtBQUs7RUFDTCxNQUFNO0VBQ04sS0FBSztFQUNMLEtBQUs7RUFDTCxLQUFLO0VBQ0wsS0FBSztFQUNMLEtBQUs7RUFDTCxLQUFLO0VBQ0wsTUFBTTtFQUNOLElBQUk7RUFDSixLQUFLO0VBQ0wsS0FBSztFQUNMLE1BQU07RUFDTixNQUFNO0VBQ04sTUFBTTtFQUNOLGFBQWE7RUFDYixNQUFNO0VBQ04sTUFBTTtFQUNOLE9BQU87RUFDUCxPQUFPO0VBQ1AsS0FBSztFQUNMLEtBQUs7RUFDTCxPQUFPO0VBQ1AsT0FBTztFQUNQLE1BQU07RUFDTixLQUFLO0FBQ1A7QUFFQSxNQUFNLFlBQXNDIn0=
// denoCacheMetadata=9721722145960598505,18108971469218969919