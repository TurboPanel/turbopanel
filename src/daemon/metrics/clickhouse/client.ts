/**
 * Narrow ClickHouse HTTP client (Web-standard `fetch`).
 *
 * Auth: `X-ClickHouse-User` / `X-ClickHouse-Key` (preferred over Basic —
 * ClickHouse-native, explicitly typed headers per
 * https://clickhouse.com/docs/interfaces/http ).
 *
 * Parameterized queries use `{name:Type}` placeholders with `param_name` query
 * params (same HTTP interface docs). Row values for inserts are never
 * interpolated into SQL — only newline-delimited JSON bodies.
 */

export type ClickHouseHttpClientOptions = {
  url: string;
  database: string;
  user: string;
  password: string;
  /** Injected for tests. */
  fetch?: typeof fetch;
};

export class ClickHouseHttpError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`ClickHouse HTTP ${status}: ${body.slice(0, 500)}`);
    this.name = "ClickHouseHttpError";
    this.status = status;
    this.body = body;
  }
}

export class ClickHouseHttpClient {
  readonly #baseUrl: string;
  readonly #database: string;
  readonly #user: string;
  readonly #password: string;
  readonly #fetch: typeof fetch;

  constructor(options: ClickHouseHttpClientOptions) {
    this.#baseUrl = options.url.replace(/\/+$/, "");
    this.#database = options.database;
    this.#user = options.user;
    this.#password = options.password;
    this.#fetch = options.fetch ?? fetch;
  }

  /** DDL / statements with no result set. */
  async exec(sql: string): Promise<void> {
    const response = await this.#request({ query: sql, method: "POST" });
    if (!response.ok) {
      throw new ClickHouseHttpError(response.status, await response.text());
    }
  }

  /**
   * INSERT rows as JSONEachRow. Table name must be an allowlisted identifier
   * (caller responsibility). Row values are JSON — never SQL-concatenated.
   */
  async insertRows(
    table: string,
    rows: ReadonlyArray<Record<string, unknown>>,
    format: "JSONEachRow" = "JSONEachRow",
  ): Promise<void> {
    assertSafeIdentifier(table, "table");
    if (format !== "JSONEachRow") {
      throw new TypeError(`unsupported ClickHouse insert format: ${format}`);
    }
    if (rows.length === 0) return;
    const body = rows.map((row) => JSON.stringify(row)).join("\n");
    const query = `INSERT INTO ${table} FORMAT JSONEachRow`;
    const response = await this.#request({
      query,
      method: "POST",
      body,
      headers: { "Content-Type": "application/json" },
    });
    if (!response.ok) {
      throw new ClickHouseHttpError(response.status, await response.text());
    }
  }

  /**
   * Run a SELECT (or other result-producing query). Appends
   * `FORMAT JSONEachRow` and parses newline-delimited JSON.
   */
  async query<T extends Record<string, unknown>>(
    sql: string,
    params?: Record<string, string | number | boolean>,
  ): Promise<T[]> {
    const query = sql.includes("FORMAT ")
      ? sql
      : `${sql.trimEnd()}\nFORMAT JSONEachRow`;
    const response = await this.#request({
      query,
      method: "POST",
      params,
    });
    if (!response.ok) {
      throw new ClickHouseHttpError(response.status, await response.text());
    }
    const text = await response.text();
    if (!text.trim()) return [];
    const rows: T[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      rows.push(JSON.parse(trimmed) as T);
    }
    return rows;
  }

  async #request(input: {
    query: string;
    method: "GET" | "POST";
    body?: string;
    headers?: Record<string, string>;
    params?: Record<string, string | number | boolean>;
  }): Promise<Response> {
    const url = new URL(this.#baseUrl);
    url.searchParams.set("database", this.#database);
    url.searchParams.set("query", input.query);
    if (input.params) {
      for (const [key, value] of Object.entries(input.params)) {
        url.searchParams.set(`param_${key}`, String(value));
      }
    }
    return await this.#fetch(url.toString(), {
      method: input.method,
      headers: {
        "X-ClickHouse-User": this.#user,
        "X-ClickHouse-Key": this.#password,
        ...input.headers,
      },
      body: input.body,
    });
  }
}

function assertSafeIdentifier(value: string, label: string): void {
  if (!/^[a-zA-Z_]\w*$/.test(value)) {
    throw new TypeError(`invalid ClickHouse ${label} identifier: ${value}`);
  }
}
