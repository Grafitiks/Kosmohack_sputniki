"""Тесты для planner/stats.py — смотрю на загрузку группировки.

Тут не разбираю конкретные задания (это explain.py), а проверяю сам счёт:
доли по спутнику должны сходиться в единицу, downlink не должен вылезать
за лимит, а периоды дефицита энергии должны совпадать с тем, что реально
записано в trace (below_reserve).
"""
from __future__ import annotations

from pathlib import Path

from model.operations import Session
from model.resource_env import load
from planner.smart import decide_actions
from planner.stats import compute_stats

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / 'data'


def _run(name: str, goal: str = 'priority', until_step: int | None = None) -> Session:
    scenario = load(DATA_DIR / f'{name}.json')
    session = Session(scenario)
    total = until_step if until_step is not None else scenario['time']['steps']
    while session.env.k < total:
        session.advance(decide_actions(session.env, goal))
    return session


def test_shares_add_up_to_one():
    for name in ('P01_intro', 'P02_shift', 'P03_energy'):
        session = _run(name)
        stats = compute_stats(session.env)
        assert stats['step'] == session.env.k
        for sat in stats['satellites']:
            total_share = sat['job_share'] + sat['calibration_share'] + sat['idle_share']
            # доли округлены до 4 знаков каждая по отдельности, так что сумма
            # может чуть-чуть гулять — точность лучше проверять по сырым счётчикам
            assert abs(total_share - 1.0) < 1e-3, (name, sat['id'], total_share)
            total_steps = sat['job_steps'] + sat['calibration_steps'] + sat['idle_steps']
            assert total_steps == sat['steps_total'] == session.env.k
            assert sum(sat['idle_reasons'].values()) == sat['idle_steps']


def test_downlink_usage_never_exceeds_limit():
    session = _run('P04_demand')
    limit = session.env.s['model']['downlink_parallel_limit']
    stats = compute_stats(session.env)
    assert len(stats['downlink_usage']) == session.env.k
    for row in stats['downlink_usage']:
        assert 0 <= row['used'] <= limit
        assert row['limit'] == limit

    # и сверяю с трейсом напрямую, а не только доверяю своему же подсчёту
    downlink_job_ids = {j['id'] for j in session.env.jobs.values() if j['kind'] == 'downlink'}
    counted = [0] * session.env.k
    for row in session.env.trace:
        if row['executed'] == 'job' and row['requested']['job_id'] in downlink_job_ids:
            counted[row['step']] += 1
    assert counted == [r['used'] for r in stats['downlink_usage']]


def test_energy_deficit_periods_match_trace():
    session = _run('P03_energy')  # сценарий специально с дефицитом энергии
    stats = compute_stats(session.env)
    assert stats['energy_deficit_periods']  # тут дефицит точно есть

    for period in stats['energy_deficit_periods']:
        sid = period['satellite_id']
        for t in range(period['start_step'], period['end_step']):
            row = next(r for r in session.env.trace if r['step'] == t and r['satellite_id'] == sid)
            assert row['below_reserve'] or row['reason'] == 'energy_reserve', (sid, t)
        # шаг сразу после периода уже не должен быть в дефиците (иначе период
        # не был бы там разорван)
        end = period['end_step']
        if end < session.env.k:
            row = next(r for r in session.env.trace if r['step'] == end and r['satellite_id'] == sid)
            assert not (row['below_reserve'] or row['reason'] == 'energy_reserve')


def test_idle_reasons_are_known_categories():
    from planner.stats import IDLE_REASONS
    session = _run('P04_demand')
    stats = compute_stats(session.env)
    for sat in stats['satellites']:
        assert set(sat['idle_reasons']) <= set(IDLE_REASONS)
