/**
 * Compose middleware functions into a single function based on `koa-compose` package.
 *
 * @template E - The environment type.
 *
 * @param {[[Function, unknown], unknown][] | [[Function]][]} middleware - An array of middleware functions and their corresponding parameters.
 * @param {ErrorHandler<E>} [onError] - An optional error handler function.
 * @param {NotFoundHandler<E>} [onNotFound] - An optional not-found handler function.
 *
 * @returns {(context: Context, next?: Next) => Promise<Context>} - A composed middleware function.
 */ export const compose = (middleware, onError, onNotFound)=>{
  return (context, next)=>{
    let index = -1;
    return dispatch(0);
    /**
     * Dispatch the middleware functions.
     *
     * @param {number} i - The current index in the middleware array.
     *
     * @returns {Promise<Context>} - A promise that resolves to the context.
     */ async function dispatch(i) {
      if (i <= index) {
        throw new Error('next() called multiple times');
      }
      index = i;
      let res;
      let isError = false;
      let handler;
      if (middleware[i]) {
        handler = middleware[i][0][0];
        context.req.routeIndex = i;
      } else {
        handler = i === middleware.length && next || undefined;
      }
      if (handler) {
        try {
          res = await handler(context, ()=>dispatch(i + 1));
        } catch (err) {
          if (err instanceof Error && onError) {
            context.error = err;
            res = await onError(err, context);
            isError = true;
          } else {
            throw err;
          }
        }
      } else {
        if (context.finalized === false && onNotFound) {
          res = await onNotFound(context);
        }
      }
      if (res && (context.finalized === false || isError)) {
        context.res = res;
      }
      return context;
    }
  };
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0Bob25vL2hvbm8vNC4xMi4yMy9zcmMvY29tcG9zZS50cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgdHlwZSB7IENvbnRleHQgfSBmcm9tICcuL2NvbnRleHQudHMnXG5pbXBvcnQgdHlwZSB7IEVudiwgRXJyb3JIYW5kbGVyLCBOZXh0LCBOb3RGb3VuZEhhbmRsZXIgfSBmcm9tICcuL3R5cGVzLnRzJ1xuXG4vKipcbiAqIENvbXBvc2UgbWlkZGxld2FyZSBmdW5jdGlvbnMgaW50byBhIHNpbmdsZSBmdW5jdGlvbiBiYXNlZCBvbiBga29hLWNvbXBvc2VgIHBhY2thZ2UuXG4gKlxuICogQHRlbXBsYXRlIEUgLSBUaGUgZW52aXJvbm1lbnQgdHlwZS5cbiAqXG4gKiBAcGFyYW0ge1tbRnVuY3Rpb24sIHVua25vd25dLCB1bmtub3duXVtdIHwgW1tGdW5jdGlvbl1dW119IG1pZGRsZXdhcmUgLSBBbiBhcnJheSBvZiBtaWRkbGV3YXJlIGZ1bmN0aW9ucyBhbmQgdGhlaXIgY29ycmVzcG9uZGluZyBwYXJhbWV0ZXJzLlxuICogQHBhcmFtIHtFcnJvckhhbmRsZXI8RT59IFtvbkVycm9yXSAtIEFuIG9wdGlvbmFsIGVycm9yIGhhbmRsZXIgZnVuY3Rpb24uXG4gKiBAcGFyYW0ge05vdEZvdW5kSGFuZGxlcjxFPn0gW29uTm90Rm91bmRdIC0gQW4gb3B0aW9uYWwgbm90LWZvdW5kIGhhbmRsZXIgZnVuY3Rpb24uXG4gKlxuICogQHJldHVybnMgeyhjb250ZXh0OiBDb250ZXh0LCBuZXh0PzogTmV4dCkgPT4gUHJvbWlzZTxDb250ZXh0Pn0gLSBBIGNvbXBvc2VkIG1pZGRsZXdhcmUgZnVuY3Rpb24uXG4gKi9cbmV4cG9ydCBjb25zdCBjb21wb3NlID0gPEUgZXh0ZW5kcyBFbnYgPSBFbnY+KFxuICBtaWRkbGV3YXJlOiBbW0Z1bmN0aW9uLCB1bmtub3duXSwgdW5rbm93bl1bXSB8IFtbRnVuY3Rpb25dXVtdLFxuICBvbkVycm9yPzogRXJyb3JIYW5kbGVyPEU+LFxuICBvbk5vdEZvdW5kPzogTm90Rm91bmRIYW5kbGVyPEU+XG4pOiAoKGNvbnRleHQ6IENvbnRleHQsIG5leHQ/OiBOZXh0KSA9PiBQcm9taXNlPENvbnRleHQ+KSA9PiB7XG4gIHJldHVybiAoY29udGV4dCwgbmV4dCkgPT4ge1xuICAgIGxldCBpbmRleCA9IC0xXG5cbiAgICByZXR1cm4gZGlzcGF0Y2goMClcblxuICAgIC8qKlxuICAgICAqIERpc3BhdGNoIHRoZSBtaWRkbGV3YXJlIGZ1bmN0aW9ucy5cbiAgICAgKlxuICAgICAqIEBwYXJhbSB7bnVtYmVyfSBpIC0gVGhlIGN1cnJlbnQgaW5kZXggaW4gdGhlIG1pZGRsZXdhcmUgYXJyYXkuXG4gICAgICpcbiAgICAgKiBAcmV0dXJucyB7UHJvbWlzZTxDb250ZXh0Pn0gLSBBIHByb21pc2UgdGhhdCByZXNvbHZlcyB0byB0aGUgY29udGV4dC5cbiAgICAgKi9cbiAgICBhc3luYyBmdW5jdGlvbiBkaXNwYXRjaChpOiBudW1iZXIpOiBQcm9taXNlPENvbnRleHQ+IHtcbiAgICAgIGlmIChpIDw9IGluZGV4KSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcignbmV4dCgpIGNhbGxlZCBtdWx0aXBsZSB0aW1lcycpXG4gICAgICB9XG4gICAgICBpbmRleCA9IGlcblxuICAgICAgbGV0IHJlc1xuICAgICAgbGV0IGlzRXJyb3IgPSBmYWxzZVxuICAgICAgbGV0IGhhbmRsZXJcblxuICAgICAgaWYgKG1pZGRsZXdhcmVbaV0pIHtcbiAgICAgICAgaGFuZGxlciA9IG1pZGRsZXdhcmVbaV1bMF1bMF1cbiAgICAgICAgY29udGV4dC5yZXEucm91dGVJbmRleCA9IGlcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGhhbmRsZXIgPSAoaSA9PT0gbWlkZGxld2FyZS5sZW5ndGggJiYgbmV4dCkgfHwgdW5kZWZpbmVkXG4gICAgICB9XG5cbiAgICAgIGlmIChoYW5kbGVyKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgcmVzID0gYXdhaXQgaGFuZGxlcihjb250ZXh0LCAoKSA9PiBkaXNwYXRjaChpICsgMSkpXG4gICAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAgIGlmIChlcnIgaW5zdGFuY2VvZiBFcnJvciAmJiBvbkVycm9yKSB7XG4gICAgICAgICAgICBjb250ZXh0LmVycm9yID0gZXJyXG4gICAgICAgICAgICByZXMgPSBhd2FpdCBvbkVycm9yKGVyciwgY29udGV4dClcbiAgICAgICAgICAgIGlzRXJyb3IgPSB0cnVlXG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHRocm93IGVyclxuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgaWYgKGNvbnRleHQuZmluYWxpemVkID09PSBmYWxzZSAmJiBvbk5vdEZvdW5kKSB7XG4gICAgICAgICAgcmVzID0gYXdhaXQgb25Ob3RGb3VuZChjb250ZXh0KVxuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIGlmIChyZXMgJiYgKGNvbnRleHQuZmluYWxpemVkID09PSBmYWxzZSB8fCBpc0Vycm9yKSkge1xuICAgICAgICBjb250ZXh0LnJlcyA9IHJlc1xuICAgICAgfVxuICAgICAgcmV0dXJuIGNvbnRleHRcbiAgICB9XG4gIH1cbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFHQTs7Ozs7Ozs7OztDQVVDLEdBQ0QsT0FBTyxNQUFNLFVBQVUsQ0FDckIsWUFDQSxTQUNBO0VBRUEsT0FBTyxDQUFDLFNBQVM7SUFDZixJQUFJLFFBQVEsQ0FBQztJQUViLE9BQU8sU0FBUztJQUVoQjs7Ozs7O0tBTUMsR0FDRCxlQUFlLFNBQVMsQ0FBUztNQUMvQixJQUFJLEtBQUssT0FBTztRQUNkLE1BQU0sSUFBSSxNQUFNO01BQ2xCO01BQ0EsUUFBUTtNQUVSLElBQUk7TUFDSixJQUFJLFVBQVU7TUFDZCxJQUFJO01BRUosSUFBSSxVQUFVLENBQUMsRUFBRSxFQUFFO1FBQ2pCLFVBQVUsVUFBVSxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsRUFBRTtRQUM3QixRQUFRLEdBQUcsQ0FBQyxVQUFVLEdBQUc7TUFDM0IsT0FBTztRQUNMLFVBQVUsQUFBQyxNQUFNLFdBQVcsTUFBTSxJQUFJLFFBQVM7TUFDakQ7TUFFQSxJQUFJLFNBQVM7UUFDWCxJQUFJO1VBQ0YsTUFBTSxNQUFNLFFBQVEsU0FBUyxJQUFNLFNBQVMsSUFBSTtRQUNsRCxFQUFFLE9BQU8sS0FBSztVQUNaLElBQUksZUFBZSxTQUFTLFNBQVM7WUFDbkMsUUFBUSxLQUFLLEdBQUc7WUFDaEIsTUFBTSxNQUFNLFFBQVEsS0FBSztZQUN6QixVQUFVO1VBQ1osT0FBTztZQUNMLE1BQU07VUFDUjtRQUNGO01BQ0YsT0FBTztRQUNMLElBQUksUUFBUSxTQUFTLEtBQUssU0FBUyxZQUFZO1VBQzdDLE1BQU0sTUFBTSxXQUFXO1FBQ3pCO01BQ0Y7TUFFQSxJQUFJLE9BQU8sQ0FBQyxRQUFRLFNBQVMsS0FBSyxTQUFTLE9BQU8sR0FBRztRQUNuRCxRQUFRLEdBQUcsR0FBRztNQUNoQjtNQUNBLE9BQU87SUFDVDtFQUNGO0FBQ0YsRUFBQyJ9
// denoCacheMetadata=10343741467080765175,10822579729305543453