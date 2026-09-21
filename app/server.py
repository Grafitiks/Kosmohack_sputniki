"""Бэкенд сервиса на FastAPI.

Держит сессии смены в памяти (по случайному id) и крутит модель организаторов
(model/resource_env.py, model/operations.py) через простое правило из
planner/baseline.py. Отдаёт JSON по /api/..., статику интерфейса — из
app/static/.

Запуск: python3 app/server.py (или uvicorn app.server:app --reload)
"""
from __future__ import annotations

import copy
import sys
import threading
import uuid
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from fastapi import Body, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from model.operations import Session
from model.resource_env import load, validate
from planner.baseline import decide_actions

DATA_DIR = ROOT / 'data'
STATIC_DIR = Path(__file__).resolve().parent / 'static'
GOALS = ('priority', 'revenue')

app = FastAPI(title='Kosmohack sputniki backend')

# Разрешаем все источники, чтобы фронтенд второго участника мог стучаться
# с любого dev-порта, пока не собран в app/static.
app.add_middleware(CORSMiddleware, allow_origins=['*'], allow_methods=['*'], allow_headers=['*'])


class ApiError(Exception):
    """Ошибка входных данных или запроса — превращается в {"error": ...}."""

    def __init__(self, message: str, status_code: int = 400):
        self.message = message
        self.status_code = status_code


@app.exception_handler(ApiError)
async def handle_api_error(request, exc: ApiError):
    return JSONResponse(status_code=exc.status_code, content={'error': exc.message})


@app.exception_handler(ValueError)
async def handle_value_error(request, exc: ValueError):
    # Сюда попадают ошибки из model/resource_env.py и model/operations.py:
    # там уже написан понятный текст, просто отдаём его как есть.
    return JSONResponse(status_code=400, content={'error': str(exc)})


@app.exception_handler(Exception)
async def handle_unexpected(request, exc: Exception):
    import traceback
    traceback.print_exc()
    return JSONResponse(status_code=500, content={'error': f'внутренняя ошибка: {exc}'})


def _require_int(value: Any, name: str, minimum: int | None = None, maximum: int | None = None) -> int:
    if type(value) is not int:
        raise ApiError(f'{name} должен быть целым числом')
    if minimum is not None and value < minimum:
        raise ApiError(f'{name} должен быть не меньше {minimum}')
    if maximum is not None and value > maximum:
        raise ApiError(f'{name} должен быть не больше {maximum}')
    return value


def _require_goal(value: Any, name: str = 'goal') -> str:
    if value not in GOALS:
        raise ApiError(f'{name} должен быть одним из {list(GOALS)}')
    return value


# ---------------------------------------------------------------------------
# Планировщик вызывается отсюда — одна точка входа. Сейчас тут всегда простое
# правило, цель смены на выбор действий не влияет. Когда будет настоящий
# планировщик, менять только эту функцию.
# ---------------------------------------------------------------------------
def plan_step(env, goal: str) -> dict[str, dict]:
    return decide_actions(env)


def run_to_end(session: Session, goal: str) -> None:
    total = session.env.s['time']['steps']
    while session.env.k < total:
        session.advance(plan_step(session.env, goal))


class SessionRecord:
    def __init__(self, session: Session, goal: str):
        self.session = session
        self.goal = goal
        self.lock = threading.Lock()


SESSIONS: dict[str, SessionRecord] = {}
SESSIONS_LOCK = threading.Lock()

# Сценарии с правками оператора (overrides) храним тут же, в памяти, под
# отдельным id вида "custom-...". В data/ ничего не пишем и не трогаем.
CUSTOM_SCENARIOS: dict[str, dict] = {}
CUSTOM_LOCK = threading.Lock()


def get_record(session_id: str) -> SessionRecord:
    record = SESSIONS.get(session_id)
    if record is None:
        raise ApiError('сессия не найдена', status_code=404)
    return record


def load_scenario_by_id(scenario_id: Any) -> dict:
    if not isinstance(scenario_id, str) or not scenario_id:
        raise ApiError('scenario_id должен быть непустой строкой')
    with CUSTOM_LOCK:
        custom = CUSTOM_SCENARIOS.get(scenario_id)
    if custom is not None:
        return copy.deepcopy(custom)
    path = DATA_DIR / f'{scenario_id}.json'
    if not path.exists():
        raise ApiError(f'сценарий {scenario_id!r} не найден', status_code=404)
    return load(path)


def scenario_summary(scenario_id: str, scenario: dict) -> dict:
    return {
        'id': scenario_id,
        'title': scenario['meta']['title'],
        'satellites': len(scenario['satellites']),
        'steps': scenario['time']['steps'],
        'jobs': len(scenario['jobs']),
    }


