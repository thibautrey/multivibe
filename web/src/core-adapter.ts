import { ApiError, type DashboardAdapter } from '../../packages/ui/src';
function dashboardPath(path: string): string {
  // Dashboard requests share the admin Access policy, separate from API clients.
  return /^\/v1\/models(?:\?|$)/.test(path)
    ? path.replace('/v1/models', '/admin/dashboard/models')
    : path.startsWith('/') ? path : `/admin/${path}`;
}
export const coreAdapter: DashboardAdapter = {
  async request(resource, init) {
    const response = await fetch(dashboardPath(resource), {
      ...init,
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', ...init?.headers },
    });
    const body = await response.text();
    if (!response.ok) throw new ApiError(response.status, body || `HTTP ${response.status}`);
    return body ? JSON.parse(body) : {};
  },
  fetch: (path, init) => fetch(dashboardPath(path), { ...init, credentials: 'same-origin' }),
};
