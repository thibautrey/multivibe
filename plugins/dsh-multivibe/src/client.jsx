/* Bundled as a browser IIFE; React is supplied by the DSH module loader. */
window.__ModuleLoader__.load({
  id: 'dsh-multivibe',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'multivibe'
    const PANEL_ID = 'multivibe'
    const PAGE_SIZE = 50
    const MAX_SELECTED = 256
    const messages = {
      fr: {
        title: 'MultiVibe', description: 'Connectez votre gateway aux modèles de DSH, sans partager de jeton administrateur.',
        purpose: 'Utilisez les modèles de MultiVibe dans vos conversations DSH. Ce panneau affiche votre configuration et vous permet de connecter une gateway.', existing: 'Fournisseurs MultiVibe configurés dans DSH', existingHint: 'Ces fournisseurs existent déjà, indépendamment du plugin. La configuration affichée ne prouve pas que la gateway répond. Sélectionnez leur modèle dans une conversation DSH.', configured: 'Modèles configurés', credential: 'Clé disponible dans DSH', credentialMissing: 'Clé absente du processus DSH', setup: 'Configurer une connexion gérée', openPanel: 'Ouvrir le panneau MultiVibe', pluginActive: 'Plugin actif', configuration: 'Connexion gérée par le plugin',
        loading: 'Chargement…', working: 'Opération en cours…', refresh: 'Actualiser l’état',
        connected: 'Connexion gérée active', disconnected: 'Aucune connexion gérée', provider: 'Identifiant du fournisseur',
        namespace: 'Configuration DSH', chooseNamespace: 'Choisir une configuration', baseURL: 'URL de la gateway',
        apiKey: 'Clé API proxy dédiée à DSH', keyHint: 'La clé reste dans ce formulaire jusqu’à la connexion. Elle n’est jamais ajoutée à une URL.',
        clearKey: 'Effacer la clé', protocol: 'Protocole', discover: 'Découvrir les modèles', connect: 'Connecter MultiVibe',
        disconnect: 'Déconnecter', disconnectConfirm: 'Le fournisseur géré sera retiré. Le credential est conservé par défaut, car d’autres profils inactifs peuvent l’utiliser.',
        deleteCredential: 'Supprimer aussi le credential : je confirme qu’aucun autre profil ou paramètre ne le référence.',
        retainedKeys: 'Références de credentials conservés. Révoquez les clés proxy dans MultiVibe si elles ne sont plus nécessaires.',
        confirmDisconnect: 'Confirmer la déconnexion', cancel: 'Annuler', catalog: 'Actualiser le catalogue', dashboard: 'Ouvrir le dashboard',
        modelCount: 'Modèles configurés', connectedAt: 'Connecté depuis', models: 'Modèles', selected: 'sélectionnés',
        empty: 'Aucun modèle retourné.', discoverHint: 'Découvrez les modèles, puis sélectionnez ceux à ajouter au fournisseur.',
        capacityHint: 'Renseignez explicitement les capacités manquantes. Aucune valeur n’est devinée. La sortie ne doit pas dépasser le contexte.',
        context: 'Fenêtre de contexte (tokens)', output: 'Sortie maximale (tokens)', previous: 'Précédent', next: 'Suivant', page: 'Page',
        selectionLimit: 'Vous pouvez sélectionner au maximum 256 modèles.',
        reconnectHint: 'Pour changer de connexion, déconnectez d’abord le fournisseur. Aucun fournisseur existant ne sera écrasé.',
        remote: 'Lecture seule : ouvrez DSH Desktop ou l’interface sur localhost pour modifier la connexion.',
        pending: 'Une opération incomplète est enregistrée. La récupération retire uniquement le fournisseur géré, selon le choix enregistré pour son credential ; vérifiez ensuite la connexion.',
        retained: 'Une connexion est enregistrée mais inactive. Si le fournisseur a été modifié ailleurs, restaurez-le ou supprimez-le manuellement dans DSH, puis déconnectez ici pour nettoyer le credential.',
        recover: 'Récupérer l’opération incomplète', recovered: 'Récupération terminée. Vérifiez l’état affiché.', saved: 'Connexion enregistrée.', removed: 'Déconnexion terminée.',
        refreshed: 'État actualisé.', discovered: 'Catalogue découvert. Sélectionnez les modèles à connecter.',
        stale: 'Impossible de confirmer l’état actuel. Actualisez l’état avant toute modification.',
        CONFLICT: 'La configuration a changé. L’état a été rechargé ; votre saisie est conservée. Vérifiez-la avant de réessayer.',
        PROVIDER_EXISTS: 'Ce fournisseur existe déjà. Il ne sera pas remplacé : choisissez un autre identifiant.',
        AUTH: 'Clé invalide ou accès refusé. Vérifiez la clé proxy MultiVibe.',
        ENDPOINT: 'Indiquez une URL HTTPS, ou HTTP sur loopback, sans identifiants, paramètres ni fragment.',
        KEY_REQUIRED: 'Saisissez la clé API proxy.', NAMESPACE: 'Choisissez une configuration DSH disponible.',
        PROVIDER: 'Saisissez un identifiant de fournisseur valide (lettres minuscules, chiffres et tirets).',
        SELECTION: 'Sélectionnez entre 1 et 256 modèles du catalogue découvert.',
        CAPACITY: 'Chaque modèle sélectionné doit avoir des capacités entières positives, avec sortie ≤ contexte.',
        PENDING: 'Récupérez l’opération incomplète avant de modifier la connexion.',
        ALREADY_CONNECTED: 'Déconnectez le fournisseur avant de créer une autre connexion.',
        READ_ONLY: 'La connexion ne peut pas être modifiée depuis cette page.',
        TIMEOUT: 'Le délai a été dépassé. Vérifiez l’état avant de réessayer une modification.',
        RESPONSE: 'La réponse du service est invalide.', UNAVAILABLE: 'Le service est indisponible. Réessayez ou vérifiez la gateway.',
      },
      en: {
        title: 'MultiVibe', description: 'Connect your gateway to DSH models without sharing an administrator token.',
        purpose: 'Use MultiVibe models in your DSH conversations. This panel shows your configuration and lets you connect a gateway.', existing: 'MultiVibe providers configured in DSH', existingHint: 'These providers already exist independently of the plugin. Displayed configuration does not prove the gateway is responding. Select their model in a DSH conversation.', configured: 'Configured models', credential: 'Key available in DSH', credentialMissing: 'Key absent from the DSH process', setup: 'Set up a managed connection', openPanel: 'Open MultiVibe panel', pluginActive: 'Plugin active', configuration: 'Connection managed by this plugin',
        loading: 'Loading…', working: 'Operation in progress…', refresh: 'Refresh status',
        connected: 'Managed connection active', disconnected: 'No managed connection', provider: 'Provider ID',
        namespace: 'DSH configuration', chooseNamespace: 'Choose a configuration', baseURL: 'Gateway URL',
        apiKey: 'Dedicated DSH proxy API key', keyHint: 'The key stays in this form until connection succeeds. It is never added to a URL.',
        clearKey: 'Clear key', protocol: 'Protocol', discover: 'Discover models', connect: 'Connect MultiVibe',
        disconnect: 'Disconnect', disconnectConfirm: 'The managed provider will be removed. Its credential is retained by default because inactive profiles may still use it.',
        deleteCredential: 'Also delete the credential: I confirm no other profile or setting references it.',
        retainedKeys: 'Retained credential references. Revoke the proxy keys in MultiVibe if they are no longer needed.',
        confirmDisconnect: 'Confirm disconnection', cancel: 'Cancel', catalog: 'Refresh catalog', dashboard: 'Open dashboard',
        modelCount: 'Configured models', connectedAt: 'Connected since', models: 'Models', selected: 'selected',
        empty: 'No models returned.', discoverHint: 'Discover models, then select which ones to add to the provider.',
        capacityHint: 'Enter missing capacities explicitly. No values are guessed. Output must not exceed context.',
        context: 'Context window (tokens)', output: 'Maximum output (tokens)', previous: 'Previous', next: 'Next', page: 'Page',
        selectionLimit: 'You can select at most 256 models.',
        reconnectHint: 'Disconnect the provider before changing the connection. Existing providers will never be overwritten.',
        remote: 'Read-only: open DSH Desktop or the localhost interface to change the connection.',
        pending: 'An incomplete operation was recorded. Recovery removes only the managed provider and respects the recorded credential choice; check the connection afterwards.',
        retained: 'A connection is saved but inactive. If its provider was edited elsewhere, restore it or remove it manually in DSH, then disconnect here to clean up the credential.',
        recover: 'Recover incomplete operation', recovered: 'Recovery finished. Check the displayed status.', saved: 'Connection saved.', removed: 'Disconnection finished.',
        refreshed: 'Status refreshed.', discovered: 'Catalog discovered. Select the models to connect.',
        stale: 'Could not confirm the current status. Refresh status before making changes.',
        CONFLICT: 'Configuration changed. Status was reloaded and your draft was kept. Review it before retrying.',
        PROVIDER_EXISTS: 'This provider already exists. It will not be replaced: choose another ID.',
        AUTH: 'Invalid key or access denied. Check your MultiVibe proxy key.',
        ENDPOINT: 'Enter an HTTPS URL, or loopback HTTP, without credentials, query parameters or a fragment.',
        KEY_REQUIRED: 'Enter the proxy API key.', NAMESPACE: 'Choose an available DSH configuration.',
        PROVIDER: 'Enter a valid provider ID (lowercase letters, digits and hyphens).',
        SELECTION: 'Select between 1 and 256 models from the discovered catalog.',
        CAPACITY: 'Every selected model needs positive integer capacities, with output ≤ context.',
        PENDING: 'Recover the incomplete operation before changing the connection.',
        ALREADY_CONNECTED: 'Disconnect the provider before creating another connection.',
        READ_ONLY: 'The connection cannot be changed from this page.',
        TIMEOUT: 'The request timed out. Check status before retrying a change.',
        RESPONSE: 'The service returned an invalid response.', UNAVAILABLE: 'The service is unavailable. Retry or check the gateway.',
      },
    }
    const css = `
      .mvDsh{box-sizing:border-box;width:100%;height:100%;overflow:auto;max-width:1040px;margin:0 auto;padding:calc(var(--dsh-frame-top-clearance,0px) + 20px) 24px 28px;color:var(--dsw-alias-label-primary,inherit);font-size:14px;line-height:1.5}
      .mvDsh .mvProvider{padding:16px;border:1px solid var(--dsw-alias-border-l4,#888);border-radius:12px;margin:12px 0}.mvDsh .mvSetup{margin-top:24px}.mvDsh summary{cursor:pointer;font-weight:600}.mvDsh code{overflow-wrap:anywhere}.mvDsh button:focus-visible,.mvDsh summary:focus-visible{outline:2px solid #6758d6;outline-offset:3px}.mvDsh h2,.mvDsh h3{margin:0 0 8px}.mvDsh p{margin:8px 0}.mvDsh small,.mvDsh .mvHint{color:var(--dsw-alias-label-tertiary,inherit)}
      .mvDsh fieldset{border:0;padding:0;margin:0;min-width:0}.mvDsh .mvFields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
      .mvDsh label{display:flex;flex-direction:column;gap:5px}.mvDsh input:not([type=checkbox]),.mvDsh select{box-sizing:border-box;width:100%;min-width:0;padding:8px;border:1px solid var(--dsw-alias-border-l4,#888);border-radius:8px;color:inherit;background:var(--dsw-alias-bg-layer-3,transparent);font:inherit}
      .mvDsh .mvActions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:14px 0}.mvDsh button,.mvDsh .mvDashboard{padding:7px 12px;border:1px solid var(--dsw-alias-border-l4,#888);border-radius:8px;font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-3,transparent);cursor:pointer}
      .mvDsh button:disabled{opacity:.5;cursor:default}.mvDsh .mvPrimary{background:var(--dsw-alias-label-primary,#333);color:var(--dsw-alias-bg-layer-3,#fff)}
      .mvDsh :focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#3686ff);outline-offset:2px}.mvDsh .mvAlert{padding:12px;border:1px solid var(--dsw-alias-border-l4,#888);border-radius:8px}.mvDsh .mvError{color:var(--dsw-alias-state-error-primary,#b42318)}
      .mvDsh dl{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 16px}.mvDsh dt{font-weight:600}.mvDsh dd{margin:0;overflow-wrap:anywhere}
      .mvDsh .mvModels{margin-top:18px}.mvDsh .mvModelList{max-height:520px;overflow:auto;border:1px solid var(--dsw-alias-border-l4,#888);border-radius:10px}.mvDsh .mvModel{padding:12px;border-bottom:1px solid var(--dsw-alias-border-l4,#888)}.mvDsh .mvModel:last-child{border-bottom:0}
      .mvDsh .mvCheck{flex-direction:row;align-items:flex-start;gap:9px;overflow-wrap:anywhere}.mvDsh .mvCheck input{margin-top:5px;flex:none}.mvDsh .mvCapacity{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:8px}.mvDsh code{overflow-wrap:anywhere}
      @media(max-width:580px){.mvDsh{padding:12px}.mvDsh .mvFields,.mvDsh .mvCapacity{grid-template-columns:1fr}.mvDsh dl{grid-template-columns:1fr;gap:4px}.mvDsh dd{margin-bottom:8px}}
    `
    const apiError = code => Object.assign(new Error('MultiVibe request failed'), { code })
    function isLoopback(hostname) {
      const host = String(hostname || '').toLowerCase().replace(/\.$/, '')
      if (host === 'localhost' || host === '::1' || host === '[::1]') return true
      const parts = host.split('.')
      return parts.length === 4 && parts[0] === '127' && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
    }
    function gatewayURL(value) {
      try {
        const url = new URL(value)
        if (url.username || url.password || url.search || url.hash ||
          !(url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback(url.hostname)))) throw apiError('ENDPOINT')
        return url
      } catch { throw apiError('ENDPOINT') }
    }
    function readStatus(value) {
      if (!value || value.revision == null || typeof value.connected !== 'boolean' || typeof value.pending !== 'boolean' || !Array.isArray(value.providers)) throw apiError('RESPONSE')
      if (value.connected && (!value.connection || typeof value.connection.providerId !== 'string' || typeof value.connection.baseURL !== 'string')) throw apiError('RESPONSE')
      return { ...value, existingProviders: Array.isArray(value.existingProviders) ? value.existingProviders.filter(provider => provider && typeof provider.providerId === 'string' && typeof provider.baseURL === 'string' && Array.isArray(provider.models)) : [], providers: value.providers.filter(provider => provider && typeof provider.settingsNs === 'string' && provider.settingsNs) }
    }
    const positiveInteger = value => (typeof value === 'number' || typeof value === 'string') && Number.isSafeInteger(Number(value)) && Number(value) > 0 && String(value).trim() !== ''
    function readCatalog(value) {
      if (!value || !Array.isArray(value.models) || value.models.length > 10000) throw apiError('RESPONSE')
      const ids = new Set()
      return value.models.map(model => {
        if (!model || typeof model.id !== 'string' || !model.id || model.id.length > 512 || ids.has(model.id)) throw apiError('RESPONSE')
        ids.add(model.id)
        return {
          id: model.id, name: typeof model.name === 'string' ? model.name.slice(0, 512) : model.id,
          contextWindow: positiveInteger(model.contextWindow) ? Number(model.contextWindow) : undefined,
          maxTokens: positiveInteger(model.maxTokens) ? Number(model.maxTokens) : undefined,
          inputModalities: Array.isArray(model.inputModalities) ? model.inputModalities.filter(item => typeof item === 'string' && item.length <= 32).slice(0, 16) : [],
        }
      })
    }
    function safeCode(code) {
      if (['CONFLICT', 'REVISION_CONFLICT', 'STALE_REVISION'].includes(code)) return 'CONFLICT'
      if (['AUTH', 'UNAUTHORIZED', 'INVALID_CREDENTIAL', 'INVALID_API_KEY', 'PERMISSION', 'FORBIDDEN'].includes(code)) return 'AUTH'
      return Object.hasOwn(messages.en, code) && /^[A-Z_]+$/.test(code) ? code : 'UNAVAILABLE'
    }
    async function callApi(endpoint, payload, signal) {
      const read = endpoint === 'status' || endpoint === 'catalog'
      if (!['status', 'catalog', 'discover', 'connect', 'disconnect', 'recover'].includes(endpoint)) throw apiError('UNAVAILABLE')
      if (!read && !isLoopback(window.location.hostname)) throw apiError('READ_ONLY')
      const controller = new AbortController()
      let timedOut = false
      const abort = () => controller.abort()
      if (signal?.aborted) controller.abort()
      else signal?.addEventListener('abort', abort, { once: true })
      const timer = setTimeout(() => { timedOut = true; controller.abort() }, 45000)
      try {
        if (controller.signal.aborted) throw apiError('CANCELLED')
        const response = await fetch(`/api/multivibe/${endpoint}`, {
          method: read ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
          ...(read ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}) }),
        })
        let data
        try { data = await response.json() } catch { throw apiError('RESPONSE') }
        if (!response.ok) throw apiError(safeCode(data?.error?.code))
        return data
      } catch (error) {
        if (timedOut) throw apiError('TIMEOUT')
        if (signal?.aborted) throw apiError('CANCELLED')
        throw apiError(safeCode(error?.code))
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
      }
    }
    function MultivibePanel({ t, callApi: request }) {
      const [status, setStatus] = React.useState(null)
      const [busy, setBusy] = React.useState('status')
      const [error, setError] = React.useState('')
      const [note, setNote] = React.useState('')
      const [baseURL, setBaseURL] = React.useState('http://127.0.0.1:1455/v1')
      const [providerId, setProviderId] = React.useState('multivibe')
      const [settingsNs, setSettingsNs] = React.useState('')
      const [removeCredential, setRemoveCredential] = React.useState(false)
      const [protocol, setProtocol] = React.useState('openai-completions')
      const [hasKey, setHasKey] = React.useState(false)
      const [models, setModels] = React.useState([])
      const [selectedIds, setSelectedIds] = React.useState([])
      const [capacities, setCapacities] = React.useState({})
      const [discovered, setDiscovered] = React.useState(false)
      const [page, setPage] = React.useState(0)
      const [confirmDisconnect, setConfirmDisconnect] = React.useState(false)
      const mounted = React.useRef(false)
      const active = React.useRef(null)
      const requests = React.useRef(new Set())
      const keyInput = React.useRef(null)
      const attachKey = React.useCallback(node => {
        if (!node && keyInput.current) keyInput.current.value = ''
        keyInput.current = node
      }, [])
      const local = isLoopback(window.location.hostname)
      const writable = local && status && !status.pending && !busy
      const clearKey = () => { if (keyInput.current) keyInput.current.value = ''; setHasKey(false) }
      const invalidateCatalog = () => { setModels([]); setSelectedIds([]); setCapacities({}); setDiscovered(false); setPage(0); setNote(''); setError('') }
      const acceptStatus = next => {
        setStatus(next)
        setProviderId(previous => !next.connection && next.existingProviders.some(provider => provider.providerId === previous) ? 'multivibe-companion' : previous)
        setSettingsNs(previous => next.providers.some(provider => provider.settingsNs === previous) ? previous : next.providers.length === 1 ? next.providers[0].settingsNs : '')
        setConfirmDisconnect(false)
      }
      // The ref guards the very first double click, before React has rendered busy state.
      const run = async (operation, work, commit) => {
        if (active.current || !mounted.current) return
        const controller = new AbortController()
        active.current = controller; requests.current.add(controller)
        setBusy(operation); setError(''); setNote('')
        const live = () => mounted.current && !controller.signal.aborted && active.current === controller
        try {
          const result = await work(controller.signal)
          if (live()) commit(result)
        } catch (failure) {
          if (!live()) return
          const code = safeCode(failure?.code)
          // A timeout or an error can still have committed a journal entry on the Host.
          if (['connect', 'disconnect', 'recover'].includes(operation) || code === 'CONFLICT') {
            try {
              const current = readStatus(await request('status', undefined, controller.signal))
              if (live()) acceptStatus(current)
            } catch { if (live()) { setStatus(null); setNote('stale') } }
          } else if (operation === 'status') setStatus(null)
          if (live()) setError(code)
        } finally {
          requests.current.delete(controller)
          if (active.current === controller) {
            active.current = null
            if (mounted.current) setBusy('')
          }
        }
      }
      const reloadStatus = () => run('status', async signal => readStatus(await request('status', undefined, signal)), next => { acceptStatus(next); setNote('refreshed') })
      React.useEffect(() => {
        mounted.current = true
        void reloadStatus()
        return () => {
          mounted.current = false
          for (const controller of requests.current) controller.abort()
          requests.current.clear(); active.current = null
          // Keep the secret out of React state and erase its DOM value on teardown.
          if (keyInput.current) keyInput.current.value = ''
        }
      }, [])
      const mutate = (operation, notice) => {
        if (!local || !status || status.pending && operation !== 'recover' || busy) return
        void run(operation, async signal => readStatus(await request(operation, { revision: status.revision, ...(operation === 'disconnect' ? { removeCredential } : {}) }, signal)), next => {
          acceptStatus(next); setRemoveCredential(false); clearKey(); invalidateCatalog(); setNote(notice)
        })
      }
      const discover = () => {
        if (!writable || status.connected) return
        let url
        try { url = gatewayURL(baseURL).href } catch { setError('ENDPOINT'); return }
        const apiKey = keyInput.current?.value.trim() || ''
        if (!apiKey) { setError('KEY_REQUIRED'); return }
        void run('discover', async signal => {
          const result = await request('discover', { baseURL: url, apiKey }, signal)
          const catalog = readCatalog(result)
          const normalized = gatewayURL(result.baseURL || url).href
          return { catalog, normalized }
        }, ({ catalog, normalized }) => {
          setBaseURL(normalized); setModels(catalog); setSelectedIds([]); setPage(0); setDiscovered(true)
          setCapacities(Object.fromEntries(catalog.map(model => [model.id, { contextWindow: model.contextWindow ?? '', maxTokens: model.maxTokens ?? '' }])))
          setNote('discovered')
        })
      }
      const connect = event => {
        event.preventDefault()
        if (!writable || status.connection || active.current) return
        if (!status.providers.some(provider => provider.settingsNs === settingsNs)) { setError('NAMESPACE'); return }
        if (!/^[a-z][a-z0-9-]{2,63}$/.test(providerId)) { setError('PROVIDER'); return }
        if (!discovered || !selectedIds.length || selectedIds.length > MAX_SELECTED || selectedIds.some(id => !models.some(model => model.id === id))) { setError('SELECTION'); return }
        const apiKey = keyInput.current?.value.trim() || ''
        if (!apiKey) { setError('KEY_REQUIRED'); return }
        let url
        try { url = gatewayURL(baseURL).href } catch { setError('ENDPOINT'); return }
        const selectedCapacities = Object.fromEntries(selectedIds.map(id => [id, capacities[id]]))
        if (Object.values(selectedCapacities).some(value => !value || !positiveInteger(value.contextWindow) || !positiveInteger(value.maxTokens) || Number(value.maxTokens) > Number(value.contextWindow))) { setError('CAPACITY'); return }
        const payload = {
          revision: status.revision, providerId, settingsNs, baseURL: url, apiKey, protocol, selectedIds,
          capacities: Object.fromEntries(Object.entries(selectedCapacities).map(([id, value]) => [id, { contextWindow: Number(value.contextWindow), maxTokens: Number(value.maxTokens) }])),
        }
        void run('connect', async signal => readStatus(await request('connect', payload, signal)), next => {
          acceptStatus(next); clearKey(); invalidateCatalog(); setNote('saved')
        })
      }
      const refreshCatalog = () => {
        if (!status?.connected || busy) return
        void run('catalog', async signal => readCatalog(await request('catalog', undefined, signal)), catalog => { setModels(catalog); setSelectedIds([]); setPage(0) })
      }
      const selectModel = (id, checked) => {
        setSelectedIds(previous => checked ? (previous.includes(id) || previous.length >= MAX_SELECTED ? previous : [...previous, id]) : previous.filter(value => value !== id))
        setError(''); setNote('')
      }
      let dashboard
      try { if (status?.connected) dashboard = `${gatewayURL(status.connection.baseURL).origin}/` } catch { /* Do not render an unsafe gateway link. */ }
      const pageCount = Math.max(1, Math.ceil(models.length / PAGE_SIZE))
      const visibleModels = models.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
      const field = (label, props) => h('label', { key: props.name }, t(label), h('input', props))
      return h('section', { className: 'mvDsh', 'aria-busy': Boolean(busy), 'data-testid': 'multivibe-panel' },
        h('h2', null, t('title')), h('p', { className: 'mvHint' }, t('description')),
        !local && h('p', { className: 'mvAlert' }, t('remote')),
        h('div', { className: 'mvActions' }, h('strong', null, status ? t(status?.connected ? 'connected' : 'disconnected') : t(busy ? 'loading' : 'stale')),
          h('button', { type: 'button', disabled: Boolean(busy), onClick: reloadStatus }, t('refresh'))),
        h('p', { className: 'mvHint' }, t('purpose')),
        status && h('p', { role: 'status' }, t('pluginActive')),
        status?.existingProviders.length > 0 && h('section', { 'aria-label': t('existing') },
          h('h3', null, t('existing')), h('p', { className: 'mvHint' }, t('existingHint')),
          status.existingProviders.map(provider => h('article', { className: 'mvProvider', key: `${provider.settingsNs}:${provider.providerId}` },
            h('h3', null, provider.displayName || provider.providerId), h('code', null, provider.baseURL),
            h('p', null, `${provider.protocol || '—'} · ${provider.models.length} ${t('configured')}`),
            h('p', { className: 'mvHint' }, t(provider.credentialConfigured ? 'credential' : 'credentialMissing')),
            h('details', null, h('summary', null, t('models')), h('ul', null, provider.models.map(model => h('li', { key: model.id },
              h('strong', null, model.name || model.id), ' · ', h('code', null, model.id),
              model.contextWindow && ` · ${t('context')}: ${model.contextWindow}`, model.maxTokens && ` · ${t('output')}: ${model.maxTokens}`))))))),
        h('h3', null, t('configuration')),
        status?.pending && h('div', { className: 'mvAlert', role: 'alert' }, h('p', null, t('pending')),
          h('button', { type: 'button', disabled: !local || Boolean(busy), onClick: () => mutate('recover', 'recovered') }, t('recover'))),
        status?.connection && h(React.Fragment, null,
          !status.connected && h('p', { className: 'mvAlert', role: 'alert' }, t('retained')),
          h('dl', null, h('dt', null, t('provider')), h('dd', null, status.connection.providerId),
            h('dt', null, t('baseURL')), h('dd', null, status.connection.baseURL),
            h('dt', null, t('protocol')), h('dd', null, status.connection.protocol),
            h('dt', null, t('modelCount')), h('dd', null, status.connection.modelCount),
            status.connection.connectedAt != null && h(React.Fragment, null, h('dt', null, t('connectedAt')), h('dd', null,
              Number.isFinite(new Date(status.connection.connectedAt).getTime()) ? new Date(status.connection.connectedAt).toLocaleString() : '—'))),
          h('p', { className: 'mvHint' }, t('reconnectHint')),
          h('div', { className: 'mvActions' },
            h('button', { type: 'button', disabled: !status.connected || Boolean(busy), onClick: refreshCatalog }, t('catalog')),
            dashboard && h('a', { className: 'mvDashboard', href: dashboard, target: '_blank', rel: 'noopener noreferrer' }, t('dashboard')),
            h('button', { type: 'button', disabled: !writable, onClick: () => setConfirmDisconnect(true) }, t('disconnect'))),
          confirmDisconnect && h('div', { className: 'mvAlert' }, h('p', null, t('disconnectConfirm')),
            h('label', { className: 'mvCheck' }, h('input', { name: 'removeCredential', type: 'checkbox', checked: removeCredential, onChange: event => setRemoveCredential(event.target.checked) }), t('deleteCredential')),
            h('div', { className: 'mvActions' }, h('button', { type: 'button', disabled: !writable, onClick: () => mutate('disconnect', 'removed') }, t('confirmDisconnect')),
              h('button', { type: 'button', disabled: Boolean(busy), onClick: () => setConfirmDisconnect(false) }, t('cancel'))))),
        Array.isArray(status?.retainedCredentialRefs) && status.retainedCredentialRefs.length > 0 && h('details', { className: 'mvAlert' },
          h('summary', null, t('retainedKeys')), h('ul', null, status.retainedCredentialRefs.filter(ref => typeof ref === 'string' && /^MULTIVIBE_DSH_[A-F0-9]{32}$/.test(ref)).map(ref => h('li', { key: ref }, h('code', null, ref))))),
        status && !status.connection && h('details', { className: 'mvSetup', open: status.existingProviders.length === 0 }, h('summary', null, t('setup')), h('form', { onSubmit: connect },
          h('fieldset', { disabled: !writable }, h('div', { className: 'mvFields' },
            field('baseURL', { name: 'baseURL', type: 'url', required: true, value: baseURL, autoComplete: 'off', spellCheck: false, onChange: event => { setBaseURL(event.target.value); invalidateCatalog() } }),
            field('provider', { name: 'providerId', value: providerId, required: true, maxLength: 64, autoComplete: 'off', spellCheck: false, onChange: event => { setProviderId(event.target.value); setError('') } }),
            h('label', null, t('namespace'), h('select', { name: 'settingsNs', required: true, value: settingsNs, onChange: event => setSettingsNs(event.target.value) },
              h('option', { value: '' }, t('chooseNamespace')), status.providers.map(provider => h('option', { key: provider.settingsNs, value: provider.settingsNs }, provider.displayName || provider.settingsNs)))),
            h('label', null, t('protocol'), h('select', { name: 'protocol', value: protocol, onChange: event => { setProtocol(event.target.value); setError('') } },
              h('option', { value: 'openai-completions' }, 'OpenAI Chat Completions'), h('option', { value: 'openai-responses' }, 'OpenAI Responses'))),
            field('apiKey', { name: 'apiKey', type: 'password', ref: attachKey, autoComplete: 'off', spellCheck: false, 'aria-describedby': 'mvDshKeyHint', onChange: event => { setHasKey(Boolean(event.target.value.trim())); invalidateCatalog() } })),
          h('p', { id: 'mvDshKeyHint', className: 'mvHint' }, t('keyHint')),
          h('div', { className: 'mvActions' }, h('button', { type: 'button', disabled: !hasKey, onClick: () => { clearKey(); invalidateCatalog() } }, t('clearKey')),
            h('button', { type: 'button', disabled: !hasKey || !baseURL, onClick: discover }, t('discover'))),
          !discovered && h('p', { className: 'mvHint' }, t('discoverHint')),
          discovered && h('p', { className: 'mvHint' }, t('capacityHint')),
          h('button', { className: 'mvPrimary', type: 'submit', disabled: !discovered || !hasKey || !selectedIds.length || !settingsNs }, t('connect'))))),
        (discovered || status?.connected && models.length > 0) && h('div', { className: 'mvModels' },
          h('h3', null, t('models'), !status?.connected && ` · ${selectedIds.length}/${MAX_SELECTED} ${t('selected')}`),
          !models.length && h('p', { role: 'status' }, t('empty')),
          !status?.connected && selectedIds.length >= MAX_SELECTED && h('p', { role: 'status' }, t('selectionLimit')),
          h('div', { className: 'mvModelList' }, visibleModels.map(model => {
            const selected = selectedIds.includes(model.id)
            const capacity = capacities[model.id] || { contextWindow: '', maxTokens: '' }
            return h('div', { className: 'mvModel', key: model.id },
              status?.connected ? h('strong', null, model.name) : h('label', { className: 'mvCheck' },
                h('input', { type: 'checkbox', checked: selected, disabled: !writable || !selected && selectedIds.length >= MAX_SELECTED, onChange: event => selectModel(model.id, event.target.checked) }), h('strong', null, model.name)),
              h('div', null, h('code', null, model.id)), model.inputModalities.length > 0 && h('small', null, model.inputModalities.join(', ')),
              status?.connected ? h('p', { className: 'mvHint' }, `${t('context')}: ${model.contextWindow ?? '—'} · ${t('output')}: ${model.maxTokens ?? '—'}`) : selected && h('fieldset', { className: 'mvCapacity', disabled: !writable },
                ['contextWindow', 'maxTokens'].map(key => field(key === 'contextWindow' ? 'context' : 'output', {
                  name: `${key}:${model.id}`, type: 'number', min: 1, step: 1, value: capacity[key], required: true,
                  onChange: event => { const value = event.target.value; setCapacities(previous => ({ ...previous, [model.id]: { ...previous[model.id], [key]: value } })); setError('') },
                }))))
          })),
          models.length > PAGE_SIZE && h('nav', { className: 'mvActions', 'aria-label': t('models') },
            h('button', { type: 'button', disabled: Boolean(busy) || page === 0, onClick: () => setPage(value => value - 1) }, t('previous')),
            h('span', null, `${t('page')} ${page + 1}/${pageCount}`),
            h('button', { type: 'button', disabled: Boolean(busy) || page + 1 >= pageCount, onClick: () => setPage(value => value + 1) }, t('next')))),
        busy && h('p', { role: 'status' }, t(busy === 'status' ? 'loading' : 'working')),
        note && h('p', { role: 'status' }, t(note)),
        error && h('p', { className: 'mvError', role: 'alert' }, t(error)))
    }
    return {
      inject: ['slots', 'locale', 'layout'],
      apply(ctx) {
        const fallback = key => {
          const language = String(document.documentElement?.lang || navigator.language || 'en').toLowerCase().startsWith('fr') ? 'fr' : 'en'
          return messages[language][key] || messages.en.UNAVAILABLE
        }
        if (ctx.locale?.register) ctx.effect(() => ctx.locale.register(NS, messages), 'multivibe locale')
        const bound = ctx.locale?.bind?.(NS)
        const t = key => {
          const value = bound?.(key)
          return typeof value === 'string' && value !== key && value !== `${NS}.${key}` ? value : fallback(key)
        }
        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.pluginCss = 'dsh-multivibe'; style.textContent = css
          document.head.appendChild(style)
          return () => style.remove()
        }, 'multivibe styles')
        // Public global-panel contract: the sidebar id addresses the main key.
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: PANEL_ID, locale: NS, inject: () => ({ t, callApi }),
        }, MultivibePanel))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: PANEL_ID, order: 30, label: () => t('title'), locale: NS,
        }, ({ size = 16 }) => h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
          h('path', { d: 'M4 19V5l8 10 8-10v14', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }))))
        // Configuration lives on the installed bundle's detail page. A launcher
        // selects the one global panel instead of mounting a second keyed form.
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config', key: 'dsh-multivibe', locale: NS,
          inject: () => ({ t, open: () => ctx.layout.selectPanel(PANEL_ID) }),
        }, ({ t, open }) => h('div', { className: 'mvLauncher' }, h('p', null, t('purpose')),
          h('button', { type: 'button', onClick: open }, t('openPanel')))))
      },
    }
  },
})
