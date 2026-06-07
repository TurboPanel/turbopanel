import { join } from 'node:path';
import { serveStatic as baseServeStatic } from '../../middleware/serve-static/index.ts';
const { open, lstatSync, errors } = Deno;
export const serveStatic = (options = {})=>{
  return async function serveStatic(c, next) {
    const getContent = async (path)=>{
      try {
        if (isDir(path)) {
          return null;
        }
        const file = await open(path);
        return file.readable;
      } catch (e) {
        if (!(e instanceof errors.NotFound)) {
          console.warn(`${e}`);
        }
        return null;
      }
    };
    const isDir = (path)=>{
      let isDir;
      try {
        const stat = lstatSync(path);
        isDir = stat.isDirectory;
      } catch  {}
      return isDir;
    };
    return baseServeStatic({
      ...options,
      getContent,
      join,
      isDir
    })(c, next);
  };
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0Bob25vL2hvbm8vNC4xMi4yMy9zcmMvYWRhcHRlci9kZW5vL3NlcnZlLXN0YXRpYy50cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBqb2luIH0gZnJvbSAnbm9kZTpwYXRoJ1xuaW1wb3J0IHR5cGUgeyBTZXJ2ZVN0YXRpY09wdGlvbnMgfSBmcm9tICcuLi8uLi9taWRkbGV3YXJlL3NlcnZlLXN0YXRpYy9pbmRleC50cydcbmltcG9ydCB7IHNlcnZlU3RhdGljIGFzIGJhc2VTZXJ2ZVN0YXRpYyB9IGZyb20gJy4uLy4uL21pZGRsZXdhcmUvc2VydmUtc3RhdGljL2luZGV4LnRzJ1xuaW1wb3J0IHR5cGUgeyBFbnYsIE1pZGRsZXdhcmVIYW5kbGVyIH0gZnJvbSAnLi4vLi4vdHlwZXMudHMnXG5cbmNvbnN0IHsgb3BlbiwgbHN0YXRTeW5jLCBlcnJvcnMgfSA9IERlbm9cblxuZXhwb3J0IGNvbnN0IHNlcnZlU3RhdGljID0gPEUgZXh0ZW5kcyBFbnYgPSBFbnY+KFxuICBvcHRpb25zOiBTZXJ2ZVN0YXRpY09wdGlvbnM8RT4gPSB7fVxuKTogTWlkZGxld2FyZUhhbmRsZXIgPT4ge1xuICByZXR1cm4gYXN5bmMgZnVuY3Rpb24gc2VydmVTdGF0aWMoYywgbmV4dCkge1xuICAgIGNvbnN0IGdldENvbnRlbnQgPSBhc3luYyAocGF0aDogc3RyaW5nKSA9PiB7XG4gICAgICB0cnkge1xuICAgICAgICBpZiAoaXNEaXIocGF0aCkpIHtcbiAgICAgICAgICByZXR1cm4gbnVsbFxuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgZmlsZSA9IGF3YWl0IG9wZW4ocGF0aClcbiAgICAgICAgcmV0dXJuIGZpbGUucmVhZGFibGVcbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgaWYgKCEoZSBpbnN0YW5jZW9mIGVycm9ycy5Ob3RGb3VuZCkpIHtcbiAgICAgICAgICBjb25zb2xlLndhcm4oYCR7ZX1gKVxuICAgICAgICB9XG4gICAgICAgIHJldHVybiBudWxsXG4gICAgICB9XG4gICAgfVxuICAgIGNvbnN0IGlzRGlyID0gKHBhdGg6IHN0cmluZykgPT4ge1xuICAgICAgbGV0IGlzRGlyXG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBzdGF0ID0gbHN0YXRTeW5jKHBhdGgpXG4gICAgICAgIGlzRGlyID0gc3RhdC5pc0RpcmVjdG9yeVxuICAgICAgfSBjYXRjaCB7fVxuICAgICAgcmV0dXJuIGlzRGlyXG4gICAgfVxuICAgIHJldHVybiBiYXNlU2VydmVTdGF0aWMoe1xuICAgICAgLi4ub3B0aW9ucyxcbiAgICAgIGdldENvbnRlbnQsXG4gICAgICBqb2luLFxuICAgICAgaXNEaXIsXG4gICAgfSkoYywgbmV4dClcbiAgfVxufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLFNBQVMsSUFBSSxRQUFRLFlBQVc7QUFFaEMsU0FBUyxlQUFlLGVBQWUsUUFBUSx5Q0FBd0M7QUFHdkYsTUFBTSxFQUFFLElBQUksRUFBRSxTQUFTLEVBQUUsTUFBTSxFQUFFLEdBQUc7QUFFcEMsT0FBTyxNQUFNLGNBQWMsQ0FDekIsVUFBaUMsQ0FBQyxDQUFDO0VBRW5DLE9BQU8sZUFBZSxZQUFZLENBQUMsRUFBRSxJQUFJO0lBQ3ZDLE1BQU0sYUFBYSxPQUFPO01BQ3hCLElBQUk7UUFDRixJQUFJLE1BQU0sT0FBTztVQUNmLE9BQU87UUFDVDtRQUVBLE1BQU0sT0FBTyxNQUFNLEtBQUs7UUFDeEIsT0FBTyxLQUFLLFFBQVE7TUFDdEIsRUFBRSxPQUFPLEdBQUc7UUFDVixJQUFJLENBQUMsQ0FBQyxhQUFhLE9BQU8sUUFBUSxHQUFHO1VBQ25DLFFBQVEsSUFBSSxDQUFDLEdBQUcsR0FBRztRQUNyQjtRQUNBLE9BQU87TUFDVDtJQUNGO0lBQ0EsTUFBTSxRQUFRLENBQUM7TUFDYixJQUFJO01BQ0osSUFBSTtRQUNGLE1BQU0sT0FBTyxVQUFVO1FBQ3ZCLFFBQVEsS0FBSyxXQUFXO01BQzFCLEVBQUUsT0FBTSxDQUFDO01BQ1QsT0FBTztJQUNUO0lBQ0EsT0FBTyxnQkFBZ0I7TUFDckIsR0FBRyxPQUFPO01BQ1Y7TUFDQTtNQUNBO0lBQ0YsR0FBRyxHQUFHO0VBQ1I7QUFDRixFQUFDIn0=
// denoCacheMetadata=15455702488807378147,17871377498714674228