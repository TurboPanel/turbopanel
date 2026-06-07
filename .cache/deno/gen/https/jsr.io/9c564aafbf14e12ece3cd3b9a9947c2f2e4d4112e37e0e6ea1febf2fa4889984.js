/**
 * @module
 * html Helper for Hono.
 */ import { escapeToBuffer, raw, resolveCallbackSync, stringBufferToString } from '../../utils/html.ts';
export { raw };
export const html = (strings, ...values)=>{
  const buffer = [
    ''
  ];
  for(let i = 0, len = strings.length - 1; i < len; i++){
    buffer[0] += strings[i];
    const children = Array.isArray(values[i]) ? values[i].flat(Infinity) : [
      values[i]
    ];
    for(let i = 0, len = children.length; i < len; i++){
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const child = children[i];
      if (typeof child === 'string') {
        escapeToBuffer(child, buffer);
      } else if (typeof child === 'number') {
        ;
        buffer[0] += child;
      } else if (typeof child === 'boolean' || child === null || child === undefined) {
        continue;
      } else if (typeof child === 'object' && child.isEscaped) {
        if (child.callbacks) {
          buffer.unshift('', child);
        } else {
          const tmp = child.toString();
          if (tmp instanceof Promise) {
            buffer.unshift('', tmp);
          } else {
            buffer[0] += tmp;
          }
        }
      } else if (child instanceof Promise) {
        buffer.unshift('', child);
      } else {
        escapeToBuffer(child.toString(), buffer);
      }
    }
  }
  buffer[0] += strings.at(-1);
  return buffer.length === 1 ? 'callbacks' in buffer ? raw(resolveCallbackSync(raw(buffer[0], buffer.callbacks))) : raw(buffer[0]) : stringBufferToString(buffer, buffer.callbacks);
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0Bob25vL2hvbm8vNC4xMi4yMy9zcmMvaGVscGVyL2h0bWwvaW5kZXgudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBAbW9kdWxlXG4gKiBodG1sIEhlbHBlciBmb3IgSG9uby5cbiAqL1xuXG5pbXBvcnQgeyBlc2NhcGVUb0J1ZmZlciwgcmF3LCByZXNvbHZlQ2FsbGJhY2tTeW5jLCBzdHJpbmdCdWZmZXJUb1N0cmluZyB9IGZyb20gJy4uLy4uL3V0aWxzL2h0bWwudHMnXG5pbXBvcnQgdHlwZSB7IEh0bWxFc2NhcGVkLCBIdG1sRXNjYXBlZFN0cmluZywgU3RyaW5nQnVmZmVyV2l0aENhbGxiYWNrcyB9IGZyb20gJy4uLy4uL3V0aWxzL2h0bWwudHMnXG5cbmV4cG9ydCB7IHJhdyB9XG5cbmV4cG9ydCBjb25zdCBodG1sID0gKFxuICBzdHJpbmdzOiBUZW1wbGF0ZVN0cmluZ3NBcnJheSxcbiAgLi4udmFsdWVzOiB1bmtub3duW11cbik6IEh0bWxFc2NhcGVkU3RyaW5nIHwgUHJvbWlzZTxIdG1sRXNjYXBlZFN0cmluZz4gPT4ge1xuICBjb25zdCBidWZmZXI6IFN0cmluZ0J1ZmZlcldpdGhDYWxsYmFja3MgPSBbJyddIGFzIFN0cmluZ0J1ZmZlcldpdGhDYWxsYmFja3NcblxuICBmb3IgKGxldCBpID0gMCwgbGVuID0gc3RyaW5ncy5sZW5ndGggLSAxOyBpIDwgbGVuOyBpKyspIHtcbiAgICBidWZmZXJbMF0gKz0gc3RyaW5nc1tpXVxuXG4gICAgY29uc3QgY2hpbGRyZW4gPSBBcnJheS5pc0FycmF5KHZhbHVlc1tpXSlcbiAgICAgID8gKHZhbHVlc1tpXSBhcyBBcnJheTx1bmtub3duPikuZmxhdChJbmZpbml0eSlcbiAgICAgIDogW3ZhbHVlc1tpXV1cbiAgICBmb3IgKGxldCBpID0gMCwgbGVuID0gY2hpbGRyZW4ubGVuZ3RoOyBpIDwgbGVuOyBpKyspIHtcbiAgICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBAdHlwZXNjcmlwdC1lc2xpbnQvbm8tZXhwbGljaXQtYW55XG4gICAgICBjb25zdCBjaGlsZCA9IGNoaWxkcmVuW2ldIGFzIGFueVxuICAgICAgaWYgKHR5cGVvZiBjaGlsZCA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgZXNjYXBlVG9CdWZmZXIoY2hpbGQsIGJ1ZmZlcilcbiAgICAgIH0gZWxzZSBpZiAodHlwZW9mIGNoaWxkID09PSAnbnVtYmVyJykge1xuICAgICAgICA7KGJ1ZmZlclswXSBhcyBzdHJpbmcpICs9IGNoaWxkXG4gICAgICB9IGVsc2UgaWYgKHR5cGVvZiBjaGlsZCA9PT0gJ2Jvb2xlYW4nIHx8IGNoaWxkID09PSBudWxsIHx8IGNoaWxkID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgY29udGludWVcbiAgICAgIH0gZWxzZSBpZiAodHlwZW9mIGNoaWxkID09PSAnb2JqZWN0JyAmJiAoY2hpbGQgYXMgSHRtbEVzY2FwZWQpLmlzRXNjYXBlZCkge1xuICAgICAgICBpZiAoKGNoaWxkIGFzIEh0bWxFc2NhcGVkU3RyaW5nKS5jYWxsYmFja3MpIHtcbiAgICAgICAgICBidWZmZXIudW5zaGlmdCgnJywgY2hpbGQpXG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgY29uc3QgdG1wID0gY2hpbGQudG9TdHJpbmcoKVxuICAgICAgICAgIGlmICh0bXAgaW5zdGFuY2VvZiBQcm9taXNlKSB7XG4gICAgICAgICAgICBidWZmZXIudW5zaGlmdCgnJywgdG1wKVxuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBidWZmZXJbMF0gKz0gdG1wXG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9IGVsc2UgaWYgKGNoaWxkIGluc3RhbmNlb2YgUHJvbWlzZSkge1xuICAgICAgICBidWZmZXIudW5zaGlmdCgnJywgY2hpbGQpXG4gICAgICB9IGVsc2Uge1xuICAgICAgICBlc2NhcGVUb0J1ZmZlcihjaGlsZC50b1N0cmluZygpLCBidWZmZXIpXG4gICAgICB9XG4gICAgfVxuICB9XG4gIGJ1ZmZlclswXSArPSBzdHJpbmdzLmF0KC0xKSBhcyBzdHJpbmdcblxuICByZXR1cm4gYnVmZmVyLmxlbmd0aCA9PT0gMVxuICAgID8gJ2NhbGxiYWNrcycgaW4gYnVmZmVyXG4gICAgICA/IHJhdyhyZXNvbHZlQ2FsbGJhY2tTeW5jKHJhdyhidWZmZXJbMF0sIGJ1ZmZlci5jYWxsYmFja3MpKSlcbiAgICAgIDogcmF3KGJ1ZmZlclswXSlcbiAgICA6IHN0cmluZ0J1ZmZlclRvU3RyaW5nKGJ1ZmZlciwgYnVmZmVyLmNhbGxiYWNrcylcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7O0NBR0MsR0FFRCxTQUFTLGNBQWMsRUFBRSxHQUFHLEVBQUUsbUJBQW1CLEVBQUUsb0JBQW9CLFFBQVEsc0JBQXFCO0FBR3BHLFNBQVMsR0FBRyxHQUFFO0FBRWQsT0FBTyxNQUFNLE9BQU8sQ0FDbEIsU0FDQSxHQUFHO0VBRUgsTUFBTSxTQUFvQztJQUFDO0dBQUc7RUFFOUMsSUFBSyxJQUFJLElBQUksR0FBRyxNQUFNLFFBQVEsTUFBTSxHQUFHLEdBQUcsSUFBSSxLQUFLLElBQUs7SUFDdEQsTUFBTSxDQUFDLEVBQUUsSUFBSSxPQUFPLENBQUMsRUFBRTtJQUV2QixNQUFNLFdBQVcsTUFBTSxPQUFPLENBQUMsTUFBTSxDQUFDLEVBQUUsSUFDcEMsQUFBQyxNQUFNLENBQUMsRUFBRSxDQUFvQixJQUFJLENBQUMsWUFDbkM7TUFBQyxNQUFNLENBQUMsRUFBRTtLQUFDO0lBQ2YsSUFBSyxJQUFJLElBQUksR0FBRyxNQUFNLFNBQVMsTUFBTSxFQUFFLElBQUksS0FBSyxJQUFLO01BQ25ELDhEQUE4RDtNQUM5RCxNQUFNLFFBQVEsUUFBUSxDQUFDLEVBQUU7TUFDekIsSUFBSSxPQUFPLFVBQVUsVUFBVTtRQUM3QixlQUFlLE9BQU87TUFDeEIsT0FBTyxJQUFJLE9BQU8sVUFBVSxVQUFVOztRQUNsQyxNQUFNLENBQUMsRUFBRSxJQUFlO01BQzVCLE9BQU8sSUFBSSxPQUFPLFVBQVUsYUFBYSxVQUFVLFFBQVEsVUFBVSxXQUFXO1FBQzlFO01BQ0YsT0FBTyxJQUFJLE9BQU8sVUFBVSxZQUFZLEFBQUMsTUFBc0IsU0FBUyxFQUFFO1FBQ3hFLElBQUksQUFBQyxNQUE0QixTQUFTLEVBQUU7VUFDMUMsT0FBTyxPQUFPLENBQUMsSUFBSTtRQUNyQixPQUFPO1VBQ0wsTUFBTSxNQUFNLE1BQU0sUUFBUTtVQUMxQixJQUFJLGVBQWUsU0FBUztZQUMxQixPQUFPLE9BQU8sQ0FBQyxJQUFJO1VBQ3JCLE9BQU87WUFDTCxNQUFNLENBQUMsRUFBRSxJQUFJO1VBQ2Y7UUFDRjtNQUNGLE9BQU8sSUFBSSxpQkFBaUIsU0FBUztRQUNuQyxPQUFPLE9BQU8sQ0FBQyxJQUFJO01BQ3JCLE9BQU87UUFDTCxlQUFlLE1BQU0sUUFBUSxJQUFJO01BQ25DO0lBQ0Y7RUFDRjtFQUNBLE1BQU0sQ0FBQyxFQUFFLElBQUksUUFBUSxFQUFFLENBQUMsQ0FBQztFQUV6QixPQUFPLE9BQU8sTUFBTSxLQUFLLElBQ3JCLGVBQWUsU0FDYixJQUFJLG9CQUFvQixJQUFJLE1BQU0sQ0FBQyxFQUFFLEVBQUUsT0FBTyxTQUFTLE1BQ3ZELElBQUksTUFBTSxDQUFDLEVBQUUsSUFDZixxQkFBcUIsUUFBUSxPQUFPLFNBQVM7QUFDbkQsRUFBQyJ9
// denoCacheMetadata=7042656693181558750,14664915780204636630