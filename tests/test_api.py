"""Тесты бэкенда (app/server.py) через TestClient.

Я тут просто прохожу руками то, что уже проверял curl-ом: создание сессии,
шаги, события, сравнение целей, overrides. Ничего умного, просто чтобы не
сломать это заново при следующей правке.
"""
import json
from pathlib import Path

from fastapi.testclient import TestClient

from app.server import app
from model.operations import replay_episode
from model.resource_env import load

ROOT = Path(__file__).resolve().parents[1]
client = TestClient(app)


def create_p01_session(goal='priority', **extra_payload):
    payload = {'scenario_id': 'P01_intro', 'goal': goal, **extra_payload}
    r = client.post('/api/sessions', json=payload)
    assert r.status_code == 200, r.text
    return r.json()


def test_create_step_and_run_to_end():
    state = create_p01_session()
    sid = state['session_id']
    assert state['step'] == 0
    assert state['total_steps'] == 48
    assert len(state['satellites']) == 16
    assert len(state['jobs']) == 18

    r = client.post(f'/api/sessions/{sid}/step', json={'n': 5})
    assert r.status_code == 200
    assert r.json()['step'] == 5

    r = client.post(f'/api/sessions/{sid}/run', json={'until_step': 48})
    assert r.status_code == 200
    state = r.json()
    assert state['step'] == 48
    # смена кончилась, все задания либо done, либо missed
    statuses = {j['status'] for j in state['jobs']}
    assert statuses <= {'done', 'missed'}


def test_run_backwards_is_rejected():
    state = create_p01_session()
    sid = state['session_id']
    client.post(f'/api/sessions/{sid}/step', json={'n': 10})
    r = client.post(f'/api/sessions/{sid}/run', json={'until_step': 3})
    assert r.status_code == 400
    assert 'error' in r.json()


def test_duplicate_event_id_rejected_and_state_unchanged():
    state = create_p01_session()
    sid = state['session_id']
    state = client.post(f'/api/sessions/{sid}/run', json={'until_step': 12}).json()

    demo = json.loads((ROOT / 'examples' / 'events_demo.json').read_text())
    event = json.loads(json.dumps(demo['events'][0]))  # add_jobs, но сделан под P02 (288 шагов)
    event['at_step'] = state['step']
    for j in event['jobs']:
        j['release_step'] = state['step']
        j['deadline_step'] = min(48, state['step'] + 10)  # у P01 всего 48 шагов

    r = client.post(f'/api/sessions/{sid}/event', json=event)
    assert r.status_code == 200, r.text
    state = r.json()
    assert len(state['jobs']) == 18 + 3

    # тот же id ещё раз -> ошибка, задания не задваиваются
    r = client.post(f'/api/sessions/{sid}/event', json=event)
    assert r.status_code == 400
    assert 'error' in r.json()

    result = client.get(f'/api/sessions/{sid}/result').json()
    assert len(result['events']) == 1
    assert len(result['initial_scenario']['jobs']) == 18  # исходный сценарий не трогали


def test_satellite_outage_event():
    state = create_p01_session()
    sid = state['session_id']
    outage = {'id': 'OUT-1', 'at_step': 0, 'type': 'satellite_outage',
              'satellite_ids': ['S05'], 'end_step': 3}
    r = client.post(f'/api/sessions/{sid}/event', json=outage)
    assert r.status_code == 200
    state = r.json()
    s05 = next(s for s in state['satellites'] if s['id'] == 'S05')
    assert s05['available'] is False


def test_goal_change():
    state = create_p01_session(goal='priority')
    sid = state['session_id']
    r = client.post(f'/api/sessions/{sid}/goal', json={'goal': 'revenue'})
    assert r.status_code == 200
    assert r.json()['goal'] == 'revenue'

    r = client.post(f'/api/sessions/{sid}/goal', json={'goal': 'not_a_real_goal'})
    assert r.status_code == 400
    assert 'error' in r.json()


def test_compare_does_not_change_original_session():
    state = create_p01_session()
    sid = state['session_id']
    client.post(f'/api/sessions/{sid}/run', json={'until_step': 12})
    before = client.get(f'/api/sessions/{sid}/result').json()

    r = client.post(f'/api/sessions/{sid}/compare', json={'goal_a': 'priority', 'goal_b': 'revenue'})
    assert r.status_code == 200
    cmp_data = r.json()
    assert cmp_data['at_step'] == 12
    assert set(cmp_data.keys()) == {'at_step', 'a', 'b', 'verdict'}
    assert cmp_data['a']['goal'] == 'priority'
    assert cmp_data['b']['goal'] == 'revenue'

    after = client.get(f'/api/sessions/{sid}/result').json()
    assert after == before  # compare крутит форки, а не саму сессию


def test_result_replays_through_operations_py():
    state = create_p01_session()
    sid = state['session_id']
    client.post(f'/api/sessions/{sid}/run', json={'until_step': 20})
    outage = {'id': 'OUT-1', 'at_step': 20, 'type': 'satellite_outage',
              'satellite_ids': ['S02'], 'end_step': 30}
    client.post(f'/api/sessions/{sid}/event', json=outage)
    state = client.post(f'/api/sessions/{sid}/run', json={'until_step': 48}).json()

    result = client.get(f'/api/sessions/{sid}/result').json()
    replayed = replay_episode(result['initial_scenario'], result['events'],
                              result['commands'], result['steps_executed'])
    assert replayed.summary() == state['summary']


