#!/usr/bin/env python3
"""Read quota metadata only. Never starts an inference turn. Python 3.9+."""
import argparse
import datetime
import fcntl
import json
import os
from pathlib import Path
import queue
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.request

BASE = Path(__file__).resolve().parent
STATE = BASE / 'state'

class Failure(Exception):
    def __init__(self, code, retry_after=None):
        self.code, self.retry_after = code, retry_after

def load(path, default=None):
    try:
        return json.loads(Path(path).read_text())
    except (FileNotFoundError, ValueError):
        return default

def save(path, data):
    tmp = Path(str(path) + '.tmp')
    tmp.write_text(json.dumps(data, ensure_ascii=False))
    tmp.chmod(0o600)
    tmp.replace(path)

def http_json(url, token, method='GET', payload=None, extra=None):
    headers={'Authorization':'Bearer '+token, 'Accept':'application/json','User-Agent':'ai-usage-widget/1.0'}
    headers.update(extra or {})
    data=None
    if payload is not None:
        data=json.dumps(payload).encode()
        headers['Content-Type']='application/json'
    req=urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=25) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        if exc.code in (401,403): raise Failure('auth_required')
        if exc.code==429:
            retry=exc.headers.get('Retry-After','')
            raise Failure('rate_limited',int(retry) if retry.isdigit() else None)
        raise Failure('unavailable')
    except (TimeoutError, OSError): raise Failure('unavailable')

