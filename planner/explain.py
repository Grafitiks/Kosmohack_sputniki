"""Объясняю, почему конкретное задание не выполнено (или пока не выполнено).

Идея такая: сперва смотрю на окно задания [release, deadline) целиком — если
даже суммарного контакта у допустимых спутников не хватает на work_steps
шагов, то задание нельзя было выполнить в принципе, при любом алгоритме, и
дальше разбирать нечего.

Если контакта в сумме хватало, иду по trace шаг за шагом и смотрю, что
произошло на каждом шаге, где контакт был, а задание не продвинулось:
спутник делал другое задание, калибровался, был в отказе, не хватило
энергии до резерва или упёрлись в тепловой лимит, не было места в лимите
наземной связи, или планировщик сам решил, что запас (slack) уже
отрицательный и дальше пытаться бессмысленно.

Трюк с "а что было бы, если бы спутнику дали это задание" (энергия,
температура, калибровка) я не считаю заново вручную — трейс уже хранит
energy_before_wh/temp_before_c на каждом шаге для каждого спутника,
независимо от того, что там реально произошло, а calibration_age_steps с
предыдущего шага. Beру эти значения и на секунду подменяю ими env.k и
env.state[sid], зову настоящий env.can_execute() (он и есть источник
истины по всем правилам модели) и сразу возвращаю всё обратно. Это не
трогает model/ — просто на мгновение использую его метод с историческими
данными вместо текущих.

Причины срыва задания (этот модуль) и причины простоя спутника
(planner/stats.py) — разные вещи, я их не смешиваю: тут смотрю от задания
"почему оно не продвинулось", там — от спутника "куда делось его время".
"""
from __future__ import annotations

from collections import Counter, defaultdict

CATEGORY_PRIORITY = [
    'occupied', 'calibration', 'satellite_unavailable',
    'energy_reserve', 'thermal_limit', 'ground_capacity', 'other',
]

CATEGORY_TEXT = {
    'occupied': 'спутник был занят другими заданиями',
    'calibration': 'мешала калибровка',
    'energy_reserve': 'не хватало энергии до резерва',
    'thermal_limit': 'мешал тепловой лимит',
    'ground_capacity': 'не было места в лимите наземной связи (2 downlink за шаг)',
    'satellite_unavailable': 'спутник был в отказе',
    'slack_negative': 'планировщик сам отказался — запас по времени уже кончился',
    'other': 'причина не определилась однозначно (похоже, алгоритм просто выбрал другое)',
}


class _Context:
    """Всё, что считаю один раз на сессию, а не на каждое задание заново."""

    def __init__(self, env):
        self.env = env
        self.downlink_limit = env.s['model']['downlink_parallel_limit']

        self.trace_index: dict[tuple[int, str], dict] = {}
        for row in env.trace:
            self.trace_index[(row['step'], row['satellite_id'])] = row

        self.failures: dict[str, list[tuple[int, int]]] = defaultdict(list)
        for f in env.s['failures']:
            self.failures[f['satellite_id']].append((f['start_step'], f['end_step']))

        self.downlinks_used_per_step: dict[int, int] = defaultdict(int)
        for row in env.trace:
            if row['executed'] == 'job':
                j = env.jobs.get(row['requested'].get('job_id'))
                if j is not None and j['kind'] == 'downlink':
                    self.downlinks_used_per_step[row['step']] += 1

        self._job_prefix_cache: dict[str, tuple[int, list[int]]] = {}
        self._job_per_sat_cache: dict[str, dict[str, int]] = {}

    def not_failed(self, sid: str, t: int) -> bool:
        return not any(a <= t < b for a, b in self.failures.get(sid, ()))

    def calib_age_before(self, sid: str, t: int) -> int:
        """Возраст калибровки ДО шага t — то, что реально видел бы can_execute."""
        if t == 0:
            return self.env.sats[sid]['initial_calibration_age_steps']
        row = self.trace_index.get((t - 1, sid))
        return row['calibration_age_steps'] if row else self.env.sats[sid]['initial_calibration_age_steps']

    def job_union_prefix(self, job: dict) -> tuple[int, list[int]]:
        """Префиксная сумма: сколько шагов от release набралось с контактом
        хоть у одного допустимого спутника. Строю один раз на задание.
        """
        entry = self._job_prefix_cache.get(job['id'])
        if entry is not None:
            return entry
        release, deadline = job['release_step'], job['deadline_step']
        kind, eligible = job['kind'], job['eligible_satellites']
        prefix = [0] * (deadline - release + 1)
        for i, t in enumerate(range(release, deadline)):
            ok = any(self.env.s['environment'][sid][kind + '_available'][t] and self.not_failed(sid, t)
                    for sid in eligible)
            prefix[i + 1] = prefix[i] + (1 if ok else 0)
        entry = (release, prefix)
        self._job_prefix_cache[job['id']] = entry
        return entry

    def future_slots_from(self, job: dict, t: int) -> int:
        release, prefix = self.job_union_prefix(job)
        lo, hi = t - release, job['deadline_step'] - release
        return prefix[hi] - prefix[lo]

    def per_satellite_contacts(self, job: dict) -> dict[str, int]:
        cached = self._job_per_sat_cache.get(job['id'])
        if cached is not None:
            return cached
        release, deadline = job['release_step'], job['deadline_step']
        kind, eligible = job['kind'], job['eligible_satellites']
        counts = {sid: 0 for sid in eligible}
        for t in range(release, deadline):
            for sid in eligible:
                if self.env.s['environment'][sid][kind + '_available'][t] and self.not_failed(sid, t):
                    counts[sid] += 1
        self._job_per_sat_cache[job['id']] = counts
        return counts


