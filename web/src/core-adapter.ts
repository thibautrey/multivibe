import { ApiError, type DashboardAdapter } from '../../packages/ui/src';
export const coreAdapter: DashboardAdapter = {
  async request(resource, init) {
    const response = await fetch(resource.startsWith("/v1/") ? resource : `/admin/${resource}`, {
      ...init,
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', ...init?.headers },
    });
    const body = await response.text();
    if (!response.ok) throw new ApiError(response.status, body || `HTTP ${response.status}`);
    return body ? JSON.parse(body) : {};
  },
  fetch: (path, init) => fetch(path.startsWith("/") ? path : `/admin/${path}`, { ...init, credentials: 'same-origin' }),
};
