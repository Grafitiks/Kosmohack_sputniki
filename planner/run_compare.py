"""Гоняю baseline и smart на всех сценариях из data/ по обеим целям и
печатаю табличку — чтобы своими глазами увидеть, где умный планировщик
реально лучше простого правила, а где нет.

Запуск: python3 planner/run_compare.py
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from model.operations import Session
from model.resource_env import load
from planner.baseline import decide_actions as baseline_decide_actions
from planner.smart import decide_actions as smart_decide_actions

SCENARIOS = ('P01_intro', 'P02_shift', 'P03_energy', 'P04_demand')
# goal у baseline не используется, у smart называется priority/commercial —
# API-имя (для симметрии с server.py) я тоже указываю рядом
GOALS = (('priority', 'priority'), ('revenue', 'commercial'))


def run_one(scenario: dict, algorithm: str, smart_goal: str) -> tuple[dict, float]:
    session = Session(scenario, run_metadata={'goal': smart_goal, 'algorithm': algorithm, 'version': '1', 'parameters': {}})
    total = scenario['time']['steps']
    t0 = time.perf_counter()
    while session.env.k < total:
        if algorithm == 'baseline':
            actions = baseline_decide_actions(session.env)
        else:
            actions = smart_decide_actions(session.env, smart_goal)
        session.advance(actions)
    elapsed = time.perf_counter() - t0
    return session.summary(), elapsed


def main() -> None:
    rows = []
    for name in SCENARIOS:
        scenario = load(ROOT / 'data' / f'{name}.json')
        for api_goal, smart_goal in GOALS:
            for algorithm in ('baseline', 'smart'):
                summary, elapsed = run_one(scenario, algorithm, smart_goal)
                rows.append({
                    'scenario': name,
                    'goal': api_goal,
                    'algorithm': algorithm,
                    'completed': f"{summary['jobs_completed']}/{summary['jobs_total']}",
                    'critical_on_time': f"{summary['critical_jobs_completed_on_time']}/{summary['critical_jobs_due']}",
                    'revenue_usd': summary['revenue_usd'],
                    'blocked': summary['blocked_command_count'],
                    'seconds': round(elapsed, 3),
                })

    headers = ['scenario', 'goal', 'algorithm', 'completed', 'critical_on_time', 'revenue_usd', 'blocked', 'seconds']
    widths = {h: max(len(h), max(len(str(r[h])) for r in rows)) for h in headers}

    def fmt_row(values: dict) -> str:
        return ' | '.join(str(values[h]).ljust(widths[h]) for h in headers)

    print(fmt_row({h: h for h in headers}))
    print('-+-'.join('-' * widths[h] for h in headers))
    prev_scenario = None
    for r in rows:
        if prev_scenario is not None and r['scenario'] != prev_scenario:
            print('-+-'.join('-' * widths[h] for h in headers))
        print(fmt_row(r))
        prev_scenario = r['scenario']


if __name__ == '__main__':
    main()
