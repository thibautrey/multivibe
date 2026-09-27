import React, { createContext, useContext, useMemo } from 'react';
import { ApiError, type DashboardAdapter } from './lib/api';
import { dashboardResourceAllowed, type DashboardCapabilities } from './capabilities';
import type { ApiEndpoint } from './components/tabs/docsCatalog';
export interface DashboardRuntime {
  adapter: DashboardAdapter;
  capabilities: DashboardCapabilities;
  /** Explicit grants from the server. Omission retains Core's role-aware navigation. */
  allowedPages?: readonly string[];
  endpoints?: readonly ApiEndpoint[];
  /** Optional allowed direct provider IDs; SDK provider choices still come from provider-catalog. */
  providerIds?: readonly string[];
}
const RuntimeContext = createContext<DashboardRuntime | null>(null);
export function DashboardProvider({ value, children }: { value: DashboardRuntime; children: React.ReactNode }) {
  const guarded = useMemo(() => ({ ...value, adapter: {
    ...value.adapter,
    request: async (resource: string, init?: RequestInit) => {
      if (!dashboardResourceAllowed(resource, value.capabilities)) throw new ApiError(403, 'This dashboard capability is unavailable.');
      return value.adapter.request(resource, init);
    },
    fetch: async (path: string, init?: RequestInit) => {
      // Never let an embedded playground regain local administrative authority.
      if (path.startsWith('/admin/')) {
        const resource = path.slice('/admin/'.length);
        if (!value.capabilities.host || !dashboardResourceAllowed(resource, value.capabilities)) throw new ApiError(403, 'Host administration is unavailable.');
      }
      return value.adapter.fetch(path, init);
    },
  } }), [value.adapter, value.capabilities, value.allowedPages, value.endpoints, value.providerIds]);
  return <RuntimeContext.Provider value={guarded}>{children}</RuntimeContext.Provider>;
}
export function useDashboardRuntime() {
  const value = useContext(RuntimeContext);
  if (!value) throw new Error('Dashboard components require DashboardProvider.');
  return value;
}
export function useDashboardApi() { return useDashboardRuntime().adapter.request; }
