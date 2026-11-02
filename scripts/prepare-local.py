#!/usr/bin/env python3
"""Prepare ignored local keys and deployment files; never prints key values."""
import hashlib
import json
import os
from pathlib import Path
import secrets

def main():
    os.umask(0o077)
    root=Path(__file__).resolve().parents[1]
    local=root/'.local'
    local.mkdir(mode=0o700,exist_ok=True)
    keys_path=local/'keys.json'
    if keys_path.exists():
        keys=json.loads(keys_path.read_text())
    else:
        keys={'readKey':secrets.token_urlsafe(32),'writeKey':secrets.token_urlsafe(32)}
        keys_path.write_text(json.dumps(keys))
        keys_path.chmod(0o600)
    source=(root/'cloudflare/worker.mjs').read_text()
    for name,placeholder in [('readKey','__READ_HASH__'),('writeKey','__WRITE_HASH__')]:
        source=source.replace(placeholder,hashlib.sha256(keys[name].encode()).hexdigest())
    (local/'worker.mjs').write_text(source)
    (local/'reader-key.txt').write_text(keys['readKey']+'\n')
    (local/'reader-key.txt').chmod(0o600)
    if not (local/'wrangler.jsonc').exists():
        (local/'wrangler.jsonc').write_text((root/'cloudflare/wrangler.example.jsonc').read_text())
    if not (local/'collector-config.json').exists():
        config=json.loads((root/'config.example.json').read_text())
        config['writeKey']=keys['writeKey']
        (local/'collector-config.json').write_text(json.dumps(config,indent=2))
        (local/'collector-config.json').chmod(0o600)
    print('Prepared .local/ files. Existing keys retained. No key values printed.')

if __name__=='__main__':
    main()
