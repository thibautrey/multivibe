"""Compile/run the native journal checks with system Swift, without project dependencies."""
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parent
with tempfile.TemporaryDirectory(prefix='hermes-checkpoint-tests-') as temporary:
    binary = str(Path(temporary) / 'checks')
    subprocess.run(['swiftc', '-swift-version', '6', '-parse-as-library',
                    str(root.parent / 'MultiVibeChat/Core/HermesCheckpointStore.swift'),
                    str(root / 'checkpoint-store.test.swift'), '-o', binary], check=True)
    subprocess.run([binary], check=True)
