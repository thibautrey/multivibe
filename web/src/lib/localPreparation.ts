import type { PreparationJob, PreparationStage } from '../../../src/local-model-preparation';
export const preparationLabels: Record<PreparationStage,string> = {
  'awaiting-consent':'Review download', installing:'Installing runtime', downloading:'Downloading model',
  preparing:'Preparing model', testing:'Testing locally', 'verifying-chat':'Checking chat connection',
  ready:'Ready', cancelled:'Cancelled', interrupted:'Interrupted', failed:'Preparation stopped',
};
export const preparationActive = (stage: PreparationStage) => ['installing','downloading','preparing','testing','verifying-chat'].includes(stage);
export function preparationChatReady(job: PreparationJob) {
  return job.stage === 'ready' && Boolean(job.testedAt && job.chatModelId);
}
export function preparationError(error: unknown): string {
  let code = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  try { code = JSON.parse(code).error; } catch { /* A stored job contains a code, not JSON. */ }
  const messages: Record<string,string> = {
    local_preparation_unavailable:'Local preparation is not connected on this Host. No download was started.',
    host_permission_required:'Local execution is paused or downloads are disabled. Review Host permissions before continuing.',
    runtime_download_quote_required:'The runtime is not installed. Its download size must be included in a new approval before setup can continue.',
    import_reconciliation_required:'A previous import was interrupted. Check its status on Host before starting another import.',
    download_budget_exceeded:'This download exceeds the Host download limit. Review Host limits or choose a smaller model.',
    insufficient_disk:'Free some space on Host, then check again.',
    resources_unknown:'Host could not check its available resources. Reconnect Host and check again.',
    compatibility_not_established:'Host cannot yet verify a suitable version of this model. No download was started.',
    model_access_required:'Review the publisher’s access requirements before preparing this model.',
    host_preparation_busy:'Another preparation is running on Host. Wait or cancel it first.',
    consent_mismatch:'This download plan changed. Check again and review the new plan.',
    new_preflight_required:'Check again to obtain a new download plan.',
    host_restarted_recheck_required:'Host restarted. Check again before continuing; download resumption is not guaranteed.',
    local_test_failed:'The model did not answer the local test. Check again or choose a lighter model.',
    chat_route_not_ready:'The local test finished, but chat is not available. Check again before using this model.',
    download_exceeds_consent:'The download exceeded the approved volume and was stopped. Review a new plan before retrying.',
    cancelled:'Preparation was cancelled. Existing models remain unchanged.',
  };
  return messages[code] ?? 'Preparation could not continue. Check Host and try again. No Cloud fallback was used.';
}
export function preparationBytes(bytes: number) {
  return `${(bytes / 1024 ** 3).toLocaleString('en-US', {maximumFractionDigits:2})} GiB (${bytes.toLocaleString('en-US')} bytes)`;
}
