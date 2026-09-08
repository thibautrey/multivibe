#!/usr/bin/env python3
"""Read-only Host/Cloud runtime audit. Never retrieves raw keys or peppers."""
from __future__ import annotations

import argparse
import json
import re
import secrets
import subprocess
import sys
from datetime import datetime, timezone

WORKLOADS = ('multivibe-cloud-api', 'multivibe-cloud-identity', 'multivibe-billing-live')
NAMESPACE = 'multivibe-cloud'


class AuditError(Exception):
    pass


def kubectl(*args: str) -> str:
    try:
        result = subprocess.run(['kubectl', '--request-timeout=15s', '-n', NAMESPACE, *args],
                                capture_output=True, text=True, timeout=25)
    except (OSError, subprocess.TimeoutExpired):
        raise AuditError('Kubernetes request unavailable or timed out') from None
    if result.returncode:
        # Exec failures may include application stdout or environment diagnostics.
        raise AuditError('Kubernetes request failed; raw output withheld')
    return result.stdout


def digest_value(value: str) -> str:
    if not re.fullmatch('[0-9a-f]{64}', value):
        raise AuditError('Runtime comparison failed; raw output withheld')
    return value


def comparison_groups(values: dict[str, str]) -> list[list[str]]:
    groups: dict[str, list[str]] = {}
    for name, value in values.items():
        groups.setdefault(digest_value(value), []).append(name)
    return list(groups.values())


def pepper_code(nonce: str) -> str:
    return ('const c=require("node:crypto");const p=process.env.SERVICE_KEY_HASH_PEPPER;'
            'if(!p)process.exit(2);process.stdout.write(c.createHmac("sha256",'
            + json.dumps(nonce) + ').update(p).digest("hex"));')


def database_code(nonce: str) -> str:
    return ('const {Pool}=require("pg"),c=require("node:crypto");'
            'const p=new Pool({connectionString:process.env.DATABASE_URL,max:1,'
            'options:"-c default_transaction_read_only=on -c statement_timeout=5000"});'
            '(async()=>{const r=await p.query("SELECT current_database() AS db,'
            'inet_server_addr()::text AS host,inet_server_port() AS port");'
            'process.stdout.write(c.createHmac("sha256",' + json.dumps(nonce)
            + ').update(JSON.stringify(r.rows)).digest("hex"));})()'
            '.catch(()=>{process.exitCode=1}).finally(()=>p.end());')


def key_state_code() -> str:
    # No key_digest, raw identity, project ID, email, financial amount or prompt selected.
    sql = '''SELECT k.key_prefix,k.scopes,k.created_at,k.expires_at,k.revoked_at,
       k.expires_at > now() AS unexpired,
       EXISTS(SELECT 1 FROM service_key_management_events e
              WHERE e.service_key_id=k.id AND e.action='created') AS creation_event_persisted,
       EXISTS(SELECT 1 FROM entitlement_versions e WHERE e.project_id=k.project_id) AS has_any_entitlement,
       EXISTS(SELECT 1 FROM entitlement_balances b WHERE b.project_id=k.project_id) AS has_any_balance
       FROM service_keys k ORDER BY k.created_at DESC LIMIT 5'''
    return ('const {Pool}=require("pg");const p=new Pool({connectionString:process.env.DATABASE_URL,max:1,'
            'options:"-c default_transaction_read_only=on -c statement_timeout=5000"});'
            '(async()=>{const r=await p.query(' + json.dumps(sql) + ');console.log(JSON.stringify(r.rows));})()'
            '.catch(()=>{process.exitCode=1}).finally(()=>p.end());')


def population_code() -> str:
    sql = """SELECT count(*)::int AS total_keys,
      count(*) FILTER(WHERE revoked_at IS NULL AND expires_at>now())::int AS active_keys,
      count(*) FILTER(WHERE NOT EXISTS(SELECT 1 FROM service_key_management_events e
        WHERE e.service_key_id=k.id AND e.action='created'))::int AS keys_without_creation_event,
      min(created_at) AS earliest_creation, max(created_at) AS latest_creation
      FROM service_keys k"""
    return ('const {Pool}=require("pg");const p=new Pool({connectionString:process.env.DATABASE_URL,max:1,'
            'options:"-c default_transaction_read_only=on -c statement_timeout=5000"});'
            '(async()=>{const r=await p.query(' + json.dumps(sql) + ');console.log(JSON.stringify(r.rows[0]));})()'
            '.catch(()=>{process.exitCode=1}).finally(()=>p.end());')


