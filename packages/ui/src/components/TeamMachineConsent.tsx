import { useDashboardApi, useDashboardRuntime } from "../adapter";
import React,{useEffect,useState} from 'react';

export function TeamMachineConsent(){
  const api = useDashboardApi();
  const { capabilities } = useDashboardRuntime();
 const [connection,setConnection]=useState<any>(null),[state,setState]=useState<any>(null),[error,setError]=useState('');
 async function refresh(){try{const [c,s]=await Promise.all([api('team-machine/connection'),api('team-machine')]);setConnection(c);setState(s);}catch{try{const local=await api('team-machine');setState(local);setConnection(local.consent);}catch{setConnection(null);}}}
 useEffect(()=>{if(!capabilities.teamMachine)return;void refresh();},[]);
 if(!connection)return null;
 return <section className="panel"><h3>Gestion de la machine par Team</h3><p>Autorisez les administrateurs de votre organisation à choisir un runtime local, les modèles partagés et les membres autorisés. Ils pourront activer le partage à distance. Vous pouvez arrêter le partage ou retirer cette autorisation ici.</p><button className="btn secondary" onClick={async()=>{try{await api('team-machine/consent',{method:state?.consent?'DELETE':'POST',body:state?.consent?undefined:JSON.stringify({authorizeRemoteManagement:true})});await refresh();}catch{setError('La modification de l’autorisation a échoué.');}}}>{state?.consent?'Retirer l’autorisation de gestion distante':'Autoriser la gestion distante par mon organisation'}</button>{error&&<p role="alert">{error}</p>}</section>;
}
