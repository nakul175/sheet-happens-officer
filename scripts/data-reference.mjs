import fs from 'node:fs';
const schema=fs.readFileSync('prisma/schema.prisma','utf8');
const models=[...schema.matchAll(/^model (\w+) \{\n([\s\S]*?)^\}/gm)];
let text='# Model and relation reference\n\nGenerated from `prisma/schema.prisma`; do not edit field tables by hand. See CONTRACT.md for semantics and unresolved boundaries.\n\n';
for(const [,name,body] of models){
 text+=`## ${name}\n\n| Field | Prisma type | Attributes / relation deletion rule |\n| --- | --- | --- |\n`;
 for(const line of body.split('\n')){const m=line.trim().match(/^(\w+)\s+(\S+)(.*)$/);if(m)text+=`| ${m[1]} | ${m[2]} | ${m[3].trim().replaceAll('|','\\|')||'—'} |\n`;}
 const constraints=body.split('\n').map(x=>x.trim()).filter(x=>x.startsWith('@@'));if(constraints.length)text+='\nModel constraints: '+constraints.map(x=>'`'+x+'`').join('; ')+'.\n';text+='\n';
}
text+='## Custom SQL inventory\n\nRead definitions in migration order; later ALTER/replacements take precedence. This inventory includes checks, partial indexes, triggers and functions.\n\n';
for(const dir of fs.readdirSync('prisma/migrations',{withFileTypes:true}).filter(x=>x.isDirectory()).sort((a,b)=>a.name.localeCompare(b.name))){
 const sql=fs.readFileSync(`prisma/migrations/${dir.name}/migration.sql`,'utf8');
 const statements=sql.split('\n').filter(x=>/CREATE (OR REPLACE )?(FUNCTION|TRIGGER|CONSTRAINT TRIGGER)|CREATE UNIQUE INDEX.*WHERE|CHECK\s*\(/i.test(x));
 if(statements.length)text+=`### ${dir.name}\n\n\`\`\`sql\n${statements.join('\n')}\n\`\`\`\n\n`;
}
const file='docs/data/MODEL-REFERENCE.md';
if(process.argv.includes('--check')){if(fs.readFileSync(file,'utf8')!==text)throw Error('DATA_REFERENCE_STALE');}
else fs.writeFileSync(file,text);
console.log(`Data reference: ${models.length} models; ${process.argv.includes('--check')?'consistent':'generated'}`);
