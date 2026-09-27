/** Capabilities describe UI availability; server authorization remains authoritative. */
export type DashboardCapabilities = {
  host: boolean;
  hostOnboarding: boolean;
  localRuntimes: boolean;
  plugins: boolean;
  hostUpdates: boolean;
  hostHarnesses: boolean;
  teamMachine: boolean;
  cloudConnection: boolean;
  githubPromotion: boolean;
  teamHome: boolean;
  usageRefresh: boolean;
  localAuthentication: boolean;
  providerUpstreamSettings: boolean;
  providerCredentialEditing: boolean;
  providerPriority: boolean;
  providerCapacity: boolean;
  providerBrowserOAuth: boolean;
  providerModelDiscovery: boolean;
};
export const CORE_CAPABILITIES: Readonly<DashboardCapabilities> = Object.freeze({
  host: true, hostOnboarding: true, localRuntimes: true, plugins: true,
  hostUpdates: true, hostHarnesses: true, teamMachine: true, cloudConnection: true,
  githubPromotion: true, teamHome: true, usageRefresh: true, localAuthentication: true,
  providerUpstreamSettings: true, providerCredentialEditing: true, providerPriority: true,
  providerCapacity: true, providerBrowserOAuth: true, providerModelDiscovery: true,
});
export const CLOUD_CAPABILITIES: Readonly<DashboardCapabilities> = Object.freeze({
  host: false, hostOnboarding: false, localRuntimes: false, plugins: false,
  hostUpdates: false, hostHarnesses: false, teamMachine: false, cloudConnection: false,
  githubPromotion: false, teamHome: false, usageRefresh: false, localAuthentication: false,
  providerUpstreamSettings: false, providerCredentialEditing: false, providerPriority: false,
  providerCapacity: false, providerBrowserOAuth: false, providerModelDiscovery: false,
});

export function dashboardResourceAllowed(resource: string, capabilities: DashboardCapabilities): boolean {
  const path = resource.split('?')[0].replace(/^\//, '');
  if (/^(?:host-update)(?:\/|$)/.test(path)) return capabilities.hostUpdates;
  if (/^(?:host-harnesses)(?:\/|$)/.test(path)) return capabilities.hostHarnesses;
  if (/^(?:modules)(?:\/|$)/.test(path)) return capabilities.plugins;
  if (/^(?:team-machine)(?:\/|$)/.test(path)) return capabilities.teamMachine;
  if (/^(?:provider-agent|local-runtimes|local-model-preparation|model-memory|open-model-family|model-recommendations)(?:\/|$)/.test(path)) return capabilities.localRuntimes;
  if (/^cloud\/(?:connect|disconnect)$/.test(path)) return capabilities.cloudConnection;
  if (path === 'usage/refresh-stale') return capabilities.usageRefresh;
  if (path === 'quota-reset-forecast') return capabilities.host;
  if (/^accounts\/[^/]+\/models(?:\/refresh)?$/.test(path)) return capabilities.providerModelDiscovery;
  if (path === 'grok/import') return capabilities.host;
  return !path.startsWith('admin/') && !path.includes('..') && !resource.startsWith('//') && !resource.includes('://');
}

/** Omit unsupported controls from mutations as well as hiding their form fields. */
export function providerMutationFields<T extends Record<string, unknown>>(fields: T, capabilities: DashboardCapabilities, mode: 'create' | 'update'): Record<string, unknown> {
  const result: Record<string, unknown> = { ...fields };
  if (!capabilities.providerUpstreamSettings) {
    delete result.upstreamMode;
    if (mode === 'update') delete result.baseUrl;
  }
  if (!capabilities.providerCredentialEditing) {
    delete result.refreshToken;
    if (mode === 'update') {
      delete result.accessToken;
      delete result.chatgptAccountId;
    }
  }
  if (!capabilities.providerPriority) delete result.priority;
  if (!capabilities.providerCapacity) { delete result.location; delete result.capacityProfile; }
  return result;
}
