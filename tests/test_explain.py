"""Тесты для planner/explain.py.

Для «невозможно по окну» беру готовый пример из P01 (там я уже разбирал
руками, что у JOB-0002 всего одно окно связи на два шага работы). Для
«сорвано из-за занятости» строю крошечный сценарий на одном спутнике —
так я точно знаю, что там произойдёт, и не завишу от того, как именно
планировщик разрулит конкуренцию на настоящих данных.
"""
from __future__ import annotations

from pathlib import Path

from model.operations import Session
from model.resource_env import load
from planner.baseline import decide_actions as baseline_decide_actions
from planner.explain import explain_all, explain_job
from planner.smart import decide_actions as smart_decide_actions

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / 'data'


def _run(scenario, decide, goal=None):
    session = Session(scenario)
    total = scenario['time']['steps']
    while session.env.k < total:
        actions = decide(session.env) if goal is None else decide(session.env, goal)
        session.advance(actions)
    return session


def test_impossible_by_contact_window_on_p01():
    scenario = load(DATA_DIR / 'P01_intro.json')
    session = _run(scenario, smart_decide_actions, 'priority')

    # JOB-0002 у S02: work_steps=2, а downlink_available в окне [0,13) даёт
    # только один True (шаг 3) — я это уже проверял руками в предыдущей сессии
    r = explain_job(session.env, 'JOB-0002')
    assert r['verdict'] == 'impossible_by_contact_window'
    assert r['status'] == 'missed'
    assert r['proof']['work_steps'] == 2
    assert r['proof']['contact_steps'] == 1
    assert r['proof']['per_satellite_contacts'] == {'S02': 1}
    # раз задание невозможно физически, отдельных потерянных шагов не считаю
    assert r['lost_steps_by_reason'] == {}
    assert r['main_reason'] == 'impossible_by_contact_window'


def test_done_job_has_no_failure_analysis():
    scenario = load(DATA_DIR / 'P01_intro.json')
    session = _run(scenario, smart_decide_actions, 'priority')
    r = explain_job(session.env, 'JOB-0001')  # это задание реально успевает
    assert r['status'] == 'done'
    assert r['verdict'] == 'done'


def _tiny_scenario() -> dict:
    """Один спутник, два задания. У S01 контакт для downlink открыт только
    на шаге 0, а для relay — всегда. JOB-A (downlink, низкий приоритет)
    может выполниться только в этот единственный момент, но туда же метит
    JOB-B (relay, приоритет 3) — и по сортировке забирает спутник себе.
    """
    n = 6
    return {
        'schema_version': 'cosmo-B-ops-1.0',
        'meta': {'id': 'tiny_occupied', 'title': 'tiny'},
        'time': {'step_s': 300, 'steps': n},
        'model': {
            'reserve_soc_pct': 10.0, 'critical_soc_pct': 5.0,
            'charge_efficiency': 0.9, 'discharge_efficiency': 0.9,
            'thermal_tau_s': 1800.0, 'thermal_gain_c_per_w': 0.2,
            'heater_below_c': -100.0, 'payload_min_c': -100.0, 'payload_max_c': 100.0,
            'charge_min_c': -100.0, 'charge_max_c': 100.0,
            'calibration_valid_steps': 100, 'downlink_parallel_limit': 2,
        },
        'satellites': [{
            'id': 'S01', 'capacity_wh': 1000.0, 'initial_soc_pct': 100.0, 'initial_temp_c': 20.0,
            'base_w': 5.0, 'heater_w': 0.0, 'calibration_w': 5.0, 'downlink_w': 10.0, 'relay_w': 10.0,
            'initial_calibration_age_steps': 0,
        }],
        'environment': {'S01': {
            'solar_w': [50.0] * n,
            'thermal_target_c': [20.0] * n,
            'downlink_available': [True] + [False] * (n - 1),
            'relay_available': [True] * n,
        }},
        'jobs': [
            {'id': 'JOB-A', 'kind': 'downlink', 'release_step': 0, 'deadline_step': n,
             'work_steps': 1, 'eligible_satellites': ['S01'], 'priority': 1, 'value_usd': 10.0},
            {'id': 'JOB-B', 'kind': 'relay', 'release_step': 0, 'deadline_step': n,
             'work_steps': 1, 'eligible_satellites': ['S01'], 'priority': 3, 'value_usd': 50.0},
        ],
        'failures': [],
    }


def test_lost_to_occupied():
    scenario = _tiny_scenario()
    session = _run(scenario, baseline_decide_actions)

    # контакта на всё окно ровно столько, сколько нужно (1 == work_steps) —
    # значит физически возможно, но спутник в этот единственный момент занят
    r = explain_job(session.env, 'JOB-A')
    assert r['proof']['contact_steps'] == 1  # не "невозможно", контакта хватало бы
    assert r['verdict'] == 'occupied'
    assert r['status'] == 'missed'
    assert r['lost_steps_by_reason'] == {'occupied': 1}
    assert r['lost_steps_examples']['occupied'][0]['job_id'] == 'JOB-B'
    assert r['lost_steps_examples']['occupied'][0]['priority'] == 3
    assert 'занят' in r['text']

    # а JOB-B в это время спокойно выполнилось
    b = explain_job(session.env, 'JOB-B')
    assert b['status'] == 'done'


def test_explain_all_reason_counts_match_per_job_verdicts():
    scenario = load(DATA_DIR / 'P01_intro.json')
    session = _run(scenario, smart_decide_actions, 'priority')

    summary = explain_all(session.env)
    not_completed = [j for j in session.env.jobs.values() if j['completed_step'] is None]
    assert summary['jobs_not_completed'] == len(not_completed)
    assert sum(summary['reasons'].values()) == len(not_completed)

    recomputed = {}
    for job in not_completed:
        r = explain_job(session.env, job['id'])
        recomputed[r['verdict']] = recomputed.get(r['verdict'], 0) + 1
    assert recomputed == summary['reasons']

    assert all(j['priority'] == 3 for j in summary['top_priority_jobs'])
    values = [j['value_usd'] for j in summary['top_priority_jobs']]
    assert values == sorted(values, reverse=True)
