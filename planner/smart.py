"""Планировщик поумнее baseline.py. Не трогаю model/ и baseline.py — просто
смотрю на env и решаю, кому что делать в этом шаге.

Как я это придумал:

1. Беру задания, которые уже открыты (released, не готовы, k < дедлайна).
2. Для каждого считаю future_slots — сколько шагов до дедлайна у него ещё
   останется контакт хоть с одним допустимым спутником. slack = future_slots
   минус оставшаяся работа. Если slack < 0 — задание физически не успеть,
   ресурсы на него не трачу (как в P01: если окно связи одно, а работы на
   два шага, никакой алгоритм это не спасёт).
3. Сортирую задания под цель (priority или commercial, см. ниже) и раздаю
   жадно, проверяя env.can_execute и лимit downlink за шаг.
4. Перед тем как отдать спутнику неглавную работу, гляжу вперёд по энергии:
   не посажу ли я его так, что он не дотянет до своего ближайшего задания
   приоритета 3 (downlink). Без deepcopy — считаю по солнцу и базовой
   нагрузке грубой формулой, это не полная физика, а прикидка.
6. Если спутник простаивает и калибровка истечёт раньше, чем понадобится
   следующее окно связи, калибрую заранее — но не отбираю шаг у задания,
   которому он нужен прямо сейчас и у которого нет запаса (slack == 0).

Для скорости строю индексы по спутникам один раз на "поколение" сценария
(пока не прилетело новое событие) и кэширую прямо на объекте env — это
не трогает model/, просто временный атрибут объекта в памяти.
"""
from __future__ import annotations

import bisect

GOALS = ('priority', 'commercial')


def _build_generation_cache(env) -> dict:
    """Строю один раз для текущего состояния env.s. Событие (add_jobs,
    outage, close_downlink) всегда пересоздаёт env.s целиком (так устроен
    model/operations.py), так что id(env.s) — готовый признак "всё то же
    самое или уже что-то поменялось".
    """
    n = env.s['time']['steps']
    sat_ids = list(env.sats)

    failed_at: dict[str, list[bool]] = {sid: [False] * n for sid in sat_ids}
    for f in env.s['failures']:
        flags = failed_at.get(f['satellite_id'])
        if flags is None:
            continue
        for t in range(f['start_step'], f['end_step']):
            flags[t] = True

    reachable: dict[str, dict[str, list[bool]]] = {}
    contact_steps: dict[str, dict[str, list[int]]] = {}
    solar_prefix: dict[str, list[float]] = {}
    for sid in sat_ids:
        env_sid = env.s['environment'][sid]
        not_failed = [not x for x in failed_at[sid]]
        reachable[sid] = {
            'downlink': [a and b for a, b in zip(env_sid['downlink_available'], not_failed)],
            'relay': [a and b for a, b in zip(env_sid['relay_available'], not_failed)],
        }
        contact_steps[sid] = {
            kind: [t for t, ok in enumerate(reachable[sid][kind]) if ok]
            for kind in ('downlink', 'relay')
        }
        prefix = [0.0] * (n + 1)
        solar = env_sid['solar_w']
        for t in range(n):
            prefix[t + 1] = prefix[t] + solar[t]
        solar_prefix[sid] = prefix

    return {
        'gen': id(env.s),
        'reachable': reachable,
        'contact_steps': contact_steps,
        'solar_prefix': solar_prefix,
        'job_prefix': {},  # job_id -> (release_step, prefix) — строю лениво, по мере надобности
    }


def _get_cache(env) -> dict:
    cache = getattr(env, '_smart_cache', None)
    if cache is None or cache['gen'] != id(env.s):
        cache = _build_generation_cache(env)
        env._smart_cache = cache
    return cache


def _job_prefix(cache: dict, job: dict) -> tuple[int, list[int]]:
    entry = cache['job_prefix'].get(job['id'])
    if entry is not None:
        return entry
    release, deadline = job['release_step'], job['deadline_step']
    kind = job['kind']
    reach = cache['reachable']
    elig = job['eligible_satellites']
    prefix = [0] * (deadline - release + 1)
    for i, t in enumerate(range(release, deadline)):
        ok = any(reach[sid][kind][t] for sid in elig)
        prefix[i + 1] = prefix[i] + (1 if ok else 0)
    entry = (release, prefix)
    cache['job_prefix'][job['id']] = entry
    return entry


def _future_slots(cache: dict, job: dict, k: int) -> int:
    release, prefix = _job_prefix(cache, job)
    lo = k - release  # k >= release всегда, т.к. задание уже "активно"
    hi = job['deadline_step'] - release
    return prefix[hi] - prefix[lo]


def _next_contact_step(cache: dict, sid: str, kind: str, start: int, end: int) -> int | None:
    if start >= end:
        return None
    steps = cache['contact_steps'][sid][kind]
    i = bisect.bisect_left(steps, start)
    if i < len(steps) and steps[i] < end:
        return steps[i]
    return None


def _energy_ok(env, cache: dict, sid: str, power: float, protected_job: dict | None,
               job_being_done: dict | None, reserve_wh: float) -> bool:
    """Проверяю, не посажу ли спутник так, что он не дотянет до своего
    ближайшего downlink-задания приоритета 3. Если такого задания нет, или
    это именно оно и есть — беспокоиться не о чем.
    """
    if protected_job is None:
        return True
    if job_being_done is not None and job_being_done['id'] == protected_job['id']:
        return True
    k = env.k
    target_step = _next_contact_step(cache, sid, 'downlink', k + 1, protected_job['deadline_step'])
    if target_step is None:
        return True  # это уже не спасти прогнозом, пусть решает can_execute

    en_after, _, _, _ = env.transition(sid, power)
    if target_step <= k + 1:
        projected = en_after
    else:
        span = target_step - (k + 1)
        prefix = cache['solar_prefix'][sid]
        avg_solar = (prefix[target_step] - prefix[k + 1]) / span
        v = env.sats[sid]
        m = env.s['model']
        dt = env.s['time']['step_s']
        net_w = avg_solar - v['base_w']  # грубо: без нагревателя и без полезной нагрузки
        delta = net_w * dt / 3600 * span
        delta *= m['charge_efficiency'] if net_w >= 0 else 1.0 / m['discharge_efficiency']
        projected = en_after + delta

    return projected >= reserve_wh


