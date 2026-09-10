import React, {useEffect,useState} from 'react';
import {api} from '../lib/api';
export function TeamMachineCard(){
 const [state,setState]=useState<any>(null);const [error,setError]=useState('');
 async function refresh(){try{setState(await api('/admin/team-machine'));}catch{setState(null);}}
 useEffect(()=>{void refresh();const timer=setInterval(()=>void refresh(),15000);return()=>clearInterval(timer);},[]);
 if(!state?.sharing)return null;
 return <article className="panel"><h3>Partage Team</h3><p>{state.sharing.runtimeId} · {state.sharing.transport==='private_network'?'Réseau privé':'Relais Cloud'}</p><p>{state.sharing.models.join(', ')}</p><p>Autorisation valable jusqu’au {new Date(state.sharing.expiresAt).toLocaleString()}.</p><button className="btn secondary" onClick={async()=>{try{await api('/admin/team-machine/stop',{method:'POST'});await refresh();}catch{setError('Impossible d’arrêter le partage.');}}}>Arrêter le partage sur cette machine</button>{error&&<p role="alert">{error}</p>}</article>;
}
