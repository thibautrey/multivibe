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
};
export const CORE_CAPABILITIES: Readonly<DashboardCapabilities> = Object.freeze({
  host: true, hostOnboarding: true, localRuntimes: true, plugins: true,
  hostUpdates: true, hostHarnesses: true, teamMachine: true, cloudConnection: true,
  githubPromotion: true, teamHome: true, usageRefresh: true, localAuthentication: true,
});
export const CLOUD_CAPABILITIES: Readonly<DashboardCapabilities> = Object.freeze({
  host: false, hostOnboarding: false, localRuntimes: false, plugins: false,
  hostUpdates: false, hostHarnesses: false, teamMachine: false, cloudConnection: false,
  githubPromotion: false, teamHome: false, usageRefresh: false, localAuthentication: false,
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
  if (path === 'grok/import') return capabilities.host;
  return !path.startsWith('admin/') && !path.includes('..') && !resource.startsWith('//') && !resource.includes('://');
}
