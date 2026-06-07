/**
 * @module
 * This module provides the `HTTPException` class.
 */ /**
 * `HTTPException` must be used when a fatal error such as authentication failure occurs.
 *
 * @see {@link https://hono.dev/docs/api/exception}
 *
 * @param {StatusCode} status - status code of HTTPException
 * @param {HTTPExceptionOptions} options - options of HTTPException
 * @param {HTTPExceptionOptions["res"]} options.res - response of options of HTTPException
 * @param {HTTPExceptionOptions["message"]} options.message - message of options of HTTPException
 * @param {HTTPExceptionOptions["cause"]} options.cause - cause of options of HTTPException
 *
 * @example
 * ```ts
 * import { HTTPException } from 'hono/http-exception'
 *
 * // ...
 *
 * app.post('/auth', async (c, next) => {
 *   // authentication
 *   if (authorized === false) {
 *     throw new HTTPException(401, { message: 'Custom error message' })
 *   }
 *   await next()
 * })
 * ```
 */ export class HTTPException extends Error {
  res;
  status;
  /**
   * Creates an instance of `HTTPException`.
   * @param status - HTTP status code for the exception. Defaults to 500.
   * @param options - Additional options for the exception.
   */ constructor(status = 500, options){
    super(options?.message, {
      cause: options?.cause
    });
    this.res = options?.res;
    this.status = status;
  }
  /**
   * Returns the response object associated with the exception.
   * If a response object is not provided, a new response is created with the error message and status code.
   * @returns The response object.
   */ getResponse() {
    if (this.res) {
      const newResponse = new Response(this.res.body, {
        status: this.status,
        headers: this.res.headers
      });
      return newResponse;
    }
    return new Response(this.message, {
      status: this.status
    });
  }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0Bob25vL2hvbm8vNC4xMi4yMy9zcmMvaHR0cC1leGNlcHRpb24udHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBAbW9kdWxlXG4gKiBUaGlzIG1vZHVsZSBwcm92aWRlcyB0aGUgYEhUVFBFeGNlcHRpb25gIGNsYXNzLlxuICovXG5cbmltcG9ydCB0eXBlIHsgQ29udGVudGZ1bFN0YXR1c0NvZGUgfSBmcm9tICcuL3V0aWxzL2h0dHAtc3RhdHVzLnRzJ1xuXG4vKipcbiAqIE9wdGlvbnMgZm9yIGNyZWF0aW5nIGFuIGBIVFRQRXhjZXB0aW9uYC5cbiAqIEBwcm9wZXJ0eSByZXMgLSBPcHRpb25hbCByZXNwb25zZSBvYmplY3QgdG8gdXNlLlxuICogQHByb3BlcnR5IG1lc3NhZ2UgLSBPcHRpb25hbCBjdXN0b20gZXJyb3IgbWVzc2FnZS5cbiAqIEBwcm9wZXJ0eSBjYXVzZSAtIE9wdGlvbmFsIGNhdXNlIG9mIHRoZSBlcnJvci5cbiAqL1xudHlwZSBIVFRQRXhjZXB0aW9uT3B0aW9ucyA9IHtcbiAgcmVzPzogUmVzcG9uc2VcbiAgbWVzc2FnZT86IHN0cmluZ1xuICBjYXVzZT86IHVua25vd25cbn1cblxuLyoqXG4gKiBgSFRUUEV4Y2VwdGlvbmAgbXVzdCBiZSB1c2VkIHdoZW4gYSBmYXRhbCBlcnJvciBzdWNoIGFzIGF1dGhlbnRpY2F0aW9uIGZhaWx1cmUgb2NjdXJzLlxuICpcbiAqIEBzZWUge0BsaW5rIGh0dHBzOi8vaG9uby5kZXYvZG9jcy9hcGkvZXhjZXB0aW9ufVxuICpcbiAqIEBwYXJhbSB7U3RhdHVzQ29kZX0gc3RhdHVzIC0gc3RhdHVzIGNvZGUgb2YgSFRUUEV4Y2VwdGlvblxuICogQHBhcmFtIHtIVFRQRXhjZXB0aW9uT3B0aW9uc30gb3B0aW9ucyAtIG9wdGlvbnMgb2YgSFRUUEV4Y2VwdGlvblxuICogQHBhcmFtIHtIVFRQRXhjZXB0aW9uT3B0aW9uc1tcInJlc1wiXX0gb3B0aW9ucy5yZXMgLSByZXNwb25zZSBvZiBvcHRpb25zIG9mIEhUVFBFeGNlcHRpb25cbiAqIEBwYXJhbSB7SFRUUEV4Y2VwdGlvbk9wdGlvbnNbXCJtZXNzYWdlXCJdfSBvcHRpb25zLm1lc3NhZ2UgLSBtZXNzYWdlIG9mIG9wdGlvbnMgb2YgSFRUUEV4Y2VwdGlvblxuICogQHBhcmFtIHtIVFRQRXhjZXB0aW9uT3B0aW9uc1tcImNhdXNlXCJdfSBvcHRpb25zLmNhdXNlIC0gY2F1c2Ugb2Ygb3B0aW9ucyBvZiBIVFRQRXhjZXB0aW9uXG4gKlxuICogQGV4YW1wbGVcbiAqIGBgYHRzXG4gKiBpbXBvcnQgeyBIVFRQRXhjZXB0aW9uIH0gZnJvbSAnaG9uby9odHRwLWV4Y2VwdGlvbidcbiAqXG4gKiAvLyAuLi5cbiAqXG4gKiBhcHAucG9zdCgnL2F1dGgnLCBhc3luYyAoYywgbmV4dCkgPT4ge1xuICogICAvLyBhdXRoZW50aWNhdGlvblxuICogICBpZiAoYXV0aG9yaXplZCA9PT0gZmFsc2UpIHtcbiAqICAgICB0aHJvdyBuZXcgSFRUUEV4Y2VwdGlvbig0MDEsIHsgbWVzc2FnZTogJ0N1c3RvbSBlcnJvciBtZXNzYWdlJyB9KVxuICogICB9XG4gKiAgIGF3YWl0IG5leHQoKVxuICogfSlcbiAqIGBgYFxuICovXG5leHBvcnQgY2xhc3MgSFRUUEV4Y2VwdGlvbiBleHRlbmRzIEVycm9yIHtcbiAgcmVhZG9ubHkgcmVzPzogUmVzcG9uc2VcbiAgcmVhZG9ubHkgc3RhdHVzOiBDb250ZW50ZnVsU3RhdHVzQ29kZVxuXG4gIC8qKlxuICAgKiBDcmVhdGVzIGFuIGluc3RhbmNlIG9mIGBIVFRQRXhjZXB0aW9uYC5cbiAgICogQHBhcmFtIHN0YXR1cyAtIEhUVFAgc3RhdHVzIGNvZGUgZm9yIHRoZSBleGNlcHRpb24uIERlZmF1bHRzIHRvIDUwMC5cbiAgICogQHBhcmFtIG9wdGlvbnMgLSBBZGRpdGlvbmFsIG9wdGlvbnMgZm9yIHRoZSBleGNlcHRpb24uXG4gICAqL1xuICBjb25zdHJ1Y3RvcihzdGF0dXM6IENvbnRlbnRmdWxTdGF0dXNDb2RlID0gNTAwLCBvcHRpb25zPzogSFRUUEV4Y2VwdGlvbk9wdGlvbnMpIHtcbiAgICBzdXBlcihvcHRpb25zPy5tZXNzYWdlLCB7IGNhdXNlOiBvcHRpb25zPy5jYXVzZSB9KVxuICAgIHRoaXMucmVzID0gb3B0aW9ucz8ucmVzXG4gICAgdGhpcy5zdGF0dXMgPSBzdGF0dXNcbiAgfVxuXG4gIC8qKlxuICAgKiBSZXR1cm5zIHRoZSByZXNwb25zZSBvYmplY3QgYXNzb2NpYXRlZCB3aXRoIHRoZSBleGNlcHRpb24uXG4gICAqIElmIGEgcmVzcG9uc2Ugb2JqZWN0IGlzIG5vdCBwcm92aWRlZCwgYSBuZXcgcmVzcG9uc2UgaXMgY3JlYXRlZCB3aXRoIHRoZSBlcnJvciBtZXNzYWdlIGFuZCBzdGF0dXMgY29kZS5cbiAgICogQHJldHVybnMgVGhlIHJlc3BvbnNlIG9iamVjdC5cbiAgICovXG4gIGdldFJlc3BvbnNlKCk6IFJlc3BvbnNlIHtcbiAgICBpZiAodGhpcy5yZXMpIHtcbiAgICAgIGNvbnN0IG5ld1Jlc3BvbnNlID0gbmV3IFJlc3BvbnNlKHRoaXMucmVzLmJvZHksIHtcbiAgICAgICAgc3RhdHVzOiB0aGlzLnN0YXR1cyxcbiAgICAgICAgaGVhZGVyczogdGhpcy5yZXMuaGVhZGVycyxcbiAgICAgIH0pXG4gICAgICByZXR1cm4gbmV3UmVzcG9uc2VcbiAgICB9XG4gICAgcmV0dXJuIG5ldyBSZXNwb25zZSh0aGlzLm1lc3NhZ2UsIHtcbiAgICAgIHN0YXR1czogdGhpcy5zdGF0dXMsXG4gICAgfSlcbiAgfVxufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Q0FHQyxHQWdCRDs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQXlCQyxHQUNELE9BQU8sTUFBTSxzQkFBc0I7RUFDeEIsSUFBYztFQUNkLE9BQTRCO0VBRXJDOzs7O0dBSUMsR0FDRCxZQUFZLFNBQStCLEdBQUcsRUFBRSxPQUE4QixDQUFFO0lBQzlFLEtBQUssQ0FBQyxTQUFTLFNBQVM7TUFBRSxPQUFPLFNBQVM7SUFBTTtJQUNoRCxJQUFJLENBQUMsR0FBRyxHQUFHLFNBQVM7SUFDcEIsSUFBSSxDQUFDLE1BQU0sR0FBRztFQUNoQjtFQUVBOzs7O0dBSUMsR0FDRCxjQUF3QjtJQUN0QixJQUFJLElBQUksQ0FBQyxHQUFHLEVBQUU7TUFDWixNQUFNLGNBQWMsSUFBSSxTQUFTLElBQUksQ0FBQyxHQUFHLENBQUMsSUFBSSxFQUFFO1FBQzlDLFFBQVEsSUFBSSxDQUFDLE1BQU07UUFDbkIsU0FBUyxJQUFJLENBQUMsR0FBRyxDQUFDLE9BQU87TUFDM0I7TUFDQSxPQUFPO0lBQ1Q7SUFDQSxPQUFPLElBQUksU0FBUyxJQUFJLENBQUMsT0FBTyxFQUFFO01BQ2hDLFFBQVEsSUFBSSxDQUFDLE1BQU07SUFDckI7RUFDRjtBQUNGIn0=
// denoCacheMetadata=5167646754222364026,16095920124393349476