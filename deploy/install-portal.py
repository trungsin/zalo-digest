"""Install the reviewed portal service and append its route to the existing tunnel."""
from pathlib import Path
import datetime
import shutil
import subprocess

repo = Path('/home/leesun/zalo-digest')
config = Path('/etc/cloudflared/config.yml')
original = config.read_text()
hostname = 'zalo.datxanhmientrung.ai'
if hostname not in original:
    marker = '  - service: http_status:404'
    if original.count(marker) != 1:
        raise SystemExit('Unexpected tunnel config; no changes applied')
    backup = config.with_name('config.yml.bak.zalo-portal-' + datetime.datetime.now().strftime('%Y%m%d%H%M%S'))
    shutil.copy2(config, backup)
    route = f'  - hostname: {hostname}\n    service: http://127.0.0.1:3080\n'
    config.write_text(original.replace(marker, route + marker))
    result = subprocess.run(['/usr/local/bin/cloudflared', '--config', str(config), 'tunnel', 'ingress', 'validate'])
    if result.returncode:
        shutil.copy2(backup, config)
        raise SystemExit('Tunnel validation failed; original config restored')
service = Path('/etc/systemd/system/zalo-portal.service')
shutil.copyfile(repo / 'deploy/zalo-portal.service', service)
service.chmod(0o644)
subprocess.run(['systemctl', 'daemon-reload'], check=True)
subprocess.run(['systemctl', 'enable', '--now', 'zalo-portal.service'], check=True)
subprocess.run(['systemctl', 'restart', 'cloudflared.service'], check=True)
subprocess.run(['systemctl', 'is-active', 'zalo-portal.service', 'cloudflared.service', 'zalo-digest@leesun.service'], check=True)
