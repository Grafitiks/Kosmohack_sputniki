"""Загрузка группировки: куда спутники тратят время и где не хватает
ресурсов. Это другой взгляд, чем planner/explain.py — там я разбираю
конкретное задание ("почему оно сорвалось"), тут смотрю от спутника
("чем он был занят"). Причины срыва задания и причины простоя спутника
специально не путаю — они отвечают на разные вопросы.

Для простоя проверяю то же самое, что и explain.py: если спутник ничего не
делал, смотрю, было ли для него вообще что делать (пендинг-задание с
контактом), и если было — реальная ли это была помеха (калибровка, энергия,
тепловой лимит, лимит наземной связи, отказ) или просто нечего было делать.
"""
from __future__ import annotations

from collections import Counter, defaultdict

from planner.explain import replay_can_execute

IDLE_REASONS = (
    'no_work', 'calibration_needed', 'satellite_unavailable',
    'energy_reserve', 'thermal_limit', 'ground_capacity', 'other',
)


class _StatsContext:
    def __init__(self, env):
        self.env = env
        self.downlink_limit = env.s['model']['downlink_parallel_limit']

        self.trace_index: dict[tuple[int, str], dict] = {}
        for row in env.trace:
            self.trace_index[(row['step'], row['satellite_id'])] = row

        self.failures: dict[str, list[tuple[int, int]]] = defaultdict(list)
        for f in env.s['failures']:
            self.failures[f['satellite_id']].append((f['start_step'], f['end_step']))

        self.jobs_by_satellite: dict[str, list[dict]] = defaultdict(list)
        for j in env.jobs.values():
            for sid in j['eligible_satellites']:
                self.jobs_by_satellite[sid].append(j)

        self.downlinks_used_per_step: dict[int, int] = defaultdict(int)
        for row in env.trace:
            if row['executed'] == 'job':
                j = env.jobs.get(row['requested'].get('job_id'))
                if j is not None and j['kind'] == 'downlink':
                    self.downlinks_used_per_step[row['step']] += 1

    def not_failed(self, sid: str, t: int) -> bool:
        return not any(a <= t < b for a, b in self.failures.get(sid, ()))

    def calib_age_before(self, sid: str, t: int) -> int:
        if t == 0:
            return self.env.sats[sid]['initial_calibration_age_steps']
        row = self.trace_index.get((t - 1, sid))
        return row['calibration_age_steps'] if row else self.env.sats[sid]['initial_calibration_age_steps']


def _classify_idle_step(ctx: _StatsContext, sid: str, t: int, calib_valid: int) -> str:
    if not ctx.not_failed(sid, t):
        return 'satellite_unavailable'

    # сначала смотрю, было ли вообще что делать — иначе просроченная
    # калибровка без единого пендинг-задания незаслуженно попадёт в причины
    # простоя, хотя спутнику всё равно нечего было делать
    candidates = [
        j for j in ctx.jobs_by_satellite.get(sid, ())
        if (j['completed_step'] is None or j['completed_step'] > t)
        and j['release_step'] <= t < j['deadline_step']
        and ctx.env.s['environment'][sid][j['kind'] + '_available'][t]
    ]
    if not candidates:
        return 'no_work'

    if ctx.calib_age_before(sid, t) >= calib_valid:
        return 'calibration_needed'

    # беру самого приоритетного кандидата — достаточно проверить его,
    # чтобы понять, была ли реальная физическая помеха
    job = max(candidates, key=lambda j: (j['priority'], j['value_usd']))
    row = ctx.trace_index[(t, sid)]
    ok, reason, _ = replay_can_execute(
        ctx.env, sid, job['id'], t,
        row['energy_before_wh'], row['temp_before_c'], ctx.calib_age_before(sid, t),
    )
    if not ok:
        if reason in ('energy_reserve', 'thermal_limit'):
            return reason
        return 'other'
    if job['kind'] == 'downlink' and ctx.downlinks_used_per_step.get(t, 0) >= ctx.downlink_limit:
        return 'ground_capacity'
    return 'other'  # спутник был свободен и мог бы — но алгоритм выбрал другое


def _deficit_periods(ctx: _StatsContext, sid: str, k: int) -> list[dict]:
    periods = []
    start = None
    for t in range(k):
        row = ctx.trace_index.get((t, sid))
        deficit = bool(row and (row['below_reserve'] or row['reason'] == 'energy_reserve'))
        if deficit and start is None:
            start = t
        elif not deficit and start is not None:
            periods.append({'satellite_id': sid, 'start_step': start, 'end_step': t})
            start = None
    if start is not None:
        periods.append({'satellite_id': sid, 'start_step': start, 'end_step': k})
    return periods


def compute_stats(env) -> dict:
    ctx = _StatsContext(env)
    k = env.k
    calib_valid = env.s['model']['calibration_valid_steps']
    sids = sorted(env.sats)

    satellites = []
    total_job_steps = 0
    total_contact_steps = 0
    for sid in sids:
        job_steps = 0
        calibration_steps = 0
        contact_steps = 0  # шагов, где был хоть какой-то контакт (downlink или relay) и спутник не в отказе
        idle_reasons: Counter = Counter()
        env_sid = env.s['environment'][sid]
        for t in range(k):
            row = ctx.trace_index.get((t, sid))
            if row is None:
                continue
            if (env_sid['downlink_available'][t] or env_sid['relay_available'][t]) and ctx.not_failed(sid, t):
                contact_steps += 1
            if row['executed'] == 'job':
                job_steps += 1
            elif row['executed'] == 'calibrate':
                calibration_steps += 1
            else:
                idle_reasons[_classify_idle_step(ctx, sid, t, calib_valid)] += 1
        idle_steps = sum(idle_reasons.values())
        total_job_steps += job_steps
        total_contact_steps += contact_steps
        satellites.append({
            'id': sid,
            'steps_total': k,
            'job_steps': job_steps,
            'calibration_steps': calibration_steps,
            'idle_steps': idle_steps,
            'job_share': round(job_steps / k, 4) if k else 0.0,
            'calibration_share': round(calibration_steps / k, 4) if k else 0.0,
            'idle_share': round(idle_steps / k, 4) if k else 0.0,
            'idle_reasons': {r: idle_reasons[r] for r in idle_reasons},
            # сколько было шагов с доступным контактом и какая их доля реально ушла на задания —
            # job_steps тут всегда подмножество contact_steps (задание не сделать без контакта)
            'contact_steps': contact_steps,
            'contact_utilization': round(job_steps / contact_steps, 4) if contact_steps else None,
        })

    downlink_usage = [
        {'step': t, 'used': ctx.downlinks_used_per_step.get(t, 0), 'limit': ctx.downlink_limit}
        for t in range(k)
    ]

    energy_deficit_periods = []
    for sid in sids:
        energy_deficit_periods.extend(_deficit_periods(ctx, sid, k))
    energy_deficit_periods.sort(key=lambda p: p['start_step'])

    return {
        'step': k,
        'satellites': satellites,
        'downlink_usage': downlink_usage,
        'energy_deficit_periods': energy_deficit_periods,
        # то же самое, что и per-satellite contact_utilization, но по всей группировке разом
        'contact_utilization': round(total_job_steps / total_contact_steps, 4) if total_contact_steps else None,
    }
