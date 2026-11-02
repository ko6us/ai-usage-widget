// Scriptable: run once in the app to configure; then add a medium widget.
const KEY='ai-usage-widget-reader';
const ENDPOINT='https://ai-usage-widget.mq-gauss.workers.dev';
const fm=FileManager.local();
const cache=fm.joinPath(fm.documentsDirectory(),'ai-usage-widget-cache.json');
async function configureKey() {
  const a=new Alert();a.title='AI Usage 初期設定';
  a.message='読み取り専用キーを入力してください。Codex・Claudeのログイン情報は不要です。';
  a.addSecureTextField('読み取り専用キー');a.addAction('保存');a.addCancelAction('キャンセル');
  if(await a.presentAlert()===-1)return false;
  const value=a.textFieldValue(0).trim().replace(/^Bearer\s+/i,'');
  if(!/^[A-Za-z0-9_-]{43}$/.test(value)){
    const invalid=new Alert();invalid.title='キーの形式を確認';
    invalid.message='読み取りキーの43文字だけを貼り付けてください。説明文や見出しは含めません。';
    invalid.addAction('閉じる');await invalid.presentAlert();return false;
  }
  Keychain.set(KEY,value);
  return true;
}
if(!config.runsInWidget && !Keychain.contains(KEY)) {
  if(!await configureKey()){Script.complete();return;}
}
let data=null,offline=false,errorLabel='';
async function fetchUsage(){
  offline=false;errorLabel='';
  if(!Keychain.contains(KEY)){errorLabel='キー未設定';return;}
  if(!/^[A-Za-z0-9_-]{43}$/.test(Keychain.get(KEY).trim())){
    offline=true;errorLabel='キーの形式エラー';return;
  }
  let stage='通信',status=0;
  try {
    const req=new Request(ENDPOINT+'/v1/usage');req.timeoutInterval=25;
    req.headers={Authorization:'Bearer '+Keychain.get(KEY).trim(),'User-Agent':'ai-usage-widget/1.0',Accept:'application/json'};
    const raw=await req.loadString();
    status=Number(req.response?.statusCode||0);
    if(status!==200){
      errorLabel=status===401?'キー認証エラー (401)':status===403?'接続拒否 (403)':`HTTP ${status}`;
      throw Error('http');
    }
    stage='JSON形式';
    const result=JSON.parse(raw);
    stage='データ形式';
    if(result.schemaVersion!==1 || !result.services?.codex || !result.services?.claude)throw Error('schema');
    data=result;
    try{fm.writeString(cache,JSON.stringify(result));}catch{}
  }catch{
    offline=true;if(!errorLabel)errorLabel=stage+'エラー';
  }
}
await fetchUsage();
if(!config.runsInWidget && offline){
  const failure=new Alert();failure.title='使用量を取得できませんでした';
  failure.message=errorLabel+'\nキーはこの画面にもログにも表示していません。401はキー不一致、403はアクセス拒否、通信エラーは接続に失敗した状態です。';
  failure.addAction('再試行');failure.addAction('キーを入れ直す');failure.addCancelAction('閉じる');
  const choice=await failure.presentAlert();
  if(choice===0 || (choice===1 && await configureKey())){
    await fetchUsage();
    if(offline){const again=new Alert();again.title='取得結果';again.message=errorLabel;again.addAction('閉じる');await again.presentAlert();}
  }
}
if(!data && fm.fileExists(cache)){try{data=JSON.parse(fm.readString(cache));}catch{}}
const widget=new ListWidget();
widget.backgroundColor=new Color('#141c1b');widget.setPadding(0,0,0,0);
widget.refreshAfterDate=new Date(Date.now()+15*60*1000);
const now=Date.now()/1000;
function reset(at){
  if(!at)return 'リセット時刻なし';
  const mins=Math.ceil((at-now)/60);
  if(mins<=0)return 'リセット後・再取得待ち';
  if(mins>=1440)return `あと${Math.floor(mins/1440)}日${Math.floor(mins%1440/60)}時間`;
  if(mins<60)return `あと${mins}分`;
  return `あと${Math.floor(mins/60)}時間${mins%60}分`;
}
// Circle variant. Authentication, cache and refresh settings match AI Usage.
const canvas=new DrawContext();
canvas.size=new Size(338,158);canvas.respectScreenScale=true;canvas.opaque=true;
canvas.setFillColor(new Color('#141c1b'));canvas.fillRect(new Rect(0,0,338,158));
function text(x,y,value,size,color='#dce5e2',bold=false,width=146,height=22,align='left',mono=false){
  canvas.setFont(mono?Font.boldMonospacedSystemFont(size):bold?Font.boldSystemFont(size):Font.systemFont(size));
  canvas.setTextColor(new Color(color));
  if(align==='center')canvas.setTextAlignedCenter();
  else if(align==='right')canvas.setTextAlignedRight();else canvas.setTextAlignedLeft();
  canvas.drawTextInRect(String(value),new Rect(x,y,width,height));
}
function ring(cx,cy,remaining,color){
  const radius=27,stroke=4;
  canvas.setFillColor(new Color('#34403d'));
  canvas.fillEllipse(new Rect(cx-radius-stroke/2,cy-radius-stroke/2,2*radius+stroke,2*radius+stroke));
  canvas.setFillColor(new Color('#141c1b'));
  canvas.fillEllipse(new Rect(cx-radius+stroke/2,cy-radius+stroke/2,2*radius-stroke,2*radius-stroke));
  // Overlapping round dots form a smooth arc, starting at 12 o'clock clockwise.
  if(remaining<=0)return;
  canvas.setFillColor(new Color(color));
  const sweep=2*Math.PI*remaining/100;
  const steps=Math.max(1,Math.ceil(sweep*radius*2));
  for(let i=0;i<=steps;i++){
    const angle=-Math.PI/2+sweep*i/steps;
    canvas.fillEllipse(new Rect(cx+radius*Math.cos(angle)-stroke/2,cy+radius*Math.sin(angle)-stroke/2,stroke,stroke));
  }
}
canvas.setFillColor(new Color('#33413b'));canvas.fillRect(new Rect(168.5,14,0.5,129));
for(const [name,title,color,left] of [['codex','Codex','#78c6e0',11],['claude','Claude','#db9878',180]]){
  text(left,9,title,17,color,true);
  text(left+116,14,'残り',9,'#a6b2ad',false,30,15,'right');
  const service=data?.services?.[name];
  const visibleWindows=(service?.windows||[]).filter(w=>w.id!=='iguana_necktie');
  const stale=offline || service?.status!=='ok' || !service?.fetchedAt || now-service.fetchedAt>1200;
  if(!visibleWindows.length){
    text(left,57,'—',34,'#cdd6d2',true,146,43);
    text(left,111,errorLabel || (service?.errorCode==='auth_required'?'ログイン待ち':'取得待ち'),10,'#a6b2ad',false,146,28);
  }else{
    for(const [index,win] of visibleWindows.slice(0,2).entries()){
      const x=left+index*77,cx=x+34;
      text(x,34,win.label,10,'#a6b2ad',false,68,16,'center');
      const remaining=Math.max(0,Math.min(100,100-win.usedPercent));
      ring(cx,81,remaining,stale?'#687b73':color);
      const value=String(Math.round(remaining))+'%';
      text(x+6,68,value,value.length===4?19:22,stale?'#a4afa9':'#f1f5f3',true,56,29,'center',true);
      text(x-3,115,reset(win.resetsAt),8.5,'#a6b2ad',false,74,25,'center');
    }
  }
  if(service?.fetchedAt){
    const date=new Date(service.fetchedAt*1000);
    const hh=String(date.getHours()).padStart(2,'0'),mm=String(date.getMinutes()).padStart(2,'0');
    text(left,141,`${stale?'更新停止 · ':''}取得 ${hh}:${mm}`,8.5,stale?'#e8bd76':'#92a299',false,146,14);
  }
}
widget.backgroundImage=canvas.getImage();
Script.setWidget(widget);
if(!config.runsInWidget)await widget.presentMedium();
Script.complete();
