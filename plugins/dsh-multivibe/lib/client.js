"use strict";
(() => {
  // src/client.jsx
  window.__ModuleLoader__.load({
    id: "dsh-multivibe",
    factory(require2) {
      const React = require2("react");
      const h = React.createElement;
      const NS = "settings.multivibe";
      const PAGE_SIZE = 50;
      const MAX_SELECTED = 256;
      const messages = {
        fr: {
          title: "MultiVibe",
          description: "Connectez votre gateway aux mod\xE8les de DSH, sans partager de jeton administrateur.",
          loading: "Chargement\u2026",
          working: "Op\xE9ration en cours\u2026",
          refresh: "Actualiser l\u2019\xE9tat",
          connected: "Connect\xE9",
          disconnected: "Non connect\xE9",
          provider: "Identifiant du fournisseur",
          namespace: "Configuration DSH",
          chooseNamespace: "Choisir une configuration",
          baseURL: "URL de la gateway",
          apiKey: "Cl\xE9 API proxy d\xE9di\xE9e \xE0 DSH",
          keyHint: "La cl\xE9 reste dans ce formulaire jusqu\u2019\xE0 la connexion. Elle n\u2019est jamais ajout\xE9e \xE0 une URL.",
          clearKey: "Effacer la cl\xE9",
          protocol: "Protocole",
          discover: "D\xE9couvrir les mod\xE8les",
          connect: "Connecter MultiVibe",
          disconnect: "D\xE9connecter",
          disconnectConfirm: "Le fournisseur g\xE9r\xE9 sera retir\xE9. Le credential est conserv\xE9 par d\xE9faut, car d\u2019autres profils inactifs peuvent l\u2019utiliser.",
          deleteCredential: "Supprimer aussi le credential : je confirme qu\u2019aucun autre profil ou param\xE8tre ne le r\xE9f\xE9rence.",
          retainedKeys: "R\xE9f\xE9rences de credentials conserv\xE9s. R\xE9voquez les cl\xE9s proxy dans MultiVibe si elles ne sont plus n\xE9cessaires.",
          confirmDisconnect: "Confirmer la d\xE9connexion",
          cancel: "Annuler",
          catalog: "Actualiser le catalogue",
          dashboard: "Ouvrir le dashboard",
          modelCount: "Mod\xE8les configur\xE9s",
          connectedAt: "Connect\xE9 depuis",
          models: "Mod\xE8les",
          selected: "s\xE9lectionn\xE9s",
          empty: "Aucun mod\xE8le retourn\xE9.",
          discoverHint: "D\xE9couvrez les mod\xE8les, puis s\xE9lectionnez ceux \xE0 ajouter au fournisseur.",
          capacityHint: "Renseignez explicitement les capacit\xE9s manquantes. Aucune valeur n\u2019est devin\xE9e. La sortie ne doit pas d\xE9passer le contexte.",
          context: "Fen\xEAtre de contexte (tokens)",
          output: "Sortie maximale (tokens)",
          previous: "Pr\xE9c\xE9dent",
          next: "Suivant",
          page: "Page",
          selectionLimit: "Vous pouvez s\xE9lectionner au maximum 256 mod\xE8les.",
          reconnectHint: "Pour changer de connexion, d\xE9connectez d\u2019abord le fournisseur. Aucun fournisseur existant ne sera \xE9cras\xE9.",
          remote: "Lecture seule : ouvrez DSH Desktop ou l\u2019interface sur localhost pour modifier la connexion.",
          pending: "Une op\xE9ration incompl\xE8te est enregistr\xE9e. La r\xE9cup\xE9ration retire uniquement le fournisseur g\xE9r\xE9, selon le choix enregistr\xE9 pour son credential ; v\xE9rifiez ensuite la connexion.",
          retained: "Une connexion est enregistr\xE9e mais inactive. Si le fournisseur a \xE9t\xE9 modifi\xE9 ailleurs, restaurez-le ou supprimez-le manuellement dans DSH, puis d\xE9connectez ici pour nettoyer le credential.",
          recover: "R\xE9cup\xE9rer l\u2019op\xE9ration incompl\xE8te",
          recovered: "R\xE9cup\xE9ration termin\xE9e. V\xE9rifiez l\u2019\xE9tat affich\xE9.",
          saved: "Connexion enregistr\xE9e.",
          removed: "D\xE9connexion termin\xE9e.",
          refreshed: "\xC9tat actualis\xE9.",
          discovered: "Catalogue d\xE9couvert. S\xE9lectionnez les mod\xE8les \xE0 connecter.",
          stale: "Impossible de confirmer l\u2019\xE9tat actuel. Actualisez l\u2019\xE9tat avant toute modification.",
          CONFLICT: "La configuration a chang\xE9. L\u2019\xE9tat a \xE9t\xE9 recharg\xE9 ; votre saisie est conserv\xE9e. V\xE9rifiez-la avant de r\xE9essayer.",
          PROVIDER_EXISTS: "Ce fournisseur existe d\xE9j\xE0. Il ne sera pas remplac\xE9 : choisissez un autre identifiant.",
          AUTH: "Cl\xE9 invalide ou acc\xE8s refus\xE9. V\xE9rifiez la cl\xE9 proxy MultiVibe.",
          ENDPOINT: "Indiquez une URL HTTPS, ou HTTP sur loopback, sans identifiants, param\xE8tres ni fragment.",
          KEY_REQUIRED: "Saisissez la cl\xE9 API proxy.",
          NAMESPACE: "Choisissez une configuration DSH disponible.",
          PROVIDER: "Saisissez un identifiant de fournisseur valide (lettres minuscules, chiffres et tirets).",
          SELECTION: "S\xE9lectionnez entre 1 et 256 mod\xE8les du catalogue d\xE9couvert.",
          CAPACITY: "Chaque mod\xE8le s\xE9lectionn\xE9 doit avoir des capacit\xE9s enti\xE8res positives, avec sortie \u2264 contexte.",
          PENDING: "R\xE9cup\xE9rez l\u2019op\xE9ration incompl\xE8te avant de modifier la connexion.",
          ALREADY_CONNECTED: "D\xE9connectez le fournisseur avant de cr\xE9er une autre connexion.",
          READ_ONLY: "La connexion ne peut pas \xEAtre modifi\xE9e depuis cette page.",
          TIMEOUT: "Le d\xE9lai a \xE9t\xE9 d\xE9pass\xE9. V\xE9rifiez l\u2019\xE9tat avant de r\xE9essayer une modification.",
          RESPONSE: "La r\xE9ponse du service est invalide.",
          UNAVAILABLE: "Le service est indisponible. R\xE9essayez ou v\xE9rifiez la gateway."
        },
        en: {
          title: "MultiVibe",
          description: "Connect your gateway to DSH models without sharing an administrator token.",
          loading: "Loading\u2026",
          working: "Operation in progress\u2026",
          refresh: "Refresh status",
          connected: "Connected",
          disconnected: "Not connected",
          provider: "Provider ID",
          namespace: "DSH configuration",
          chooseNamespace: "Choose a configuration",
          baseURL: "Gateway URL",
          apiKey: "Dedicated DSH proxy API key",
          keyHint: "The key stays in this form until connection succeeds. It is never added to a URL.",
          clearKey: "Clear key",
          protocol: "Protocol",
          discover: "Discover models",
          connect: "Connect MultiVibe",
          disconnect: "Disconnect",
          disconnectConfirm: "The managed provider will be removed. Its credential is retained by default because inactive profiles may still use it.",
          deleteCredential: "Also delete the credential: I confirm no other profile or setting references it.",
          retainedKeys: "Retained credential references. Revoke the proxy keys in MultiVibe if they are no longer needed.",
          confirmDisconnect: "Confirm disconnection",
          cancel: "Cancel",
          catalog: "Refresh catalog",
          dashboard: "Open dashboard",
          modelCount: "Configured models",
          connectedAt: "Connected since",
          models: "Models",
          selected: "selected",
          empty: "No models returned.",
          discoverHint: "Discover models, then select which ones to add to the provider.",
          capacityHint: "Enter missing capacities explicitly. No values are guessed. Output must not exceed context.",
          context: "Context window (tokens)",
          output: "Maximum output (tokens)",
          previous: "Previous",
          next: "Next",
          page: "Page",
          selectionLimit: "You can select at most 256 models.",
          reconnectHint: "Disconnect the provider before changing the connection. Existing providers will never be overwritten.",
          remote: "Read-only: open DSH Desktop or the localhost interface to change the connection.",
          pending: "An incomplete operation was recorded. Recovery removes only the managed provider and respects the recorded credential choice; check the connection afterwards.",
          retained: "A connection is saved but inactive. If its provider was edited elsewhere, restore it or remove it manually in DSH, then disconnect here to clean up the credential.",
          recover: "Recover incomplete operation",
          recovered: "Recovery finished. Check the displayed status.",
          saved: "Connection saved.",
          removed: "Disconnection finished.",
          refreshed: "Status refreshed.",
          discovered: "Catalog discovered. Select the models to connect.",
          stale: "Could not confirm the current status. Refresh status before making changes.",
          CONFLICT: "Configuration changed. Status was reloaded and your draft was kept. Review it before retrying.",
          PROVIDER_EXISTS: "This provider already exists. It will not be replaced: choose another ID.",
          AUTH: "Invalid key or access denied. Check your MultiVibe proxy key.",
          ENDPOINT: "Enter an HTTPS URL, or loopback HTTP, without credentials, query parameters or a fragment.",
          KEY_REQUIRED: "Enter the proxy API key.",
          NAMESPACE: "Choose an available DSH configuration.",
          PROVIDER: "Enter a valid provider ID (lowercase letters, digits and hyphens).",
          SELECTION: "Select between 1 and 256 models from the discovered catalog.",
          CAPACITY: "Every selected model needs positive integer capacities, with output \u2264 context.",
          PENDING: "Recover the incomplete operation before changing the connection.",
          ALREADY_CONNECTED: "Disconnect the provider before creating another connection.",
          READ_ONLY: "The connection cannot be changed from this page.",
          TIMEOUT: "The request timed out. Check status before retrying a change.",
          RESPONSE: "The service returned an invalid response.",
          UNAVAILABLE: "The service is unavailable. Retry or check the gateway."
        }
      };
      const css = `
      .mvDsh{max-width:860px;padding:20px;color:var(--dsw-alias-label-primary,inherit);font-size:14px;line-height:1.5}
      .mvDsh h2,.mvDsh h3{margin:0 0 8px}.mvDsh p{margin:8px 0}.mvDsh small,.mvDsh .mvHint{color:var(--dsw-alias-label-tertiary,inherit)}
      .mvDsh fieldset{border:0;padding:0;margin:0;min-width:0}.mvDsh .mvFields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
      .mvDsh label{display:flex;flex-direction:column;gap:5px}.mvDsh input:not([type=checkbox]),.mvDsh select{box-sizing:border-box;width:100%;min-width:0;padding:8px;border:1px solid var(--dsw-alias-border-l4,#888);border-radius:8px;color:inherit;background:var(--dsw-alias-bg-layer-3,transparent);font:inherit}
      .mvDsh .mvActions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:14px 0}.mvDsh button,.mvDsh .mvDashboard{padding:7px 12px;border:1px solid var(--dsw-alias-border-l4,#888);border-radius:8px;font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-3,transparent);cursor:pointer}
      .mvDsh button:disabled{opacity:.5;cursor:default}.mvDsh .mvPrimary{background:var(--dsw-alias-label-primary,#333);color:var(--dsw-alias-bg-layer-3,#fff)}
      .mvDsh :focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#3686ff);outline-offset:2px}.mvDsh .mvAlert{padding:12px;border:1px solid var(--dsw-alias-border-l4,#888);border-radius:8px}.mvDsh .mvError{color:var(--dsw-alias-state-error-primary,#b42318)}
      .mvDsh dl{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 16px}.mvDsh dt{font-weight:600}.mvDsh dd{margin:0;overflow-wrap:anywhere}
      .mvDsh .mvModels{margin-top:18px}.mvDsh .mvModelList{max-height:520px;overflow:auto;border:1px solid var(--dsw-alias-border-l4,#888);border-radius:10px}.mvDsh .mvModel{padding:12px;border-bottom:1px solid var(--dsw-alias-border-l4,#888)}.mvDsh .mvModel:last-child{border-bottom:0}
      .mvDsh .mvCheck{flex-direction:row;align-items:flex-start;gap:9px;overflow-wrap:anywhere}.mvDsh .mvCheck input{margin-top:5px;flex:none}.mvDsh .mvCapacity{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:8px}.mvDsh code{overflow-wrap:anywhere}
      @media(max-width:580px){.mvDsh{padding:12px}.mvDsh .mvFields,.mvDsh .mvCapacity{grid-template-columns:1fr}.mvDsh dl{grid-template-columns:1fr;gap:4px}.mvDsh dd{margin-bottom:8px}}
    `;
      const apiError = (code) => Object.assign(new Error("MultiVibe request failed"), { code });
      function isLoopback(hostname) {
        const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
        if (host === "localhost" || host === "::1" || host === "[::1]") return true;
        const parts = host.split(".");
        return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
      }
      function gatewayURL(value) {
        try {
          const url = new URL(value);
          if (url.username || url.password || url.search || url.hash || !(url.protocol === "https:" || url.protocol === "http:" && isLoopback(url.hostname))) throw apiError("ENDPOINT");
          return url;
        } catch {
          throw apiError("ENDPOINT");
        }
      }
      function readStatus(value) {
        if (!value || value.revision == null || typeof value.connected !== "boolean" || typeof value.pending !== "boolean" || !Array.isArray(value.providers)) throw apiError("RESPONSE");
        if (value.connected && (!value.connection || typeof value.connection.providerId !== "string" || typeof value.connection.baseURL !== "string")) throw apiError("RESPONSE");
        return { ...value, providers: value.providers.filter((provider) => provider && typeof provider.settingsNs === "string" && provider.settingsNs) };
      }
      const positiveInteger = (value) => (typeof value === "number" || typeof value === "string") && Number.isSafeInteger(Number(value)) && Number(value) > 0 && String(value).trim() !== "";
      function readCatalog(value) {
        if (!value || !Array.isArray(value.models) || value.models.length > 1e4) throw apiError("RESPONSE");
        const ids = /* @__PURE__ */ new Set();
        return value.models.map((model) => {
          if (!model || typeof model.id !== "string" || !model.id || model.id.length > 512 || ids.has(model.id)) throw apiError("RESPONSE");
          ids.add(model.id);
          return {
            id: model.id,
            name: typeof model.name === "string" ? model.name.slice(0, 512) : model.id,
            contextWindow: positiveInteger(model.contextWindow) ? Number(model.contextWindow) : void 0,
            maxTokens: positiveInteger(model.maxTokens) ? Number(model.maxTokens) : void 0,
            inputModalities: Array.isArray(model.inputModalities) ? model.inputModalities.filter((item) => typeof item === "string" && item.length <= 32).slice(0, 16) : []
          };
        });
      }
      function safeCode(code) {
        if (["CONFLICT", "REVISION_CONFLICT", "STALE_REVISION"].includes(code)) return "CONFLICT";
        if (["AUTH", "UNAUTHORIZED", "INVALID_CREDENTIAL", "INVALID_API_KEY", "PERMISSION", "FORBIDDEN"].includes(code)) return "AUTH";
        return Object.hasOwn(messages.en, code) && /^[A-Z_]+$/.test(code) ? code : "UNAVAILABLE";
      }
      async function callApi(endpoint, payload, signal) {
        const read = endpoint === "status" || endpoint === "catalog";
        if (!["status", "catalog", "discover", "connect", "disconnect", "recover"].includes(endpoint)) throw apiError("UNAVAILABLE");
        if (!read && !isLoopback(window.location.hostname)) throw apiError("READ_ONLY");
        const controller = new AbortController();
        let timedOut = false;
        const abort = () => controller.abort();
        if (signal?.aborted) controller.abort();
        else signal?.addEventListener("abort", abort, { once: true });
        const timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, 45e3);
        try {
          if (controller.signal.aborted) throw apiError("CANCELLED");
          const response = await fetch(`/api/multivibe/${endpoint}`, {
            method: read ? "GET" : "POST",
            credentials: "same-origin",
            cache: "no-store",
            redirect: "error",
            signal: controller.signal,
            ...read ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload || {}) }
          });
          let data;
          try {
            data = await response.json();
          } catch {
            throw apiError("RESPONSE");
          }
          if (!response.ok) throw apiError(safeCode(data?.error?.code));
          return data;
        } catch (error) {
          if (timedOut) throw apiError("TIMEOUT");
          if (signal?.aborted) throw apiError("CANCELLED");
          throw apiError(safeCode(error?.code));
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
        }
      }
      function MultivibePanel({ t, callApi: request }) {
        const [status, setStatus] = React.useState(null);
        const [busy, setBusy] = React.useState("status");
        const [error, setError] = React.useState("");
        const [note, setNote] = React.useState("");
        const [baseURL, setBaseURL] = React.useState("http://127.0.0.1:1455/v1");
        const [providerId, setProviderId] = React.useState("multivibe");
        const [settingsNs, setSettingsNs] = React.useState("");
        const [removeCredential, setRemoveCredential] = React.useState(false);
        const [protocol, setProtocol] = React.useState("openai-completions");
        const [hasKey, setHasKey] = React.useState(false);
        const [models, setModels] = React.useState([]);
        const [selectedIds, setSelectedIds] = React.useState([]);
        const [capacities, setCapacities] = React.useState({});
        const [discovered, setDiscovered] = React.useState(false);
        const [page, setPage] = React.useState(0);
        const [confirmDisconnect, setConfirmDisconnect] = React.useState(false);
        const mounted = React.useRef(false);
        const active = React.useRef(null);
        const requests = React.useRef(/* @__PURE__ */ new Set());
        const keyInput = React.useRef(null);
        const attachKey = React.useCallback((node) => {
          if (!node && keyInput.current) keyInput.current.value = "";
          keyInput.current = node;
        }, []);
        const local = isLoopback(window.location.hostname);
        const writable = local && status && !status.pending && !busy;
        const clearKey = () => {
          if (keyInput.current) keyInput.current.value = "";
          setHasKey(false);
        };
        const invalidateCatalog = () => {
          setModels([]);
          setSelectedIds([]);
          setCapacities({});
          setDiscovered(false);
          setPage(0);
          setNote("");
          setError("");
        };
        const acceptStatus = (next) => {
          setStatus(next);
          setSettingsNs((previous) => next.providers.some((provider) => provider.settingsNs === previous) ? previous : next.providers.length === 1 ? next.providers[0].settingsNs : "");
          setConfirmDisconnect(false);
        };
        const run = async (operation, work, commit) => {
          if (active.current || !mounted.current) return;
          const controller = new AbortController();
          active.current = controller;
          requests.current.add(controller);
          setBusy(operation);
          setError("");
          setNote("");
          const live = () => mounted.current && !controller.signal.aborted && active.current === controller;
          try {
            const result = await work(controller.signal);
            if (live()) commit(result);
          } catch (failure) {
            if (!live()) return;
            const code = safeCode(failure?.code);
            if (["connect", "disconnect", "recover"].includes(operation) || code === "CONFLICT") {
              try {
                const current = readStatus(await request("status", void 0, controller.signal));
                if (live()) acceptStatus(current);
              } catch {
                if (live()) {
                  setStatus(null);
                  setNote("stale");
                }
              }
            } else if (operation === "status") setStatus(null);
            if (live()) setError(code);
          } finally {
            requests.current.delete(controller);
            if (active.current === controller) {
              active.current = null;
              if (mounted.current) setBusy("");
            }
          }
        };
        const reloadStatus = () => run("status", async (signal) => readStatus(await request("status", void 0, signal)), (next) => {
          acceptStatus(next);
          setNote("refreshed");
        });
        React.useEffect(() => {
          mounted.current = true;
          void reloadStatus();
          return () => {
            mounted.current = false;
            for (const controller of requests.current) controller.abort();
            requests.current.clear();
            active.current = null;
            if (keyInput.current) keyInput.current.value = "";
          };
        }, []);
        const mutate = (operation, notice) => {
          if (!local || !status || status.pending && operation !== "recover" || busy) return;
          void run(operation, async (signal) => readStatus(await request(operation, { revision: status.revision, ...operation === "disconnect" ? { removeCredential } : {} }, signal)), (next) => {
            acceptStatus(next);
            setRemoveCredential(false);
            clearKey();
            invalidateCatalog();
            setNote(notice);
          });
        };
        const discover = () => {
          if (!writable || status.connected) return;
          let url;
          try {
            url = gatewayURL(baseURL).href;
          } catch {
            setError("ENDPOINT");
            return;
          }
          const apiKey = keyInput.current?.value.trim() || "";
          if (!apiKey) {
            setError("KEY_REQUIRED");
            return;
          }
          void run("discover", async (signal) => {
            const result = await request("discover", { baseURL: url, apiKey }, signal);
            const catalog = readCatalog(result);
            const normalized = gatewayURL(result.baseURL || url).href;
            return { catalog, normalized };
          }, ({ catalog, normalized }) => {
            setBaseURL(normalized);
            setModels(catalog);
            setSelectedIds([]);
            setPage(0);
            setDiscovered(true);
            setCapacities(Object.fromEntries(catalog.map((model) => [model.id, { contextWindow: model.contextWindow ?? "", maxTokens: model.maxTokens ?? "" }])));
            setNote("discovered");
          });
        };
        const connect = (event) => {
          event.preventDefault();
          if (!writable || status.connection || active.current) return;
          if (!status.providers.some((provider) => provider.settingsNs === settingsNs)) {
            setError("NAMESPACE");
            return;
          }
          if (!/^[a-z][a-z0-9-]{2,63}$/.test(providerId)) {
            setError("PROVIDER");
            return;
          }
          if (!discovered || !selectedIds.length || selectedIds.length > MAX_SELECTED || selectedIds.some((id) => !models.some((model) => model.id === id))) {
            setError("SELECTION");
            return;
          }
          const apiKey = keyInput.current?.value.trim() || "";
          if (!apiKey) {
            setError("KEY_REQUIRED");
            return;
          }
          let url;
          try {
            url = gatewayURL(baseURL).href;
          } catch {
            setError("ENDPOINT");
            return;
          }
          const selectedCapacities = Object.fromEntries(selectedIds.map((id) => [id, capacities[id]]));
          if (Object.values(selectedCapacities).some((value) => !value || !positiveInteger(value.contextWindow) || !positiveInteger(value.maxTokens) || Number(value.maxTokens) > Number(value.contextWindow))) {
            setError("CAPACITY");
            return;
          }
          const payload = {
            revision: status.revision,
            providerId,
            settingsNs,
            baseURL: url,
            apiKey,
            protocol,
            selectedIds,
            capacities: Object.fromEntries(Object.entries(selectedCapacities).map(([id, value]) => [id, { contextWindow: Number(value.contextWindow), maxTokens: Number(value.maxTokens) }]))
          };
          void run("connect", async (signal) => readStatus(await request("connect", payload, signal)), (next) => {
            acceptStatus(next);
            clearKey();
            invalidateCatalog();
            setNote("saved");
          });
        };
        const refreshCatalog = () => {
          if (!status?.connected || busy) return;
          void run("catalog", async (signal) => readCatalog(await request("catalog", void 0, signal)), (catalog) => {
            setModels(catalog);
            setSelectedIds([]);
            setPage(0);
          });
        };
        const selectModel = (id, checked) => {
          setSelectedIds((previous) => checked ? previous.includes(id) || previous.length >= MAX_SELECTED ? previous : [...previous, id] : previous.filter((value) => value !== id));
          setError("");
          setNote("");
        };
        let dashboard;
        try {
          if (status?.connected) dashboard = `${gatewayURL(status.connection.baseURL).origin}/`;
        } catch {
        }
        const pageCount = Math.max(1, Math.ceil(models.length / PAGE_SIZE));
        const visibleModels = models.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
        const field = (label, props) => h("label", { key: props.name }, t(label), h("input", props));
        return h(
          "section",
          { className: "mvDsh", "aria-busy": Boolean(busy), "data-testid": "multivibe-panel" },
          h("h2", null, t("title")),
          h("p", { className: "mvHint" }, t("description")),
          !local && h("p", { className: "mvAlert" }, t("remote")),
          h(
            "div",
            { className: "mvActions" },
            h("strong", null, status ? t(status?.connected ? "connected" : "disconnected") : t(busy ? "loading" : "stale")),
            h("button", { type: "button", disabled: Boolean(busy), onClick: reloadStatus }, t("refresh"))
          ),
          status?.pending && h(
            "div",
            { className: "mvAlert", role: "alert" },
            h("p", null, t("pending")),
            h("button", { type: "button", disabled: !local || Boolean(busy), onClick: () => mutate("recover", "recovered") }, t("recover"))
          ),
          status?.connection && h(
            React.Fragment,
            null,
            !status.connected && h("p", { className: "mvAlert", role: "alert" }, t("retained")),
            h(
              "dl",
              null,
              h("dt", null, t("provider")),
              h("dd", null, status.connection.providerId),
              h("dt", null, t("baseURL")),
              h("dd", null, status.connection.baseURL),
              h("dt", null, t("protocol")),
              h("dd", null, status.connection.protocol),
              h("dt", null, t("modelCount")),
              h("dd", null, status.connection.modelCount),
              status.connection.connectedAt != null && h(React.Fragment, null, h("dt", null, t("connectedAt")), h(
                "dd",
                null,
                Number.isFinite(new Date(status.connection.connectedAt).getTime()) ? new Date(status.connection.connectedAt).toLocaleString() : "\u2014"
              ))
            ),
            h("p", { className: "mvHint" }, t("reconnectHint")),
            h(
              "div",
              { className: "mvActions" },
              h("button", { type: "button", disabled: !status.connected || Boolean(busy), onClick: refreshCatalog }, t("catalog")),
              dashboard && h("a", { className: "mvDashboard", href: dashboard, target: "_blank", rel: "noopener noreferrer" }, t("dashboard")),
              h("button", { type: "button", disabled: !writable, onClick: () => setConfirmDisconnect(true) }, t("disconnect"))
            ),
            confirmDisconnect && h(
              "div",
              { className: "mvAlert" },
              h("p", null, t("disconnectConfirm")),
              h("label", { className: "mvCheck" }, h("input", { name: "removeCredential", type: "checkbox", checked: removeCredential, onChange: (event) => setRemoveCredential(event.target.checked) }), t("deleteCredential")),
              h(
                "div",
                { className: "mvActions" },
                h("button", { type: "button", disabled: !writable, onClick: () => mutate("disconnect", "removed") }, t("confirmDisconnect")),
                h("button", { type: "button", disabled: Boolean(busy), onClick: () => setConfirmDisconnect(false) }, t("cancel"))
              )
            )
          ),
          Array.isArray(status?.retainedCredentialRefs) && status.retainedCredentialRefs.length > 0 && h(
            "details",
            { className: "mvAlert" },
            h("summary", null, t("retainedKeys")),
            h("ul", null, status.retainedCredentialRefs.filter((ref) => typeof ref === "string" && /^MULTIVIBE_DSH_[A-F0-9]{32}$/.test(ref)).map((ref) => h("li", { key: ref }, h("code", null, ref))))
          ),
          status && !status.connection && h(
            "form",
            { onSubmit: connect },
            h(
              "fieldset",
              { disabled: !writable },
              h(
                "div",
                { className: "mvFields" },
                field("baseURL", { name: "baseURL", type: "url", required: true, value: baseURL, autoComplete: "off", spellCheck: false, onChange: (event) => {
                  setBaseURL(event.target.value);
                  invalidateCatalog();
                } }),
                field("provider", { name: "providerId", value: providerId, required: true, maxLength: 64, autoComplete: "off", spellCheck: false, onChange: (event) => {
                  setProviderId(event.target.value);
                  setError("");
                } }),
                h("label", null, t("namespace"), h(
                  "select",
                  { name: "settingsNs", required: true, value: settingsNs, onChange: (event) => setSettingsNs(event.target.value) },
                  h("option", { value: "" }, t("chooseNamespace")),
                  status.providers.map((provider) => h("option", { key: provider.settingsNs, value: provider.settingsNs }, provider.displayName || provider.settingsNs))
                )),
                h("label", null, t("protocol"), h(
                  "select",
                  { name: "protocol", value: protocol, onChange: (event) => {
                    setProtocol(event.target.value);
                    setError("");
                  } },
                  h("option", { value: "openai-completions" }, "OpenAI Chat Completions"),
                  h("option", { value: "openai-responses" }, "OpenAI Responses")
                )),
                field("apiKey", { name: "apiKey", type: "password", ref: attachKey, autoComplete: "off", spellCheck: false, "aria-describedby": "mvDshKeyHint", onChange: (event) => {
                  setHasKey(Boolean(event.target.value.trim()));
                  invalidateCatalog();
                } })
              ),
              h("p", { id: "mvDshKeyHint", className: "mvHint" }, t("keyHint")),
              h(
                "div",
                { className: "mvActions" },
                h("button", { type: "button", disabled: !hasKey, onClick: () => {
                  clearKey();
                  invalidateCatalog();
                } }, t("clearKey")),
                h("button", { type: "button", disabled: !hasKey || !baseURL, onClick: discover }, t("discover"))
              ),
              !discovered && h("p", { className: "mvHint" }, t("discoverHint")),
              discovered && h("p", { className: "mvHint" }, t("capacityHint")),
              h("button", { className: "mvPrimary", type: "submit", disabled: !discovered || !hasKey || !selectedIds.length || !settingsNs }, t("connect"))
            )
          ),
          (discovered || status?.connected && models.length > 0) && h(
            "div",
            { className: "mvModels" },
            h("h3", null, t("models"), !status?.connected && ` \xB7 ${selectedIds.length}/${MAX_SELECTED} ${t("selected")}`),
            !models.length && h("p", { role: "status" }, t("empty")),
            !status?.connected && selectedIds.length >= MAX_SELECTED && h("p", { role: "status" }, t("selectionLimit")),
            h("div", { className: "mvModelList" }, visibleModels.map((model) => {
              const selected = selectedIds.includes(model.id);
              const capacity = capacities[model.id] || { contextWindow: "", maxTokens: "" };
              return h(
                "div",
                { className: "mvModel", key: model.id },
                status?.connected ? h("strong", null, model.name) : h(
                  "label",
                  { className: "mvCheck" },
                  h("input", { type: "checkbox", checked: selected, disabled: !writable || !selected && selectedIds.length >= MAX_SELECTED, onChange: (event) => selectModel(model.id, event.target.checked) }),
                  h("strong", null, model.name)
                ),
                h("div", null, h("code", null, model.id)),
                model.inputModalities.length > 0 && h("small", null, model.inputModalities.join(", ")),
                status?.connected ? h("p", { className: "mvHint" }, `${t("context")}: ${model.contextWindow ?? "\u2014"} \xB7 ${t("output")}: ${model.maxTokens ?? "\u2014"}`) : selected && h(
                  "fieldset",
                  { className: "mvCapacity", disabled: !writable },
                  ["contextWindow", "maxTokens"].map((key) => field(key === "contextWindow" ? "context" : "output", {
                    name: `${key}:${model.id}`,
                    type: "number",
                    min: 1,
                    step: 1,
                    value: capacity[key],
                    required: true,
                    onChange: (event) => {
                      const value = event.target.value;
                      setCapacities((previous) => ({ ...previous, [model.id]: { ...previous[model.id], [key]: value } }));
                      setError("");
                    }
                  }))
                )
              );
            })),
            models.length > PAGE_SIZE && h(
              "nav",
              { className: "mvActions", "aria-label": t("models") },
              h("button", { type: "button", disabled: Boolean(busy) || page === 0, onClick: () => setPage((value) => value - 1) }, t("previous")),
              h("span", null, `${t("page")} ${page + 1}/${pageCount}`),
              h("button", { type: "button", disabled: Boolean(busy) || page + 1 >= pageCount, onClick: () => setPage((value) => value + 1) }, t("next"))
            )
          ),
          busy && h("p", { role: "status" }, t(busy === "status" ? "loading" : "working")),
          note && h("p", { role: "status" }, t(note)),
          error && h("p", { className: "mvError", role: "alert" }, t(error))
        );
      }
      return {
        inject: ["slots", "locale"],
        apply(ctx) {
          const fallback = (key) => {
            const language = String(document.documentElement?.lang || navigator.language || "en").toLowerCase().startsWith("fr") ? "fr" : "en";
            return messages[language][key] || messages.en.UNAVAILABLE;
          };
          if (ctx.locale?.register) ctx.effect(() => ctx.locale.register(NS, messages), "multivibe locale");
          const bound = ctx.locale?.bind?.(NS);
          const t = (key) => {
            const value = bound?.(key);
            return typeof value === "string" && value !== key && value !== `${NS}.${key}` ? value : fallback(key);
          };
          ctx.effect(() => {
            const style = document.createElement("style");
            style.dataset.pluginCss = "dsh-multivibe";
            style.textContent = css;
            document.head.appendChild(style);
            return () => style.remove();
          }, "multivibe styles");
          ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register({
            name: "settings.plugins.tab",
            id: "multivibe",
            label: () => t("title"),
            ...ctx.locale ? { locale: NS } : {},
            inject: () => ({ t, callApi })
          }, MultivibePanel));
        }
      };
    }
  });
})();
