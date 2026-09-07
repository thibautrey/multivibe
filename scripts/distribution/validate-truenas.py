#!/usr/bin/env python3
"""Render against an externally supplied upstream library; no TrueNAS mutation.

Usage: python validate-truenas.py /path/to/library/2.3.11
Dependencies: jinja2, pyyaml, docker, bcrypt (install outside a source worktree).
"""
import copy
import importlib.util
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import jinja2

root = Path(__file__).resolve().parents[2]
app = root / 'packaging/truenas/multivibe-host'
library = Path(sys.argv[1]).resolve()
spec = importlib.util.spec_from_file_location('multivibe_ix_library', library / '__init__.py', submodule_search_locations=[str(library)])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
from importlib import import_module
render = import_module('multivibe_ix_library.render')
error = import_module('multivibe_ix_library.error').RenderError
values = json.loads((app / 'ix_values.yaml').read_text()) | json.loads((app / 'templates/test_values/basic-values.yaml').read_text())
values['ix_context'] = {'app_name': 'multivibe-host', 'is_install': True}
template = jinja2.Environment(extensions=['jinja2.ext.do'], undefined=jinja2.StrictUndefined).from_string((app / 'templates/docker-compose.yaml').read_text())

def evaluate(inputs):
    return json.loads(template.render(values=inputs, ix_lib=SimpleNamespace(base=SimpleNamespace(render=render))))

result = evaluate(values)
host = result['services']['multivibe-host']
assert host['read_only'] and host['init'] and not host['privileged']
assert host['platform'] == 'linux/amd64'
assert host['cap_drop'] == ['ALL']
assert set(host['cap_add']) == {'CHOWN', 'FOWNER', 'SETGID', 'SETUID'}
assert any('no-new-privileges' in opt for opt in host['security_opt'])
assert len(host['ports']) == 1 and host['ports'][0]['target'] == 1455
assert {v['target'] for v in host['volumes']} == {'/data', '/models'}
assert 'healthcheck' not in host  # Preserve the image's bundled-Node probe.
assert host['deploy']['resources']['reservations']['devices'][0]['driver'] == 'nvidia'
assert 'noexec' in host['tmpfs'][0]
for bad in ['gpu', 'storage']:
    inputs = copy.deepcopy(values)
    if bad == 'gpu':
        inputs['resources']['gpus'] = {}
    else:
        inputs['storage']['models_path'] = inputs['storage']['data_path']
    try:
        evaluate(inputs)
    except error:
        pass
    else:
        raise AssertionError(f'{bad} validation did not reject invalid inputs')
print('TrueNAS render, hardening, GPU selection and storage guards passed')
