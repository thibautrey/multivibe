#!/usr/bin/env python3
"""Run native model acceptance with disposable DerivedData and explicit live-download opt-in."""
import argparse
import datetime
import pathlib
import plistlib
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--destination', required=True, help='xcodebuild destination')
parser.add_argument('--team', help='Development team for physical-device signing')
parser.add_argument('--live', action='store_true', help='Download actual model weights and run native inference')
parser.add_argument('--ui', action='store_true', help='Include the marketplace screenshot test')
args = parser.parse_args()
root = pathlib.Path(__file__).resolve().parents[1]
repo = root.parents[1]
output = root / '.build' / 'validation' / datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
output.mkdir(parents=True)
print(output, flush=True)
with tempfile.TemporaryDirectory(prefix='MULTIVIBE-54-derived-', dir='/tmp') as derived:
    build = ['xcodebuild', '-project', str(root / 'MultiVibeChat.xcodeproj'), '-scheme', 'MultiVibeChat',
             '-destination', args.destination, '-derivedDataPath', derived,
             '-clonedSourcePackagesDirPath', str(repo / '.build' / 'ios-packages')]
    build += ['DEVELOPMENT_TEAM=' + args.team, '-allowProvisioningUpdates'] if args.team else ['CODE_SIGNING_ALLOWED=NO']
    with (output / 'build.log').open('w') as log:
        subprocess.run(build + ['build-for-testing'], stdout=log, stderr=subprocess.STDOUT, check=True)
    testfile = next(pathlib.Path(derived).glob('Build/Products/*.xctestrun'))
    run = plistlib.loads(testfile.read_bytes())
    def configure(value):
        if isinstance(value, dict):
            if 'TestBundlePath' in value and args.live:
                for key in ['EnvironmentVariables', 'TestingEnvironmentVariables']:
                    value.setdefault(key, {})['MULTIVIBE_LOCAL_DEVICE_TEST'] = '1'
            for child in list(value.values()):
                configure(child)
        elif isinstance(value, list):
            for child in value:
                configure(child)
    configure(run)
    testfile.write_bytes(plistlib.dumps(run))
    test = ['xcodebuild', 'test-without-building', '-xctestrun', str(testfile), '-destination', args.destination,
            '-resultBundlePath', str(output / 'Tests.xcresult'),
            '-only-testing:MultiVibeChatTests/DownloadedModelDeviceTests' if args.live else '-only-testing:MultiVibeChatTests']
    if args.ui:
        test.append('-only-testing:MultiVibeChatUITests/DownloadedMarketplaceUITests')
    with (output / 'test.log').open('w') as log:
        subprocess.run(test, stdout=log, stderr=subprocess.STDOUT, check=True)
