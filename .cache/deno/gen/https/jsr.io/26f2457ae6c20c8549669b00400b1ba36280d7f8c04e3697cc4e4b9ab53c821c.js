import { METHOD_NAME_ALL } from '../../router.ts';
import { findTargetHandler, isMiddleware } from '../../utils/handler.ts';
/**
 * Get dirname
 * @param path File Path
 * @returns Parent dir path
 */ export const dirname = (path)=>{
  const separatedPath = path.split(/[\/\\]/);
  return separatedPath.slice(0, -1).join('/') // Windows supports slash path
  ;
};
const normalizePath = (path)=>{
  return path.replace(/(\\)/g, '/').replace(/\/$/g, '');
};
const handleParent = (resultPaths, beforeParentFlag)=>{
  if (resultPaths.length === 0 || beforeParentFlag) {
    resultPaths.push('..');
  } else {
    resultPaths.pop();
  }
};
const handleNonDot = (path, resultPaths)=>{
  path = path.replace(/^\.(?!.)/, '');
  if (path !== '') {
    resultPaths.push(path);
  }
};
const handleSegments = (paths, resultPaths)=>{
  let beforeParentFlag = false;
  for (const path of paths){
    // Handle `..`
    if (path === '..') {
      handleParent(resultPaths, beforeParentFlag);
      beforeParentFlag = true;
    } else {
      // Handle `.` or `abc`
      handleNonDot(path, resultPaths);
      beforeParentFlag = false;
    }
  }
};
export const joinPaths = (...paths)=>{
  paths = paths.map(normalizePath);
  const resultPaths = [];
  handleSegments(paths.join('/').split('/'), resultPaths);
  return (paths[0][0] === '/' ? '/' : '') + resultPaths.join('/');
};
export const filterStaticGenerateRoutes = (hono)=>{
  return hono.routes.reduce((acc, { method, handler, path })=>{
    const targetHandler = findTargetHandler(handler);
    if ([
      'GET',
      METHOD_NAME_ALL
    ].includes(method) && !isMiddleware(targetHandler)) {
      acc.push({
        path
      });
    }
    return acc;
  }, []);
};
export const isDynamicRoute = (path)=>{
  return path.split('/').some((segment)=>segment.startsWith(':') || segment.includes('*'));
};
export const ensureWithinOutDir = (outDir, filePath)=>{
  const normalizedOutDir = joinPaths('/', outDir);
  const normalizedFilePath = joinPaths('/', filePath);
  if (normalizedFilePath !== normalizedOutDir && !normalizedFilePath.startsWith(`${normalizedOutDir}/`)) {
    throw new Error(`Path traversal detected: "${filePath}" is outside the output directory`);
  }
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0Bob25vL2hvbm8vNC4xMi4yMy9zcmMvaGVscGVyL3NzZy91dGlscy50cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgdHlwZSB7IEhvbm8gfSBmcm9tICcuLi8uLi9ob25vLnRzJ1xuaW1wb3J0IHsgTUVUSE9EX05BTUVfQUxMIH0gZnJvbSAnLi4vLi4vcm91dGVyLnRzJ1xuaW1wb3J0IHR5cGUgeyBFbnYsIFJvdXRlclJvdXRlIH0gZnJvbSAnLi4vLi4vdHlwZXMudHMnXG5pbXBvcnQgeyBmaW5kVGFyZ2V0SGFuZGxlciwgaXNNaWRkbGV3YXJlIH0gZnJvbSAnLi4vLi4vdXRpbHMvaGFuZGxlci50cydcblxuLyoqXG4gKiBHZXQgZGlybmFtZVxuICogQHBhcmFtIHBhdGggRmlsZSBQYXRoXG4gKiBAcmV0dXJucyBQYXJlbnQgZGlyIHBhdGhcbiAqL1xuZXhwb3J0IGNvbnN0IGRpcm5hbWUgPSAocGF0aDogc3RyaW5nKTogc3RyaW5nID0+IHtcbiAgY29uc3Qgc2VwYXJhdGVkUGF0aCA9IHBhdGguc3BsaXQoL1tcXC9cXFxcXS8pXG4gIHJldHVybiBzZXBhcmF0ZWRQYXRoLnNsaWNlKDAsIC0xKS5qb2luKCcvJykgLy8gV2luZG93cyBzdXBwb3J0cyBzbGFzaCBwYXRoXG59XG5cbmNvbnN0IG5vcm1hbGl6ZVBhdGggPSAocGF0aDogc3RyaW5nKTogc3RyaW5nID0+IHtcbiAgcmV0dXJuIHBhdGgucmVwbGFjZSgvKFxcXFwpL2csICcvJykucmVwbGFjZSgvXFwvJC9nLCAnJylcbn1cblxuY29uc3QgaGFuZGxlUGFyZW50ID0gKHJlc3VsdFBhdGhzOiBzdHJpbmdbXSwgYmVmb3JlUGFyZW50RmxhZzogYm9vbGVhbik6IHZvaWQgPT4ge1xuICBpZiAocmVzdWx0UGF0aHMubGVuZ3RoID09PSAwIHx8IGJlZm9yZVBhcmVudEZsYWcpIHtcbiAgICByZXN1bHRQYXRocy5wdXNoKCcuLicpXG4gIH0gZWxzZSB7XG4gICAgcmVzdWx0UGF0aHMucG9wKClcbiAgfVxufVxuXG5jb25zdCBoYW5kbGVOb25Eb3QgPSAocGF0aDogc3RyaW5nLCByZXN1bHRQYXRoczogc3RyaW5nW10pOiB2b2lkID0+IHtcbiAgcGF0aCA9IHBhdGgucmVwbGFjZSgvXlxcLig/IS4pLywgJycpXG4gIGlmIChwYXRoICE9PSAnJykge1xuICAgIHJlc3VsdFBhdGhzLnB1c2gocGF0aClcbiAgfVxufVxuXG5jb25zdCBoYW5kbGVTZWdtZW50cyA9IChwYXRoczogc3RyaW5nW10sIHJlc3VsdFBhdGhzOiBzdHJpbmdbXSk6IHZvaWQgPT4ge1xuICBsZXQgYmVmb3JlUGFyZW50RmxhZyA9IGZhbHNlXG4gIGZvciAoY29uc3QgcGF0aCBvZiBwYXRocykge1xuICAgIC8vIEhhbmRsZSBgLi5gXG4gICAgaWYgKHBhdGggPT09ICcuLicpIHtcbiAgICAgIGhhbmRsZVBhcmVudChyZXN1bHRQYXRocywgYmVmb3JlUGFyZW50RmxhZylcbiAgICAgIGJlZm9yZVBhcmVudEZsYWcgPSB0cnVlXG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIEhhbmRsZSBgLmAgb3IgYGFiY2BcbiAgICAgIGhhbmRsZU5vbkRvdChwYXRoLCByZXN1bHRQYXRocylcbiAgICAgIGJlZm9yZVBhcmVudEZsYWcgPSBmYWxzZVxuICAgIH1cbiAgfVxufVxuXG5leHBvcnQgY29uc3Qgam9pblBhdGhzID0gKC4uLnBhdGhzOiBzdHJpbmdbXSk6IHN0cmluZyA9PiB7XG4gIHBhdGhzID0gcGF0aHMubWFwKG5vcm1hbGl6ZVBhdGgpXG4gIGNvbnN0IHJlc3VsdFBhdGhzOiBzdHJpbmdbXSA9IFtdXG4gIGhhbmRsZVNlZ21lbnRzKHBhdGhzLmpvaW4oJy8nKS5zcGxpdCgnLycpLCByZXN1bHRQYXRocylcbiAgcmV0dXJuIChwYXRoc1swXVswXSA9PT0gJy8nID8gJy8nIDogJycpICsgcmVzdWx0UGF0aHMuam9pbignLycpXG59XG5cbmludGVyZmFjZSBGaWx0ZXJTdGF0aWNHZW5lcmF0ZVJvdXRlRGF0YSB7XG4gIHBhdGg6IHN0cmluZ1xufVxuXG5leHBvcnQgY29uc3QgZmlsdGVyU3RhdGljR2VuZXJhdGVSb3V0ZXMgPSA8RSBleHRlbmRzIEVudj4oXG4gIGhvbm86IEhvbm88RT5cbik6IEZpbHRlclN0YXRpY0dlbmVyYXRlUm91dGVEYXRhW10gPT4ge1xuICByZXR1cm4gaG9uby5yb3V0ZXMucmVkdWNlKChhY2MsIHsgbWV0aG9kLCBoYW5kbGVyLCBwYXRoIH06IFJvdXRlclJvdXRlKSA9PiB7XG4gICAgY29uc3QgdGFyZ2V0SGFuZGxlciA9IGZpbmRUYXJnZXRIYW5kbGVyKGhhbmRsZXIpXG4gICAgaWYgKFsnR0VUJywgTUVUSE9EX05BTUVfQUxMXS5pbmNsdWRlcyhtZXRob2QpICYmICFpc01pZGRsZXdhcmUodGFyZ2V0SGFuZGxlcikpIHtcbiAgICAgIGFjYy5wdXNoKHsgcGF0aCB9KVxuICAgIH1cbiAgICByZXR1cm4gYWNjXG4gIH0sIFtdIGFzIEZpbHRlclN0YXRpY0dlbmVyYXRlUm91dGVEYXRhW10pXG59XG5cbmV4cG9ydCBjb25zdCBpc0R5bmFtaWNSb3V0ZSA9IChwYXRoOiBzdHJpbmcpOiBib29sZWFuID0+IHtcbiAgcmV0dXJuIHBhdGguc3BsaXQoJy8nKS5zb21lKChzZWdtZW50KSA9PiBzZWdtZW50LnN0YXJ0c1dpdGgoJzonKSB8fCBzZWdtZW50LmluY2x1ZGVzKCcqJykpXG59XG5cbmV4cG9ydCBjb25zdCBlbnN1cmVXaXRoaW5PdXREaXIgPSAob3V0RGlyOiBzdHJpbmcsIGZpbGVQYXRoOiBzdHJpbmcpOiB2b2lkID0+IHtcbiAgY29uc3Qgbm9ybWFsaXplZE91dERpciA9IGpvaW5QYXRocygnLycsIG91dERpcilcbiAgY29uc3Qgbm9ybWFsaXplZEZpbGVQYXRoID0gam9pblBhdGhzKCcvJywgZmlsZVBhdGgpXG5cbiAgaWYgKFxuICAgIG5vcm1hbGl6ZWRGaWxlUGF0aCAhPT0gbm9ybWFsaXplZE91dERpciAmJlxuICAgICFub3JtYWxpemVkRmlsZVBhdGguc3RhcnRzV2l0aChgJHtub3JtYWxpemVkT3V0RGlyfS9gKVxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYFBhdGggdHJhdmVyc2FsIGRldGVjdGVkOiBcIiR7ZmlsZVBhdGh9XCIgaXMgb3V0c2lkZSB0aGUgb3V0cHV0IGRpcmVjdG9yeWApXG4gIH1cbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFDQSxTQUFTLGVBQWUsUUFBUSxrQkFBaUI7QUFFakQsU0FBUyxpQkFBaUIsRUFBRSxZQUFZLFFBQVEseUJBQXdCO0FBRXhFOzs7O0NBSUMsR0FDRCxPQUFPLE1BQU0sVUFBVSxDQUFDO0VBQ3RCLE1BQU0sZ0JBQWdCLEtBQUssS0FBSyxDQUFDO0VBQ2pDLE9BQU8sY0FBYyxLQUFLLENBQUMsR0FBRyxDQUFDLEdBQUcsSUFBSSxDQUFDLEtBQUssOEJBQThCOztBQUM1RSxFQUFDO0FBRUQsTUFBTSxnQkFBZ0IsQ0FBQztFQUNyQixPQUFPLEtBQUssT0FBTyxDQUFDLFNBQVMsS0FBSyxPQUFPLENBQUMsUUFBUTtBQUNwRDtBQUVBLE1BQU0sZUFBZSxDQUFDLGFBQXVCO0VBQzNDLElBQUksWUFBWSxNQUFNLEtBQUssS0FBSyxrQkFBa0I7SUFDaEQsWUFBWSxJQUFJLENBQUM7RUFDbkIsT0FBTztJQUNMLFlBQVksR0FBRztFQUNqQjtBQUNGO0FBRUEsTUFBTSxlQUFlLENBQUMsTUFBYztFQUNsQyxPQUFPLEtBQUssT0FBTyxDQUFDLFlBQVk7RUFDaEMsSUFBSSxTQUFTLElBQUk7SUFDZixZQUFZLElBQUksQ0FBQztFQUNuQjtBQUNGO0FBRUEsTUFBTSxpQkFBaUIsQ0FBQyxPQUFpQjtFQUN2QyxJQUFJLG1CQUFtQjtFQUN2QixLQUFLLE1BQU0sUUFBUSxNQUFPO0lBQ3hCLGNBQWM7SUFDZCxJQUFJLFNBQVMsTUFBTTtNQUNqQixhQUFhLGFBQWE7TUFDMUIsbUJBQW1CO0lBQ3JCLE9BQU87TUFDTCxzQkFBc0I7TUFDdEIsYUFBYSxNQUFNO01BQ25CLG1CQUFtQjtJQUNyQjtFQUNGO0FBQ0Y7QUFFQSxPQUFPLE1BQU0sWUFBWSxDQUFDLEdBQUc7RUFDM0IsUUFBUSxNQUFNLEdBQUcsQ0FBQztFQUNsQixNQUFNLGNBQXdCLEVBQUU7RUFDaEMsZUFBZSxNQUFNLElBQUksQ0FBQyxLQUFLLEtBQUssQ0FBQyxNQUFNO0VBQzNDLE9BQU8sQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDLEVBQUUsS0FBSyxNQUFNLE1BQU0sRUFBRSxJQUFJLFlBQVksSUFBSSxDQUFDO0FBQzdELEVBQUM7QUFNRCxPQUFPLE1BQU0sNkJBQTZCLENBQ3hDO0VBRUEsT0FBTyxLQUFLLE1BQU0sQ0FBQyxNQUFNLENBQUMsQ0FBQyxLQUFLLEVBQUUsTUFBTSxFQUFFLE9BQU8sRUFBRSxJQUFJLEVBQWU7SUFDcEUsTUFBTSxnQkFBZ0Isa0JBQWtCO0lBQ3hDLElBQUk7TUFBQztNQUFPO0tBQWdCLENBQUMsUUFBUSxDQUFDLFdBQVcsQ0FBQyxhQUFhLGdCQUFnQjtNQUM3RSxJQUFJLElBQUksQ0FBQztRQUFFO01BQUs7SUFDbEI7SUFDQSxPQUFPO0VBQ1QsR0FBRyxFQUFFO0FBQ1AsRUFBQztBQUVELE9BQU8sTUFBTSxpQkFBaUIsQ0FBQztFQUM3QixPQUFPLEtBQUssS0FBSyxDQUFDLEtBQUssSUFBSSxDQUFDLENBQUMsVUFBWSxRQUFRLFVBQVUsQ0FBQyxRQUFRLFFBQVEsUUFBUSxDQUFDO0FBQ3ZGLEVBQUM7QUFFRCxPQUFPLE1BQU0scUJBQXFCLENBQUMsUUFBZ0I7RUFDakQsTUFBTSxtQkFBbUIsVUFBVSxLQUFLO0VBQ3hDLE1BQU0scUJBQXFCLFVBQVUsS0FBSztFQUUxQyxJQUNFLHVCQUF1QixvQkFDdkIsQ0FBQyxtQkFBbUIsVUFBVSxDQUFDLEdBQUcsaUJBQWlCLENBQUMsQ0FBQyxHQUNyRDtJQUNBLE1BQU0sSUFBSSxNQUFNLENBQUMsMEJBQTBCLEVBQUUsU0FBUyxpQ0FBaUMsQ0FBQztFQUMxRjtBQUNGLEVBQUMifQ==
// denoCacheMetadata=4459139362972756361,11049857285042610930