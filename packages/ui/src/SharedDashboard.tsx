import React from 'react';
import App from './App';
import { DashboardProvider, type DashboardRuntime } from './adapter';
import type { Account, ExposedModel } from './types';
export interface DashboardPageContext { accounts: Account[]; models: ExposedModel[]; refresh: () => Promise<void> }
export interface DashboardPage {
  id: string;
  label: string;
  description: string;
  group: 'Operate' | 'Build' | 'Advanced';
  /** User-menu pages remain routable without appearing in the workspace sidebar. */
  hiddenFromNavigation?: boolean;
  render: (context: DashboardPageContext) => React.ReactNode;
}
export interface SharedDashboardProps extends DashboardRuntime {
  apiKeyExtensions?: import("./components/tabs/ApiKeysTab").ApiKeyExtensions;
  pages?: readonly DashboardPage[];
  pageOverrides?: Readonly<Record<string, (context: DashboardPageContext) => React.ReactNode>>;
  pageAddons?: Readonly<Record<string, { before?: (context: DashboardPageContext) => React.ReactNode; after?: (context: DashboardPageContext) => React.ReactNode }>>;
  activePage?: string;
  onNavigate?: (page: string, query?: Record<string, string>) => void;
  userMenu?: React.ReactNode;
  workspaceSelector?: React.ReactNode;
  brandSubtitle?: string;
  chatUrl?: string;
}
export default function SharedDashboard(props: SharedDashboardProps) {
  return <DashboardProvider value={props}><App {...props} /></DashboardProvider>;
}
