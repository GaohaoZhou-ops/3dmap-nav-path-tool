import hashlib
import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get("BASE_URL", "http://127.0.0.1:22001")
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"


def api(path, body=None, token=None):
    request = Request(BASE + "/__atlas/ipad" + path,
                      data=json.dumps(body).encode() if body is not None else None,
                      headers={"Content-Type": "application/json", **({"Authorization": "Bearer " + token} if token else {})})
    with urlopen(request) as response:
        return json.load(response)


def ready(page):
    page.locator('[data-session-state="ready"]').wait_for(state='attached', timeout=30000)
    page.locator('.loading-curtain').wait_for(state='hidden', timeout=30000)


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True, executable_path=CHROME)
    page = browser.new_page(viewport={"width": 1600, "height": 1000})
    page.set_default_timeout(30000)
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(BASE + '/workbench')
    page.wait_for_load_state('networkidle')
    ready(page)
    page.locator('[data-independent-teaching-input="true"]').set_input_files(str(Path(__file__).parent / 'fixtures/rotation-map.ply'))
    ready(page)
    page.get_by_role('button', name='移动到 iPad 或 Vision Pro 上运行').click()
    dialog = page.get_by_role('dialog', name='移动到 iPad 或 Vision Pro 上运行')
    expect(dialog).to_be_visible()
    page.get_by_role('button', name='准备物体与配对码').click()
    page.locator('[data-ipad-status="ready"]').wait_for()
    page.screenshot(path='/tmp/atlas-ipad-pairing.png', full_page=True)
    ticket = page.evaluate("JSON.parse(localStorage.getItem('atlas-ipad-handoffs-v1'))[0]")
    paired = api('/pair', {"code": ticket['pairingCode'], "deviceId": str(uuid.uuid4()), "deviceName": "iPad Pro UI test"})
    request = Request(BASE + '/__atlas/ipad/sessions/' + ticket['id'] + '/model', headers={"Authorization": "Bearer " + paired['deviceToken']})
    with urlopen(request) as response:
        model = response.read()
    assert hashlib.sha256(model).hexdigest() == ticket['manifest']['modelHash']
    assert api('/sessions/' + ticket['id'], token=ticket['ownerToken'])['status'] == 'paired'
    result = json.loads(Path('/tmp/atlas-ipad-swift-result.json').read_text())
    result['sessionId'] = ticket['id']
    result['modelHash'] = ticket['manifest']['modelHash']
    # Real Swift-encoded optical pose contract, with the transfer-specific identity filled in.
    second = json.loads(json.dumps(result['samples'][0]))
    second['id'] = str(uuid.uuid4())
    second['name'] = 'Pose 002'
    second['cameraPose']['position']['x'] += 0.5
    result['samples'].append(second)
    assert api('/sessions/' + ticket['id'] + '/result', result, paired['deviceToken'])['received']
    page.get_by_role('button', name='检查完成状态').click()
    page.locator('[data-ipad-status="completed"]').wait_for()
    page.get_by_role('button', name='接收示教结果', exact=True).click()
    page.locator('[data-ipad-status="imported"]').wait_for()
    page.get_by_role('button', name='再次接收（去重）').click()
    expect(page.get_by_role('button', name='再次接收（去重）')).to_be_enabled()
    page.get_by_role('button', name='关闭设备示教窗口').click()
    page.get_by_role('button', name='打开示教数据管理页').click()
    detail = page.get_by_role('region', name='iPad 示教结果')
    expect(detail).to_contain_text('2 个 Pose')
    assert page.locator('.teaching-data-page').get_attribute('data-teaching-task-count') == '1'
    page.screenshot(path='/tmp/atlas-ipad-result.png', full_page=True)
    with page.expect_download() as info:
        page.get_by_role('button', name='导出 iPad 示教 JSON').click()
    exported = json.loads(Path(info.value.path()).read_text())
    assert len(exported['samples']) == 2
    assert exported['samples'][0]['name'] == 'Pose 001'
    page.reload(wait_until='networkidle')
    ready(page)
    expect(page.get_by_role('region', name='iPad 示教结果')).to_contain_text('2 个 Pose')
    page.get_by_role('button', name='继续工作 · 返回主工作台继续示教').click()
    page.get_by_role('button', name='移动到 iPad 或 Vision Pro 上运行').click()
    expect(page.locator('[data-ipad-status="imported"]')).to_be_visible()
    page.keyboard.press('Escape')
    expect(dialog).not_to_be_visible()
    # Narrow desktop viewport: the entry and dialog remain reachable.
    page.set_viewport_size({"width": 1280, "height": 800})
    page.get_by_role('button', name='移动到 iPad 或 Vision Pro 上运行').click()
    expect(dialog).to_be_visible()
    page.screenshot(path='/tmp/atlas-ipad-pairing-1280.png', full_page=True)
    assert not errors, errors
    browser.close()
print('iPad entry, model handoff, Swift Pose round trip, import deduplication, export and reload passed.')