def drift_gate(report: dict) -> bool:
    # Agreement alone is insufficient when a workload or replica is missing/unready.
    return (report.get('allWorkloadsObserved') is True
            and report.get('allExpectedReplicasObserved') is True
            and report.get('allPepperValuesAligned') is True
            and report.get('apiIdentitySameDatabase') is True
            and bool(report.get('pods'))
            and all(p.get('ready') is True for p in report['pods']))


def collect() -> dict:
    nonce = secrets.token_hex(32)
    report = {'checkedAt': datetime.now(timezone.utc).isoformat(), 'namespace': NAMESPACE,
              'readOnly': True, 'deployments': [], 'pods': [], 'specificUserKeyMatched': False}
    for name in WORKLOADS:
        deployment = json.loads(kubectl('get', 'deployment', name, '-o', 'json'))
        annotations = deployment['metadata'].get('annotations', {})
        containers = deployment['spec']['template']['spec']['containers']
        source = annotations.get('multivibe.cloud/cloud-source-sha')
        report['deployments'].append({
            'name': name, 'expectedReplicas': deployment['spec'].get('replicas', 1), 'revision': annotations.get('deployment.kubernetes.io/revision'),
            'sourceCommit': source if source and re.fullmatch('[0-9a-f]{40}', source) else None,
            'images': [c['image'] for c in containers],
            'pepperSecretRefs': [e.get('valueFrom', {}).get('secretKeyRef') for c in containers
                                 for e in c.get('env', []) if e['name'] == 'SERVICE_KEY_HASH_PEPPER'],
        })
    pods = json.loads(kubectl('get', 'pods', '-o', 'json'))['items']
    digests = {}
    for pod in pods:
        name = pod['metadata']['name']
        if not any(name.startswith(workload + '-') for workload in WORKLOADS):
            continue
        statuses = pod['status'].get('containerStatuses', [])
        report['pods'].append({'name': name, 'ready': bool(statuses) and all(c.get('ready') for c in statuses),
                               'startedAt': pod['status'].get('startTime'), 'imageIds': [c.get('imageID') for c in statuses]})
        digests[name] = kubectl('exec', name, '--', 'node', '-e', pepper_code(nonce)).strip()
    report['equalPepperGroups'] = comparison_groups(digests)
    report['allWorkloadsObserved'] = all(any(name.startswith(workload + '-') for name in digests) for workload in WORKLOADS)
    report['allExpectedReplicasObserved'] = all(sum(name.startswith(d['name'] + '-') for name in digests) == d['expectedReplicas'] and d['expectedReplicas'] > 0 for d in report['deployments'])
    report['allPepperValuesAligned'] = len(report['equalPepperGroups']) == 1 and report['allWorkloadsObserved']
    db_values = [digest_value(kubectl('exec', 'deployment/' + name, '--', 'node', '-e', database_code(nonce)).strip())
                 for name in WORKLOADS[:2]]
    report['apiIdentitySameDatabase'] = len(set(db_values)) == 1
    # Emit only known booleans, never arbitrary environment contents.
    flags_code = 'console.log(JSON.stringify(Object.fromEntries(["MANAGED_LIVE_INFERENCE_ENABLED","MONETARY_EFFECTS_ENABLED","MARKETPLACE_ROUTING_ENABLED"].map(k=>[k,process.env[k]==="true"]))));'
    report['apiFlags'] = json.loads(kubectl('exec', 'deployment/multivibe-cloud-api', '--', 'node', '-e', flags_code))
    report['recentKeyStates'] = json.loads(kubectl('exec', 'deployment/multivibe-cloud-api', '--', 'node', '-e', key_state_code()))
    report['keyPopulation'] = json.loads(kubectl('exec', 'deployment/multivibe-cloud-api', '--', 'node', '-e', population_code()))
    report['recentQueryCoversAllKeys'] = report['keyPopulation']['total_keys'] == len(report['recentKeyStates'])
    report['driftGatePassed'] = drift_gate(report)
    report['realInferenceAttempted'] = False
    report['rawKeyUsed'] = False
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--require-aligned', action='store_true', help='exit 1 for unequal live peppers or databases')
    args = parser.parse_args()
    try:
        report = collect()
    except (AuditError, ValueError, KeyError, TypeError) as error:
        print(json.dumps({'auditComplete': False, 'error': str(error) if isinstance(error, AuditError)
                          else 'Invalid audit response; raw output withheld'}))
        return 2
    print(json.dumps(report, indent=2))
    return int(args.require_aligned and not report['driftGatePassed'])


if __name__ == '__main__':
    sys.exit(main())
