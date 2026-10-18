#!/usr/bin/env python3
"""Browser checks for the CRM screens that the Vitest suite cannot see (SHO-E10..E13).

Covers: no sideways scroll at 390 px, drag-and-drop on the pipeline board, keyboard use of the Home switch,
the browser-storage fallback, and a Viewer seeing the task Links section read-only.

Run against a server started with EMAIL_OUTBOX_DIR set (sign-up mails are read from there):
    pip install playwright && playwright install chromium
    BASE=http://localhost:3000 EMAIL_OUTBOX_DIR=$PWD/.outbox python3 e2e/crm_browser.py
Exit code is 0 only if every check passes. Not part of CI or the deploy.
"""
import glob, json, os, re, sys, time, urllib.error, urllib.request
from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "http://localhost:3000")
BOX = os.environ["EMAIL_OUTBOX_DIR"]
PW = "correct-horse-9"
results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail and not ok else ""))


def call(path, body=None, cookie=None, method=None):
    h = {"content-type": "application/json"}
    if cookie:
        h["cookie"] = cookie
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode() if body is not None else None, headers=h,
                                 method=method or ("POST" if body is not None else "GET"))
    try:
        r = urllib.request.urlopen(req)
    except urllib.error.HTTPError as e:
        r = e
    raw = r.read()
    return r.status, (json.loads(raw) if raw and "json" in (r.headers.get("content-type") or "") else {}), r.headers


def account(label):
    email = f"e2e-{label}-{int(time.time() * 1000)}@aplyd.com"
    call("/api/auth/signup", {"name": f"E2E {label}", "email": email, "password": PW})
    token = None
    for f in sorted(glob.glob(BOX + "/*")):
        m = json.load(open(f))
        if m["to"] == email and "Verify" in m["subject"]:
            token = re.search(r"token=([\w-]+)", m["text"]).group(1)
    call("/api/auth/verify", {"token": token})
    _, data, headers = call("/api/auth/signin", {"email": email, "password": PW})
    return {"cookie": headers["set-cookie"].split(";")[0], "id": data["user"]["id"]}


lead, viewer = account("lead"), account("viewer")
org = call("/api/orgs", {"name": f"E2E Org {time.time()}", "kind": "Ministry"}, lead["cookie"])[1]["organisation"]["id"]
pipes = call("/api/deals/pipelines", None, lead["cookie"])[1]["pipelines"]
pro = next(p for p in pipes if p["key"] == "DEAL_PROACTIVE")
due = time.strftime("%Y-%m-%d", time.localtime(time.time() + 5 * 86400))
deal = call("/api/deals", {"name": "E2E drag deal", "organisationId": org, "pipelineId": pro["id"], "leaderId": lead["id"],
                           "whyPursue": "fit", "nextStep": {"title": "Call", "dueDate": due}, "value": 100000, "currency": "INR"}, lead["cookie"])[1]["deal"]["id"]
proj = call("/api/projects", {"name": f"E2E project {time.time()}", "leaderId": lead["id"]}, lead["cookie"])[1]["project"]["id"]
call(f"/api/projects/{proj}/members", {"userId": viewer["id"], "role": "VIEWER"}, lead["cookie"])
task = call(f"/api/projects/{proj}/tasks", {"title": "Linked task", "assigneeId": lead["id"]}, lead["cookie"])[1]["task"]["id"]
call(f"/api/tasks/{task}/links", {"organisationId": org}, lead["cookie"])
name, value = lead["cookie"].split("=", 1)
vname, vvalue = viewer["cookie"].split("=", 1)


def go(pg, path):
    # The first visit to a screen on a dev server compiles it and can abort the navigation once; retry.
    for attempt in range(3):
        try:
            pg.goto(BASE + path, wait_until="domcontentloaded")
            break
        except Exception:
            if attempt == 2:
                raise
            pg.wait_for_timeout(2000)
    pg.wait_for_load_state("load"); pg.wait_for_timeout(2500)


def sideways(pg):
    for _ in range(4):
        try:
            return pg.evaluate("document.documentElement.scrollWidth > innerWidth")
        except Exception:  # the page was still navigating
            pg.wait_for_timeout(1500)
    return True


