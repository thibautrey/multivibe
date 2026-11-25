export type EdgeCompressionStatus = {
  enabled: boolean;
  configured?: boolean;
  url: string | null;
  mode: string | null;
  timeoutMs: number;
  minBytes: number;
  configError: string | null;
  failures?: number;
  blockedForMs?: number;
};

export type CompressionApplyInput = {
  url: string;
  token?: string;
  mode?: string;
  timeoutMs: number;
  minBytes: number;
};

export type HeadroomEdgeClientOptions = {
  baseUrl: string;
  token: string;
  request?: typeof fetch;
};

/** Accept either a base URL or the full gateway endpoint. */
export function normalizeCompressionUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) return null;
  if (!url.hostname) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  const trimmed = url.pathname.replace(/\/+$/, "");
  url.pathname = trimmed === "" || trimmed === "/" ? "/v1/compress" : trimmed;
  return url.toString();
}

/**
 * Control-plane half of the runtime compression contract: the Rust edge owns
 * the inference path, this client only pushes the current endpoint, token and
 * limits over the internal route.
 */
export class HeadroomEdgeClient {
  private readonly request: typeof fetch;

  constructor(private readonly options: HeadroomEdgeClientOptions) {
    this.request = options.request ?? fetch;
  }

  get available(): boolean {
    return Boolean(this.options.baseUrl.trim() && this.options.token.trim());
  }

  private async call(method: "GET" | "PUT" | "DELETE", body?: unknown): Promise<EdgeCompressionStatus> {
    if (!this.available) {
      throw new Error(
        "The edge internal token is unavailable; restart MultiVibe with V1_EDGE_INTERNAL_JOB_TOKEN set",
      );
    }
    const response = await this.request(
      `${this.options.baseUrl.replace(/\/+$/, "")}/internal/v1-edge/compression`,
      {
        method,
        headers: {
          accept: "application/json",
          "x-multivibe-internal-token": this.options.token,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(5_000),
      },
    );
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        typeof (payload as { error?: unknown }).error === "string"
          ? (payload as { error: string }).error
          : `The edge rejected the compression settings (${response.status})`,
      );
    }
    return payload as EdgeCompressionStatus;
  }

  status(): Promise<EdgeCompressionStatus> {
    return this.call("GET");
  }

  apply(input: CompressionApplyInput): Promise<EdgeCompressionStatus> {
    return this.call("PUT", {
      url: input.url,
      token: input.token ?? undefined,
      mode: input.mode || null,
      timeoutMs: input.timeoutMs,
      minBytes: input.minBytes,
    });
  }

  clear(): Promise<EdgeCompressionStatus> {
    return this.call("DELETE");
  }
}
