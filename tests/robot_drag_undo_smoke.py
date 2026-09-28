import math
import os
from pathlib import Path

from playwright.sync_api import sync_playwright

from archive_helpers import read_exported_project
from chassis_drag_smoke import chassis_screen_point, read_camera
from end_effector_control_smoke import double_click_tool, load_robot
from viewer_tools_helpers import viewer_tool


BASE_URL = os.environ.get('BASE_URL', 'http://127.0.0.1:21990')
ROOT = Path(__file__).resolve().parents[1]


def state(canvas):
    return canvas.evaluate('''node => {
        const d = node.dataset;
        const axes = ['X', 'Y', 'Z', 'Roll', 'Pitch', 'Yaw'];
        return {
            pose: axes.map(axis => Number(d['robot' + axis])),
            target: axes.map(axis => Number(d['endEffectorTarget' + axis])),
            joints: JSON.parse(d.robotJointValues),
        };
    }''')


def assert_restored(canvas, expected, target=False):
    actual = state(canvas)
    assert actual['pose'] == expected['pose'], (actual, expected)
    assert actual['joints'].keys() == expected['joints'].keys()
    assert all(abs(actual['joints'][key] - value) < 1e-7
               for key, value in expected['joints'].items()), (actual, expected)
    if target:
        assert actual['target'] == expected['target'], (actual, expected)


def undo_depth(canvas):
    return int(canvas.get_attribute('data-robot-drag-undo-depth') or 0)


def start_drag(page, canvas, kind='end-effector', rotate=False):
    if kind == 'chassis':
        x, y = chassis_screen_point(canvas)
        offsets = [(0, 0)]
        attribute = 'data-chassis-dragging'
    else:
        box = canvas.bounding_box()
        x = box['x'] + float(canvas.get_attribute('data-end-effector-target-screen-x'))
        y = box['y'] + float(canvas.get_attribute('data-end-effector-target-screen-y'))
        offsets = [(0, 0)] if not rotate else [
            (radius * math.cos(angle), radius * math.sin(angle))
            for radius in (18, 24, 30, 36, 42, 50)
            for angle in (0, math.pi / 4, math.pi / 2, 3 * math.pi / 4)
        ]
        attribute = 'data-end-effector-dragging'
    for dx, dy in offsets:
        page.mouse.move(x + dx, y + dy)
        page.mouse.down()
        if canvas.get_attribute(attribute) == 'true':
            return x + dx, y + dy
        page.mouse.up()
    raise AssertionError(f'Could not pick the {kind} drag handle')


def drag(page, canvas, dx=12, dy=-6, kind='end-effector', rotate=False, release=True):
    x, y = start_drag(page, canvas, kind, rotate)
    page.mouse.move(x + dx, y + dy, steps=8)
    if release:
        page.mouse.up()
        page.wait_for_timeout(100)
    return x + dx, y + dy


def undo(page, canvas, expected, target=False, key='Control+z'):
    page.keyboard.press(key)
    page.wait_for_timeout(120)
    assert_restored(canvas, expected, target)