def ctx(br, width, who=(name, value), block_storage=False):
    c = br.new_context(viewport={"width": width, "height": 900})
    c.add_cookies([{"name": who[0], "value": who[1], "url": BASE}])
    if block_storage:
        c.add_init_script("Object.defineProperty(window,'localStorage',{get(){throw new Error('blocked')}})")
    return c


with sync_playwright() as p:
    br = p.chromium.launch()

    # 1. No sideways scroll on the CRM screens at phone and desktop width.
    for width in (390, 1280):
        c = ctx(br, width)
        pg = c.new_page()
        for path in ("/accounts", f"/accounts/{org}", "/deals", f"/projects/{deal}", "/review"):
            go(pg, path)
            check(f"{width}px: no sideways scroll on {path}", not sideways(pg))
        c.close()

    # 2. Drag a card to the next stage on the board; the server must agree.
    c = ctx(br, 1280); pg = c.new_page()
    go(pg, "/deals")
    card = pg.locator(".dcard", has_text="E2E drag deal").first
    target = pg.locator("section.dcol[aria-label='Conversation']")
    card.drag_to(target); pg.wait_for_timeout(1200)
    stage = call(f"/api/projects/{deal}", None, lead["cookie"])[1]["project"]["deal"]["stage"]["name"]
    check("drag: card dropped on Conversation moves the deal", stage == "Conversation", stage)
    pg.get_by_role("button", name="By category").click(); pg.wait_for_timeout(800)
    check("category view: deal appears under Active", pg.locator("section[aria-label='Active']", has_text="E2E drag deal").count() == 1)

    # 2b. Sidebar highlights Deals (not Projects) on a deal page; the organisation page shows its deals as a board.
    go(pg, f"/projects/{deal}")
    check("sidebar: Deals is highlighted on a deal page", pg.locator("nav.nav a[aria-current='page']").inner_text() == "Deals", pg.locator("nav.nav a[aria-current='page']").all_inner_texts().__str__())
    go(pg, f"/accounts/{org}")
    check("organisation page: deals shown as a board", pg.locator(".dboard .dcard", has_text="E2E drag deal").count() == 1)
    c.close()

    # 2c. Finishing the last dated task of a deal on Home asks 'What is next?' in the same group, not at the top of the page.
    c = ctx(br, 1280); pg = c.new_page()
    go(pg, "/")
    pg.get_by_role("button", name='Complete "Call"').first.click(); pg.wait_for_timeout(1800)
    prompt = pg.get_by_text("What is next for E2E drag deal?")
    check("prompt: 'What is next?' appears after the last dated task", prompt.count() == 1)
    inside = pg.locator("section[aria-label='Next 7 days']").get_by_text("What is next for E2E drag deal?").count() == 1
    check("prompt: it sits in the same date group the task was in", inside)
    c.close()

    # 3. Keyboard: focus the Home switch and press Space.
    c = ctx(br, 1280); pg = c.new_page()
    go(pg, "/")
    btn = pg.get_by_role("button", name="By project")
    btn.focus(); pg.keyboard.press("Space"); pg.wait_for_timeout(300)
    check("keyboard: Space on By project turns it on", btn.get_attribute("aria-pressed") == "true")
    pg.reload(); pg.wait_for_load_state("load"); pg.wait_for_timeout(2000)
    check("remembered: By project is still on after reload", pg.get_by_role("button", name="By project").get_attribute("aria-pressed") == "true")
    c.close()

    # 4. Browser storage blocked: Home opens By date and does not crash.
    c = ctx(br, 1280, block_storage=True); pg = c.new_page(); errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    go(pg, "/")
    check("storage blocked: Home opens By date", pg.get_by_role("button", name="By date").get_attribute("aria-pressed") == "true")
    check("storage blocked: no page error", not [e for e in errs if "blocked" in e], str(errs))
    c.close()

    # 5. A Viewer sees the task's links but cannot add or remove them.
    c = ctx(br, 1280, who=(vname, vvalue)); pg = c.new_page()
    go(pg, f"/?task={task}")
    check("viewer: sees the Links section", pg.get_by_text("Links", exact=True).count() >= 1)
    check("viewer: no '+ Link' button", pg.get_by_role("button", name="+ Link").count() == 0)
    check("viewer: no remove-link button", pg.get_by_role("button", name="Remove link").count() == 0)
    c.close()
    br.close()

failed = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(failed)}/{len(results)} passed")
sys.exit(1 if failed else 0)