def test_overrides_initial_soc_and_priority_and_outage():
    original = load(ROOT / 'data' / 'P01_intro.json')
    job_id = original['jobs'][6]['id']  # JOB-0007, relay, priority 2 в исходнике
    assert original['jobs'][6]['priority'] == 2

    overrides = {
        'initial_soc_pct': {'satellite_id': 'S01', 'value': 10.0},
        'priority': {'job_id': job_id, 'value': 3},
        'outage': {'satellite_id': 'S03', 'start_step': 0, 'end_step': 5},
    }
    state = create_p01_session(overrides=overrides)
    sid = state['session_id']

    s01 = next(s for s in state['satellites'] if s['id'] == 'S01')
    assert s01['soc_pct'] == 10.0

    job = next(j for j in state['jobs'] if j['id'] == job_id)
    assert job['priority'] == 3

    s03 = next(s for s in state['satellites'] if s['id'] == 'S03')
    assert s03['available'] is False

    # overrides должны попасть в initial_scenario и пережить пересчёт
    scenario = client.get(f'/api/sessions/{sid}/scenario').json()
    assert any(v['id'] == 'S01' and v['initial_soc_pct'] == 10.0 for v in scenario['satellites'])
    result = client.get(f'/api/sessions/{sid}/result').json()
    replayed = replay_episode(result['initial_scenario'], result['events'],
                              result['commands'], result['steps_executed'])
    assert replayed.summary() == state['summary']


def test_overrides_solar_factor_single_and_all():
    original = load(ROOT / 'data' / 'P01_intro.json')
    s01_solar_0 = original['environment']['S01']['solar_w'][0]
    s02_solar_0 = original['environment']['S02']['solar_w'][0]
    assert s01_solar_0 > 0  # иначе тест ничего не проверяет

    # только один спутник
    state = create_p01_session(overrides={'solar_factor': {'satellite_id': 'S01', 'value': 0.0}})
    sid = state['session_id']
    state = client.post(f'/api/sessions/{sid}/step', json={'n': 1}).json()
    rows = {r['satellite_id']: r for r in state['last_step_rows']}
    assert rows['S01']['solar_w'] == 0.0
    assert rows['S02']['solar_w'] == s02_solar_0  # других не тронули

    # все спутники сразу
    state = create_p01_session(overrides={'solar_factor': {'value': 0.5}})
    sid = state['session_id']
    state = client.post(f'/api/sessions/{sid}/step', json={'n': 1}).json()
    rows = {r['satellite_id']: r for r in state['last_step_rows']}
    assert rows['S01']['solar_w'] == s01_solar_0 * 0.5
    assert rows['S02']['solar_w'] == s02_solar_0 * 0.5


def test_overrides_invalid_are_rejected_with_clear_error():
    cases = [
        {'initial_soc_pct': {'satellite_id': 'NOPE', 'value': 50.0}},
        {'initial_soc_pct': {'satellite_id': 'S01', 'value': 150.0}},  # вне 0..100
        {'solar_factor': {'value': -1.0}},  # отрицательный коэффициент
        {'priority': {'job_id': 'NOPE', 'value': 2}},
        {'priority': {'job_id': 'JOB-0001', 'value': 7}},  # приоритет 1..3
        {'outage': {'satellite_id': 'S01', 'start_step': 10, 'end_step': 5}},  # конец раньше начала
        {'bogus_field': {}},
    ]
    for overrides in cases:
        r = client.post('/api/sessions', json={'scenario_id': 'P01_intro', 'goal': 'priority', 'overrides': overrides})
        assert r.status_code == 400, f'{overrides} должен был отклониться, а пришло {r.status_code}: {r.text}'
        assert 'error' in r.json()


def test_custom_scenario_can_be_reused():
    r = client.post('/api/scenarios/custom', json={
        'scenario_id': 'P01_intro',
        'overrides': {'priority': {'job_id': 'JOB-0007', 'value': 1}},
    })
    assert r.status_code == 200, r.text
    custom = r.json()
    custom_id = custom['id']
    assert custom_id.startswith('custom-')
    assert custom['satellites'] == 16

    # сценарий виден в общем списке
    scenarios = client.get('/api/scenarios').json()
    assert any(s['id'] == custom_id for s in scenarios)

    # и по нему можно создать сессию как по обычному scenario_id
    state = create_p01_session(scenario_id=custom_id)
    assert state['scenario'] == custom_id
    job = next(j for j in state['jobs'] if j['id'] == 'JOB-0007')
    assert job['priority'] == 1


def test_missing_scenario_gives_clear_error():
    r = client.post('/api/sessions', json={'goal': 'priority'})
    assert r.status_code == 400
    assert 'error' in r.json()

    r = client.post('/api/sessions', json={'scenario_id': 'not_a_real_scenario', 'goal': 'priority'})
    assert r.status_code == 404
    assert 'error' in r.json()

    r = client.get('/api/sessions/not_a_real_session/result')
    assert r.status_code == 404
    assert 'error' in r.json()