def run():
    errors = []
    with sync_playwright() as playwright:
        executable = os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE')
        browser = playwright.chromium.launch(
            headless=True, **({'executable_path': executable} if executable else {}),
        )
        page = browser.new_page(viewport={'width': 1440, 'height': 900})
        page.set_default_timeout(30_000)
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(f"{BASE_URL.rstrip('/')}/workbench", wait_until='networkidle')
        page.locator('[data-session-state="ready"]').wait_for()
        page.locator('input[type="file"][accept=".ply"]').set_input_files(
            str(ROOT / 'tests/fixtures/rotation-map.ply'),
        )
        page.locator('.loading-curtain').wait_for(state='hidden')
        load_robot(page)
        canvas = page.locator('.three-canvas')
        viewer_tool(page, name='定位机器人模型').click()
        page.wait_for_timeout(400)

        x, y = chassis_screen_point(canvas)
        page.mouse.dblclick(x, y, delay=70)
        page.wait_for_function("document.querySelector('.three-canvas').dataset.chassisDragMode === 'armed'")
        initial = state(canvas)
        camera = read_camera(canvas)
        drag(page, canvas, dx=24, dy=8, kind='chassis')
        first = state(canvas)
        assert first['pose'] != initial['pose']
        drag(page, canvas, dx=-12, dy=7, kind='chassis')
        assert undo_depth(canvas) == 2
        start_drag(page, canvas, kind='chassis')
        page.mouse.up()  # A click without movement must not consume an undo step.
        assert undo_depth(canvas) == 2
        undo(page, canvas, first)
        undo(page, canvas, initial)
        assert read_camera(canvas) == camera

        drag(page, canvas, kind='chassis')
        first = state(canvas)
        x, y = drag(page, canvas, kind='chassis', release=False)
        undo(page, canvas, first)
        assert canvas.get_attribute('data-chassis-dragging') == 'false'
        page.mouse.move(x + 15, y + 10, steps=4)
        page.mouse.up()
        assert_restored(canvas, first)
        assert undo_depth(canvas) == 1
        undo(page, canvas, initial)
        page.keyboard.press('Escape')
        print('chassis gestures and active-drag undo passed', flush=True)

        double_click_tool(page, canvas, 'left')
        page.locator('[aria-label="机械臂末端空间球"]').wait_for()
        page.wait_for_timeout(100)
        initial_arm = state(canvas)
        drag(page, canvas)
        first_arm = state(canvas)
        assert first_arm['joints'] != initial_arm['joints']
        assert undo_depth(canvas) == 1
        drag(page, canvas, dx=-7, dy=4)
        assert undo_depth(canvas) == 2
        undo(page, canvas, first_arm, target=True)
        # The unconfirmed space-ball preview stays open and returns to its start.
        undo(page, canvas, initial_arm, target=True)
        assert canvas.get_attribute('data-end-effector-control-state') == 'active'
        assert canvas.get_attribute('data-end-effector-active-locked') == 'false'

        x, y = drag(page, canvas, release=False)
        undo(page, canvas, initial_arm, target=True)
        assert canvas.get_attribute('data-end-effector-dragging') == 'false'
        page.mouse.move(x + 12, y - 4, steps=4)
        page.mouse.up()
        assert_restored(canvas, initial_arm, target=True)
        assert undo_depth(canvas) == 0

        page.get_by_role('button', name='RPY 旋转', exact=True).click()
        drag(page, canvas, dx=5, dy=8, rotate=True)
        assert state(canvas)['target'][3:] != initial_arm['target'][3:]
        undo(page, canvas, initial_arm, target=True)
        page.get_by_role('button', name='XYZ 位移', exact=True).click()
        print('XYZ/RPY and unconfirmed/active arm undo passed', flush=True)

        for lock_name in ('锁定本体姿态左机械臂末端', '锁定全局姿态左机械臂末端'):
            drag(page, canvas)
            page.get_by_role('button', name=lock_name, exact=True).click()
            assert canvas.get_attribute('data-end-effector-active-locked') == 'true'
            undo(page, canvas, initial_arm, target=True)
            assert canvas.get_attribute('data-end-effector-active-locked') == 'false'
            assert canvas.get_attribute('data-end-effector-transform-attached') == 'true'

        drag(page, canvas)
        current = state(canvas)
        field = page.get_by_role('spinbutton', name='末端 X (m)')
        field.focus()
        page.keyboard.press('Control+z')
        assert_restored(canvas, current, target=True)
        assert undo_depth(canvas) == 1
        canvas.focus()
        assert undo_depth(canvas) == 1
        page.keyboard.press('Control+Shift+z')
        assert_restored(canvas, current, target=True)

        page.get_by_role('button', name='打开示教数据管理页').click()
        page.locator('[data-app-page="teaching-data"]').wait_for()
        page.keyboard.press('Control+z')
        assert_restored(canvas, current)
        page.get_by_role('button', name='返回主工作台继续示教').click()
        undo(page, canvas, initial_arm, target=True, key='Meta+z')
        print('lock restoration, text focus and page scope passed', flush=True)

        # Chassis motion can also move globally locked arm joints through IK.
        page.get_by_role('button', name='锁定全局姿态左机械臂末端', exact=True).click()
        page.get_by_role('button', name='退出机械臂末端控制').click()
        x, y = chassis_screen_point(canvas)
        page.mouse.dblclick(x, y, delay=70)
        locked_start = state(canvas)
        drag(page, canvas, dx=10, dy=4, kind='chassis')
        undo(page, canvas, locked_start)
        assert canvas.get_attribute('data-end-effector-left-lock-mode') == 'map'
        page.keyboard.press('Escape')

        # Closing the arm panel must keep undo; subsequent numeric edits must
        # not accidentally restore an old drag over the independently edited pose.
        double_click_tool(page, canvas, 'right')
        right_start = state(canvas)
        drag(page, canvas, dx=5, dy=-4)
        page.get_by_role('button', name='退出机械臂末端控制').click()
        undo(page, canvas, right_start)
        assert canvas.get_attribute('data-end-effector-left-lock-mode') == 'map'
        double_click_tool(page, canvas, 'right')
        drag(page, canvas, dx=5, dy=-4)
        field = page.get_by_role('spinbutton', name='末端 X (m)')
        field.fill(str(state(canvas)['target'][0] + 0.003))
        field.press('Enter')
        assert undo_depth(canvas) == 0
        numeric = state(canvas)
        canvas.focus()
        undo(page, canvas, numeric, target=True)

        # Export and reload verify the parent state was restored, not just WebGL.
        drag(page, canvas, dx=5, dy=-4)
        undo(page, canvas, numeric, target=True)
        page.get_by_role('button', name='打开示教数据管理页').click()
        with page.expect_download() as info:
            page.get_by_role('button', name='导出示教工程 ZIP').click()
        project = read_exported_project(info.value)
        assert all(abs(project['robot']['joints'][key] - value) < 1e-7
                   for key, value in numeric['joints'].items())
        page.get_by_role('button', name='返回主工作台继续示教').click()
        page.wait_for_timeout(800)
        page.reload(wait_until='networkidle')
        page.wait_for_function("document.querySelector('.three-canvas')?.dataset.robotModelState === 'loaded'", timeout=180_000)
        assert_restored(canvas, numeric)
        assert undo_depth(canvas) == 0
        print('map locks, external edits, export and reload passed', flush=True)
        assert not errors, errors
        browser.close()


if __name__ == '__main__':
    run()
