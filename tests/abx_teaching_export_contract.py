"""Use unmodified ABX readers with a disposable database; never contact a robot."""
import base64
import hashlib
import io
import json
from pathlib import Path
import sys
from unittest.mock import patch


sys.dont_write_bytecode = True
folder, brain = (Path(value).resolve() for value in sys.argv[1:])
sys.path[:0] = [str(brain / 'tools/web'), str(brain / 'tools/chassis')]
import teaching_store as teaching
import route_graph
import execution_plan


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
graph = route_graph.load_graph(folder / 'abx/graph_route.geojson', folder / 'abx/graph_yaw.geojson')
assert len(graph['nodes']) == 2 and len(graph['edges']) == 1
assert graph['edges'][0]['start'] == 0 and graph['edges'][0]['end'] == 1
assert graph['nodes'][0]['x_m'] == 1.25 and graph['nodes'][0]['y_m'] == -2.5
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
        with patch.object(route_graph, 'load_graph', return_value=graph):
            plan = execution_plan.load_plan(str(database), [item['id']], 'mock', 'botx_abx_zivid_m70')
        assert plan['summary']['navigation_count'] == 2
        assert plan['summary']['capture_count'] == 0
        assert plan['summary']['point_count'] == 5
        parkings = plan['tasks'][0]['parkings']
        assert [group['name'] for group in parkings] == ['停车点 A', '停车点 B']
        points = [point for group in parkings for point in group['points']]
        assert [point['kind'] for point in points] == ['navigation', 'pose', 'pose', 'navigation', 'pose']
        assert points[0]['target']['x_m'] == 1.25 and points[3]['target']['y_m'] == 6.75
        assert len(points[1]['joints']) == 20
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
        with patch.object(route_graph, 'load_graph', return_value=graph):
            try:
                execution_plan.load_plan(str(database), [item['id']], 'mock', 'different-robot')
            except teaching.Error:
                pass
            else:
                raise AssertionError('model mismatch was accepted')

print('Native ABX import, checksum rejection, re-export and execution-plan verification passed (temporary DB only)')