def replay_can_execute(env, sid: str, job_id: str, t: int, energy_wh: float, temp_c: float, calib_age: int):
    """Спрашиваю у настоящего env.can_execute, приняло бы оно это задание на
    шаге t, если бы у спутника было именно такое (историческое) состояние.
    Подменяю env.k и env.state[sid] и сразу же возвращаю как было — снаружи
    эта функция не оставляет следов. Публичная — её же использует
    planner/stats.py для похожего вопроса про простой спутника.
    """
    orig_k = env.k
    orig_state = env.state[sid]
    env.k = t
    env.state[sid] = {'energy_wh': energy_wh, 'temp_c': temp_c, 'calibration_age_steps': calib_age}
    try:
        return env.can_execute(sid, {'action': 'job', 'job_id': job_id})
    finally:
        env.k = orig_k
        env.state[sid] = orig_state


def _classify_lost_step(ctx: _Context, job: dict, t: int) -> tuple[str, dict | None]:
    env = ctx.env
    kind = job['kind']
    found: dict[str, dict | None] = {}
    for sid in job['eligible_satellites']:
        if not env.s['environment'][sid][kind + '_available'][t]:
            continue  # у этого спутника контакта на этом шаге и не было
        if not ctx.not_failed(sid, t):
            found.setdefault('satellite_unavailable', None)
            continue
        row = ctx.trace_index.get((t, sid))
        if row is None:
            continue
        if row['executed'] == 'job':
            other_id = row['requested'].get('job_id')
            other = env.jobs.get(other_id)
            found.setdefault('occupied', {'job_id': other_id, 'priority': other['priority'] if other else None})
            continue
        if row['executed'] == 'calibrate':
            found.setdefault('calibration', None)
            continue
        # спутник простаивал — проверяю по настоящей физике, приняло бы задание
        ok, reason, _ = replay_can_execute(
            env, sid, job['id'], t,
            row['energy_before_wh'], row['temp_before_c'], ctx.calib_age_before(sid, t),
        )
        if not ok:
            mapped = {
                'calibration_required': 'calibration',
                'satellite_unavailable': 'satellite_unavailable',
                'energy_reserve': 'energy_reserve',
                'thermal_limit': 'thermal_limit',
            }.get(reason, 'other')
            found.setdefault(mapped, None)
            continue
        if kind == 'downlink' and ctx.downlinks_used_per_step.get(t, 0) >= ctx.downlink_limit:
            found.setdefault('ground_capacity', None)
        else:
            found.setdefault('other', None)

    if not found:
        return 'other', None
    category = min(found, key=CATEGORY_PRIORITY.index)
    return category, found[category]


def _build_text(job: dict, status: str, main_reason: str | None,
                total_lost: int, contact_so_far: int, done_steps: int) -> str:
    head = (f"Задание {'не выполнено в срок' if status == 'missed' else 'пока не выполнено'} "
           f"(приоритет {job['priority']}, ${job['value_usd']:.2f}).")
    if main_reason is None:
        return head + ' За прожитые шаги окна потерь не нашлось — контакт есть, просто ещё не дошли руки.'
    reason_text = CATEGORY_TEXT.get(main_reason, main_reason)
    body = f' Из {contact_so_far} шагов с контактом потеряно {total_lost}, главная причина — {reason_text}.'
    tail = ''
    if done_steps > 0 and status == 'missed':
        tail = f' Успели сделать {done_steps} из {job["work_steps"]} шагов работы — это пропало впустую.'
    return head + body + tail


