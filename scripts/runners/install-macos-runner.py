#!/usr/bin/env python3
"""Install a native, unprivileged MultiVibe runner service (invoke with administrator privileges)."""
import argparse, grp, hashlib, os, pathlib, plistlib, platform, pwd, subprocess, tarfile

p = argparse.ArgumentParser()
p.add_argument('--account', required=True)
p.add_argument('--architecture', choices=['arm64', 'x64'], required=True)
p.add_argument('--archive', type=pathlib.Path, required=True)
p.add_argument('--token-file', type=pathlib.Path, required=True)
a = p.parse_args()
if os.geteuid() != 0: raise SystemExit('Administrator authentication is required.')
if platform.system() != 'Darwin' or platform.machine() != {'arm64':'arm64','x64':'x86_64'}[a.architecture]: raise SystemExit('Host architecture does not match runner archive.')
user = pwd.getpwnam(a.account)
if user.pw_uid < 500: raise SystemExit('A normal non-root account is required.')
checksums = {'arm64':'5a2cd92908a93d7276a194e1de6008099f3e7946f3f8e14aa7a1a7b4a31fdec2', 'x64':'d383f505d7ed041b1873ab68c35dd766fc093f2252330f95bb427be8f2c6dcfc'}
if hashlib.sha256(a.archive.read_bytes()).hexdigest() != checksums[a.architecture]: raise SystemExit('Runner archive checksum mismatch.')
label = 'multivibe-macos-' + ('arm64' if a.architecture == 'arm64' else 'amd64')
root = pathlib.Path(user.pw_dir) / ('actions-runner-' + label)
service = 'solutions.pleiades.github-runner.' + label
plist = pathlib.Path('/Library/LaunchDaemons') / (service + '.plist')
if root.exists() or plist.exists(): raise SystemExit('Runner directory or service already exists; refusing to overwrite.')
root.mkdir(mode=0o700)
with tarfile.open(a.archive) as archive:
    for member in archive.getmembers():
        if member.name.startswith('/') or '..' in pathlib.PurePosixPath(member.name).parts: raise SystemExit('Invalid archive path.')
    archive.extractall(root)
for directory, dirs, files in os.walk(root):
    os.chown(directory,user.pw_uid,user.pw_gid)
    for name in files: os.chown(os.path.join(directory,name),user.pw_uid,user.pw_gid,follow_symlinks=False)
env = dict(os.environ)
env['PATH'] = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
env['ACTIONS_RUNNER_INPUT_TOKEN'] = a.token_file.read_text().strip()
try:
    subprocess.run(['/usr/bin/sudo','-H','-u',a.account,'--preserve-env=ACTIONS_RUNNER_INPUT_TOKEN,PATH',str(root/'config.sh'),
      '--unattended','--url','https://github.com/thibautrey/multivibe','--name',label,'--labels',label,'--work','_work'],cwd=root,env=env,check=True)
finally:
    env.pop('ACTIONS_RUNNER_INPUT_TOKEN',None)
    a.token_file.unlink(missing_ok=True)
# The service runs as this account, never as root. No login session or expanded SSH command access is needed.
log = root / '_diag/service.log'
configuration = {'Label':service,'UserName':a.account,'GroupName':grp.getgrgid(user.pw_gid).gr_name,
 'ProgramArguments':['/bin/bash',str(root/'bin/runsvc.sh')], 'WorkingDirectory':str(root),
 'RunAtLoad':True,'KeepAlive':True,'ThrottleInterval':15,
 'EnvironmentVariables':{'HOME':user.pw_dir,'PATH':'/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'},
 'StandardOutPath':str(log),'StandardErrorPath':str(log)}
plist.write_bytes(plistlib.dumps(configuration));plist.chmod(0o644)
subprocess.run(['/bin/launchctl','bootstrap','system',str(plist)],check=True)
print('Installed '+label+' as '+a.account)
