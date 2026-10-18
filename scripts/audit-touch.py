# SHO-US-22.2 AC4: counts touch targets under 44x44 px at phone widths. Needs a running dev server, tools/seed data and Playwright. Usage: python3 scripts/audit-touch.py (run from the folder that has seed.json)
import json,sys
from playwright.sync_api import sync_playwright
seed=json.load(open("seed.json")); B="http://localhost:3000"
JS="""()=>{const sel='button,a[href],input:not([type=hidden]),select,textarea,[role=button],[role=tab],[role=link],[tabindex="0"]';
const out=[];for(const e of document.querySelectorAll(sel)){const cs=getComputedStyle(e);if(cs.visibility==='hidden'||cs.display==='none')continue;
let r=e.getBoundingClientRect();if(!r.width||!r.height)continue;
// a ::after hit area counts
const af=getComputedStyle(e,'::after');let w=r.width,h=r.height;
if(af.content!=='none'&&af.position==='absolute'){const i=[af.top,af.right,af.bottom,af.left].map(parseFloat);if(i.every(x=>!isNaN(x))){w=r.width-i[1]-i[3];h=r.height-i[0]-i[2]}}
if(e.tagName==='A'&&e.closest('p,small,.hint,.sub,.t')&&cs.display==='inline')continue;
if(e.type==='checkbox'||e.type==='radio'){const l=e.closest('label');if(l){const lr=l.getBoundingClientRect();w=Math.max(w,lr.width);h=Math.max(h,lr.height)}}
if(w<43.5||h<43.5)out.push((e.className||e.tagName)+' '+Math.round(w)+'x'+Math.round(h)+' '+(e.textContent||e.getAttribute('aria-label')||'').trim().slice(0,24))}
return out}"""
pages=[f"/projects/{seed['p1']}?task={seed['tasks'][1]}"]
tot=0
with sync_playwright() as p:
    b=p.chromium.launch()
    for w in [320,375,414,600]:
        c=b.new_context(viewport={"width":w,"height":800},has_touch=True,is_mobile=True)
        c.request.post(B+"/api/auth/signin",data={"email":"root.test@aplyd.com","password":"correct-horse-9"})
        for u in pages:
            pg=c.new_page(); pg.goto(B+u,wait_until="load"); pg.wait_for_timeout(1500)
            bad=None
            for _ in range(8):
                try: bad=pg.evaluate(JS); break
                except Exception as e: pg.wait_for_timeout(2500)
            if bad is None: bad=['ERR']
            tot+=len(bad)
            if bad: print(w,u,len(bad),sorted(set(bad))[:8])
            pg.close()
        c.close()
    b.close()
print("TOTAL undersized:",tot)