def _explain_job_impl(ctx: _Context, job_id: str) -> dict:
    env = ctx.env
    job = env.jobs[job_id]
    release, deadline = job['release_step'], job['deadline_step']
    kind, eligible, work_steps = job['kind'], job['eligible_satellites'], job['work_steps']
    status = 'missed' if deadline <= env.k else 'in_progress'
    done_steps = work_steps - job['remaining_steps']

    base = {
        'job_id': job_id, 'kind': kind, 'priority': job['priority'], 'value_usd': job['value_usd'],
        'release_step': release, 'deadline_step': deadline, 'work_steps': work_steps,
        'eligible_satellites': eligible, 'status': status,
    }

    _, prefix = ctx.job_union_prefix(job)
    contact_steps = prefix[-1]

    if contact_steps < work_steps:
        per_sat = ctx.per_satellite_contacts(job)
        text = (f'Успеть нельзя ни при каких действиях: заданию нужно {work_steps} шаг(ов) работы, '
               f'а контакт в окне [{release}, {deadline}) набирается только на {contact_steps} '
               '(' + ', '.join(f'{sid}: {c}' for sid, c in per_sat.items()) + ').')
        base.update({
            'verdict': 'impossible_by_contact_window',
            'text': text,
            'proof': {'work_steps': work_steps, 'contact_steps': contact_steps, 'per_satellite_contacts': per_sat},
            'lost_steps_by_reason': {},
            'main_reason': 'impossible_by_contact_window',
            'wasted_progress_steps': done_steps if status == 'missed' else 0,
        })
        return base

    if env.k <= release:
        base.update({
            'verdict': 'not_released_yet',
            'text': f'Задание ещё не открылось, окно начнётся на шаге {release}.',
            'proof': {'work_steps': work_steps, 'contact_steps': contact_steps},
            'lost_steps_by_reason': {},
            'main_reason': None,
            'wasted_progress_steps': 0,
        })
        return base

    analysis_end = min(deadline, env.k)
    remaining = work_steps
    lost_counts: Counter = Counter()
    lost_examples: dict[str, list[dict]] = defaultdict(list)

    for t in range(release, analysis_end):
        served = False
        for sid in eligible:
            row = ctx.trace_index.get((t, sid))
            if row is not None and row['executed'] == 'job' and row['requested'].get('job_id') == job_id:
                served = True
                break
        if served:
            remaining -= 1
            continue
        if remaining <= 0:
            continue
        if not any(env.s['environment'][sid][kind + '_available'][t] for sid in eligible):
            continue  # контакта в этот момент вообще не было ни у кого — не потерянный шаг, а закрытое окно

        slack = ctx.future_slots_from(job, t) - remaining
        if slack < 0:
            category, detail = 'slack_negative', None
        else:
            category, detail = _classify_lost_step(ctx, job, t)
        lost_counts[category] += 1
        if len(lost_examples[category]) < 5:
            entry = {'step': t}
            if detail:
                entry.update(detail)
            lost_examples[category].append(entry)

    total_lost = sum(lost_counts.values())
    main_reason = lost_counts.most_common(1)[0][0] if lost_counts else None
    contact_so_far = prefix[analysis_end - release]
    text = _build_text(job, status, main_reason, total_lost, contact_so_far, done_steps)

    base.update({
        'verdict': main_reason or 'on_track',
        'text': text,
        'proof': {
            'work_steps': work_steps, 'contact_steps': contact_steps,
            'analyzed_window': [release, analysis_end], 'contact_steps_so_far': contact_so_far,
            'lost_steps_total': total_lost,
        },
        'lost_steps_by_reason': dict(lost_counts),
        'lost_steps_examples': dict(lost_examples),
        'main_reason': main_reason,
        'wasted_progress_steps': done_steps if status == 'missed' else 0,
    })
    return base


def explain_job(env, job_id: str) -> dict:
    """Разбор одного задания. Для уже выполненного просто говорю, что оно
    выполнено — разбирать тут нечего.
    """
    job = env.jobs.get(job_id)
    if job is None:
        raise ValueError(f'задание {job_id!r} не найдено')
    if job['completed_step'] is not None:
        return {
            'job_id': job_id, 'kind': job['kind'], 'priority': job['priority'], 'value_usd': job['value_usd'],
            'status': 'done', 'verdict': 'done',
            'text': f"Задание выполнено на шаге {job['completed_step']}, разбирать нечего.",
            'proof': {}, 'lost_steps_by_reason': {}, 'main_reason': None, 'wasted_progress_steps': 0,
        }
    ctx = _Context(env)
    return _explain_job_impl(ctx, job_id)


def explain_all(env) -> dict:
    """Сводка по всем не выполненным заданиям: сколько по каждой причине и
    топ-10 самых дорогих просроченных приоритета 3.
    """
    ctx = _Context(env)
    reason_counts: Counter = Counter()
    all_results = []
    for job in env.jobs.values():
        if job['completed_step'] is not None:
            continue
        result = _explain_job_impl(ctx, job['id'])
        reason_counts[result['verdict']] += 1
        all_results.append(result)

    priority_results = [r for r in all_results if r['priority'] == 3]
    priority_results.sort(key=lambda r: -r['value_usd'])

    return {
        'step': env.k,
        'jobs_not_completed': len(all_results),
        'reasons': dict(reason_counts),
        'top_priority_jobs': priority_results[:10],
    }
