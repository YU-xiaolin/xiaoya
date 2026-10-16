// Public teaching templates only. Never reads FAMILY_LEARNING_DATA_DIR or private data.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildTestTasks, buildPreviewTasks, buildPracticeTasks } from '../src/test-mode.js';
import { questionSpeechText, reinforcementSpeechText, hintSpeechText, demonstrationSpeechText } from '../src/voice-text.js';
import { taskHintVariants } from '../src/targeted-hints.js';
import { pinyin } from 'pinyin-pro';

const resources = new URL('../src-tauri/resources/', import.meta.url);
const hanzi = (await readFile(new URL('幼儿汉字1000字表.csv', resources), 'utf8')).trim().split(/\r?\n/u).slice(1).map(line => {
  const [ref, stage, theme, display] = line.split(',');
  return {ref, stage, theme, display, optionDisplay:display, status:'未学', lastSeenAt:null, incorrectCount:0};
});
const english_letter = (await readFile(new URL('英语字母26个.csv', resources), 'utf8')).trim().split(/\r?\n/u).slice(1).map(line => {
  const [ref, upper, lower, association] = line.split(',');
  return {ref, display:`${upper} ${lower}`, optionDisplay:upper, association, status:'未学', lastSeenAt:null, incorrectCount:0};
});
const catalog = {hanzi, english_letter};
function template(task, mode) {
  const clips=[];
  const add=(text,rate,pitch)=>{if(text?.trim())clips.push({text:text.trim(),voice:'zh-CN-XiaoyiNeural',rate,pitch,volume:'+0%'});};
  add(questionSpeechText(task),'+14%','+6Hz');
  add(reinforcementSpeechText(task,mode),'+10%','+4Hz');
  for(const hint of taskHintVariants(task))add(hintSpeechText(task,hint),'+12%','+5Hz');
  add(demonstrationSpeechText(task),'+10%','+4Hz');
  const {taskId,isNew,options,...fields}=task;
  return {fields,clips};
}
const result={schemaVersion:1,templates:{},pronunciations:{}};
for(const subject of ['hanzi','english_letter'])for(const item of catalog[subject]){
  const kinds=subject==='hanzi'?['recognition','choice']:['choice'];
  for(const kind of kinds){
    const task=buildTestTasks(subject,[item],catalog,()=>0.25,1,{hanziOralReadingPercent:kind==='recognition'?100:0})[0];
    result.templates[`${subject}:${item.ref}:${kind}`]=template(task,'lesson');
  }
  result.templates[`${subject}:${item.ref}:preview`]=template(buildPreviewTasks(subject,[],catalog,[item.ref],1)[0],'preview');
  result.templates[`${subject}:${item.ref}:practice`]=template(buildPracticeTasks(subject,[],catalog,[item.ref],()=>0.25)[0],'practice');
  if(subject==='hanzi')result.pronunciations[item.display]=pinyin(item.display,{multiple:true,type:'array'});
}
const output=new URL('ai-transfer-templates.json',resources);
const content=JSON.stringify(result)+'\n';
if(process.argv.includes('--check')){
  if(await readFile(output,'utf8')!==content)throw new Error('AI transfer teaching templates are stale; regenerate them.');
}else await writeFile(output,content,'utf8');
console.log(`${process.argv.includes('--check')?'Verified':'Generated'} ${Object.keys(result.templates).length} public teaching templates: ${fileURLToPath(output)}`);
