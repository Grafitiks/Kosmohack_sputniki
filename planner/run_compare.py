"""Гоняю baseline и smart на всех сценариях из data/ по обеим целям и
печатаю табличку — чтобы своими глазами увидеть, где умный планировщик
реально лучше простого правила, а где нет, и сколько теряем против
теоретического потолка.

Дополнительно гоняю P02 ещё и с events_demo.json — проверить, как обе
стратегии реагируют на события посреди смены.

Каждый прогон сохраняю в results/<сценарий>_<algorithm>_<goal>.json (тем же
форматом, что и run_baseline.py, — его можно повторить через
model/operations.py --result). Саму табличку сохраняю в results/comparison.md.

Запуск: python3 planner/run_compare.py
"""
from __future__ import annotations

import copy
import json
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
ALGORITHM_METADATA = {
    'baseline': {'algorithm': 'baseline_deadline_priority_value', 'version': '1'},
    'smart': {'algorithm': 'smart_lookahead', 'version': '1'},
}
RESULTS_DIR = ROOT / 'results'


def merge_events_into_scenario(scenario: dict, events: list[dict]) -> dict:
    """Склеиваю сценарий с событиями в один — так же, как это делает
    apply_event в model/operations.py, только на голых данных, без прогона
    самой модели. Нужно только для подсчёта потолка по контактам (ниже):
    там я хочу учитывать и задания, и отказы, которые принесли события.
    """
    merged = copy.deepcopy(scenario)
    for e in events:
        if e['type'] == 'add_jobs':
            merged['jobs'].extend(e['jobs'])
        elif e['type'] == 'satellite_outage':
            for sid in e['satellite_ids']:
                merged['failures'].append({'satellite_id': sid, 'start_step': e['at_step'], 'end_step': e['end_step']})
        elif e['type'] == 'close_downlink':
            for sid in e['satellite_ids']:
                at, end = e['at_step'], e['end_step']
                merged['environment'][sid]['downlink_available'][at:end] = [False] * (end - at)
    return merged


def contact_ceiling(scenario: dict) -> tuple[int, int, int, int]:
    """Верхняя граница по одним только окнам связи: не смотрю ни на энергию,
    ни на лимит наземной связи (2 downlink за шаг) — просто считаю, у
    скольких заданий от release до deadline вообще набирается хотя бы
    work_steps шагов, когда у кого-то из допустимых спутников есть контакт
    (и спутник не в отказе). Дальше это не расписание, а просто счётчик —
    выше него не запрыгнет никакой алгоритм.

    Возвращает (сколько заданий проходит, всего заданий,
    сколько из них приоритета 3, всего приоритета 3).
    """
    ids = [v['id'] for v in scenario['satellites']]
    n = scenario['time']['steps']
    failed: dict[str, list[bool]] = {sid: [False] * n for sid in ids}
    for f in scenario['failures']:
        flags = failed.get(f['satellite_id'])
        if flags is None:
            continue
        for t in range(f['start_step'], f['end_step']):
            flags[t] = True

    reachable_jobs = 0
    reachable_priority = 0
    total_priority = sum(1 for j in scenario['jobs'] if j['priority'] == 3)
    for j in scenario['jobs']:
        kind_key = j['kind'] + '_available'
        elig = j['eligible_satellites']
        env = scenario['environment']
        count = 0
        for t in range(j['release_step'], j['deadline_step']):
            if any(env[sid][kind_key][t] and not failed[sid][t] for sid in elig):
                count += 1
                if count >= j['work_steps']:
                    break  # дальше можно не считать, тут уже хватает
        if count >= j['work_steps']:
            reachable_jobs += 1
            if j['priority'] == 3:
                reachable_priority += 1
    return reachable_jobs, len(scenario['jobs']), reachable_priority, total_priority


def run_one(scenario: dict, algorithm: str, api_goal: str, smart_goal: str,
           events_by_step: dict[int, list[dict]] | None = None) -> tuple[Session, float]:
    meta = ALGORITHM_METADATA[algorithm]
    session = Session(scenario, run_metadata={
        'goal': api_goal, 'algorithm': meta['algorithm'], 'version': meta['version'], 'parameters': {},
    })
    total = scenario['time']['steps']
    events_by_step = events_by_step or {}
    t0 = time.perf_counter()
    while session.env.k < total:
        for e in events_by_step.get(session.env.k, []):
            session.apply_event(e)
        if algorithm == 'baseline':
            actions = baseline_decide_actions(session.env)
        else:
            actions = smart_decide_actions(session.env, smart_goal)
        session.advance(actions)
    elapsed = time.perf_counter() - t0
    return session, elapsed


