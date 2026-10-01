"""Run actual vendored Hermes pure helpers without importing its server dependencies."""
import ast
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

root = Path(__file__).parent / 'upstream/hermes-loop/agent'
source = ast.parse((root / 'message_sanitization.py').read_text())
names = {'_tc_field', '_tc_set', 'coalesce_tool_call_id', 'uniquify_tool_call_ids', 'normalize_finish_reason'}
selected = [node for node in source.body if isinstance(node, ast.FunctionDef) and node.name in names]
namespace = {'Any': Any, 'logger': SimpleNamespace(warning=lambda *args: None), '_FINISH_REASON_ALIASES': {'max_tokens': 'length', 'end': 'stop', 'function_call': 'tool_calls'}}
exec(compile(ast.Module(body=selected, type_ignores=[]), '<pinned-hermes-helpers>', 'exec'), namespace)
cases = [['a', 'a', 'a_d2', 'a'], ['call_x|item_1', 'call_x|item_2'], ['b', 'c', 'b']]
output = []
for ids in cases:
    calls = [{'id': item, 'function': {'name': 'read'}} for item in ids]
    namespace['uniquify_tool_call_ids'](calls)
    output.append({'ids': ids, 'expected': [namespace['coalesce_tool_call_id'](call) for call in calls]})
print(json.dumps(output))
