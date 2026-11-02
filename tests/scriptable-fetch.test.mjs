import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const source=(await readFile(new URL('../scriptable/AI Usage.js',import.meta.url),'utf8')).split('const widget=new ListWidget();')[0];
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const run=new AsyncFunction('config','Keychain','FileManager','Request','Alert','Script',source+'return {data,offline,errorLabel};');
async function scenario(statuses,{widget=true,actions=[],input='r'.repeat(43),networkError=false}={}){
 let key='x'.repeat(43),calls=0;const messages=[];
 const keychain={contains:()=>true,get:()=>key,set:(_,value)=>{key=value}};
 const fm={documentsDirectory:()=>'',joinPath:()=>'',writeString:()=>{},fileExists:()=>false};
 class Request {async loadString(){if(networkError)throw Error('secret '+key);this.response={statusCode:statuses[calls++]};return JSON.stringify({schemaVersion:1,services:{codex:{},claude:{}}});}}
 class Alert {addSecureTextField(){}addAction(){}addCancelAction(){}textFieldValue(){return input;}async presentAlert(){messages.push(this.message);return actions.shift()??-1;}}
 const result=await run({runsInWidget:widget},keychain,{local:()=>fm},Request,Alert,{complete(){}});
 return {result,calls,key,messages};
}
test('widget reports unauthorized response rather than unexplained waiting',async()=>{
 const {result}=await scenario([401]);assert.equal(result.offline,true);assert.equal(result.errorLabel,'キー認証エラー (401)');
});
test('in-app key replacement retries and recovers from unauthorized response',async()=>{
 const {result,calls,key,messages}=await scenario([401,200],{widget:false,actions:[1,0]});
 assert.equal(calls,2);assert.equal(key,'r'.repeat(43));assert.equal(result.offline,false);assert.equal(result.errorLabel,'');
 assert.ok(messages.every(message=>!message.includes('x'.repeat(43))));
});
test('network exception text containing a secret is not exposed',async()=>{
 const {result,messages}=await scenario([],{widget:false,networkError:true,actions:[-1]});
 assert.equal(result.errorLabel,'通信エラー');assert.ok(messages.every(message=>!message.includes('secret')));
});
