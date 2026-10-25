// Export safe, synthetic samples. No LINE API calls or personal data.
import { mkdirSync,writeFileSync } from 'node:fs';
import { catalog,createPreview } from './products.js';
import { relaxWelcome,relaxScanCard,relaxReport,relaxTodayCard } from './relax-flex.js';
const answers={goal:'evening',minutes:'5',barrier:'busy',format:'text',reminder:'none'};
const preview=createPreview(catalog.relax,answers);
const data=x=>`${x}~00000000-0000-4000-8000-000000000000~0`;
const samples={welcome:relaxWelcome(),scan:relaxScanCard(data,'https://liff.line.me/example'),report:relaxReport(preview,data,{before:78,after:71})[1],today:relaxTodayCard(preview,7,data)};
const dir=new URL('./flex-samples/',import.meta.url);mkdirSync(dir,{recursive:true});
for(const [name,message] of Object.entries(samples))writeFileSync(new URL(`${name}.json`,dir),JSON.stringify(message,null,2)+'\n');
console.log('Exported 4 synthetic Flex samples; paste each contents object into LINE Flex Message Simulator.');
