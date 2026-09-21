"""Простое правило для сравнения.

На каждом шаге берём задания, которые уже можно делать, и сортируем по сроку,
потом по приоритету, потом по цене. Раздаём спутникам по порядку, пока хватает
заряда и связи. Если спутнику нечего делать, а калибровка просрочена, калибруем.
Будущее не учитываем, каждый шаг решаем заново.
"""
from __future__ import annotations


def _sort_key(job: dict) -> tuple:
    return (job['deadline_step'], -job['priority'], -job['value_usd'])


def decide_actions(env) -> dict[str, dict]:
    k = env.k
    downlink_limit = env.s['model']['downlink_parallel_limit']
    calibration_valid_steps = env.s['model']['calibration_valid_steps']

    active_jobs = [
        j for j in env.jobs.values()
        if j['completed_step'] is None and j['remaining_steps'] > 0
        and j['release_step'] <= k < j['deadline_step']
    ]
    active_jobs.sort(key=_sort_key)

    actions: dict[str, dict] = {}
    used_satellites: set[str] = set()
    downlinks_used = 0
    pending_satellites: set[str] = set()

    for job in active_jobs:
        pending_satellites.update(job['eligible_satellites'])
        if job['kind'] == 'downlink' and downlinks_used >= downlink_limit:
            continue
        for sid in job['eligible_satellites']:
            if sid in used_satellites:
                continue
            ok, _, _ = env.can_execute(sid, {'action': 'job', 'job_id': job['id']})
            if ok:
                actions[sid] = {'action': 'job', 'job_id': job['id']}
                used_satellites.add(sid)
                if job['kind'] == 'downlink':
                    downlinks_used += 1
                break

    for sid in env.sats:
        if sid in used_satellites or sid not in pending_satellites:
            continue
        if env.state[sid]['calibration_age_steps'] < calibration_valid_steps:
            continue
        ok, _, _ = env.can_execute(sid, {'action': 'calibrate'})
        if ok:
            actions[sid] = {'action': 'calibrate'}
            used_satellites.add(sid)

    return actions
