import { Node } from './node.ts';
export class Trie {
  #context = {
    varIndex: 0
  };
  #root = new Node();
  insert(path, index, pathErrorCheckOnly) {
    const paramAssoc = [];
    const groups = [] // [mark, original string]
    ;
    for(let i = 0;;){
      let replaced = false;
      path = path.replace(/\{[^}]+\}/g, (m)=>{
        const mark = `@\\${i}`;
        groups[i] = [
          mark,
          m
        ];
        i++;
        replaced = true;
        return mark;
      });
      if (!replaced) {
        break;
      }
    }
    /**
     *  - pattern (:label, :label{0-9]+}, ...)
     *  - /* wildcard
     *  - character
     */ const tokens = path.match(/(?::[^\/]+)|(?:\/\*$)|./g) || [];
    for(let i = groups.length - 1; i >= 0; i--){
      const [mark] = groups[i];
      for(let j = tokens.length - 1; j >= 0; j--){
        if (tokens[j].indexOf(mark) !== -1) {
          tokens[j] = tokens[j].replace(mark, groups[i][1]);
          break;
        }
      }
    }
    this.#root.insert(tokens, index, paramAssoc, this.#context, pathErrorCheckOnly);
    return paramAssoc;
  }
  buildRegExp() {
    let regexp = this.#root.buildRegExpStr();
    if (regexp === '') {
      return [
        /^$/,
        [],
        []
      ] // never match
      ;
    }
    let captureIndex = 0;
    const indexReplacementMap = [];
    const paramReplacementMap = [];
    regexp = regexp.replace(/#(\d+)|@(\d+)|\.\*\$/g, (_, handlerIndex, paramIndex)=>{
      if (handlerIndex !== undefined) {
        indexReplacementMap[++captureIndex] = Number(handlerIndex);
        return '$()';
      }
      if (paramIndex !== undefined) {
        paramReplacementMap[Number(paramIndex)] = ++captureIndex;
        return '';
      }
      return '';
    });
    return [
      new RegExp(`^${regexp}`),
      indexReplacementMap,
      paramReplacementMap
    ];
  }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0Bob25vL2hvbm8vNC4xMi4yMy9zcmMvcm91dGVyL3JlZy1leHAtcm91dGVyL3RyaWUudHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHR5cGUgeyBDb250ZXh0LCBQYXJhbUFzc29jQXJyYXkgfSBmcm9tICcuL25vZGUudHMnXG5pbXBvcnQgeyBOb2RlIH0gZnJvbSAnLi9ub2RlLnRzJ1xuXG5leHBvcnQgdHlwZSBSZXBsYWNlbWVudE1hcCA9IG51bWJlcltdXG5cbmV4cG9ydCBjbGFzcyBUcmllIHtcbiAgI2NvbnRleHQ6IENvbnRleHQgPSB7IHZhckluZGV4OiAwIH1cbiAgI3Jvb3Q6IE5vZGUgPSBuZXcgTm9kZSgpXG5cbiAgaW5zZXJ0KHBhdGg6IHN0cmluZywgaW5kZXg6IG51bWJlciwgcGF0aEVycm9yQ2hlY2tPbmx5OiBib29sZWFuKTogUGFyYW1Bc3NvY0FycmF5IHtcbiAgICBjb25zdCBwYXJhbUFzc29jOiBQYXJhbUFzc29jQXJyYXkgPSBbXVxuXG4gICAgY29uc3QgZ3JvdXBzOiBbc3RyaW5nLCBzdHJpbmddW10gPSBbXSAvLyBbbWFyaywgb3JpZ2luYWwgc3RyaW5nXVxuICAgIGZvciAobGV0IGkgPSAwOyA7ICkge1xuICAgICAgbGV0IHJlcGxhY2VkID0gZmFsc2VcbiAgICAgIHBhdGggPSBwYXRoLnJlcGxhY2UoL1xce1tefV0rXFx9L2csIChtKSA9PiB7XG4gICAgICAgIGNvbnN0IG1hcmsgPSBgQFxcXFwke2l9YFxuICAgICAgICBncm91cHNbaV0gPSBbbWFyaywgbV1cbiAgICAgICAgaSsrXG4gICAgICAgIHJlcGxhY2VkID0gdHJ1ZVxuICAgICAgICByZXR1cm4gbWFya1xuICAgICAgfSlcbiAgICAgIGlmICghcmVwbGFjZWQpIHtcbiAgICAgICAgYnJlYWtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiAgLSBwYXR0ZXJuICg6bGFiZWwsIDpsYWJlbHswLTldK30sIC4uLilcbiAgICAgKiAgLSAvKiB3aWxkY2FyZFxuICAgICAqICAtIGNoYXJhY3RlclxuICAgICAqL1xuICAgIGNvbnN0IHRva2VucyA9IHBhdGgubWF0Y2goLyg/OjpbXlxcL10rKXwoPzpcXC9cXCokKXwuL2cpIHx8IFtdXG4gICAgZm9yIChsZXQgaSA9IGdyb3Vwcy5sZW5ndGggLSAxOyBpID49IDA7IGktLSkge1xuICAgICAgY29uc3QgW21hcmtdID0gZ3JvdXBzW2ldXG4gICAgICBmb3IgKGxldCBqID0gdG9rZW5zLmxlbmd0aCAtIDE7IGogPj0gMDsgai0tKSB7XG4gICAgICAgIGlmICh0b2tlbnNbal0uaW5kZXhPZihtYXJrKSAhPT0gLTEpIHtcbiAgICAgICAgICB0b2tlbnNbal0gPSB0b2tlbnNbal0ucmVwbGFjZShtYXJrLCBncm91cHNbaV1bMV0pXG4gICAgICAgICAgYnJlYWtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cblxuICAgIHRoaXMuI3Jvb3QuaW5zZXJ0KHRva2VucywgaW5kZXgsIHBhcmFtQXNzb2MsIHRoaXMuI2NvbnRleHQsIHBhdGhFcnJvckNoZWNrT25seSlcblxuICAgIHJldHVybiBwYXJhbUFzc29jXG4gIH1cblxuICBidWlsZFJlZ0V4cCgpOiBbUmVnRXhwLCBSZXBsYWNlbWVudE1hcCwgUmVwbGFjZW1lbnRNYXBdIHtcbiAgICBsZXQgcmVnZXhwID0gdGhpcy4jcm9vdC5idWlsZFJlZ0V4cFN0cigpXG4gICAgaWYgKHJlZ2V4cCA9PT0gJycpIHtcbiAgICAgIHJldHVybiBbL14kLywgW10sIFtdXSAvLyBuZXZlciBtYXRjaFxuICAgIH1cblxuICAgIGxldCBjYXB0dXJlSW5kZXggPSAwXG4gICAgY29uc3QgaW5kZXhSZXBsYWNlbWVudE1hcDogUmVwbGFjZW1lbnRNYXAgPSBbXVxuICAgIGNvbnN0IHBhcmFtUmVwbGFjZW1lbnRNYXA6IFJlcGxhY2VtZW50TWFwID0gW11cblxuICAgIHJlZ2V4cCA9IHJlZ2V4cC5yZXBsYWNlKC8jKFxcZCspfEAoXFxkKyl8XFwuXFwqXFwkL2csIChfLCBoYW5kbGVySW5kZXgsIHBhcmFtSW5kZXgpID0+IHtcbiAgICAgIGlmIChoYW5kbGVySW5kZXggIT09IHVuZGVmaW5lZCkge1xuICAgICAgICBpbmRleFJlcGxhY2VtZW50TWFwWysrY2FwdHVyZUluZGV4XSA9IE51bWJlcihoYW5kbGVySW5kZXgpXG4gICAgICAgIHJldHVybiAnJCgpJ1xuICAgICAgfVxuICAgICAgaWYgKHBhcmFtSW5kZXggIT09IHVuZGVmaW5lZCkge1xuICAgICAgICBwYXJhbVJlcGxhY2VtZW50TWFwW051bWJlcihwYXJhbUluZGV4KV0gPSArK2NhcHR1cmVJbmRleFxuICAgICAgICByZXR1cm4gJydcbiAgICAgIH1cblxuICAgICAgcmV0dXJuICcnXG4gICAgfSlcblxuICAgIHJldHVybiBbbmV3IFJlZ0V4cChgXiR7cmVnZXhwfWApLCBpbmRleFJlcGxhY2VtZW50TWFwLCBwYXJhbVJlcGxhY2VtZW50TWFwXVxuICB9XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQ0EsU0FBUyxJQUFJLFFBQVEsWUFBVztBQUloQyxPQUFPLE1BQU07RUFDWCxDQUFBLE9BQVEsR0FBWTtJQUFFLFVBQVU7RUFBRSxFQUFDO0VBQ25DLENBQUEsSUFBSyxHQUFTLElBQUksT0FBTTtFQUV4QixPQUFPLElBQVksRUFBRSxLQUFhLEVBQUUsa0JBQTJCLEVBQW1CO0lBQ2hGLE1BQU0sYUFBOEIsRUFBRTtJQUV0QyxNQUFNLFNBQTZCLEVBQUUsQ0FBQywwQkFBMEI7O0lBQ2hFLElBQUssSUFBSSxJQUFJLElBQU87TUFDbEIsSUFBSSxXQUFXO01BQ2YsT0FBTyxLQUFLLE9BQU8sQ0FBQyxjQUFjLENBQUM7UUFDakMsTUFBTSxPQUFPLENBQUMsR0FBRyxFQUFFLEdBQUc7UUFDdEIsTUFBTSxDQUFDLEVBQUUsR0FBRztVQUFDO1VBQU07U0FBRTtRQUNyQjtRQUNBLFdBQVc7UUFDWCxPQUFPO01BQ1Q7TUFDQSxJQUFJLENBQUMsVUFBVTtRQUNiO01BQ0Y7SUFDRjtJQUVBOzs7O0tBSUMsR0FDRCxNQUFNLFNBQVMsS0FBSyxLQUFLLENBQUMsK0JBQStCLEVBQUU7SUFDM0QsSUFBSyxJQUFJLElBQUksT0FBTyxNQUFNLEdBQUcsR0FBRyxLQUFLLEdBQUcsSUFBSztNQUMzQyxNQUFNLENBQUMsS0FBSyxHQUFHLE1BQU0sQ0FBQyxFQUFFO01BQ3hCLElBQUssSUFBSSxJQUFJLE9BQU8sTUFBTSxHQUFHLEdBQUcsS0FBSyxHQUFHLElBQUs7UUFDM0MsSUFBSSxNQUFNLENBQUMsRUFBRSxDQUFDLE9BQU8sQ0FBQyxVQUFVLENBQUMsR0FBRztVQUNsQyxNQUFNLENBQUMsRUFBRSxHQUFHLE1BQU0sQ0FBQyxFQUFFLENBQUMsT0FBTyxDQUFDLE1BQU0sTUFBTSxDQUFDLEVBQUUsQ0FBQyxFQUFFO1VBQ2hEO1FBQ0Y7TUFDRjtJQUNGO0lBRUEsSUFBSSxDQUFDLENBQUEsSUFBSyxDQUFDLE1BQU0sQ0FBQyxRQUFRLE9BQU8sWUFBWSxJQUFJLENBQUMsQ0FBQSxPQUFRLEVBQUU7SUFFNUQsT0FBTztFQUNUO0VBRUEsY0FBd0Q7SUFDdEQsSUFBSSxTQUFTLElBQUksQ0FBQyxDQUFBLElBQUssQ0FBQyxjQUFjO0lBQ3RDLElBQUksV0FBVyxJQUFJO01BQ2pCLE9BQU87UUFBQztRQUFNLEVBQUU7UUFBRSxFQUFFO09BQUMsQ0FBQyxjQUFjOztJQUN0QztJQUVBLElBQUksZUFBZTtJQUNuQixNQUFNLHNCQUFzQyxFQUFFO0lBQzlDLE1BQU0sc0JBQXNDLEVBQUU7SUFFOUMsU0FBUyxPQUFPLE9BQU8sQ0FBQyx5QkFBeUIsQ0FBQyxHQUFHLGNBQWM7TUFDakUsSUFBSSxpQkFBaUIsV0FBVztRQUM5QixtQkFBbUIsQ0FBQyxFQUFFLGFBQWEsR0FBRyxPQUFPO1FBQzdDLE9BQU87TUFDVDtNQUNBLElBQUksZUFBZSxXQUFXO1FBQzVCLG1CQUFtQixDQUFDLE9BQU8sWUFBWSxHQUFHLEVBQUU7UUFDNUMsT0FBTztNQUNUO01BRUEsT0FBTztJQUNUO0lBRUEsT0FBTztNQUFDLElBQUksT0FBTyxDQUFDLENBQUMsRUFBRSxRQUFRO01BQUc7TUFBcUI7S0FBb0I7RUFDN0U7QUFDRiJ9
// denoCacheMetadata=17399602578778966700,12005427809420315282