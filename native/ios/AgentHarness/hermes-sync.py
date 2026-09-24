#!/usr/bin/env python3
"""Extract upstream contracts without importing/executing Hermes server code.
Use --update <full commit SHA> to download a reviewed version, or --check in CI.
"""
import ast, hashlib, json, pathlib, re, sys, urllib.request
root = pathlib.Path(__file__).resolve().parent
vendor = root / 'upstream/hermes'
files = {'tools_clarify_tool.py': 'CLARIFY_SCHEMA', 'tools_session_search_tool.py': 'SESSION_SEARCH_SCHEMA', 'tools_web_tools.py': 'WEB_EXTRACT_SCHEMA'}
manifest = vendor / 'manifest.json'
if '--update' in sys.argv:
    sha = sys.argv[sys.argv.index('--update') + 1]
    if not re.fullmatch(r'[0-9a-f]{40}', sha): raise SystemExit('Use a full reviewed commit SHA')
    downloads = {name: urllib.request.urlopen(f'https://raw.githubusercontent.com/NousResearch/hermes-agent/{sha}/{name.replace("tools_", "tools/", 1) if name != "LICENSE" else name}', timeout=30).read() for name in [*files, 'LICENSE']}
    for name, content in downloads.items(): (vendor / name).write_bytes(content)
    manifest.write_text(json.dumps({'repository': 'https://github.com/NousResearch/hermes-agent', 'commit': sha, 'sha256': {name: hashlib.sha256(content).hexdigest() for name, content in downloads.items()}}, indent=2) + '\n')
info = json.loads(manifest.read_text())
for name, digest in info['sha256'].items():
    if hashlib.sha256((vendor / name).read_bytes()).hexdigest() != digest: raise SystemExit('Snapshot integrity failure: ' + name)
def evaluate(node, constants):
    if isinstance(node, ast.Name): return constants[node.id]
    if isinstance(node, ast.Constant): return node.value
    if isinstance(node, ast.Dict): return {evaluate(k, constants): evaluate(v, constants) for k, v in zip(node.keys, node.values)}
    if isinstance(node, (ast.List, ast.Tuple)): return [evaluate(x, constants) for x in node.elts]
    if isinstance(node, ast.JoinedStr): return ''.join(str(evaluate(x, constants)) for x in node.values)
    if isinstance(node, ast.FormattedValue): return evaluate(node.value, constants)
    raise ValueError('Unsupported schema expression: ' + ast.dump(node))
contracts = {}
for filename, symbol in files.items():
    constants = {}
    for node in ast.parse((vendor / filename).read_text()).body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            name = node.targets[0].id
            if name in ('MAX_QUESTIONS', 'MAX_CHOICES', symbol): constants[name] = evaluate(node.value, constants)
    contracts[constants[symbol]['name']] = constants[symbol]
output = json.dumps(contracts, ensure_ascii=False, indent=2) + '\n'
target = root / 'hermes-contracts.json'
if '--check' in sys.argv:
    if target.read_text() != output: raise SystemExit('Stale contracts: run python3 hermes-sync.py')
else: target.write_text(output)
print('Hermes contracts verified at ' + info['commit'])
