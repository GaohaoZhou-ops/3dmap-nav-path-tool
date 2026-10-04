"""Run exact copies of ABX readers in a disposable directory, with no external writes."""
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import sys
from unittest.mock import patch


sys.dont_write_bytecode = True
folder, brain = (Path(value).resolve() for value in sys.argv[1:])
assert folder != brain.parent and brain.parent not in folder.parents


def temporary_path(value):
    if isinstance(value, (str, bytes, os.PathLike)):
        destination = Path(os.fsdecode(value)).resolve()
        if destination != folder and folder not in destination.parents:
            raise PermissionError(f'Contract test cannot write outside its temporary directory: {destination}')


def isolated_io(event, args):
    if event == 'open' and args[2] & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND):
        temporary_path(args[0])
    elif event in ('os.mkdir', 'os.remove', 'os.rmdir', 'os.chmod', 'os.utime', 'sqlite3.connect'):
        temporary_path(args[0])
    elif event in ('os.rename', 'os.link', 'os.symlink'):
        temporary_path(args[0]); temporary_path(args[1])
    elif event in ('socket.connect', 'socket.bind', 'subprocess.Popen', 'os.system'):
        raise PermissionError(f'Contract test cannot contact or start external services: {event}')


sys.addaudithook(isolated_io)
snapshot = folder / 'brain-source-snapshot'
source_digests = {}
for part in ('web', 'chassis', 'platform', 'logging'):
    for source in (brain / 'tools' / part).glob('*.py'):
        data = source.read_bytes()
        source_digests[source] = hashlib.sha256(data).digest()
        destination = snapshot / 'tools' / part / source.name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)
os.chdir(folder)
sys.path[:0] = [str(snapshot / 'tools/web'), str(snapshot / 'tools/chassis')]
import teaching_store as teaching
import route_graph
import execution_plan
import base_navigation


database = folder / 'isolated-pipeline' / 'teaching' / 'fixture.sqlite3'


def call(operation, expected=200, **args):
    output = io.StringIO()
    teaching.run(str(database), {'op': operation, 'args': args}, output)
    status, body = output.getvalue().split('\n', 1)
    assert int(status) == expected, (operation, status, body)
    return json.loads(body)


def import_task(lines, identity, expected=200):
    call('import/begin', request_id=identity, header=lines[0])
    # Exercise the same bounded UTF-8/base64 transport used by the native Web UI.
    for line in lines[1:-1]:
        chunk = base64.b64encode((line + '\n').encode('utf-8')).decode('ascii')
        call('import/append', task_id=identity, lines=chunk)
    return call('import/finish', expected=expected, task_id=identity, footer=lines[-1])


call('init')
manifest = json.loads((folder / 'abx/manifest.json').read_text())
navigation = json.loads((folder / 'abx/free-navigation.json').read_text())
assert navigation['mode'] == 'free' and navigation['nativeTaskNavigationSupported'] is False
assert teaching.VERSION == 15, 'Review the current Brain contract before changing export assumptions'
for target in [point['target'] for point in navigation['waypoints']] + [
        step['target'] for task in navigation['tasks'] for step in task['sequence'] if step['type'] == 'free_navigation']:
    fields = dict(run_id='c' * 32, mode='free', **{key: str(value) for key, value in target.items()})
    assert base_navigation.navigation_request(fields) == fields
    assert base_navigation.navigation_target(fields) == target
for index, item in enumerate(manifest['tasks']):
    lines = (folder / 'abx' / item['file']).read_text().rstrip('\n').split('\n')
    result = import_task(lines, item['id'])
    assert result['task']['name'] == item['name']
    assert result['task']['point_count'] == item['point_count']
    output = io.StringIO()
    teaching.run(str(database), {'op': 'export', 'args': {'task_id': item['id']}}, output)
    status, exported = output.getvalue().split('\n', 1)
    assert status == '200'
    exported = exported.rstrip('\n').split('\n')
    assert [json.loads(line) for line in exported[1:-1]] == [json.loads(line) for line in lines[1:-1]]
    checksum = hashlib.sha256(('\n'.join(exported[1:-1]) + ('\n' if len(exported) > 2 else '')).encode()).hexdigest()
    assert json.loads(exported[-1])['sha256'] == checksum
    # Re-exported files must also import without loss into another task.
    import_task(exported, f'{index + 100:032x}')
    if index == 0:
        with patch.object(route_graph, 'load_graph', side_effect=AssertionError('Pose imports must not depend on station files')):
            plan = execution_plan.load_plan(str(database), [item['id']], 'mock', 'botx_abx_zivid_m70')
        assert plan['summary']['navigation_count'] == 0
        assert plan['summary']['capture_count'] == 0
        assert plan['summary']['point_count'] == 3
        parkings = plan['tasks'][0]['parkings']
        assert [group['name'] for group in parkings] == ['停车点 A', '停车点 B']
        points = [point for group in parkings for point in group['points']]
        assert [point['kind'] for point in points] == ['pose', 'pose', 'pose']
        assert all(point['component'] == 'auto' for point in points)
        assert all(len(point['joints']) == 20 for point in points)
        # A changed body with the old footer must never become visible.
        tampered = list(lines)
        record_index = next(i for i, line in enumerate(lines) if 'joints_rad' in json.loads(line).get('record', {}))
        changed = json.loads(tampered[record_index])
        changed['record']['joints_rad']['head'][0] += 0.1
        tampered[record_index] = json.dumps(changed, ensure_ascii=False, separators=(',', ':'))
        rejected = 'f' * 32
        import_task(tampered, rejected, expected=400)
        call('task', expected=404, task_id=rejected)
        call('task', task_id=item['id'])
        with patch.object(route_graph, 'load_graph', side_effect=AssertionError('Pose imports must not depend on station files')):
            try:
                execution_plan.load_plan(str(database), [item['id']], 'mock', 'different-robot')
            except teaching.Error:
                pass
            else:
                raise AssertionError('model mismatch was accepted')

assert all(hashlib.sha256(source.read_bytes()).digest() == digest for source, digest in source_digests.items())
print('Native ABX import, checksum rejection, re-export and execution-plan verification passed (isolated copies; source tree unchanged)')
