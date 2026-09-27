export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}
/** A resource is semantic (e.g. accounts or model-aliases), never an admin URL. */
export type DashboardRequest = (resource: string, init?: RequestInit) => Promise<any>;
export interface DashboardAdapter {
  request: DashboardRequest;
  /** Public inference, catalog, export, and playground transport. Must preserve abort/streaming. */
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  /** Optional external authentication recovery; no Core token form is shown in Cloud. */
  onAuthenticationRequired?: () => void;
  /** API origin shown in examples. */
  apiOrigin?: string;
}