def codex_usage(config):
    command=config.get('codexCommand') or shutil.which('codex')
    if not command: raise Failure('not_installed')
    # Isolated app-server: stdio only, stderr discarded to avoid credential logging.
    proc=subprocess.Popen([command,'app-server'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True)
    incoming=queue.Queue()
    def pump():
        for line in proc.stdout:
            try: incoming.put(json.loads(line))
            except ValueError: pass
        incoming.put(None)
    threading.Thread(target=pump,daemon=True).start()
    def send(value):
        proc.stdin.write(json.dumps(value)+'\n'); proc.stdin.flush()
    def call(method,params,ident):
        send({'jsonrpc':'2.0','id':ident,'method':method,'params':params})
        deadline=time.monotonic()+35
        while time.monotonic()<deadline:
            try: msg=incoming.get(timeout=max(0.1,deadline-time.monotonic()))
            except queue.Empty: raise Failure('timeout')
            if msg is None: raise Failure('unavailable')
            if msg.get('id')==ident:
                if 'error' in msg: raise Failure('auth_required' if method.startswith('account/') else 'unavailable')
                return msg.get('result',{})
        raise Failure('timeout')
    try:
        call('initialize',{'clientInfo':{'name':'ai_usage_widget','version':'1.0.0'},'capabilities':{}},1)
        send({'jsonrpc':'2.0','method':'initialized','params':{}})
        result=call('account/rateLimits/read',{},2)
        buckets=result.get('rateLimitsByLimitId') or {'codex':result.get('rateLimits')}
        windows=[]
        for bucket_id,bucket in buckets.items():
            if not isinstance(bucket,dict): continue
            for key in ('primary','secondary'):
                w=bucket.get(key)
                if not isinstance(w,dict) or w.get('usedPercent') is None: continue
                minutes=w.get('windowDurationMins')
                label='5時間' if minutes==300 else '週間' if minutes==10080 else (str(minutes)+'分' if minutes else key)
                if bucket_id!='codex': label=str(bucket.get('limitName') or bucket_id)+' '+label
                windows.append({'id':str(bucket_id)+':'+key,'label':label,'usedPercent':float(w['usedPercent']),'resetsAt':w.get('resetsAt')})
        if not windows: raise Failure('invalid_response')
        return windows
    finally:
        proc.terminate()
        try: proc.wait(timeout=3)
        except subprocess.TimeoutExpired: proc.kill(); proc.wait()
        proc.stdin.close(); proc.stdout.close()

def epoch(value):
    if value is None: return None
    if isinstance(value,(int,float)): return int(value)
    return int(datetime.datetime.fromisoformat(value.replace('Z','+00:00')).timestamp())

def claude_usage(config):
    credential_path=Path(config.get('claudeCredentials',str(Path.home()/'.claude/.credentials.json')))
    credential=load(credential_path) or {}
    oauth=credential.get('claudeAiOauth',{})
    token=oauth.get('accessToken') or os.environ.get('CLAUDE_USAGE_ACCESS_TOKEN')
    if not token: raise Failure('auth_required')
    def refresh():
        nonlocal token,oauth
        # Enabled only for a dedicated login, never a shared everyday CLI profile.
        if not config.get('claudeDedicatedAuth') or not oauth.get('refreshToken'):
            raise Failure('auth_required')
        body=json.dumps({'grant_type':'refresh_token','refresh_token':oauth['refreshToken'],
                         'client_id':'9d1c250a-e61b-44d9-88ed-5944d1962f5e',
                         'scope':' '.join(oauth.get('scopes',[]))}).encode()
        request=urllib.request.Request('https://console.anthropic.com/v1/oauth/token',data=body,
                                       headers={'Content-Type':'application/json','Accept':'application/json','User-Agent':'ai-usage-widget/1.0'},method='POST')
        try:
            with urllib.request.urlopen(request,timeout=25) as response:
                result=json.load(response)
        except urllib.error.HTTPError as exc:
            raise Failure('auth_required' if exc.code in (400,401,403) else 'unavailable')
        except (OSError,ValueError): raise Failure('unavailable')
        if not result.get('access_token') or not isinstance(result.get('expires_in'),(int,float)):
            raise Failure('invalid_response')
        oauth={**oauth,'accessToken':result['access_token'],
               'refreshToken':result.get('refresh_token') or oauth['refreshToken'],
               'expiresAt':int(time.time()*1000+result['expires_in']*1000)}
        if result.get('scope'): oauth['scopes']=result['scope'].split()
        credential['claudeAiOauth']=oauth
        # Save the rotated refresh token before the next usage request.
        save(credential_path,credential)
        token=oauth['accessToken']
    if config.get('_refreshClaudeNow') or (oauth.get('expiresAt') and oauth['expiresAt']<time.time()*1000+60000):
        refresh()
    try:
        data=http_json('https://api.anthropic.com/api/oauth/usage',token,extra={'anthropic-beta':'oauth-2025-04-20','User-Agent':'ai-usage-widget/1.0'})
    except Failure as exc:
        if exc.code!='auth_required': raise
        refresh()
        data=http_json('https://api.anthropic.com/api/oauth/usage',token,extra={'anthropic-beta':'oauth-2025-04-20','User-Agent':'ai-usage-widget/1.0'})
    windows=[]
    for key,value in data.items():
        # Undocumented internal grant/codename; not a named subscription quota.
        if key=='iguana_necktie': continue
        if not isinstance(value,dict) or value.get('utilization') is None: continue
        label={'five_hour':'5時間','seven_day':'週間'}.get(key,key.replace('seven_day_','')+' 週間')
        windows.append({'id':key,'label':label,'usedPercent':float(value['utilization']),'resetsAt':epoch(value.get('resets_at'))})
    if not windows: raise Failure('invalid_response')
    return windows

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--dry-run',action='store_true',help='Collect locally without uploading')
    parser.add_argument('--force',action='store_true',help='Retry immediately after manual re-authentication')
    parser.add_argument('--refresh-claude',action='store_true',help='Verify dedicated Claude token refresh without inference')
    args=parser.parse_args()
    os.umask(0o077)
    STATE.mkdir(parents=True,exist_ok=True)
    lock=(STATE/'collector.lock').open('w')
    try: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError: return
    config=load(BASE/'config.json',{})
    if args.refresh_claude: config['_refreshClaudeNow']=True
    previous=load(STATE/'latest.json',{'schemaVersion':1,'services':{}})
    retries=load(STATE/'retry.json',{})
    services={}
    now=int(time.time())
    for name,collect in [('codex',codex_usage),('claude',claude_usage)]:
        old=previous['services'].get(name,{'fetchedAt':None,'windows':[]})
        if not args.force and retries.get(name,{}).get('nextAt',0)>now:
            services[name]=old
            continue
        try:
            windows=collect(config)
            for w in windows:
                if not 0<=w['usedPercent']<=100: raise Failure('invalid_response')
            services[name]={'status':'ok','fetchedAt':int(time.time()),'windows':windows,'errorCode':None}
            retries.pop(name,None)
        except Exception as exc:
            failure=exc if isinstance(exc,Failure) else Failure('unavailable')
            services[name]={**old,'status':'error','errorCode':failure.code}
            attempts=retries.get(name,{}).get('attempts',0)+1
            delay=min(3600,300*2**min(attempts-1,4))
            if failure.code in ('auth_required','not_installed'): delay=3600
            delay=max(delay,failure.retry_after or 0)
            retries[name]={'attempts':attempts,'nextAt':now+delay}
    payload={'schemaVersion':1,'services':services}
    save(STATE/'latest.json',payload)
    save(STATE/'retry.json',retries)
    # Only whitelisted status codes are logged; never raw provider responses.
    print(json.dumps({name:{'status':s['status'],'errorCode':s.get('errorCode'),'windows':len(s['windows'])} for name,s in services.items()}))
    if args.dry_run: return
    endpoint=config.get('endpoint','')
    token=config.get('writeKey','')
    if not endpoint.startswith('https://') or not token:
        print('Upload not configured'); return
    try: http_json(endpoint.rstrip('/')+'/v1/usage',token,'PUT',payload); print('Upload OK')
    except Failure as exc: print('Upload failed: '+exc.code); raise SystemExit(1)

if __name__=='__main__': main()