def save_result(session: Session, name: str, algorithm: str, api_goal: str) -> Path:
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    path = RESULTS_DIR / f'{name}_{algorithm}_{api_goal}.json'
    path.write_text(json.dumps(session.result(), ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')
    return path


def build_row(name: str, api_goal: str, algorithm: str, session: Session, elapsed: float, ceiling: tuple) -> dict:
    summary = session.summary()
    reachable_jobs, total_jobs, reachable_priority, total_priority = ceiling
    return {
        'scenario': name,
        'goal': api_goal,
        'algorithm': algorithm,
        'ceiling_jobs': f'{reachable_jobs}/{total_jobs}',
        'ceiling_critical': f'{reachable_priority}/{total_priority}',
        'completed': f"{summary['jobs_completed']}/{summary['jobs_total']}",
        'critical_on_time': f"{summary['critical_jobs_completed_on_time']}/{summary['critical_jobs_due']}",
        'revenue_usd': summary['revenue_usd'],
        'blocked': summary['blocked_command_count'],
        'seconds': round(elapsed, 3),
    }


def print_table(rows: list[dict], headers: list[str]) -> None:
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


def save_markdown(rows: list[dict], headers: list[str], path: Path) -> None:
    lines = [
        '# Сравнение baseline и smart',
        '',
        'Прогнал обе стратегии на всех наших сценариях по обеим целям. '
        '`ceiling_jobs`/`ceiling_critical` — сколько заданий (и отдельно приоритетных) можно '
        'успеть вообще, если бы хватало энергии и наземных каналов без ограничений — '
        'это верхняя граница по одним только окнам связи, разрыв до неё показывает, '
        'сколько теряем на ресурсах и на самом алгоритме. Отдельно внизу — P02 с событиями '
        'из examples/events_demo.json.',
        '',
        '| ' + ' | '.join(headers) + ' |',
        '|' + '|'.join(['---'] * len(headers)) + '|',
    ]
    for r in rows:
        lines.append('| ' + ' | '.join(str(r[h]) for h in headers) + ' |')
    path.write_text('\n'.join(lines) + '\n', encoding='utf-8')


def main() -> None:
    headers = ['scenario', 'goal', 'algorithm', 'ceiling_jobs', 'ceiling_critical',
              'completed', 'critical_on_time', 'revenue_usd', 'blocked', 'seconds']
    rows = []

    for name in SCENARIOS:
        scenario = load(ROOT / 'data' / f'{name}.json')
        ceiling = contact_ceiling(scenario)
        for api_goal, smart_goal in GOALS:
            for algorithm in ('baseline', 'smart'):
                session, elapsed = run_one(scenario, algorithm, api_goal, smart_goal)
                save_result(session, name, algorithm, api_goal)
                rows.append(build_row(name, api_goal, algorithm, session, elapsed, ceiling))

    # P02 с событиями из examples/events_demo.json — отдельная группа строк
    events_name = 'P02_shift_events'
    base_scenario = load(ROOT / 'data' / 'P02_shift.json')
    events = json.loads((ROOT / 'examples' / 'events_demo.json').read_text())['events']
    events_by_step: dict[int, list[dict]] = {}
    for e in events:
        events_by_step.setdefault(e['at_step'], []).append(e)
    events_ceiling = contact_ceiling(merge_events_into_scenario(base_scenario, events))
    for api_goal, smart_goal in GOALS:
        for algorithm in ('baseline', 'smart'):
            session, elapsed = run_one(base_scenario, algorithm, api_goal, smart_goal, events_by_step)
            save_result(session, events_name, algorithm, api_goal)
            rows.append(build_row(events_name, api_goal, algorithm, session, elapsed, events_ceiling))

    print_table(rows, headers)
    md_path = RESULTS_DIR / 'comparison.md'
    save_markdown(rows, headers, md_path)
    print(f'\nТаблица сохранена в {md_path}')
    print(f'Результаты прогонов — в {RESULTS_DIR}/<сценарий>_<algorithm>_<goal>.json')


if __name__ == '__main__':
    main()
