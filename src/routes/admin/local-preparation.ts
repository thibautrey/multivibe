import express from 'express';
import type { LocalModelPreparation } from '../../local-model-preparation.js';

// Mounted under the existing admin authentication boundary. No driver credentials
// or raw runtime errors are returned to the browser.
export function localPreparationRoutes(service?: LocalModelPreparation) {
  const router = express.Router();
  router.use((_req, res, next) => {
    res.setHeader('cache-control', 'no-store');
    if (!service) { res.status(503).json({ error: 'local_preparation_unavailable' }); return; }
    next();
  });
  const known = new Map([
    ['consent_mismatch', 409], ['new_preflight_required', 409],
    ['host_preparation_busy', 409], ['preparation_already_ready', 409],
    ['preparation_not_found', 404], ['insufficient_memory', 409], ['insufficient_disk', 409],
    ['download_budget_exceeded', 409], ['resources_unknown', 409], ['compatibility_not_established', 409],
    ['model_identity_mismatch', 409],
    ['host_permission_required', 409], ['runtime_download_quote_required', 409],
    ['import_reconciliation_required', 409], ['model_access_required', 409],
    ['local_preparation_unavailable', 503],
  ]);
  function failure(res: express.Response, error: unknown) {
    const code = error instanceof Error ? error.message : '';
    res.status(known.get(code) ?? 503).json({error: known.has(code) ? code : 'local_preparation_failed'});
  }
  function exact(body: unknown, fields: string[]): body is Record<string, string> {
    return !!body && typeof body === 'object' && !Array.isArray(body) &&
      Object.keys(body).length === fields.length && fields.every(key =>
        typeof (body as Record<string, unknown>)[key] === 'string' &&
        (body as Record<string, string>)[key].length > 0);
  }
  router.get('/', async (_req, res) => {
    try { res.json({jobs: await service!.list()}); } catch(error) { failure(res,error); }
  });
  router.post('/quote', async (req,res) => {
    // Only a model identity is accepted. Variant, paths, URLs, budget and policy
    // come from trusted preflight, not client-provided setup instructions.
    if (!exact(req.body,['modelId']) || req.body.modelId.length > 512 || /[\x00-\x1f]/u.test(req.body.modelId)) {
      res.status(400).json({error:'invalid_preparation_request'}); return;
    }
    try { res.status(201).json({job:await service!.quote(req.body.modelId)}); } catch(error) { failure(res,error); }
  });
  router.post('/:id/consent', async (req,res) => {
    if (!exact(req.body,['consentDigest']) || !/^[a-f0-9]{64}$/u.test(req.body.consentDigest)) {
      res.status(400).json({error:'invalid_preparation_request'}); return;
    }
    try { res.status(202).json({job:await service!.consent(req.params.id,req.body.consentDigest)}); } catch(error) { failure(res,error); }
  });
  router.post('/:id/cancel', async (req,res) => {
    if (!exact(req.body,[])) {res.status(400).json({error:'invalid_preparation_request'});return;}
    try { await service!.cancel(req.params.id);res.status(204).end(); } catch(error) { failure(res,error); }
  });
  return router;
}
