#!/usr/bin/env python3
"""Measure real llama.cpp prefill reuse without printing or generating private prompt text."""
import argparse
import json
import time
import urllib.request
from pathlib import Path


def request(base, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(base.rstrip('/') + path, data=data,
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=600) as response:
        return json.load(response)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', required=True, help='Authorized llama.cpp endpoint')
    parser.add_argument('--tokens', required=True, type=Path, help='JSON array of real token IDs; kept private')
    parser.add_argument('--changed-tokens', type=Path, help='Optional second real prompt with a different suffix')
    parser.add_argument('--output', required=True, type=Path, help='Metrics only; contains no prompt/output text')
    args = parser.parse_args()
    first = json.loads(args.tokens.read_text())
    second = json.loads(args.changed_tokens.read_text()) if args.changed_tokens else first
    for tokens in [first, second]:
        if not isinstance(tokens, list) or not tokens or not all(isinstance(x, int) and x >= 0 for x in tokens):
            parser.error('tokens must be a nonempty array of nonnegative token IDs (text-only)')
    prefix = next((i for i, (a, b) in enumerate(zip(first, second)) if a != b), min(len(first), len(second)))
    results = {'common_prefix_tokens': prefix, 'runs': []}
    for label, tokens in [('first', first), ('changed', second), ('repeat', second)]:
        if any(slot['is_processing'] for slot in request(args.url, '/slots')):
            raise SystemExit('Server busy; no request submitted. Retry in an idle maintenance window.')
        started = time.monotonic()
        response = request(args.url, '/completion', {
            'prompt': tokens, 'n_predict': 1, 'cache_prompt': True, 'temperature': 0, 'seed': 42,
        })
        timings = response.get('timings', {})
        # tokens_cached is final slot size, NOT cache hit count. timings.cache_n is reuse.
        row = {'case': label, 'total_prompt_tokens': len(tokens),
               'elapsed_seconds': round(time.monotonic() - started, 3),
               'reused_tokens': timings.get('cache_n'), 'evaluated_tokens': timings.get('prompt_n'),
               'prefill_ms': timings.get('prompt_ms')}
        results['runs'].append(row)
        args.output.write_text(json.dumps(results, indent=2) + '\n')
        print(json.dumps(row), flush=True)


if __name__ == '__main__':
    main()