def decide_actions(env, goal: str, params: dict | None = None) -> dict[str, dict]:
    """Решаю действия на текущий шаг env.k.

    goal: 'priority' — успеть как можно больше приоритета 3, 'commercial' —
    выжать выручку. params сейчас не обязателен, там пока только
    energy_safety_margin_pct — если хочется беречь заряд с запасом сверху
    reserve_soc_pct, можно передать, например, 5.0.
    """
    if goal not in GOALS:
        raise ValueError(f"goal должен быть одним из {list(GOALS)}")
    params = params or {}
    margin_pct = params.get('energy_safety_margin_pct', 0.0)

    k = env.k
    active = [j for j in env.jobs.values()
              if j['completed_step'] is None and j['remaining_steps'] > 0
              and j['release_step'] <= k < j['deadline_step']]
    if not active:
        return {}

    cache = _get_cache(env)
    m = env.s['model']
    downlink_limit = m['downlink_parallel_limit']
    calib_valid = m['calibration_valid_steps']

    # 2. slack — заодно собираю, кому что нужно, одним проходом
    feasible: list[dict] = []
    slack_of: dict[str, int] = {}
    zero_slack: list[dict] = []
    nearest_p3_downlink: dict[str, dict] = {}
    jobs_by_satellite: dict[str, list[dict]] = {}
    for j in active:
        slots = _future_slots(cache, j, k)
        slack = slots - j['remaining_steps']
        if slack < 0:
            continue  # физически не успеть — не трогаем
        slack_of[j['id']] = slack
        feasible.append(j)
        if slack == 0:
            zero_slack.append(j)
        if j['kind'] == 'downlink' and j['priority'] == 3:
            sid = j['eligible_satellites'][0]
            cur = nearest_p3_downlink.get(sid)
            if cur is None or j['deadline_step'] < cur['deadline_step']:
                nearest_p3_downlink[sid] = j
        for sid in j['eligible_satellites']:
            jobs_by_satellite.setdefault(sid, []).append(j)

    # 3. порядок под цель
    if goal == 'priority':
        def sort_key(j):
            return (0 if j['priority'] == 3 else 1, slack_of[j['id']], -j['value_usd'])
    else:
        def sort_key(j):
            rate = j['value_usd'] / j['remaining_steps']
            return (0 if slack_of[j['id']] == 0 else 1, -rate, 0 if j['priority'] == 3 else 1)
    feasible.sort(key=sort_key)

    # 4-5. раздаю жадно, с оглядкой на энергию
    actions: dict[str, dict] = {}
    used_satellites: set[str] = set()
    assigned_job_ids: set[str] = set()
    downlinks_used = 0

    for j in feasible:
        if j['kind'] == 'downlink' and downlinks_used >= downlink_limit:
            continue
        candidates = [sid for sid in j['eligible_satellites'] if sid not in used_satellites]
        if j['kind'] == 'relay' and len(candidates) > 1:
            # берём спутника с большим запасом энергии над резервом
            reserve_of = {sid: env.sats[sid]['capacity_wh'] * m['reserve_soc_pct'] / 100 for sid in candidates}
            candidates.sort(key=lambda sid: env.state[sid]['energy_wh'] - reserve_of[sid], reverse=True)
        for sid in candidates:
            ok, _, power = env.can_execute(sid, {'action': 'job', 'job_id': j['id']})
            if not ok:
                continue
            reserve_wh = env.sats[sid]['capacity_wh'] * (m['reserve_soc_pct'] + margin_pct) / 100
            if not _energy_ok(env, cache, sid, power, nearest_p3_downlink.get(sid), j, reserve_wh):
                continue
            actions[sid] = {'action': 'job', 'job_id': j['id']}
            used_satellites.add(sid)
            assigned_job_ids.add(j['id'])
            if j['kind'] == 'downlink':
                downlinks_used += 1
            break

    # спутники, которые прямо сейчас нужны заданию без запаса (slack == 0),
    # если оно уже обслужено кем-то другим — эти спутники свободны
    zero_slack_needs_now: set[str] = set()
    for j in zero_slack:
        if j['id'] in assigned_job_ids:
            continue
        for sid in j['eligible_satellites']:
            if cache['reachable'][sid][j['kind']][k]:
                zero_slack_needs_now.add(sid)

    # 6. калибровка заранее — только простаивающим и только тем, у кого
    # действительно есть что впереди (jobs_by_satellite)
    for sid in env.sats:
        if sid in used_satellites or sid in zero_slack_needs_now:
            continue
        jobs_here = jobs_by_satellite.get(sid)
        if not jobs_here:
            continue
        needed = None
        for j in jobs_here:
            t = _next_contact_step(cache, sid, j['kind'], k, j['deadline_step'])
            if t is not None and (needed is None or t < needed):
                needed = t
        if needed is None:
            continue
        age_at_needed = env.state[sid]['calibration_age_steps'] + (needed - k)
        if age_at_needed < calib_valid:
            continue  # калибровка ещё продержится до нужного окна
        ok, _, _ = env.can_execute(sid, {'action': 'calibrate'})
        if ok:
            actions[sid] = {'action': 'calibrate'}
            used_satellites.add(sid)

    return actions
