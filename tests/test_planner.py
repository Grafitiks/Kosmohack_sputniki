"""Тесты для planner/smart.py — тут я проверяю сам алгоритм, а не API
(API проверяется в test_api.py). Смотрю четыре вещи: что smart никогда не
предлагает невалидных команд, что он не хуже baseline, что он честно не
подглядывает в будущие события, и что кэш внутри smart.py не разваливается,
если на один шаг прилетает сразу два события.
"""
from __future__ import annotations

import json
from pathlib import Path

from model.operations import Session
from model.resource_env import load
from planner import smart
from planner.baseline import decide_actions as baseline_decide_actions
from planner.smart import decide_actions as smart_decide_actions

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / 'data'


def run_scenario(scenario: dict, algorithm: str, goal: str, until_step: int | None = None) -> Session:
    session = Session(scenario)
    total = scenario['time']['steps'] if until_step is None else until_step
    while session.env.k < total:
        if algorithm == 'baseline':
            actions = baseline_decide_actions(session.env)
        else:
            actions = smart_decide_actions(session.env, goal)
        session.advance(actions)
    return session


def test_smart_has_no_blocked_commands_on_p01_p03():
    # smart сам проверяет env.can_execute перед тем как что-то предложить,
    # так что блокировок быть не должно — ни на одном сценарии, ни с одной целью
    for name in ('P01_intro', 'P02_shift', 'P03_energy'):
        scenario = load(DATA_DIR / f'{name}.json')
        for goal in ('priority', 'commercial'):
            session = run_scenario(scenario, 'smart', goal)
            assert session.summary()['blocked_command_count'] == 0, (name, goal)


def test_smart_completes_at_least_as_many_jobs_as_baseline():
    for name in ('P02_shift', 'P03_energy', 'P04_demand'):
        scenario = load(DATA_DIR / f'{name}.json')
        baseline_completed = run_scenario(scenario, 'baseline', 'priority').summary()['jobs_completed']
        for goal in ('priority', 'commercial'):
            smart_completed = run_scenario(scenario, 'smart', goal).summary()['jobs_completed']
            assert smart_completed >= baseline_completed, (name, goal, smart_completed, baseline_completed)


def test_smart_does_not_peek_at_future_events():
    # беру P02 с событиями из examples/events_demo.json и без них. До первого
    # события планировщик вообще не должен знать, что оно случится — значит,
    # команды на всех шагах до него обязаны совпасть один в один
    scenario = load(DATA_DIR / 'P02_shift.json')
    events = json.loads((ROOT / 'examples' / 'events_demo.json').read_text())['events']
    first_event_step = min(e['at_step'] for e in events)
    events_by_step: dict[int, list[dict]] = {}
    for e in events:
        events_by_step.setdefault(e['at_step'], []).append(e)

    until = first_event_step + 5  # с запасом за границу первого события

    session_plain = run_scenario(scenario, 'smart', 'priority', until_step=until)

    session_with_events = Session(scenario)
    while session_with_events.env.k < until:
        k = session_with_events.env.k
        for e in events_by_step.get(k, []):
            session_with_events.apply_event(e)
        session_with_events.advance(smart_decide_actions(session_with_events.env, 'priority'))

    before_plain = [c for c in session_plain.commands if c['step'] < first_event_step]
    before_events = [c for c in session_with_events.commands if c['step'] < first_event_step]
    assert before_plain == before_events
    assert before_plain  # проверка не пустая, шаги реально были


def test_two_events_on_same_step_do_not_break_planner():
    scenario = load(DATA_DIR / 'P02_shift.json')
    session = Session(scenario)
    while session.env.k < 10:
        session.advance(smart_decide_actions(session.env, 'priority'))

    k = session.env.k
    cache_before = smart._get_cache(session.env)
    assert cache_before['s'] is session.env.s

    session.apply_event({
        'id': 'E-TEST-JOBS', 'at_step': k, 'type': 'add_jobs',
        'jobs': [{
            'id': 'JOB-TEST-1', 'kind': 'downlink', 'release_step': k, 'deadline_step': k + 15,
            'work_steps': 1, 'eligible_satellites': ['S01'], 'priority': 3, 'value_usd': 42.0,
        }],
    })
    s_after_first = session.env.s
    assert s_after_first is not cache_before['s']  # apply_event пересоздаёт env.s целиком

    session.apply_event({
        'id': 'E-TEST-OUTAGE', 'at_step': k, 'type': 'satellite_outage',
        'satellite_ids': ['S02'], 'end_step': k + 5,
    })
    s_after_second = session.env.s
    assert s_after_second is not s_after_first  # и второе событие — снова новый объект

    # планировщик не падает и видит уже оба события: кэш пересобрался под
    # актуальный env.s, а не остался висеть на устаревшем объекте
    cache_after = smart._get_cache(session.env)
    assert cache_after is not cache_before
    assert cache_after['s'] is session.env.s

    actions = smart_decide_actions(session.env, 'priority')
    assert isinstance(actions, dict)
    assert 'S02' not in actions  # S02 в отказе, ему ничего не должно достаться

    # и смена дальше нормально считается
    for _ in range(5):
        session.advance(smart_decide_actions(session.env, 'priority'))
    assert session.summary()['blocked_command_count'] == 0
