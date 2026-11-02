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
// Draw the approved 338 x 158 medium layout directly: no stack centering or
// fixed-width columns that leave unused margins on the iPhone.
const canvas=new DrawContext();
canvas.size=new Size(338,158);canvas.respectScreenScale=true;canvas.opaque=true;
canvas.setFillColor(new Color('#141c1b'));canvas.fillRect(new Rect(0,0,338,158));
function text(x,y,value,size,color='#dce5e2',bold=false,width=146,height=22,right=false,mono=false){
  canvas.setFont(mono?Font.boldMonospacedSystemFont(size):bold?Font.boldSystemFont(size):Font.systemFont(size));
  canvas.setTextColor(new Color(color));
  if(right)canvas.setTextAlignedRight();else canvas.setTextAlignedLeft();
  canvas.drawTextInRect(String(value),new Rect(x,y,width,height));
}
function pill(x,y,width,height,color){
  if(width<=0)return;
  const r=Math.min(height/2,width/2);
  canvas.setFillColor(new Color(color));
  if(width>2*r)canvas.fillRect(new Rect(x+r,y,width-2*r,height));
  canvas.fillEllipse(new Rect(x,y,2*r,height));
  canvas.fillEllipse(new Rect(x+width-2*r,y,2*r,height));
}
canvas.setFillColor(new Color('#33413b'));canvas.fillRect(new Rect(168.5,14,0.5,129));
for(const [name,title,color,left] of [['codex','Codex','#78c6e0',11],['claude','Claude','#db9878',180]]){
  text(left,10,title,17,color,true);
  text(left+116,15,'残り',9,'#a6b2ad',false,30,15,true);
  const service=data?.services?.[name];
  const visibleWindows=(service?.windows||[]).filter(w=>w.id!=='iguana_necktie');
  const stale=offline || service?.status!=='ok' || !service?.fetchedAt || now-service.fetchedAt>1200;
  if(!visibleWindows.length){
    text(left,52,'—',34,'#cdd6d2',true,146,43);
    text(left,105,errorLabel || (service?.errorCode==='auth_required'?'ログイン待ち':'取得待ち'),10,'#a6b2ad',false,146,28);
  }else{
    for(const [index,win] of visibleWindows.slice(0,2).entries()){
      const x=left+index*77;
      text(x,37,win.label,10,'#a6b2ad',false,74,16);
      const remaining=Math.max(0,Math.min(100,100-win.usedPercent));
      const digits=String(Math.round(remaining));
      // Three digits plus '%' must still fit a 69 pt metric cell.
      const numberSize=digits.length===3?30:34;
      const numberWidth=digits.length*numberSize*0.61;
      text(x,52,digits,numberSize,stale?'#a4afa9':'#f1f5f3',true,numberWidth+2,43,false,true);
      text(x+numberWidth+1,68,'%',14,stale?'#a4afa9':'#dce5e2',true,15,21);
      pill(x,95,69,4,'#34403d');pill(x,95,69*remaining/100,4,color);
      text(x,105,reset(win.resetsAt),8.5,'#a6b2ad',false,74,25);
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
