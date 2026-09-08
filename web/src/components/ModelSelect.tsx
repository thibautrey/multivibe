import { useEffect, useState } from "react";
import { api } from "../lib/api";

export type ConfiguredPluginModel = { id: string; metadata?: { provider?: string } };
export const listPluginModels = () => api("/admin/modules/models").then((result): ConfiguredPluginModel[] => result.models);

/** Public dashboard component; uses the instance catalog and admin session. */
export function ModelSelect({ id, value, onChange, disabled = false }: {
  id: string; value: string; onChange: (model: string) => void; disabled?: boolean;
}) {
  const [models, setModels] = useState<ConfiguredPluginModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    listPluginModels().then((items) => { if (active) setModels(items); })
      .catch(() => { if (active) setError("Could not load configured models. Reopen settings to retry."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  return <><select id={id} value={value} disabled={disabled || loading || Boolean(error)} onChange={(event) => onChange(event.target.value)}>
    <option value="">{loading ? "Loading models…" : "No model selected"}</option>
    {value && !models.some((model) => model.id === value) && <option value={value}>{value} (unavailable)</option>}
    {models.map((model) => <option key={model.id} value={model.id}>{model.id}{model.metadata?.provider ? ` · ${model.metadata.provider}` : ""}</option>)}
  </select>{error && <span role="alert">{error}</span>}</>;
}
