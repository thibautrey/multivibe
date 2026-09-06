export const CODEX_QUOTA_RESET_FORECAST_URL =
  "https://www.willcodexquotareset.com/";
export const CODEX_QUOTA_RESET_FORECAST_API_URL =
  `${CODEX_QUOTA_RESET_FORECAST_URL}api/forecast`;

export type CodexQuotaResetForecast = {
  score: number;
  state: string;
  horizonHours?: number;
};

export const CODEX_QUOTA_RESET_FORECAST_CACHE_MS = 5 * 60_000;
export const CODEX_QUOTA_RESET_FORECAST_RETRY_MS = 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function fetchCodexQuotaResetForecast(
  fetchImpl: typeof fetch = fetch,
): Promise<CodexQuotaResetForecast> {
  const response = await fetchImpl(CODEX_QUOTA_RESET_FORECAST_API_URL, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(`forecast upstream returned HTTP ${response.status}`);
  }

  const payload: unknown = await response.json();
  const forecast = isRecord(payload) && isRecord(payload.forecast)
    ? payload.forecast
    : undefined;
  const score = forecast?.score;
  if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 100) {
    throw new Error("forecast upstream returned an invalid score");
  }

  const horizonHours = forecast?.horizonHours;
  return {
    score,
    state: typeof forecast?.state === "string" ? forecast.state : "forecast",
    ...(typeof horizonHours === "number" && Number.isFinite(horizonHours) && horizonHours > 0
      ? { horizonHours }
      : {}),
  };
}

export class CodexQuotaResetForecastCache {
  private value?: CodexQuotaResetForecast;
  private failure?: unknown;
  private expiresAt = 0;
  private inFlight?: Promise<CodexQuotaResetForecast>;

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async get(): Promise<CodexQuotaResetForecast> {
    const now = this.now();
    if (this.value && now < this.expiresAt) return this.value;
    if (this.failure && now < this.expiresAt) throw this.failure;
    if (this.inFlight) return this.inFlight;
    this.inFlight = fetchCodexQuotaResetForecast(this.fetchImpl)
      .then((value) => {
        this.value = value;
        this.failure = undefined;
        this.expiresAt = this.now() + CODEX_QUOTA_RESET_FORECAST_CACHE_MS;
        return value;
      })
      .catch((error) => {
        this.expiresAt = this.now() + CODEX_QUOTA_RESET_FORECAST_RETRY_MS;
        if (this.value) return this.value;
        this.failure = error;
        throw error;
      })
      .finally(() => {
        this.inFlight = undefined;
      });
    return this.inFlight;
  }
}