def list_scenarios() -> list[dict]:
    items = []
    for path in sorted(DATA_DIR.glob('*.json')):
        scenario = load(path)
        items.append(scenario_summary(scenario['meta']['id'], scenario))
    with CUSTOM_LOCK:
        custom_items = list(CUSTOM_SCENARIOS.items())
    for scenario_id, scenario in custom_items:
        items.append(scenario_summary(scenario_id, scenario))
    return items


def _require_number(value: Any, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ApiError(f'{name} должен быть числом')
    return float(value)


def _override_satellite(o: Any, name: str, sat_ids: set[str]) -> str:
    if not isinstance(o, dict):
        raise ApiError(f'overrides.{name} должен быть объектом')
    sid = o.get('satellite_id')
    if sid not in sat_ids:
        raise ApiError(f'overrides.{name}: спутник {sid!r} не найден в сценарии')
    return sid


def apply_overrides(scenario: dict, overrides: Any) -> dict:
    """Правит копию сценария под эксперимент оператора. Саму scenario не трогаем.

    Понимает четыре вида правок: initial_soc_pct, solar_factor, priority, outage.
    В конце гоняем через validate() из model/resource_env.py — она и найдёт
    все нарушения границ (не мы придумываем свои правила поверх модели).
    """
    if not isinstance(overrides, dict):
        raise ApiError('overrides должен быть объектом')
    known = {'initial_soc_pct', 'solar_factor', 'priority', 'outage'}
    unknown = set(overrides) - known
    if unknown:
        raise ApiError(f'неизвестные overrides: {sorted(unknown)}')

    candidate = copy.deepcopy(scenario)
    sat_ids = {v['id'] for v in candidate['satellites']}
    job_ids = {j['id'] for j in candidate['jobs']}

    if 'initial_soc_pct' in overrides:
        o = overrides['initial_soc_pct']
        sid = _override_satellite(o, 'initial_soc_pct', sat_ids)
        value = _require_number(o.get('value'), 'overrides.initial_soc_pct.value')
        for v in candidate['satellites']:
            if v['id'] == sid:
                v['initial_soc_pct'] = value

    if 'solar_factor' in overrides:
        o = overrides['solar_factor']
        if not isinstance(o, dict):
            raise ApiError('overrides.solar_factor должен быть объектом')
        factor = _require_number(o.get('value'), 'overrides.solar_factor.value')
        if factor < 0:
            raise ApiError('overrides.solar_factor.value не может быть отрицательным')
        sid = o.get('satellite_id')
        if sid is None:
            targets = sorted(sat_ids)
        elif sid in sat_ids:
            targets = [sid]
        else:
            raise ApiError(f'overrides.solar_factor: спутник {sid!r} не найден в сценарии')
        for t in targets:
            env = candidate['environment'][t]
            env['solar_w'] = [x * factor for x in env['solar_w']]

    if 'priority' in overrides:
        o = overrides['priority']
        if not isinstance(o, dict):
            raise ApiError('overrides.priority должен быть объектом')
        job_id = o.get('job_id')
        if job_id not in job_ids:
            raise ApiError(f'overrides.priority: задание {job_id!r} не найдено в сценарии')
        value = o.get('value')
        if type(value) is not int:
            raise ApiError('overrides.priority.value должен быть целым числом')
        for j in candidate['jobs']:
            if j['id'] == job_id:
                j['priority'] = value

    if 'outage' in overrides:
        o = overrides['outage']
        sid = _override_satellite(o, 'outage', sat_ids)
        start = o.get('start_step')
        end = o.get('end_step')
        if type(start) is not int or type(end) is not int:
            raise ApiError('overrides.outage.start_step и end_step должны быть целыми числами')
        candidate['failures'].append({'satellite_id': sid, 'start_step': start, 'end_step': end})

    validate(candidate)
    return candidate


def resolve_scenario(payload: dict) -> dict:
    """Достаёт сценарий из payload (по id или целиком) и накладывает overrides."""
    scenario = payload.get('scenario')
    scenario_id = payload.get('scenario_id')
    if scenario is not None:
        if not isinstance(scenario, dict):
            raise ApiError('scenario должен быть объектом')
        scenario = copy.deepcopy(scenario)
    elif scenario_id:
        scenario = load_scenario_by_id(scenario_id)
    else:
        raise ApiError('нужно передать scenario_id или scenario')

    overrides = payload.get('overrides')
    if overrides:
        scenario = apply_overrides(scenario, overrides)
    return scenario


def job_status(job: dict, step: int) -> str:
    if job['completed_step'] is not None:
        return 'done'
    if job['deadline_step'] <= step:
        return 'missed'
    if job['release_step'] <= step:
        return 'active'
    return 'waiting'


def build_state(session_id: str, record: SessionRecord) -> dict:
    """Собирает состояние сессии ровно в формате app/mock/state_example.json."""
    session = record.session
    env = session.env
    step = env.k
    sids = sorted(env.sats)
    n = len(sids)
    calib_valid = env.s['model']['calibration_valid_steps']

    satellites = []
    for sid in sids:
        v = env.sats[sid]
        st = env.state[sid]
        satellites.append({
            'id': sid,
            'capacity_wh': v['capacity_wh'],
            'soc_pct': round(100 * st['energy_wh'] / v['capacity_wh'], 6),
            'temp_c': round(st['temp_c'], 6),
            'calibration_age_steps': st['calibration_age_steps'],
            'calibration_valid_steps': calib_valid,
            'available': env.available(sid),
        })

    jobs = []
    for j in env.jobs.values():
        jobs.append({
            'id': j['id'],
            'kind': j['kind'],
            'priority': j['priority'],
            'value_usd': j['value_usd'],
            'release_step': j['release_step'],
            'deadline_step': j['deadline_step'],
            'work_steps': j['work_steps'],
            'remaining_steps': j['remaining_steps'],
            'eligible_satellites': j['eligible_satellites'],
            'status': job_status(j, step),
            'completed_step': j['completed_step'],
        })

    # Ряды заряда и температуры по шагам: индекс 0 — начальное состояние,
    # индекс i (i>=1) — состояние сразу после шага i-1. env.trace хранит
    # строки шаг-за-шагом, внутри шага — по спутникам в алфавитном порядке
    # (так же, как их перебирает Environment.step), поэтому просто режем
    # список по n штук на шаг.
    soc_series = {sid: [round(env.sats[sid]['initial_soc_pct'], 6)] for sid in sids}
    temp_series = {sid: [round(env.sats[sid]['initial_temp_c'], 6)] for sid in sids}
    for s in range(step):
        for row in env.trace[s * n:(s + 1) * n]:
            sid = row['satellite_id']
            cap = env.sats[sid]['capacity_wh']
            soc_series[sid].append(round(100 * row['energy_after_wh'] / cap, 6))
            temp_series[sid].append(round(row['temp_after_c'], 6))

    last_step_rows = []
    if step > 0:
        for row in env.trace[(step - 1) * n:step * n]:
            last_step_rows.append({
                'satellite_id': row['satellite_id'],
                'requested': row['requested'],
                'executed': row['executed'],
                'reason': row['reason'],
                'completed_job': row['completed_job'],
                'load_w': row['load_w'],
                'solar_w': row['solar_w'],
            })

    m = env.s['model']
    return {
        'session_id': session_id,
        'scenario': env.s['meta']['id'],
        'title': env.s['meta']['title'],
        'goal': record.goal,
        'step': step,
        'total_steps': env.s['time']['steps'],
        'satellites': satellites,
        'jobs': jobs,
        'series': {
            'steps': list(range(step + 1)),
            'soc_pct': soc_series,
            'temp_c': temp_series,
        },
        'last_step_rows': last_step_rows,
        'model': {
            'reserve_soc_pct': m['reserve_soc_pct'],
            'critical_soc_pct': m['critical_soc_pct'],
            'payload_min_c': m['payload_min_c'],
            'payload_max_c': m['payload_max_c'],
        },
        'summary': session.summary(),
    }


COMPARE_SUMMARY_KEYS = (
    'jobs_completed', 'critical_jobs_completed_on_time', 'critical_jobs_due',
    'revenue_usd', 'below_reserve_satellite_steps', 'minimum_soc_pct', 'terminal_soc_pct',
)


def compare_summary(session: Session) -> dict:
    full = session.summary()
    return {k: full[k] for k in COMPARE_SUMMARY_KEYS}


def build_verdict(summary_a: dict, summary_b: dict) -> str:
    def better(metric: str) -> str | None:
        va, vb = summary_a[metric], summary_b[metric]
        if va == vb:
            return None
        return 'A' if va > vb else 'B'

    priority_winner = better('critical_jobs_completed_on_time')
    revenue_winner = better('revenue_usd')

    if priority_winner is None and revenue_winner is None:
        return 'Результаты одинаковые: обе ветки дают один и тот же план.'

    parts = []
    if priority_winner is None:
        parts.append(f"По приоритетным заданиям варианты равны "
                     f"({summary_a['critical_jobs_completed_on_time']} в срок).")
    else:
        parts.append(f"Для цели priority лучше вариант {priority_winner} "
                     f"({summary_a['critical_jobs_completed_on_time']} против "
                     f"{summary_b['critical_jobs_completed_on_time']} заданий в срок).")
    if revenue_winner is None:
        parts.append(f"По выручке варианты равны (${summary_a['revenue_usd']:.2f}).")
    else:
        diff = abs(summary_a['revenue_usd'] - summary_b['revenue_usd'])
        parts.append(f"Для revenue лучше вариант {revenue_winner} (выручка выше на ${diff:.2f}).")
    return ' '.join(parts)


@app.get('/api/scenarios')
def get_scenarios():
    return list_scenarios()


@app.post('/api/scenarios/custom')
def create_custom_scenario(payload: dict = Body(default={})):
    """Сохраняет сценарий (обычно с overrides) в памяти и отдаёт id для переиспользования."""
    scenario = resolve_scenario(payload)
    custom_id = f'custom-{uuid.uuid4().hex[:10]}'
    scenario = copy.deepcopy(scenario)
    scenario['meta']['id'] = custom_id
    with CUSTOM_LOCK:
        CUSTOM_SCENARIOS[custom_id] = scenario
    return scenario_summary(custom_id, scenario)


@app.post('/api/sessions')
def create_session(payload: dict = Body(default={})):
    goal = _require_goal(payload.get('goal', 'priority'))
    scenario = resolve_scenario(payload)

    session = Session(scenario, run_metadata={
        'goal': goal, 'algorithm': 'baseline_deadline_priority_value',
        'version': '1', 'parameters': {},
    })
    session_id = uuid.uuid4().hex
    record = SessionRecord(session, goal)
    with SESSIONS_LOCK:
        SESSIONS[session_id] = record
    return build_state(session_id, record)


@app.post('/api/sessions/{session_id}/step')
def step_session(session_id: str, payload: dict = Body(default={})):
    record = get_record(session_id)
    with record.lock:
        n = _require_int(payload.get('n', 1), 'n', minimum=1)
        session = record.session
        total = session.env.s['time']['steps']
        for _ in range(n):
            if session.env.k >= total:
                break
            session.advance(plan_step(session.env, record.goal))
        return build_state(session_id, record)


@app.post('/api/sessions/{session_id}/run')
def run_session(session_id: str, payload: dict = Body(default={})):
    record = get_record(session_id)
    with record.lock:
        session = record.session
        total = session.env.s['time']['steps']
        until_step = _require_int(payload.get('until_step'), 'until_step', minimum=0, maximum=total)
        if until_step < session.env.k:
            raise ApiError('until_step меньше текущего шага — назад откатить нельзя')
        while session.env.k < until_step:
            session.advance(plan_step(session.env, record.goal))
        return build_state(session_id, record)


@app.post('/api/sessions/{session_id}/event')
def event_session(session_id: str, event: dict = Body(...)):
    record = get_record(session_id)
    with record.lock:
        # apply_event сам всё проверяет и ничего не меняет при ошибке —
        # ValueError долетит до общего обработчика и станет {"error": ...}.
        record.session.apply_event(event)
        return build_state(session_id, record)


@app.post('/api/sessions/{session_id}/goal')
def set_goal(session_id: str, payload: dict = Body(default={})):
    record = get_record(session_id)
    with record.lock:
        record.goal = _require_goal(payload.get('goal'))
        return build_state(session_id, record)


@app.post('/api/sessions/{session_id}/compare')
def compare_session(session_id: str, payload: dict = Body(default={})):
    record = get_record(session_id)
    with record.lock:
        goal_a = _require_goal(payload.get('goal_a'), 'goal_a')
        goal_b = _require_goal(payload.get('goal_b'), 'goal_b')

        at_step = record.session.env.k
        fork_a = record.session.fork()
        fork_b = record.session.fork()
        run_to_end(fork_a, goal_a)
        run_to_end(fork_b, goal_b)

        summary_a = compare_summary(fork_a)
        summary_b = compare_summary(fork_b)
        return {
            'at_step': at_step,
            'a': {'goal': goal_a, 'summary': summary_a},
            'b': {'goal': goal_b, 'summary': summary_b},
            'verdict': build_verdict(summary_a, summary_b),
        }


@app.get('/api/sessions/{session_id}/scenario')
def get_session_scenario(session_id: str):
    """Отдаёт сценарий сессии таким, каким он был на старте — со всеми overrides."""
    record = get_record(session_id)
    with record.lock:
        return copy.deepcopy(record.session.initial_scenario)


@app.get('/api/sessions/{session_id}/result')
def get_result(session_id: str):
    record = get_record(session_id)
    with record.lock:
        return record.session.result()


# Статика — после всех /api/... роутов, чтобы они не перекрылись.
app.mount('/', StaticFiles(directory=str(STATIC_DIR), html=True), name='static')


if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host='0.0.0.0', port=8000)
