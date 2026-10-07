import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
const helper = fileURLToPath(new URL('./release-docker.sh', import.meta.url));

test('release Docker access uses the same isolated config for direct and sudo commands, and fails closed', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'release-docker-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'docker'), '#!/bin/bash\nif [[ "$1" == info ]]; then exit "$DIRECT_STATUS"; fi\nprintf "direct:%s:%s" "$DOCKER_CONFIG" "$*"\n', { mode: 0o755 });
  await writeFile(path.join(root, 'sudo'), '#!/bin/bash\n[[ "$1" == -n && "$2" == --preserve-env=DOCKER_CONFIG && "$3" == docker ]] || exit 99\nshift 3\nif [[ "$1" == info ]]; then exit "$SUDO_STATUS"; fi\nprintf "sudo:%s:%s" "$DOCKER_CONFIG" "$*"\n', { mode: 0o755 });
  for (const [direct, sudo, context] of [['0', '1', 'direct'], ['1', '0', 'sudo'], ['1', '1', null]]) {
    const result = spawnSync('bash', ['-c', 'source "$1" && docker build "argument with spaces"', '_', helper], {
      encoding: 'utf8', env: { ...process.env, PATH: `${root}:${process.env.PATH}`, RUNNER_TEMP: root, DIRECT_STATUS: direct, SUDO_STATUS: sudo },
    });
    if (context) {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, `${context}:${root}/multivibe-release-docker-config:build argument with spaces`);
    } else {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Docker daemon is inaccessible/u);
      assert.equal(result.stdout, '');
    }
  }
});
