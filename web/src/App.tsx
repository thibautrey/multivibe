import { SharedDashboard, CORE_CAPABILITIES } from '../../packages/ui/src';
import { coreAdapter } from './core-adapter';
export default function App() {
  return <SharedDashboard adapter={coreAdapter} capabilities={CORE_CAPABILITIES} />;
}
