"""Прогоняет смену по простому правилу и сохраняет результат.

Пример: python3 planner/run_baseline.py data/P01_intro.json
Результат ложится в results/<id>_baseline.json, потом проверяем, что расчёт
повторяется. События можно передать через --events.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from model.operations import Session, replay_episode
from model.resource_env import load
from planner.baseline import decide_actions


def run(scenario_path: Path, events_path: Path | None = None) -> Session:
    scenario = load(scenario_path)
    session = Session(scenario, run_metadata={
        'goal': 'priority',
        'algorithm': 'baseline_deadline_priority_value',
        'version': '1',
        'parameters': {},
    })

    events_by_step: dict[int, list[dict]] = {}
    if events_path is not None:
        event_file = json.loads(events_path.read_text(encoding='utf-8-sig'))
        if event_file.get('base_scenario') != scenario['meta']['id']:
            raise ValueError('Events refer to a different base scenario')
        for e in event_file['events']:
            events_by_step.setdefault(e['at_step'], []).append(e)

    steps = scenario['time']['steps']
    while session.env.k < steps:
        for e in events_by_step.get(session.env.k, []):
            session.apply_event(e)
        session.advance(decide_actions(session.env))
    return session


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('scenario', type=Path, help='файл сценария')
    parser.add_argument('--events', type=Path, default=None, help='файл событий (не обязательно)')
    parser.add_argument('--output', type=Path, default=None, help='куда сохранить результат')
    args = parser.parse_args()

    session = run(args.scenario, args.events)
    result = session.result()

    output = args.output or ROOT / 'results' / f"{result['initial_scenario']['meta']['id']}_baseline.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')

    replayed = replay_episode(result['initial_scenario'], result['events'], result['commands'], result['steps_executed'])
    if replayed.summary() != session.summary():
        raise SystemExit('Пересчёт не совпал с прогоном')

    print(f'Сохранено: {output}')
    print('Повтор расчёта совпал.')
    print(json.dumps(session.summary(), ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
