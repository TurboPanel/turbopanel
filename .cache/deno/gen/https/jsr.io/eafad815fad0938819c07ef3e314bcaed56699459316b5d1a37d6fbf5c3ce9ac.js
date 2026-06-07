// Copyright 2018-2026 the Deno authors. MIT license.
// This module is browser compatible.
export function common(paths, sep) {
  const [first = "", ...remaining] = paths;
  const parts = first.split(sep);
  let endOfPrefix = parts.length;
  let append = "";
  for (const path of remaining){
    const compare = path.split(sep);
    if (compare.length <= endOfPrefix) {
      endOfPrefix = compare.length;
      append = "";
    }
    for(let i = 0; i < endOfPrefix; i++){
      if (compare[i] !== parts[i]) {
        endOfPrefix = i;
        append = i === 0 ? "" : sep;
        break;
      }
    }
  }
  return parts.slice(0, endOfPrefix).join(sep) + append;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQvcGF0aC8xLjEuNS9fY29tbW9uL2NvbW1vbi50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvLyBDb3B5cmlnaHQgMjAxOC0yMDI2IHRoZSBEZW5vIGF1dGhvcnMuIE1JVCBsaWNlbnNlLlxuLy8gVGhpcyBtb2R1bGUgaXMgYnJvd3NlciBjb21wYXRpYmxlLlxuXG5leHBvcnQgZnVuY3Rpb24gY29tbW9uKHBhdGhzOiBzdHJpbmdbXSwgc2VwOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBbZmlyc3QgPSBcIlwiLCAuLi5yZW1haW5pbmddID0gcGF0aHM7XG4gIGNvbnN0IHBhcnRzID0gZmlyc3Quc3BsaXQoc2VwKTtcblxuICBsZXQgZW5kT2ZQcmVmaXggPSBwYXJ0cy5sZW5ndGg7XG4gIGxldCBhcHBlbmQgPSBcIlwiO1xuICBmb3IgKGNvbnN0IHBhdGggb2YgcmVtYWluaW5nKSB7XG4gICAgY29uc3QgY29tcGFyZSA9IHBhdGguc3BsaXQoc2VwKTtcbiAgICBpZiAoY29tcGFyZS5sZW5ndGggPD0gZW5kT2ZQcmVmaXgpIHtcbiAgICAgIGVuZE9mUHJlZml4ID0gY29tcGFyZS5sZW5ndGg7XG4gICAgICBhcHBlbmQgPSBcIlwiO1xuICAgIH1cblxuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgZW5kT2ZQcmVmaXg7IGkrKykge1xuICAgICAgaWYgKGNvbXBhcmVbaV0gIT09IHBhcnRzW2ldKSB7XG4gICAgICAgIGVuZE9mUHJlZml4ID0gaTtcbiAgICAgICAgYXBwZW5kID0gaSA9PT0gMCA/IFwiXCIgOiBzZXA7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgIH1cbiAgfVxuICByZXR1cm4gcGFydHMuc2xpY2UoMCwgZW5kT2ZQcmVmaXgpLmpvaW4oc2VwKSArIGFwcGVuZDtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxxREFBcUQ7QUFDckQscUNBQXFDO0FBRXJDLE9BQU8sU0FBUyxPQUFPLEtBQWUsRUFBRSxHQUFXO0VBQ2pELE1BQU0sQ0FBQyxRQUFRLEVBQUUsRUFBRSxHQUFHLFVBQVUsR0FBRztFQUNuQyxNQUFNLFFBQVEsTUFBTSxLQUFLLENBQUM7RUFFMUIsSUFBSSxjQUFjLE1BQU0sTUFBTTtFQUM5QixJQUFJLFNBQVM7RUFDYixLQUFLLE1BQU0sUUFBUSxVQUFXO0lBQzVCLE1BQU0sVUFBVSxLQUFLLEtBQUssQ0FBQztJQUMzQixJQUFJLFFBQVEsTUFBTSxJQUFJLGFBQWE7TUFDakMsY0FBYyxRQUFRLE1BQU07TUFDNUIsU0FBUztJQUNYO0lBRUEsSUFBSyxJQUFJLElBQUksR0FBRyxJQUFJLGFBQWEsSUFBSztNQUNwQyxJQUFJLE9BQU8sQ0FBQyxFQUFFLEtBQUssS0FBSyxDQUFDLEVBQUUsRUFBRTtRQUMzQixjQUFjO1FBQ2QsU0FBUyxNQUFNLElBQUksS0FBSztRQUN4QjtNQUNGO0lBQ0Y7RUFDRjtFQUNBLE9BQU8sTUFBTSxLQUFLLENBQUMsR0FBRyxhQUFhLElBQUksQ0FBQyxPQUFPO0FBQ2pEIn0=
// denoCacheMetadata=11125086855520896846,6589762924019118600