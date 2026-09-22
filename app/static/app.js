/**
 * ПУЛЬТ ОПЕРАТОРА СПУТНИКОВОЙ ГРУППИРОВКИ
 * КосмоХакатон 2026 — Автономное управление группировкой
 * 
 * Логика фронтенда:
 * 1. Состояние смены (AppState)
 * 2. Клиент API с прозрачным переключением на app/mock/ при недоступности бэкенда
 * 3. Отрисовка телеметрии, таблиц спутников, очереди задач и журнала шага
 * 4. Графики Chart.js с динамическими линиями резервов и температурных границ
 * 5. Ввод оперативных событий и сравнение стратегий (priority vs revenue)
 */

// =============================================================================
// 1. ЕДИНОЕ СОСТОЯНИЕ ПРИЛОЖЕНИЯ (AppState)
// =============================================================================
const AppState = {
  sessionId: null,
  scenarioId: 'P01_intro',
  scenarioTitle: 'Ознакомительная смена: 16 аппаратов',
  goal: 'priority',
  algorithm: 'smart',
  step: 0,
  totalSteps: 48,
  satellites: [],
  jobs: [],
  series: {
    steps: [],
    soc_pct: {},
    temp_c: {}
  },
  lastStepRows: [],
  model: {
    reserve_soc_pct: 30.0,
    critical_soc_pct: 20.0,
    payload_min_c: 5.0,
    payload_max_c: 45.0
  },
  summary: {
    steps_executed: 0,
    jobs_total: 0,
    jobs_completed: 0,
    jobs_due: 0,
    jobs_due_missed: 0,
    critical_jobs_due: 0,
    critical_jobs_completed_on_time: 0,
    revenue_usd: 0,
    below_reserve_satellite_steps: 0,
    minimum_soc_pct: 100.0,
    terminal_soc_pct: {}
  },
  
  // Режим работы (настоящий бэкенд или локальные моки)
  isMockMode: false,
  scenariosList: [],
  
  // Выбранные спутники для графиков
  selectedSatellites: new Set(['S01', 'S02', 'S03', 'S04']),
  
  // Экземпляры графиков Chart.js
  socChart: null,
  tempChart: null,
  
  // Пользовательский загруженный сценарий
  customScenarioJson: null,

  // Автоматический ход смены (Play/Pause)
  isAutoRunning: false,
  autoPlayTimer: null
};

// Цветовая палитра спутников для графиков (профессиональные различимые цвета)
const SATELLITE_COLORS = [
  '#3b82f6', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6',
  '#06b6d4', '#84cc16', '#f97316', '#14b8a6', '#a855f7',
  '#6366f1', '#eab308', '#22c55e', '#ef4444', '#0ea5e9', '#d946ef'
];

function getSatColor(id, index) {
  return SATELLITE_COLORS[index % SATELLITE_COLORS.length];
}

// =============================================================================
// 2. ВЗАИМОДЕЙСТВИЕ С API (С АВТОМАТИЧЕСКИМ ПЕРЕХОДОМ НА МОКИ)
// =============================================================================

/**
 * Проверка доступности бэкенда и загрузка сценариев
 */
async function initBackendConnection() {
  setConnectionStatus('checking', 'Подключение к серверу...');
  const wrapper = document.getElementById('connectionStatusWrapper');
  try {
    const res = await fetch('/api/scenarios', { method: 'GET' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const scenarios = await res.json();
    AppState.scenariosList = scenarios;
    AppState.isMockMode = false;
    setConnectionStatus('online', 'СЕРВЕР ЦУП: ОНЛАЙН');
    if (wrapper) wrapper.title = 'Подключено к живому бэкенду FastAPI (app/server.py). Модель спутников и алгоритм планирования работают в реальном времени.';
    populateScenariosSelect(scenarios);
  } catch (err) {
    console.warn('Бэкенд недоступен, переход в автономный режим:', err.message);
    AppState.isMockMode = true;
    setConnectionStatus('mock', 'ДЕМО-РЕЖИМ (ОФФЛАЙН)');
    if (wrapper) wrapper.title = 'Сервер Python не запущен. Используются статические демонстрационные файлы.';
    await loadMockScenarios();
  }
}

/**
 * Загрузка мок-файла с перебором относительных и абсолютных путей
 */
async function fetchMock(filename) {
  const candidates = [
    `../mock/${filename}`,
    `mock/${filename}`,
    `/app/mock/${filename}`,
    `app/mock/${filename}`
  ];
  for (const path of candidates) {
    try {
      const res = await fetch(path);
      if (res.ok) return await res.json();
    } catch (e) {}
  }
  throw new Error(`Файл примера ${filename} не найден`);
}

/**
 * Загрузка мок-сценариев
 */
async function loadMockScenarios() {
  try {
    const scenarios = await fetchMock('scenarios_example.json');
    AppState.scenariosList = scenarios;
    populateScenariosSelect(scenarios);
  } catch (e) {
    // Дефолтный fallback
    AppState.scenariosList = [
      { id: "P01_intro", title: "Ознакомительная смена: 16 аппаратов", satellites: 16, steps: 48, jobs: 18 },
      { id: "P02_shift", title: "Суточная смена: 48 аппаратов", satellites: 48, steps: 288, jobs: 1208 }
    ];
    populateScenariosSelect(AppState.scenariosList);
  }
}

/**
 * Старт новой смены: POST /api/sessions
 */
async function apiStartSession(scenarioId, goal, algorithm = 'smart', customJson = null, overrides = null) {
  stopAutoPlay(false);
  showLoader('Создание новой смены...');
  hideAlert();
  
  if (!AppState.isMockMode) {
    try {
      const payload = customJson 
        ? { scenario: customJson, goal: goal, algorithm: algorithm }
        : { scenario_id: scenarioId, goal: goal, algorithm: algorithm };
      
      if (overrides && Object.keys(overrides).length > 0) {
        payload.overrides = overrides;
      }
        
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Ошибка сервера: HTTP ${res.status}`);
      }
      
      const state = await res.json();
      applyState(state);
      hideLoader();
      return true;
    } catch (err) {
      console.warn('Ошибка вызова POST /api/sessions, используем автономный пример:', err);
      showAlert(`Бэкенд вернул ошибку (${err.message}). Загружен эталонный пример.`);
      AppState.isMockMode = true;
      setConnectionStatus('mock', 'АВТОНОМНЫЙ РЕЖИМ');
    }
  }

  // Мок-режим
  try {
    const mockState = await fetchMock('state_example.json');
    mockState.goal = goal;
    if (scenarioId) {
      mockState.scenario = scenarioId;
      const found = AppState.scenariosList.find(s => s.id === scenarioId);
      if (found) mockState.title = found.title;
    }
    applyState(mockState);
    hideLoader();
    return true;
  } catch (err) {
    hideLoader();
    showAlert(`Не удалось загрузить данные примера: ${err.message}`);
    return false;
  }
}

/**
 * Шаг расчёта: POST /api/sessions/{id}/step
 */
async function apiStep(nSteps = 1) {
  if (!AppState.sessionId && !AppState.isMockMode) {
    showAlert('Сначала запустите смену!');
    return;
  }
  
  showLoader(nSteps > 1 ? `Выполняется расчёт ${nSteps} шагов...` : 'Выполняется расчёт 1 шага (+5 мин)...');
  hideAlert();

  if (!AppState.isMockMode) {
    try {
      const res = await fetch(`/api/sessions/${AppState.sessionId}/step`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ n: nSteps })
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${res.status}`);
      }
      const state = await res.json();
      applyState(state);
      hideLoader();
      return;
    } catch (err) {
      console.warn('Ошибка при шаге API:', err);
      showAlert(`Ошибка при расчёте шага на бэкенде: ${err.message}`);
      hideLoader();
      return;
    }
  }

  // Симуляция шагов в мок-режиме
  setTimeout(() => {
    simulateMockStep(nSteps);
    hideLoader();
  }, 250);
}

/**
 * Продвижение до указанного шага: POST /api/sessions/{id}/run
 */
async function apiRunUntil(targetStep) {
  if (!AppState.sessionId && !AppState.isMockMode) {
    showAlert('Сначала запустите смену!');
    return;
  }

  if (targetStep <= AppState.step) {
    showAlert(`Целевой шаг ${targetStep} должен быть больше текущего (${AppState.step})`);
    return;
  }

  showLoader(`Расчёт группировки до шага ${targetStep}...`);
  hideAlert();

  if (!AppState.isMockMode) {
    try {
      const res = await fetch(`/api/sessions/${AppState.sessionId}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ until_step: targetStep })
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${res.status}`);
      }
      const state = await res.json();
      applyState(state);
      hideLoader();
      return;
    } catch (err) {
      showAlert(`Ошибка выполнения прогона: ${err.message}`);
      hideLoader();
      return;
    }
  }

  // Мок-прогон
  setTimeout(() => {
    const delta = targetStep - AppState.step;
    simulateMockStep(delta);
    hideLoader();
  }, 400);
}

/**
 * Обновление визуального состояния кнопки Пауза / Авто-ход / Продолжить
 */
function updatePlayPauseButton(state) {
  const btn = document.getElementById('btnPause');
  const icon = document.getElementById('btnPauseIcon');
  const label = document.getElementById('btnPauseLabel');
  if (!btn || !icon || !label) return;

  btn.classList.remove('btn-danger-soft', 'btn-success-soft', 'btn-step');

  if (state === 'running') {
    icon.setAttribute('href', '#icon-pause');
    label.textContent = 'Пауза';
    btn.classList.add('btn-danger-soft');
    btn.title = 'Приостановить автоматический ход смены';
  } else if (state === 'paused') {
    icon.setAttribute('href', '#icon-play');
    label.textContent = 'Продолжить';
    btn.classList.add('btn-success-soft');
    btn.title = 'Возобновить автоматический ход смены';
  } else {
    icon.setAttribute('href', '#icon-play');
    label.textContent = 'Авто-ход';
    btn.classList.add('btn-step');
    btn.title = 'Запустить непрерывный авто-ход смены';
  }
}

/**
 * Остановка автоматического хода смены
 */
function stopAutoPlay(asPause = true) {
  if (AppState.autoPlayTimer) {
    clearInterval(AppState.autoPlayTimer);
    AppState.autoPlayTimer = null;
  }
  AppState.isAutoRunning = false;
  hideLoader();

  if (AppState.step >= AppState.totalSteps) {
    updatePlayPauseButton('idle');
    const label = document.getElementById('btnPauseLabel');
    if (label) label.textContent = 'Смена завершена';
  } else if (asPause && AppState.step > 0) {
    updatePlayPauseButton('paused');
  } else {
    updatePlayPauseButton('idle');
  }
}

/**
 * Запуск непрерывного автоматического хода смены (Play)
 */
async function startAutoPlay() {
  if (AppState.step >= AppState.totalSteps) {
    showAlert('Смена уже завершена! Для повторного расчёта начните новую смену.');
    return;
  }

  AppState.isAutoRunning = true;
  updatePlayPauseButton('running');

  if (AppState.autoPlayTimer) {
    clearInterval(AppState.autoPlayTimer);
  }

  AppState.autoPlayTimer = setInterval(async () => {
    if (!AppState.isAutoRunning) {
      clearInterval(AppState.autoPlayTimer);
      return;
    }

    if (AppState.step >= AppState.totalSteps) {
      stopAutoPlay(false);
      showAlert('Все шаги смены успешно выполнены!');
      return;
    }

    await apiStep(1);

    if (AppState.step >= AppState.totalSteps) {
      stopAutoPlay(false);
      showAlert('Все шаги смены успешно выполнены!');
    }
  }, 850);
}

/**
 * Переключатель Play / Pause
 */
function togglePlayPause() {
  if (AppState.isAutoRunning) {
    stopAutoPlay(true);
    showAlert('Автоматический ход смены приостановлен оператором.');
  } else {
    startAutoPlay();
  }
}

/**
 * Отправка события: POST /api/sessions/{id}/event
 */
async function apiSendEvent(eventObj) {
  showLoader('Применение оперативного события...');
  hideAlert();

  if (!AppState.isMockMode) {
    try {
      const res = await fetch(`/api/sessions/${AppState.sessionId}/event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(eventObj)
      });
      
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        const msg = errData.error || `Ошибка добавления события (HTTP ${res.status})`;
        hideLoader();
        return { success: false, error: msg };
      }
      
      const state = await res.json();
      applyState(state);
      hideLoader();
      return { success: true };
    } catch (err) {
      hideLoader();
      return { success: false, error: err.message };
    }
  }

  // Локальная валидация для мок-режима
  if (eventObj.at_step !== AppState.step) {
    hideLoader();
    return { 
      success: false, 
      error: `Шаг события at_step (${eventObj.at_step}) не совпадает с текущим шагом смены (${AppState.step})` 
    };
  }

  if (eventObj.type === 'satellite_outage') {
    if (!eventObj.satellite_ids || !eventObj.satellite_ids.length) {
      hideLoader();
      return { success: false, error: 'Список аппаратов не может быть пустым' };
    }
    if (eventObj.end_step <= eventObj.at_step) {
      hideLoader();
      return { success: false, error: 'Конец интервала end_step должен быть строго больше at_step' };
    }
    // Помечаем в моке спутники как недоступные
    AppState.satellites.forEach(s => {
      if (eventObj.satellite_ids.includes(s.id)) {
        s.available = false;
      }
    });
  } else if (eventObj.type === 'add_jobs') {
    if (!eventObj.jobs || !eventObj.jobs.length) {
      hideLoader();
      return { success: false, error: 'Список новых заданий не может быть пустым' };
    }
    eventObj.jobs.forEach(j => {
      AppState.jobs.push({
        id: j.id,
        kind: j.kind,
        priority: j.priority,
        value_usd: j.value_usd,
        release_step: j.release_step,
        deadline_step: j.deadline_step,
        work_steps: j.work_steps,
        remaining_steps: j.work_steps,
        eligible_satellites: j.eligible_satellites,
        status: 'waiting',
        completed_step: null
      });
    });
  }

  renderAll();
  hideLoader();
  return { success: true };
}

/**
 * Смена цели: POST /api/sessions/{id}/goal
 */
async function apiChangeGoal(newGoal) {
  showLoader('Переключение цели управления...');
  hideAlert();

  if (!AppState.isMockMode && AppState.sessionId) {
    try {
      const res = await fetch(`/api/sessions/${AppState.sessionId}/goal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal: newGoal })
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${res.status}`);
      }
      const state = await res.json();
      applyState(state);
      hideLoader();
      return;
    } catch (err) {
      showAlert(`Не удалось изменить цель: ${err.message}`);
      hideLoader();
      return;
    }
  }

  // В мок-режиме просто фиксируем
  AppState.goal = newGoal;
  document.getElementById('goalSelect').value = newGoal;
  hideLoader();
}

/**
 * Смена алгоритма планирования: POST /api/sessions/{id}/algorithm
 */
async function apiSetAlgorithm(newAlg) {
  showLoader(`Переключение алгоритма на ${newAlg}...`);
  hideAlert();

  if (!AppState.isMockMode && AppState.sessionId) {
    try {
      const res = await fetch(`/api/sessions/${AppState.sessionId}/algorithm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ algorithm: newAlg })
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${res.status}`);
      }
      const state = await res.json();
      applyState(state);
      hideLoader();
      showAlert(`Алгоритм смены переключен на: ${newAlg === 'smart' ? '🧠 Smart Lookahead' : '⚙️ Baseline'}`);
      return;
    } catch (err) {
      showAlert(`Не удалось изменить алгоритм: ${err.message}`);
      hideLoader();
      return;
    }
  }

  AppState.algorithm = newAlg;
  const algSelect = document.getElementById('algorithmSelect');
  if (algSelect) algSelect.value = newAlg;
  hideLoader();
}

/**
 * Сравнение вариантов: POST /api/sessions/{id}/compare
 */
async function apiCompare(goalA, goalB, algA = 'smart', algB = 'baseline') {
  showLoader('Расчёт сравнения вариантов и алгоритмов...');
  hideAlert();

  if (!AppState.isMockMode && AppState.sessionId) {
    try {
      const res = await fetch(`/api/sessions/${AppState.sessionId}/compare`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          a: { goal: goalA, algorithm: algA },
          b: { goal: goalB, algorithm: algB }
        })
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${res.status}`);
      }
      const compareData = await res.json();
      hideLoader();
      return compareData;
    } catch (err) {
      showAlert(`Ошибка API сравнения: ${err.message}. Используем пример.`);
    }
  }

  // Мок-сравнение
  try {
    const compareData = await fetchMock('compare_example.json');
    hideLoader();
    return compareData;
  } catch (e) {
    hideLoader();
    showAlert(`Не удалось загрузить данные сравнения: ${e.message}`);
    return null;
  }
}

/**
 * Получение аудита решений (Explain): GET /api/sessions/{id}/explain или /explain/{job_id}
 */
async function apiGetExplain(jobId = null) {
  const url = jobId 
    ? `/api/sessions/${AppState.sessionId}/explain/${jobId}`
    : `/api/sessions/${AppState.sessionId}/explain`;
  
  if (!AppState.isMockMode && AppState.sessionId) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        return await res.json();
      }
    } catch (e) {
      console.warn('Ошибка вызова API explain:', e);
    }
  }

  // Автономный мок-режим
  try {
    const mockData = await fetchMock('explain_example.json');
    if (jobId) {
      const found = (mockData.top_priority_jobs || []).find(j => j.job_id === jobId);
      return found || {
        job_id: jobId,
        status: 'waiting',
        text: `Задание ${jobId}: в автономном режиме. Данные формируются математической моделью.`,
        proof: { contact_steps: 1, work_steps: 2 },
        verdict: 'impossible_by_contact_window',
        lost_steps_by_reason: {}
      };
    }
    return mockData;
  } catch (err) {
    console.warn('Не удалось загрузить explain mock:', err);
    return null;
  }
}

/**
 * Получение статистики загрузки флота (Stats): GET /api/sessions/{id}/stats
 */
async function apiGetStats() {
  if (!AppState.isMockMode && AppState.sessionId) {
    try {
      const res = await fetch(`/api/sessions/${AppState.sessionId}/stats`);
      if (res.ok) {
        return await res.json();
      }
    } catch (e) {
      console.warn('Ошибка вызова API stats:', e);
    }
  }

  try {
    return await fetchMock('stats_example.json');
  } catch (err) {
    console.warn('Не удалось загрузить stats mock:', err);
    return null;
  }
}

/**
 * Скачать результат: GET /api/sessions/{id}/result
 */
async function apiDownloadResult() {
  showLoader('Подготовка результата смены...');
  
  if (!AppState.isMockMode && AppState.sessionId) {
    try {
      const res = await fetch(`/api/sessions/${AppState.sessionId}/result`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      triggerDownload(blob, `result_${AppState.sessionId}_step${AppState.step}.json`);
      hideLoader();
      return;
    } catch (err) {
      console.warn('Не удалось скачать с бэкенда, формируем клиентский результат:', err);
    }
  }

  // Генерация JSON результата в формате cosmo-B-ops-result-1.0
  const exportData = {
    schema_version: "cosmo-B-ops-result-1.0",
    session_id: AppState.sessionId || "demo-session",
    scenario: AppState.scenarioId,
    title: AppState.scenarioTitle,
    steps_executed: AppState.step,
    goal: AppState.goal,
    summary: AppState.summary,
    satellites: AppState.satellites,
    jobs: AppState.jobs,
    exported_at: new Date().toISOString()
  };

  const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
  triggerDownload(blob, `result_${AppState.scenarioId}_step${AppState.step}.json`);
  hideLoader();
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// =============================================================================
// 3. ПРИМЕНЕНИЕ ДАННЫХ СОСТОЯНИЯ (State Application)
// =============================================================================

function applyState(state) {
  if (!state) return;
  
  AppState.sessionId = state.session_id || AppState.sessionId || 'session-demo';
  AppState.scenarioId = state.scenario || AppState.scenarioId;
  AppState.scenarioTitle = state.title || AppState.scenarioTitle;
  AppState.goal = state.goal || AppState.goal;
  AppState.algorithm = state.algorithm || AppState.algorithm || 'smart';
  AppState.step = state.step !== undefined ? state.step : AppState.step;
  AppState.totalSteps = state.total_steps || AppState.totalSteps || 48;
  AppState.satellites = state.satellites || [];
  AppState.jobs = state.jobs || [];
  AppState.series = state.series || { steps: [], soc_pct: {}, temp_c: {} };
  AppState.lastStepRows = state.last_step_rows || [];
  if (state.model) AppState.model = Object.assign(AppState.model, state.model);
  if (state.summary) AppState.summary = Object.assign(AppState.summary, state.summary);

  // Выбираем первые 4 аппарата по умолчанию, если выбор пуст
  if (AppState.selectedSatellites.size === 0 && AppState.satellites.length > 0) {
    AppState.satellites.slice(0, 4).forEach(s => AppState.selectedSatellites.add(s.id));
  }

  // Активируем кнопки действий
  document.getElementById('btnCompare').disabled = false;
  document.getElementById('btnDownloadResult').disabled = false;
  const btnExplain = document.getElementById('btnOpenExplain');
  if (btnExplain) btnExplain.disabled = false;
  const btnStats = document.getElementById('btnOpenStats');
  if (btnStats) btnStats.disabled = false;
  const btnToolbarExplain = document.getElementById('btnToolbarExplain');
  if (btnToolbarExplain) btnToolbarExplain.disabled = false;
  const btnToolbarStats = document.getElementById('btnToolbarStats');
  if (btnToolbarStats) btnToolbarStats.disabled = false;

  renderAll();
  if (AppState.step >= AppState.totalSteps) {
    stopAutoPlay(false);
  }
}

/**
 * Имитация шага в демо-режиме
 */
function simulateMockStep(count) {
  const newStep = Math.min(AppState.totalSteps, AppState.step + count);
  const diff = newStep - AppState.step;
  if (diff <= 0) return;

  AppState.step = newStep;
  AppState.summary.steps_executed = newStep;

  // Обновляем возраст калибровки и батарею у спутников
  AppState.satellites.forEach(s => {
    s.calibration_age_steps = (s.calibration_age_steps || 0) + diff;
    // Небольшое естественное колебание заряда
    const solarEffect = (Math.sin(newStep / 5) * 1.5);
    s.soc_pct = Math.max(15, Math.min(100, (s.soc_pct || 90) + solarEffect));
  });

  // Добавляем точки в series
  if (!AppState.series.steps) AppState.series.steps = [];
  for (let i = AppState.series.steps.length; i <= newStep; i++) {
    AppState.series.steps.push(i);
    AppState.satellites.forEach(s => {
      if (!AppState.series.soc_pct[s.id]) AppState.series.soc_pct[s.id] = [];
      if (!AppState.series.temp_c[s.id]) AppState.series.temp_c[s.id] = [];
      const lastSoc = AppState.series.soc_pct[s.id].slice(-1)[0] || s.soc_pct;
      const lastTemp = AppState.series.temp_c[s.id].slice(-1)[0] || s.temp_c;
      AppState.series.soc_pct[s.id].push(Number((lastSoc + (Math.random() * 2 - 1)).toFixed(2)));
      AppState.series.temp_c[s.id].push(Number((lastTemp + (Math.random() * 0.6 - 0.3)).toFixed(2)));
    });
  }

  renderAll();
}

// =============================================================================
// 4. ФУНКЦИИ ОТРИСОВКИ (Renderers)
// =============================================================================

function renderAll() {
  renderHeaderAndKPI();
  renderTimeline();
  renderRiskRadar();
  renderFleetMatrix();
  renderSatellitesTable();
  renderJobsTable();
  renderLastStepTable();
  renderCharts();

  // Обновление аэрокосмических модулей ЦУП
  if (window.globe3dInstance) {
    window.globe3dInstance.updateState();
  }
  if (window.orbitalMapInstance) {
    window.orbitalMapInstance.render();
  }
  if (window.passGanttInstance) {
    window.passGanttInstance.render();
  }
  if (window.flightLogInstance) {
    window.flightLogInstance.recordStepEvents();
  }
  if (window.currentAvionicsSatId && typeof window.renderAvionicsDrawer === 'function') {
    window.renderAvionicsDrawer(window.currentAvionicsSatId);
  }
}

/**
 * Предиктивный радар рисков (СППР · Критерий О7)
 */
function renderRiskRadar() {
  const container = document.getElementById('radarAlertsList');
  const summaryEl = document.getElementById('radarSummaryStats');
  if (!container) return;

  const alerts = [];
  const currentStep = AppState.step;

  // 1. Проверка истекающей калибровки (осталось 5 шагов или меньше)
  AppState.satellites.forEach(sat => {
    const validSteps = sat.calibration_valid_steps || 48;
    const remaining = validSteps - (sat.calibration_age_steps || 0);
    if (remaining <= 0) {
      alerts.push({
        type: 'danger',
        text: `🔧 <strong>${sat.id}</strong>: калибровка ИСТЕКЛА! Задания заблокированы`
      });
    } else if (remaining <= 5) {
      alerts.push({
        type: 'warn',
        text: `🔧 <strong>${sat.id}</strong>: калибровка истекает через ${remaining} ш.`
      });
    }
  });

  // 2. Проверка приближения к резерву энергии (< 35%) и отказов
  AppState.satellites.forEach(sat => {
    if (!sat.available) {
      alerts.push({
        type: 'danger',
        text: `🛑 <strong>${sat.id}</strong>: аппарат выведен из строя (outage)`
      });
    } else if (sat.soc_pct < AppState.model.critical_soc_pct) {
      alerts.push({
        type: 'danger',
        text: `🚨 <strong>${sat.id}</strong>: критический дефицит ${Number(sat.soc_pct).toFixed(1)}% (&lt;20%)!`
      });
    } else if (sat.soc_pct < AppState.model.reserve_soc_pct + 5.0) {
      alerts.push({
        type: 'warn',
        text: `⚡ <strong>${sat.id}</strong>: заряд ${Number(sat.soc_pct).toFixed(1)}% близок к резерву (30%)`
      });
    }
  });

  // 3. Проверка критических заданий (priority 3), приближающихся к дедлайну
  AppState.jobs.forEach(job => {
    if (job.status !== 'done' && job.priority === 3) {
      const remainingWork = job.remaining_steps !== undefined ? job.remaining_steps : job.work_steps;
      const stepsToDeadline = job.deadline_step - currentStep;
      if (stepsToDeadline > 0 && stepsToDeadline <= remainingWork + 2) {
        alerts.push({
          type: 'danger',
          text: `⏳ <strong>${job.id}</strong> [Пр.3]: дедлайн ш.${job.deadline_step}! Осталось ${remainingWork} ш. работы из ${stepsToDeadline}`
        });
      }
    }
  });

  if (alerts.length === 0) {
    if (summaryEl) summaryEl.textContent = 'Все системы в норме (резерв и калибровка соблюдены)';
    container.innerHTML = '<span class="radar-empty"><svg style="width:14px;height:14px;display:inline-block;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg> Рисков не обнаружено: заряд аккумуляторов, температурные коридоры и сроки калибровки в штатном допуске</span>';
  } else {
    const dangerCount = alerts.filter(a => a.type === 'danger').length;
    const warnCount = alerts.filter(a => a.type === 'warn').length;
    if (summaryEl) summaryEl.textContent = `Критических рисков: ${dangerCount} | Внимания: ${warnCount}`;
    container.innerHTML = alerts.slice(0, 8).map(a => `
      <div class="radar-pill ${a.type === 'danger' ? 'radar-pill-danger' : 'radar-pill-warn'}">
        ${a.text}
      </div>
    `).join('') + (alerts.length > 8 ? `<span class="radar-pill radar-pill-info">+ ещё ${alerts.length - 8}</span>` : '');
  }
}

/**
 * Временная шкала смены
 */
function renderTimeline() {
  const currentMinutes = AppState.step * 5;
  const totalMinutes = AppState.totalSteps * 5;
  const remainingMinutes = Math.max(0, totalMinutes - currentMinutes);
  const pct = AppState.totalSteps > 0 ? ((AppState.step / AppState.totalSteps) * 100).toFixed(1) : '0.0';

  const elPct = document.getElementById('timelinePct');
  const elElapsed = document.getElementById('timelineElapsed');
  const elRemaining = document.getElementById('timelineRemaining');
  const elBar = document.getElementById('timelineProgressBar');

  if (elPct) elPct.textContent = `${pct}%`;
  if (elElapsed) elElapsed.textContent = formatMinutesToHHMMSS(currentMinutes);
  if (elRemaining) elRemaining.textContent = formatMinutesToHHMMSS(remainingMinutes);
  if (elBar) elBar.style.width = `${Math.min(100, Math.max(0, pct))}%`;
}

function formatMinutesToHHMMSS(totalMinutes) {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
}

/**
 * Матрица состояния бортов (Fleet Matrix)
 */
function renderFleetMatrix() {
  const container = document.getElementById('fleetGridContainer');
  const headerCount = document.getElementById('fleetHeaderCount');
  if (headerCount) headerCount.textContent = AppState.satellites.length;
  if (!container) return;

  if (!AppState.satellites || AppState.satellites.length === 0) {
    container.innerHTML = '<div style="color:var(--text-tertiary); font-size:11px;">Нет данных</div>';
    return;
  }

  let html = '';
  AppState.satellites.forEach(sat => {
    const isBelowReserve = sat.soc_pct < AppState.model.reserve_soc_pct;
    const isBelowCrit = sat.soc_pct < AppState.model.critical_soc_pct;
    const isTempAlert = sat.temp_c < AppState.model.payload_min_c || sat.temp_c > AppState.model.payload_max_c;
    const isCalibUrgent = sat.calibration_age_steps >= ((sat.calibration_valid_steps || 48) - 6);

    let statusClass = 'fleet-card-healthy';
    let statusLabel = 'В строю';
    let barClass = 'soc-normal';

    if (!sat.available || isBelowCrit) {
      statusClass = 'fleet-card-danger';
      statusLabel = !sat.available ? 'Отказ' : 'Крит';
      barClass = 'soc-danger';
    } else if (isBelowReserve || isTempAlert || isCalibUrgent) {
      statusClass = 'fleet-card-warning';
      if (isBelowReserve) statusLabel = '<30%';
      else if (isTempAlert) statusLabel = 'T°!';
      else statusLabel = 'Калибр';
      barClass = 'soc-warning';
    }

    html += `
      <div class="fleet-sat-card ${statusClass}" onclick="openAvionicsDrawer('${sat.id}')" title="Кликните для открытия авионики ${sat.id}">
        <div class="fleet-card-top">
          <span class="fleet-card-id">${sat.id}</span>
          <span class="fleet-card-status-tag">${statusLabel}</span>
          <span class="fleet-card-pip"></span>
        </div>
        <div class="fleet-card-metrics">
          <span>${Number(sat.soc_pct).toFixed(0)}%</span>
          <span>${Number(sat.temp_c).toFixed(0)}°C</span>
        </div>
        <div class="fleet-card-bar-bg">
          <div class="fleet-card-bar-fill ${barClass}" style="width:${Math.min(100, Math.max(0, sat.soc_pct))}%;"></div>
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
}

/**
 * Шапка и KPI Дашборд
 */
function renderHeaderAndKPI() {
  // Название сценария
  document.getElementById('currentScenarioTitle').textContent = 
    `${AppState.scenarioTitle || AppState.scenarioId} (${AppState.sessionId || 'новая'})`;
    
  // Цель
  document.getElementById('goalSelect').value = AppState.goal || 'priority';

  // Алгоритм
  const algSelect = document.getElementById('algorithmSelect');
  if (algSelect && AppState.algorithm) {
    algSelect.value = AppState.algorithm;
  }
  const goalNotice = document.getElementById('goalNotice');
  if (goalNotice) {
    goalNotice.textContent = AppState.algorithm === 'smart' 
      ? '🧠 Smart Lookahead: прогнозирование окон и баланс SOC' 
      : '⚙️ Baseline: жадная эвристика без упреждения';
  }

  // Шаг и время (1 шаг = 5 мин)
  const currentMinutes = AppState.step * 5;
  const totalMinutes = AppState.totalSteps * 5;
  const curTimeStr = formatMinutesToHHMM(currentMinutes);
  const totTimeStr = formatMinutesToHHMM(totalMinutes);
  
  document.getElementById('kpiStep').innerHTML = `${AppState.step} <span class="val-sub">/ ${AppState.totalSteps}</span>`;
  document.getElementById('kpiTime').textContent = `Время: ${curTimeStr} / ${totTimeStr}`;

  // Выполнено заданий: показываем completed / totalJobs (а не due, чтобы не было дробей вроде 7/1)
  const totalJobs = AppState.summary.jobs_total || (AppState.jobs ? AppState.jobs.length : 0);
  const completed = AppState.summary.jobs_completed || 0;
  const jobsDue = AppState.summary.jobs_due || 0;
  const jobsMissed = AppState.summary.jobs_due_missed || 0;
  const completedEarly = Math.max(0, completed - (jobsDue - jobsMissed));

  document.getElementById('kpiJobs').innerHTML = `${completed} <span class="val-sub">/ ${totalJobs}</span>`;
  
  const elJobsSub = document.getElementById('kpiJobsSub');
  if (jobsMissed > 0) {
    elJobsSub.innerHTML = `<span class="text-danger">Сорвано: ${jobsMissed}</span> · Срок наступил у ${jobsDue}`;
  } else if (jobsDue === 0) {
    elJobsSub.textContent = completed > 0 
      ? `Досрочно: ${completed} (дедлайны ещё впереди)` 
      : `ожидание начисления заданий`;
  } else {
    elJobsSub.textContent = `Дедлайн наступил у ${jobsDue} (досрочно: ${completedEarly})`;
  }

  // Срочные задания (приоритет 3)
  const critDone = AppState.summary.critical_jobs_completed_on_time || 0;
  const critDue = AppState.summary.critical_jobs_due || 0;
  const critTotal = AppState.jobs ? AppState.jobs.filter(j => j.priority === 3).length : 0;
  const critFinishedTotal = AppState.jobs ? AppState.jobs.filter(j => j.priority === 3 && (j.completed_step !== null && j.completed_step !== undefined)).length : 0;
  
  const elCrit = document.getElementById('kpiCriticalJobs');
  const elCritSub = document.getElementById('kpiCriticalSub');

  if (critDue > 0) {
    elCrit.innerHTML = `${critDone} <span class="val-sub">/ ${critDue}</span>`;
    const critPct = Math.round((critDone / critDue) * 100);
    elCritSub.textContent = critDone === critDue 
      ? `100% в срок (закрыто ${critFinishedTotal} из ${critTotal})` 
      : `в срок: ${critPct}% (закрыто ${critFinishedTotal} из ${critTotal})`;
  } else {
    elCrit.innerHTML = `${critFinishedTotal} <span class="val-sub">/ ${critTotal}</span>`;
    elCritSub.textContent = critFinishedTotal > 0 
      ? `досрочно: ${critFinishedTotal} из ${critTotal} (дедлайн позже)` 
      : `нет срочных с наступившим сроком`;
  }

  // Выручка
  const rev = AppState.summary.revenue_usd || 0;
  document.getElementById('kpiRevenue').textContent = `$${rev.toFixed(2)}`;

  // Минимальный заряд и шаги ниже резерва
  const minSoc = AppState.summary.minimum_soc_pct !== undefined 
    ? AppState.summary.minimum_soc_pct 
    : Math.min(...AppState.satellites.map(s => s.soc_pct || 100));
    
  const elMinSoc = document.getElementById('kpiMinSoc');
  elMinSoc.textContent = `${Number(minSoc).toFixed(1)}%`;
  if (minSoc < AppState.model.reserve_soc_pct) {
    elMinSoc.className = 'kpi-val text-danger';
  } else if (minSoc < 40) {
    elMinSoc.className = 'kpi-val text-warning';
  } else {
    elMinSoc.className = 'kpi-val';
  }

  const belowSteps = AppState.summary.below_reserve_satellite_steps || 0;
  document.getElementById('kpiBelowReserve').textContent = `Ниже резерва: ${belowSteps} шагов`;

  // Потери в незавершённых задачах (work_steps_in_missed_jobs)
  const missedWorkSteps = AppState.summary.work_steps_in_missed_jobs || 0;
  const elMissedLoss = document.getElementById('kpiMissedLoss');
  if (elMissedLoss) {
    elMissedLoss.textContent = `Потери: ${missedWorkSteps} ш. в сорванных`;
    if (missedWorkSteps > 0) elMissedLoss.classList.add('kpi-sub-alert');
    else elMissedLoss.classList.remove('kpi-sub-alert');
  }

  // Отклоненные команды (blocked_command_count)
  const blockedCount = AppState.summary.blocked_command_count || 0;
  const elBlocked = document.getElementById('kpiBlockedCount');
  if (elBlocked) {
    elBlocked.textContent = `Отклонено команд: ${blockedCount}`;
    if (blockedCount > 0) elBlocked.classList.add('kpi-sub-alert');
    else elBlocked.classList.remove('kpi-sub-alert');
  }

  // Критический дефицит (<20%) (critical_soc_satellite_steps)
  const critSocSteps = AppState.summary.critical_soc_satellite_steps || 0;
  const elCritSoc = document.getElementById('kpiCriticalSocCount');
  if (elCritSoc) {
    elCritSoc.textContent = `Дефицит (<20%): ${critSocSteps} шагов`;
    if (critSocSteps > 0) elCritSoc.classList.add('kpi-sub-alert');
    else elCritSoc.classList.remove('kpi-sub-alert');
  }

  // Счётчики в заголовках вкладок
  document.getElementById('satCount').textContent = AppState.satellites.length;
  document.getElementById('jobCount').textContent = AppState.jobs.length;
}

/**
 * Таблица спутников
 */
function renderSatellitesTable() {
  const tbody = document.getElementById('satellitesTbody');
  const query = (document.getElementById('searchSatellite').value || '').toLowerCase().trim();

  const filtered = AppState.satellites.filter(s => {
    if (!query) return true;
    return s.id.toLowerCase().includes(query);
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="table-empty">Аппараты не найдены</td></tr>`;
    return;
  }

  let html = '';
  filtered.forEach(sat => {
    const isBelowReserve = sat.soc_pct < AppState.model.reserve_soc_pct;
    const isBelowCrit = sat.soc_pct < AppState.model.critical_soc_pct;
    const isTempAlert = sat.temp_c < AppState.model.payload_min_c || sat.temp_c > AppState.model.payload_max_c;
    const calibLimit = sat.calibration_valid_steps || 48;
    const isCalibUrgent = sat.calibration_age_steps >= (calibLimit - 6);

    // Класс полосы заряда
    let socColorClass = 'soc-normal';
    if (isBelowCrit) socColorClass = 'soc-danger';
    else if (isBelowReserve) socColorClass = 'soc-warning';

    let rowClass = 'row-healthy';
    if (!sat.available || isBelowCrit) rowClass = 'row-danger';
    else if (isBelowReserve || isTempAlert || isCalibUrgent) rowClass = 'row-warning';

    const isChecked = AppState.selectedSatellites.has(sat.id);

    html += `
      <tr class="${rowClass}">
        <td>
          <input type="checkbox" class="sat-checkbox" data-sat-id="${sat.id}" ${isChecked ? 'checked' : ''} />
        </td>
        <td>
          <strong class="sat-clickable" data-sat-id="${sat.id}" title="Нажмите для просмотра подробной телеметрии">${sat.id}</strong>
          ${isBelowReserve ? '<span class="badge badge-danger" style="margin-left:6px;">Ниже 30%!</span>' : ''}
        </td>
        <td>
          <div class="soc-cell">
            <div class="soc-bar-container">
              <div class="soc-bar ${socColorClass}" style="width: ${Math.min(100, Math.max(0, sat.soc_pct))}%"></div>
            </div>
            <span>${Number(sat.soc_pct).toFixed(1)}%</span>
          </div>
        </td>
        <td>
          <span class="${isTempAlert ? 'text-danger font-weight-bold' : ''}">
            ${Number(sat.temp_c).toFixed(1)}°C
          </span>
          ${isTempAlert ? ' ⚠️' : ''}
        </td>
        <td>
          <span>${sat.calibration_age_steps} / ${calibLimit}</span>
          ${isCalibUrgent ? '<span class="badge badge-warning" style="margin-left:6px;">Калибровка!</span>' : ''}
        </td>
        <td>${sat.capacity_wh} Вт·ч</td>
        <td>
          ${sat.available 
            ? '<span class="badge badge-success">В строю</span>' 
            : '<span class="badge badge-danger">Недоступен</span>'}
        </td>
      </tr>
    `;
  });

  tbody.innerHTML = html;

  // Слушатели чекбоксов
  tbody.querySelectorAll('.sat-checkbox').forEach(cb => {
    cb.addEventListener('change', (e) => {
      const id = e.target.dataset.satId;
      if (e.target.checked) {
        AppState.selectedSatellites.add(id);
      } else {
        AppState.selectedSatellites.delete(id);
      }
      renderCharts();
    });
  });

  // Клик по спутнику для детальной телеметрии
  tbody.querySelectorAll('.sat-clickable').forEach(el => {
    el.addEventListener('click', () => {
      openSatDetailModal(el.dataset.satId);
    });
  });
}

/**
 * Открытие модального окна подробной телеметрии аппарата
 */
function openSatDetailModal(satId) {
  if (typeof openAvionicsDrawer === 'function') {
    openAvionicsDrawer(satId);
  }
  const sat = AppState.satellites.find(s => s.id === satId);
  if (!sat) return;

  const modal = document.getElementById('modalSatDetail');
  document.getElementById('satDetailId').textContent = sat.id;

  const lastRow = (AppState.lastStepRows || []).find(r => r.satellite_id === sat.id);
  const isBelowReserve = sat.soc_pct < AppState.model.reserve_soc_pct;
  const isTempAlert = sat.temp_c < AppState.model.payload_min_c || sat.temp_c > AppState.model.payload_max_c;

  let lastStepInfo = '<p style="color:var(--text-dim); font-size:12px;">Сведения за последний шаг отсутствуют</p>';
  if (lastRow) {
    const trans = REASON_TRANSLATIONS[lastRow.reason] || { label: lastRow.reason, class: 'badge-muted', hint: '' };
    lastStepInfo = `
      <div class="metric-row"><span class="m-label">Запрошено:</span><strong class="m-val">${lastRow.requested ? lastRow.requested.action : 'idle'}${lastRow.requested && lastRow.requested.job_id ? ` (${lastRow.requested.job_id})` : ''}</strong></div>
      <div class="metric-row"><span class="m-label">Выполнено:</span><strong class="m-val">${lastRow.executed || 'idle'}</strong></div>
      <div class="metric-row"><span class="m-label">Статус решения:</span><span class="badge ${trans.class}">${trans.label}</span></div>
      <div class="metric-row"><span class="m-label">Нагрузка систем L:</span><strong class="m-val">${lastRow.load_w || 0} Вт</strong></div>
      <div class="metric-row"><span class="m-label">Солнечный приток S:</span><strong class="m-val">${lastRow.solar_w || 0} Вт</strong></div>
      <div class="metric-row"><span class="m-label">Завершённая задача:</span><strong class="m-val">${lastRow.completed_job || '—'}</strong></div>
    `;
  }

  document.getElementById('satDetailBody').innerHTML = `
    <div style="display:flex; flex-direction:column; gap:12px;">
      <div style="background:var(--bg-card); padding:14px; border-radius:var(--radius-md); border:1px solid var(--border-subtle);">
        <h4 style="font-size:11px; color:var(--text-dim); text-transform:uppercase; margin-bottom:8px; letter-spacing:0.5px;">Параметры борта</h4>
        <div class="metric-row">
          <span class="m-label">Заряд батареи (SOC):</span>
          <strong class="m-val ${isBelowReserve ? 'text-danger' : 'text-success'}">${Number(sat.soc_pct).toFixed(2)}% (${sat.capacity_wh} Вт·ч)</strong>
        </div>
        <div class="metric-row">
          <span class="m-label">Температура оборудования:</span>
          <strong class="m-val ${isTempAlert ? 'text-danger' : ''}">${Number(sat.temp_c).toFixed(2)}°C (норма: 5..45°C)</strong>
        </div>
        <div class="metric-row">
          <span class="m-label">Возраст калибровки:</span>
          <strong class="m-val">${sat.calibration_age_steps} из ${sat.calibration_valid_steps || 48} шагов</strong>
        </div>
        <div class="metric-row">
          <span class="m-label">Готовность к работе:</span>
          <strong class="m-val">${sat.available ? '<span class="badge badge-success">В строю</span>' : '<span class="badge badge-danger">Недоступен</span>'}</strong>
        </div>
      </div>

      <div style="background:var(--bg-card); padding:14px; border-radius:var(--radius-md); border:1px solid var(--border-subtle);">
        <h4 style="font-size:11px; color:var(--text-dim); text-transform:uppercase; margin-bottom:8px; letter-spacing:0.5px;">Последний выполненный шаг</h4>
        ${lastStepInfo}
      </div>
    </div>
  `;

  const btnToggleChart = document.getElementById('btnToggleChartForThisSat');
  btnToggleChart.onclick = () => {
    AppState.selectedSatellites.add(sat.id);
    renderSatellitesTable();
    renderCharts();
    modal.classList.add('hidden');
    document.querySelector('.nav-tab[data-tab="tabCharts"]').click();
  };

  modal.classList.remove('hidden');
}

/**
 * Таблица заданий с фильтрами и сортировкой
 */
function renderJobsTable() {
  const tbody = document.getElementById('jobsTbody');
  const statusFilter = document.getElementById('filterJobStatus').value;
  const priorityFilter = document.getElementById('filterJobPriority').value;
  const sortBy = document.getElementById('sortJobBy').value;
  const search = (document.getElementById('searchJob').value || '').toLowerCase().trim();

  let list = [...AppState.jobs];

  // Фильтр по статусу
  if (statusFilter !== 'all') {
    list = list.filter(j => j.status === statusFilter);
  }

  // Фильтр по приоритету
  if (priorityFilter !== 'all') {
    list = list.filter(j => String(j.priority) === priorityFilter);
  }

  // Поиск по ID
  if (search) {
    list = list.filter(j => j.id.toLowerCase().includes(search));
  }

  // Сортировка
  list.sort((a, b) => {
    if (sortBy === 'deadline') return a.deadline_step - b.deadline_step;
    if (sortBy === 'priority') return b.priority - a.priority;
    if (sortBy === 'value') return b.value_usd - a.value_usd;
    return a.id.localeCompare(b.id);
  });

  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" class="table-empty">Нет заданий, соответствующих выбранным фильтрам</td></tr>`;
    return;
  }

  let html = '';
  list.forEach(job => {
    // Бейдж статуса
    let statusBadge = '';
    if (job.status === 'done') statusBadge = '<span class="badge badge-success">done</span>';
    else if (job.status === 'missed') statusBadge = '<span class="badge badge-danger">missed</span>';
    else if (job.status === 'active') statusBadge = '<span class="badge badge-info">active</span>';
    else statusBadge = '<span class="badge badge-muted">waiting</span>';

    // Бейдж приоритета
    let priorityBadge = '';
    if (job.priority === 3) {
      priorityBadge = '<span class="badge badge-p3">3 (Срочное)</span>';
    } else {
      priorityBadge = `<span class="badge badge-muted">${job.priority}</span>`;
    }

    // Комментарий оператору
    let comment = '—';
    if (job.status === 'missed') {
      if (job.impossible) {
        comment = `<span class="text-warning" title="Суммарная длительность окон контакта до дедлайна: ${job.contact_steps} ш., а требуется ${job.work_steps} ш.">⚠️ Дефицит окон связи (окно ${job.contact_steps} из ${job.work_steps} ш.)</span>`;
      } else if (AppState.step >= job.deadline_step) {
        comment = `<span class="text-danger">Истёк срок на шаге ${job.deadline_step}</span>`;
      } else {
        comment = `<span class="text-danger">Сорвано (дефицит ресурсов)</span>`;
      }
    } else if (job.status === 'done') {
      comment = `<span class="text-success">Завершено на шаге ${job.completed_step !== null && job.completed_step !== undefined ? job.completed_step : '—'}</span>`;
    } else if (job.status === 'active') {
      if (job.impossible) {
        comment = `<span class="text-warning" title="Окна радиовидимости: ${job.contact_steps} из ${job.work_steps} ш.">⚠️ Не успеть по радиоокнам (${job.contact_steps} из ${job.work_steps} ш.)</span>`;
      } else {
        comment = `<span class="text-info">В работе / в очереди</span>`;
      }
    } else if (job.status === 'waiting') {
      if (job.impossible) {
        comment = `<span class="text-warning" title="Окна радиовидимости: ${job.contact_steps} из ${job.work_steps} ш.">⚠️ Дефицит окон (${job.contact_steps} из ${job.work_steps} ш.)</span>`;
      } else {
        comment = `Старт на шаге ${job.release_step}`;
      }
    }

    html += `
      <tr>
        <td><strong>${job.id}</strong></td>
        <td><span class="badge ${job.kind === 'downlink' ? 'badge-info' : 'badge-muted'}">${job.kind}</span></td>
        <td>${priorityBadge}</td>
        <td class="text-gold font-mono">$${Number(job.value_usd).toFixed(2)}</td>
        <td class="font-mono">${job.release_step} .. ${job.deadline_step}</td>
        <td class="font-mono">${job.remaining_steps !== undefined ? job.remaining_steps : '—'} / ${job.work_steps}</td>
        <td style="max-width:180px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${(job.eligible_satellites || []).join(', ')}">
          ${(job.eligible_satellites || []).join(', ')}
        </td>
        <td>${statusBadge}</td>
        <td>
          <div style="display:flex; align-items:center; justify-content:space-between; gap:6px;">
            <span>${comment}</span>
            <button class="btn-job-explain" data-job-id="${job.id}" title="Аудит решений планировщика по ${job.id}">
              🔍 Аудит
            </button>
          </div>
        </td>
      </tr>
    `;
  });

  tbody.innerHTML = html;
}

const REASON_TRANSLATIONS = {
  'accepted': { label: '✓ Принято', class: 'badge-success', hint: 'Команда успешно принята и исполняется' },
  'idle': { label: 'Ожидание', class: 'badge-muted', hint: 'Штатное ожидание' },
  'energy_reserve': { label: '⚠️ Ниже резерва 30%', class: 'badge-danger', hint: 'Отказ: энергия опустится ниже резерва 30%' },
  'thermal_limit': { label: '🌡️ Температурный предел', class: 'badge-danger', hint: 'Отказ: температура оборудования выходит за пределы 5..45°C' },
  'calibration_required': { label: '🔧 Нужна калибровка', class: 'badge-warning', hint: 'Отказ: калибровка устарела (>= 48 шагов)' },
  'no_contact': { label: '📡 Нет связи', class: 'badge-warning', hint: 'Отказ: связь со станцией или ретрансляция недоступна на шаге' },
  'ground_capacity': { label: '🛑 Лимит наземной связи', class: 'badge-danger', hint: 'Отказ: максимум 2 одновременных downlink на группировку' },
  'duplicate_job_in_step': { label: 'Конфликт назначения', class: 'badge-danger', hint: 'Отказ: над одним заданием не могут работать два аппарата сразу' },
  'satellite_unavailable': { label: 'Аппарат недоступен', class: 'badge-danger', hint: 'Отказ: спутник на техобслуживании или в отказе (outage)' },
  'outside_job_window': { label: 'Вне окна задачи', class: 'badge-danger', hint: 'Отказ: текущий шаг вне интервала выполнения задания' },
  'ineligible_satellite': { label: 'Недопустимый аппарат', class: 'badge-danger', hint: 'Отказ: спутник не входит в список допустимых для этого задания' },
  'already_completed': { label: 'Уже выполнено', class: 'badge-muted', hint: 'Задание уже полностью завершено ранее' },
  'unknown_job': { label: 'Неизвестная задача', class: 'badge-danger', hint: 'Задание с таким ID отсутствует в системе' }
};

/**
 * Журнал последнего выполненного шага (last_step_rows)
 */
function renderLastStepTable() {
  const tbody = document.getElementById('lastStepTable');
  if (!AppState.lastStepRows || AppState.lastStepRows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="table-empty">Сведения о выполненном шаге отсутствуют</td></tr>`;
    return;
  }

  let html = '';
  AppState.lastStepRows.forEach(row => {
    const requestedAction = row.requested ? row.requested.action : 'idle';
    const executedAction = row.executed || 'idle';
    const isRefused = requestedAction !== executedAction && requestedAction !== 'idle';

    const trans = REASON_TRANSLATIONS[row.reason] || {
      label: row.reason,
      class: row.reason === 'accepted' ? 'badge-success' : 'badge-danger',
      hint: row.reason
    };
    const reasonBadge = `<span class="badge ${trans.class}" title="${trans.hint}">${trans.label}</span>`;

    html += `
      <tr class="${isRefused ? 'row-reserve-alert' : ''}">
        <td><strong>${row.satellite_id}</strong></td>
        <td>${requestedAction}${row.requested && row.requested.job_id ? ` (${row.requested.job_id})` : ''}</td>
        <td><strong>${executedAction}</strong></td>
        <td>${reasonBadge}</td>
        <td class="font-mono">${row.load_w !== undefined ? row.load_w + ' Вт' : '—'}</td>
        <td class="font-mono">${row.solar_w !== undefined ? row.solar_w + ' Вт' : '—'}</td>
        <td>${row.completed_job ? `<span class="badge badge-success">${row.completed_job}</span>` : '—'}</td>
      </tr>
    `;
  });

  tbody.innerHTML = html;
}

/**
 * Отрисовка графиков Chart.js
 */
function renderCharts() {
  if (typeof Chart === 'undefined') return;

  const steps = AppState.series.steps || [];
  const selectedSats = Array.from(AppState.selectedSatellites);
  const showReserveLines = document.getElementById('chkShowReserveLines').checked;

  // 1. График заряда (SOC %)
  const socDatasets = [];
  selectedSats.forEach((satId, idx) => {
    const data = AppState.series.soc_pct[satId] || [];
    socDatasets.push({
      label: satId,
      data: data,
      borderColor: getSatColor(satId, idx),
      backgroundColor: 'transparent',
      borderWidth: 2,
      pointRadius: steps.length > 50 ? 0 : 2,
      tension: 0.1
    });
  });

  // Линия резерва 30%
  if (showReserveLines && steps.length > 0) {
    socDatasets.push({
      label: `Резерв (${AppState.model.reserve_soc_pct}%)`,
      data: steps.map(() => AppState.model.reserve_soc_pct),
      borderColor: '#ef4444',
      borderDash: [5, 5],
      borderWidth: 1.5,
      pointRadius: 0,
      fill: false
    });
    // Линия критического уровня 20%
    socDatasets.push({
      label: `Критический (${AppState.model.critical_soc_pct}%)`,
      data: steps.map(() => AppState.model.critical_soc_pct),
      borderColor: '#991b1b',
      borderDash: [2, 4],
      borderWidth: 1.5,
      pointRadius: 0,
      fill: false
    });
  }

  const socCanvas = document.getElementById('socChart');
  if (AppState.socChart) {
    AppState.socChart.data.labels = steps.map(s => `Ш.${s}`);
    AppState.socChart.data.datasets = socDatasets;
    AppState.socChart.update();
  } else if (socCanvas) {
    AppState.socChart = new Chart(socCanvas, {
      type: 'line',
      data: {
        labels: steps.map(s => `Ш.${s}`),
        datasets: socDatasets
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        scales: {
          x: {
            grid: { color: 'rgba(255, 255, 255, 0.05)' },
            ticks: { color: '#94a3b8', font: { size: 10 } }
          },
          y: {
            min: 0,
            max: 105,
            grid: { color: 'rgba(255, 255, 255, 0.05)' },
            ticks: { 
              color: '#94a3b8',
              callback: (v) => v + '%'
            }
          }
        },
        plugins: {
          legend: {
            labels: { color: '#f1f5f9', boxWidth: 12, font: { size: 11 } }
          },
          tooltip: {
            mode: 'index',
            intersect: false
          }
        }
      }
    });
  }

  // 2. График температуры (°C)
  const tempDatasets = [];
  selectedSats.forEach((satId, idx) => {
    const data = AppState.series.temp_c[satId] || [];
    tempDatasets.push({
      label: satId,
      data: data,
      borderColor: getSatColor(satId, idx),
      backgroundColor: 'transparent',
      borderWidth: 2,
      pointRadius: steps.length > 50 ? 0 : 2,
      tension: 0.1
    });
  });

  // Границы температуры (5°C и 45°C)
  if (showReserveLines && steps.length > 0) {
    tempDatasets.push({
      label: `Мин. темп. (${AppState.model.payload_min_c}°C)`,
      data: steps.map(() => AppState.model.payload_min_c),
      borderColor: '#06b6d4',
      borderDash: [5, 5],
      borderWidth: 1.5,
      pointRadius: 0,
      fill: false
    });
    tempDatasets.push({
      label: `Макс. темп. (${AppState.model.payload_max_c}°C)`,
      data: steps.map(() => AppState.model.payload_max_c),
      borderColor: '#f43f5e',
      borderDash: [5, 5],
      borderWidth: 1.5,
      pointRadius: 0,
      fill: false
    });
  }

  const tempCanvas = document.getElementById('tempChart');
  if (AppState.tempChart) {
    AppState.tempChart.data.labels = steps.map(s => `Ш.${s}`);
    AppState.tempChart.data.datasets = tempDatasets;
    AppState.tempChart.update();
  } else if (tempCanvas) {
    AppState.tempChart = new Chart(tempCanvas, {
      type: 'line',
      data: {
        labels: steps.map(s => `Ш.${s}`),
        datasets: tempDatasets
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        scales: {
          x: {
            grid: { color: 'rgba(255, 255, 255, 0.05)' },
            ticks: { color: '#94a3b8', font: { size: 10 } }
          },
          y: {
            suggestedMin: 0,
            suggestedMax: 50,
            grid: { color: 'rgba(255, 255, 255, 0.05)' },
            ticks: { 
              color: '#94a3b8',
              callback: (v) => v + '°C'
            }
          }
        },
        plugins: {
          legend: {
            labels: { color: '#f1f5f9', boxWidth: 12, font: { size: 11 } }
          },
          tooltip: {
            mode: 'index',
            intersect: false
          }
        }
      }
    });
  }
}

// =============================================================================
// 5. МОДАЛЬНЫЕ ОКНА И ОБРАБОТКА ФОРМ
// =============================================================================

/**
 * Заполнение селекта сценариев
 */
function populateScenariosSelect(scenarios) {
  const sel = document.getElementById('selectScenarioPreset');
  if (!scenarios || !scenarios.length) {
    sel.innerHTML = '<option value="">Сценарии недоступны</option>';
    return;
  }
  
  sel.innerHTML = scenarios.map(s => `
    <option value="${s.id}">
      ${s.id} — ${s.title || ''} (${s.satellites} спутн., ${s.steps} шагов, ${s.jobs} зад.)
    </option>
  `).join('');

  updateScenarioDetails();
}

function updateScenarioDetails() {
  const sel = document.getElementById('selectScenarioPreset');
  const detailsDiv = document.getElementById('scenarioPresetDetails');
  const found = AppState.scenariosList.find(s => s.id === sel.value);
  if (found) {
    detailsDiv.textContent = `Длительность: ${found.steps * 5 / 60} ч (${found.steps} шагов), Аппаратов: ${found.satellites}, Заданий: ${found.jobs}`;
  } else {
    detailsDiv.textContent = '';
  }
}

/**
 * Отрисовка модального окна сравнения (Compare)
 */
function renderCompareModal(compData) {
  if (!compData) return;

  const a = compData.a || {};
  const b = compData.b || {};
  const sumA = a.summary || {};
  const sumB = b.summary || {};

  const algLabelA = a.algorithm ? (a.algorithm === 'smart' ? '🧠 Smart' : '⚙️ Baseline') : '';
  const algLabelB = b.algorithm ? (b.algorithm === 'smart' ? '🧠 Smart' : '⚙️ Baseline') : '';
  document.getElementById('compNameA').textContent = algLabelA ? `${algLabelA} (${a.goal || 'priority'})` : (a.goal || 'A');
  document.getElementById('compNameB').textContent = algLabelB ? `${algLabelB} (${b.goal || 'revenue'})` : (b.goal || 'B');

  const jobsA = sumA.jobs_completed !== undefined ? sumA.jobs_completed : 0;
  const jobsB = sumB.jobs_completed !== undefined ? sumB.jobs_completed : 0;
  const jobsDiff = jobsB - jobsA;
  const jobsDiffBadge = jobsDiff !== 0 
    ? `<span class="delta-badge ${jobsDiff > 0 ? 'delta-pos' : 'delta-neg'}">${jobsDiff > 0 ? '+' : ''}${jobsDiff}</span>` 
    : '';
  document.getElementById('compA_jobsCompleted').textContent = jobsA;
  document.getElementById('compB_jobsCompleted').innerHTML = `${jobsB} ${jobsDiffBadge}`;

  const critA = sumA.critical_jobs_completed_on_time || 0;
  const critDueA = sumA.critical_jobs_due || 0;
  const critB = sumB.critical_jobs_completed_on_time || 0;
  const critDueB = sumB.critical_jobs_due || 0;
  const critDiff = critB - critA;
  const critDiffBadge = critDiff !== 0
    ? `<span class="delta-badge ${critDiff > 0 ? 'delta-pos' : 'delta-neg'}">${critDiff > 0 ? '+' : ''}${critDiff}</span>`
    : '';
  document.getElementById('compA_critJobs').textContent = `${critA} / ${critDueA}`;
  document.getElementById('compB_critJobs').innerHTML = `${critB} / ${critDueB} ${critDiffBadge}`;

  const revA = sumA.revenue_usd || 0;
  const revB = sumB.revenue_usd || 0;
  const revDiff = revB - revA;
  const revDiffBadge = revDiff !== 0
    ? `<span class="delta-badge ${revDiff > 0 ? 'delta-pos' : 'delta-neg'}">${revDiff > 0 ? '+' : ''}$${revDiff.toFixed(2)}</span>`
    : '';
  document.getElementById('compA_revenue').textContent = `$${revA.toFixed(2)}`;
  document.getElementById('compB_revenue').innerHTML = `$${revB.toFixed(2)} ${revDiffBadge}`;

  const minSocA = sumA.minimum_soc_pct !== undefined ? sumA.minimum_soc_pct : 0;
  const minSocB = sumB.minimum_soc_pct !== undefined ? sumB.minimum_soc_pct : 0;
  const socDiff = minSocB - minSocA;
  const socDiffBadge = socDiff !== 0
    ? `<span class="delta-badge ${socDiff > 0 ? 'delta-pos' : 'delta-neg'}">${socDiff > 0 ? '+' : ''}${socDiff.toFixed(1)}%</span>`
    : '';
  document.getElementById('compA_minSoc').textContent = `${Number(minSocA).toFixed(1)}%`;
  document.getElementById('compB_minSoc').innerHTML = `${Number(minSocB).toFixed(1)}% ${socDiffBadge}`;

  const belowA = sumA.below_reserve_satellite_steps || 0;
  const belowB = sumB.below_reserve_satellite_steps || 0;
  const belowDiff = belowB - belowA;
  const belowDiffBadge = belowDiff !== 0
    ? `<span class="delta-badge ${belowDiff < 0 ? 'delta-pos' : 'delta-neg'}">${belowDiff > 0 ? '+' : ''}${belowDiff}</span>`
    : '';
  document.getElementById('compA_belowReserve').textContent = `${belowA} шагов`;
  document.getElementById('compB_belowReserve').innerHTML = `${belowB} шагов ${belowDiffBadge}`;

  // Отрисовка остаточного заряда ключевых аппаратов (terminal_soc_pct)
  const termAContainer = document.getElementById('compA_terminalSoc');
  const termBContainer = document.getElementById('compB_terminalSoc');
  
  if (sumA.terminal_soc_pct && Object.keys(sumA.terminal_soc_pct).length > 0) {
    let termAHtml = '<div class="terminal-soc-title">Остаточный заряд аппаратов:</div>';
    for (const [sid, soc] of Object.entries(sumA.terminal_soc_pct)) {
      termAHtml += `
        <div class="terminal-soc-item">
          <span>${sid}:</span>
          <strong>${Number(soc).toFixed(1)}%</strong>
        </div>`;
    }
    termAContainer.innerHTML = termAHtml;
  } else {
    termAContainer.innerHTML = '';
  }

  if (sumB.terminal_soc_pct && Object.keys(sumB.terminal_soc_pct).length > 0) {
    let termBHtml = '<div class="terminal-soc-title">Остаточный заряд аппаратов:</div>';
    for (const [sid, soc] of Object.entries(sumB.terminal_soc_pct)) {
      termBHtml += `
        <div class="terminal-soc-item">
          <span>${sid}:</span>
          <strong>${Number(soc).toFixed(1)}%</strong>
        </div>`;
    }
    termBContainer.innerHTML = termBHtml;
  } else {
    termBContainer.innerHTML = '';
  }

  // Вердикт
  document.getElementById('verdictText').textContent = compData.verdict || 'Сравнение выполнено успешно.';
}

/**
 * Открытие модального окна аудита решений (Explain Engine · О7)
 */
async function openExplainModal(targetJobId = null) {
  const modal = document.getElementById('modalExplain');
  if (!modal) return;
  modal.classList.remove('hidden');

  showLoader('Загрузка аудита решений планировщика...');
  const explainData = await apiGetExplain(null);
  hideLoader();

  renderExplainModal(explainData, targetJobId);

  if (targetJobId) {
    const tabTop = document.getElementById('btnExplainTabTop');
    const tabDetail = document.getElementById('btnExplainTabJobDetail');
    const secTop = document.getElementById('explainSectionTop');
    const secDetail = document.getElementById('explainSectionDetail');
    if (tabTop && tabDetail && secTop && secDetail) {
      tabTop.classList.remove('active');
      tabDetail.classList.add('active');
      secTop.classList.add('hidden');
      secDetail.classList.remove('hidden');
    }
    const input = document.getElementById('explainJobIdInput');
    if (input) input.value = targetJobId;
    await renderJobExplain(targetJobId);
  }
}

/**
 * Отрисовка модального окна Explain
 */
function renderExplainModal(data, targetJobId = null) {
  if (!data) return;

  const notComp = data.jobs_not_completed !== undefined ? data.jobs_not_completed : 0;
  const reasons = data.reasons || {};
  const impossibleCount = reasons.impossible_by_contact_window || 0;
  const notReleasedCount = reasons.not_released_yet || 0;
  const energyCount = (reasons.energy_reserve || 0) + (reasons.occupied || 0);

  const elNotComp = document.getElementById('explainNotCompletedCount');
  if (elNotComp) elNotComp.textContent = notComp;
  const elImp = document.getElementById('explainImpossibleCount');
  if (elImp) elImp.textContent = impossibleCount;
  const elNotRel = document.getElementById('explainNotReleasedCount');
  if (elNotRel) elNotRel.textContent = notReleasedCount;
  const elEnergy = document.getElementById('explainEnergyCount');
  if (elEnergy) elEnergy.textContent = energyCount;

  // Отрисовка таблицы топ-задач с высоким приоритетом
  const tbody = document.getElementById('explainTopTbody');
  if (!tbody) return;

  const topJobs = data.top_priority_jobs || [];
  if (topJobs.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="table-empty">Все срочные задания выполнены или отсутствуют</td></tr>';
    return;
  }

  let html = '';
  topJobs.forEach(job => {
    let verdictBadge = '';
    if (job.verdict === 'impossible_by_contact_window') {
      verdictBadge = '<span class="audit-badge audit-badge-danger">⚠️ Физически невозможно (дефицит окон)</span>';
    } else if (job.verdict === 'not_released_yet') {
      verdictBadge = '<span class="audit-badge audit-badge-info">Окно ещё не открылось</span>';
    } else if (job.verdict === 'on_track') {
      verdictBadge = '<span class="audit-badge audit-badge-success">В графике / исполняется</span>';
    } else if (job.verdict === 'energy_reserve') {
      verdictBadge = '<span class="audit-badge audit-badge-danger">Защита резерва АКБ (SOC &lt; 30%)</span>';
    } else {
      verdictBadge = `<span class="audit-badge audit-badge-warn">${job.verdict || 'В очереди'}</span>`;
    }

    const proof = job.proof || {};
    const contactSteps = proof.contact_steps !== undefined ? proof.contact_steps : '—';
    const workSteps = proof.work_steps !== undefined ? proof.work_steps : (job.work_steps || '—');
    const isImpossible = (typeof contactSteps === 'number' && typeof workSteps === 'number' && contactSteps < workSteps);

    let statusBadge = '';
    if (job.status === 'done') statusBadge = '<span class="badge badge-success">done</span>';
    else if (job.status === 'missed') statusBadge = '<span class="badge badge-danger">missed</span>';
    else if (job.status === 'in_progress' || job.status === 'active') statusBadge = '<span class="badge badge-info">active</span>';
    else statusBadge = '<span class="badge badge-muted">waiting</span>';

    html += `
      <tr>
        <td class="font-mono"><strong>${job.job_id}</strong></td>
        <td><span class="badge ${job.kind === 'downlink' ? 'badge-info' : 'badge-muted'}">${job.kind || '—'}</span></td>
        <td class="text-gold font-mono">$${Number(job.value_usd || 0).toFixed(2)}</td>
        <td class="font-mono">${job.release_step} .. ${job.deadline_step}</td>
        <td class="font-mono ${isImpossible ? 'text-danger font-bold' : ''}">
          ${contactSteps} / ${workSteps}
          ${isImpossible ? ' ❌' : ' ✓'}
        </td>
        <td>${statusBadge}</td>
        <td>${verdictBadge}</td>
        <td>
          <button class="btn btn-xs btn-outline btn-explain-row-inspect" data-job-id="${job.job_id}">
            Детали
          </button>
        </td>
      </tr>
    `;
  });

  tbody.innerHTML = html;
}

/**
 * Отрисовка аудита конкретного задания (Explain Job)
 */
async function renderJobExplain(jobId) {
  const container = document.getElementById('jobAuditDetails');
  if (!container) return;

  if (!jobId) {
    container.innerHTML = '<span class="text-tertiary">Укажите ID задания для получения пошагового аудита.</span>';
    return;
  }

  container.innerHTML = '<span class="text-accent">Анализ причин и математическое доказательство...</span>';
  
  const audit = await apiGetExplain(jobId);
  if (!audit) {
    container.innerHTML = `<span class="text-danger">Не удалось получить данные для задания ${jobId}</span>`;
    return;
  }

  const proof = audit.proof || {};
  const isImpossible = (proof.contact_steps !== undefined && proof.work_steps !== undefined && proof.contact_steps < proof.work_steps);

  let reasonRows = '';
  const lost = audit.lost_steps_by_reason || {};
  const REASON_TITLES = {
    occupied: 'Занятость подходящих спутников другими задачами',
    calibration: 'Аппараты выполняли плановую калибровку сенсоров',
    energy_reserve: 'Защита батареи (разряд опустился бы ниже резерва 30%)',
    thermal_limit: 'Выход за безопасный температурный лимит 5..45°C',
    ground_capacity: 'Исчерпан параллельный лимит наземных станций связи',
    satellite_unavailable: 'Аппараты в аварии или на техобслуживании (outage)'
  };

  for (const [rKey, count] of Object.entries(lost)) {
    if (count > 0) {
      reasonRows += `
        <div class="audit-reason-row">
          <span class="audit-reason-name">${REASON_TITLES[rKey] || rKey}:</span>
          <strong class="font-mono text-warning">${count} шагов</strong>
        </div>
      `;
    }
  }

  if (!reasonRows) {
    reasonRows = '<div style="color:var(--text-tertiary); font-size:12px;">Потерь шагов по вторичным причинам не зафиксировано</div>';
  }

  container.innerHTML = `
    <div class="job-audit-header">
      <div style="display:flex; align-items:center; gap:8px;">
        <span class="font-mono" style="font-size:15px; font-weight:700; color:var(--text-primary);">${audit.job_id || jobId}</span>
        <span class="badge ${audit.status === 'done' ? 'badge-success' : (audit.status === 'missed' ? 'badge-danger' : 'badge-info')}">
          ${audit.status || 'active'}
        </span>
        ${isImpossible ? '<span class="audit-badge audit-badge-danger">Математически невозможно</span>' : ''}
      </div>
      <span class="font-mono text-gold" style="font-weight:700;">$${Number(audit.value_usd || 0).toFixed(2)}</span>
    </div>

    <div style="margin-top:10px;">
      <p style="font-size:13px; line-height:1.5; color:var(--text-secondary); margin-bottom:12px;">
        ${audit.text || 'Анализ завершен.'}
      </p>

      ${isImpossible ? `
        <div class="impossible-proof-box">
          <div style="font-weight:700; color:var(--accent-red); margin-bottom:4px;">
            ⚠️ Математическое доказательство (Критерий О7):
          </div>
          <div style="font-size:12px; color:var(--text-secondary);">
            Суммарная длительность всех окон связи со всеми допустимыми аппаратами от релиза (ш.${audit.release_step !== undefined ? audit.release_step : '—'}) до дедлайна (ш.${audit.deadline_step !== undefined ? audit.deadline_step : '—'}) составляет 
            <strong class="text-danger font-mono">${proof.contact_steps}</strong> шагов, в то время как выполнение задания требует 
            <strong class="text-accent font-mono">${proof.work_steps}</strong> шагов.
            <br>
            <em>Вывод: Задание не может быть выполнено ни одним физически реализуемым планом (contact_steps &lt; work_steps). Вины планировщика нет.</em>
          </div>
        </div>
      ` : ''}

      <div style="margin-top:12px;">
        <div style="font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.06em; color:var(--text-tertiary); margin-bottom:6px;">
          РАСПРЕДЕЛЕНИЕ ПОТЕРЯННЫХ ШАГОВ ВОЗМОЖНОСТИ:
        </div>
        <div class="audit-reasons-list">
          ${reasonRows}
        </div>
      </div>
    </div>
  `;
}

/**
 * Открытие модального окна статистики загрузки флота (Stats)
 */
async function openStatsModal() {
  const modal = document.getElementById('modalStats');
  if (!modal) return;
  modal.classList.remove('hidden');

  showLoader('Загрузка статистики утилизации группировки...');
  const statsData = await apiGetStats();
  hideLoader();

  renderStatsModal(statsData);
}

/**
 * Отрисовка модального окна Stats
 */
function renderStatsModal(statsData) {
  if (!statsData) return;

  const sats = statsData.satellites || [];
  let totalJobSteps = 0;
  let totalCalibSteps = 0;
  let totalIdleSteps = 0;
  let totalAllSteps = 0;

  sats.forEach(s => {
    totalJobSteps += s.job_steps || 0;
    totalCalibSteps += s.calibration_steps || 0;
    totalIdleSteps += s.idle_steps || 0;
    totalAllSteps += s.steps_total || 0;
  });

  const jobShare = totalAllSteps > 0 ? ((totalJobSteps / totalAllSteps) * 100).toFixed(1) : '0.0';
  const calibShare = totalAllSteps > 0 ? ((totalCalibSteps / totalAllSteps) * 100).toFixed(1) : '0.0';
  const idleShare = totalAllSteps > 0 ? ((totalIdleSteps / totalAllSteps) * 100).toFixed(1) : '0.0';
  const contactUtil = statsData.contact_utilization !== undefined && statsData.contact_utilization !== null
    ? (Number(statsData.contact_utilization) * 100).toFixed(1)
    : '0.0';

  const elJob = document.getElementById('statsJobShare');
  if (elJob) elJob.textContent = `${jobShare}%`;
  const elCal = document.getElementById('statsCalibShare');
  if (elCal) elCal.textContent = `${calibShare}%`;
  const elIdle = document.getElementById('statsIdleShare');
  if (elIdle) elIdle.textContent = `${idleShare}%`;
  const elContact = document.getElementById('statsContactUtil');
  if (elContact) elContact.textContent = `${contactUtil}%`;

  // Отрисовка таблицы по аппаратам
  const tbody = document.getElementById('statsSatellitesTbody');
  if (!tbody) return;

  if (sats.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="table-empty">Нет данных статистики аппаратов</td></tr>';
    return;
  }

  let html = '';
  sats.forEach(s => {
    const jShare = ((s.job_share || 0) * 100).toFixed(1);
    const cUtil = s.contact_utilization !== undefined && s.contact_utilization !== null
      ? ((s.contact_utilization) * 100).toFixed(1) + '%'
      : '—';

    let topReason = '—';
    let topReasonCount = 0;
    const IDLE_TITLES = {
      no_work: 'Ожидание задач',
      energy_reserve: 'Дефицит заряда (SOC < 30%)',
      calibration_needed: 'Ожидание калибровки',
      ground_capacity: 'Лимит станций связи',
      satellite_unavailable: 'Отказ аппарата',
      thermal_limit: 'Температурный предел',
      other: 'Прочее'
    };
    if (s.idle_reasons) {
      for (const [r, count] of Object.entries(s.idle_reasons)) {
        if (count > topReasonCount) {
          topReasonCount = count;
          topReason = `${IDLE_TITLES[r] || r} (${count} ш.)`;
        }
      }
    }

    html += `
      <tr>
        <td class="font-mono"><strong>${s.id}</strong></td>
        <td class="font-mono">${s.job_steps}</td>
        <td class="font-mono">${s.calibration_steps}</td>
        <td class="font-mono">${s.idle_steps}</td>
        <td class="font-mono text-accent font-bold">${jShare}%</td>
        <td class="font-mono">${s.contact_steps || 0}</td>
        <td class="font-mono text-gold font-bold">${cUtil}</td>
        <td style="font-size:12px; color:var(--text-secondary);">${topReason}</td>
      </tr>
    `;
  });

  tbody.innerHTML = html;
}

// =============================================================================
// 6. ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ И ИНИЦИАЛИЗАЦИЯ
// =============================================================================

function formatMinutesToHHMM(totalMinutes) {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function setConnectionStatus(type, text) {
  const dot = document.getElementById('statusDot');
  const txt = document.getElementById('statusText');

  if (dot) {
    dot.className = 'status-pip ' + (type === 'online' ? 'online' : 'mock');
  }
  if (txt) {
    txt.textContent = text;
  }
}

function showLoader(text = 'Выполняется расчёт...') {
  if (AppState.isAutoRunning) return;
  const loader = document.getElementById('operationLoader');
  document.getElementById('loaderText').textContent = text;
  loader.classList.remove('hidden');

  // Блокируем кнопки шага кроме кнопки Пауза
  document.querySelectorAll('.btn-step:not(#btnPause)').forEach(b => b.disabled = true);
}

function hideLoader() {
  document.getElementById('operationLoader').classList.add('hidden');
  document.querySelectorAll('.btn-step').forEach(b => b.disabled = false);
}

function showAlert(text) {
  const banner = document.getElementById('alertBanner');
  document.getElementById('alertMsg').textContent = text;
  banner.classList.remove('hidden');
}

function hideAlert() {
  document.getElementById('alertBanner').classList.add('hidden');
}

// =============================================================================
// 7. СЛУШАТЕЛИ СОБЫТИЙ (DOM Event Listeners)
// =============================================================================

document.addEventListener('DOMContentLoaded', () => {

  // Инициализация связи с бэкендом
  initBackendConnection();

  // Автоматический старт демо-смены при первой загрузке, чтобы страница не была пустой
  apiStartSession('P01_intro', 'priority');

  // Клик по статусу связи для повторной проверки/переподключения
  const statusBadge = document.getElementById('connectionStatusWrapper');
  if (statusBadge) {
    statusBadge.addEventListener('click', initBackendConnection);
  }

  // Закрытие алерта
  document.getElementById('alertClose').addEventListener('click', hideAlert);

  // Инициализация аэрокосмических модулей ЦУП
  if (typeof Globe3D === 'function' && document.getElementById('globe3dContainer')) {
    window.globe3dInstance = new Globe3D('globe3dContainer');
    document.getElementById('btnGlobeAutoRotate')?.addEventListener('click', () => {
      window.globe3dInstance.toggleAutoRotate();
    });
    document.getElementById('btnGlobeResetView')?.addEventListener('click', () => {
      window.globe3dInstance.resetView();
    });
  }
  if (typeof OrbitalMap === 'function' && document.getElementById('orbitalMapCanvas')) {
    window.orbitalMapInstance = new OrbitalMap('orbitalMapCanvas');
  }
  if (typeof PassGantt === 'function' && document.getElementById('passGanttContainer')) {
    window.passGanttInstance = new PassGantt('passGanttContainer');
  }
  if (typeof FlightDirectorLog === 'function' && document.getElementById('flightLogStream')) {
    window.flightLogInstance = new FlightDirectorLog('flightLogStream');
  }

  // Табы рабочей зоны
  document.querySelectorAll('.nav-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-tab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(c => c.classList.remove('active'));

      btn.classList.add('active');
      const targetTab = document.getElementById(btn.dataset.tab);
      if (targetTab) targetTab.classList.add('active');

      // Реакция на переключение табов
      if (btn.dataset.tab === 'tabMap') {
        if (window.globe3dInstance) window.globe3dInstance.onResize();
        if (window.orbitalMapInstance) window.orbitalMapInstance.resize();
        if (window.passGanttInstance) window.passGanttInstance.render();
      } else if (btn.dataset.tab === 'tabCharts') {
        renderCharts();
      } else if (btn.dataset.tab === 'tabFlightLog') {
        if (window.flightLogInstance) window.flightLogInstance.render();
      }
    });
  });

  // Фильтры и кнопки журнала полетов (Flight Log)
  document.querySelectorAll('.btn-log-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.btn-log-filter').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      if (window.flightLogInstance) {
        window.flightLogInstance.setFilter(btn.dataset.filter);
      }
    });
  });

  const searchLogInput = document.getElementById('searchFlightLog');
  if (searchLogInput) {
    searchLogInput.addEventListener('input', (e) => {
      if (window.flightLogInstance) {
        window.flightLogInstance.setSearch(e.target.value);
      }
    });
  }

  const btnExportLog = document.getElementById('btnExportFlightLog');
  if (btnExportLog) {
    btnExportLog.addEventListener('click', () => {
      if (window.flightLogInstance) window.flightLogInstance.exportTxt();
    });
  }

  const btnClearLog = document.getElementById('btnClearFlightLog');
  if (btnClearLog) {
    btnClearLog.addEventListener('click', () => {
      if (window.flightLogInstance) window.flightLogInstance.clear();
    });
  }

  // Управление шагами
  document.getElementById('btnStep1').addEventListener('click', () => {
    if (AppState.isAutoRunning) stopAutoPlay(true);
    apiStep(1);
  });
  document.getElementById('btnStep12').addEventListener('click', () => {
    if (AppState.isAutoRunning) stopAutoPlay(true);
    apiStep(12);
  });

  document.getElementById('btnRunUntil').addEventListener('click', () => {
    if (AppState.isAutoRunning) stopAutoPlay(true);
    const inputVal = parseInt(document.getElementById('inputUntilStep').value, 10);
    if (isNaN(inputVal) || inputVal <= 0) {
      showAlert('Введите корректный номер целевого шага');
      return;
    }
    apiRunUntil(inputVal);
  });

  document.getElementById('btnPause').addEventListener('click', togglePlayPause);

  // Смена цели управления
  document.getElementById('goalSelect').addEventListener('change', (e) => {
    apiChangeGoal(e.target.value);
  });

  // Смена алгоритма планирования
  const algSelect = document.getElementById('algorithmSelect');
  if (algSelect) {
    algSelect.addEventListener('change', (e) => {
      apiSetAlgorithm(e.target.value);
    });
  }

  // Быстрый выбор спутников для графиков
  document.getElementById('btnSelectAllSats').addEventListener('click', () => {
    AppState.satellites.forEach(s => AppState.selectedSatellites.add(s.id));
    renderSatellitesTable();
    renderCharts();
  });

  document.getElementById('btnSelectFirst4Sats').addEventListener('click', () => {
    AppState.selectedSatellites.clear();
    AppState.satellites.slice(0, 4).forEach(s => AppState.selectedSatellites.add(s.id));
    renderSatellitesTable();
    renderCharts();
  });

  document.getElementById('btnClearSatSelection').addEventListener('click', () => {
    AppState.selectedSatellites.clear();
    renderSatellitesTable();
    renderCharts();
  });

  // Фильтры и поиск в таблицах
  document.getElementById('searchSatellite').addEventListener('input', renderSatellitesTable);
  document.getElementById('filterJobStatus').addEventListener('change', renderJobsTable);
  document.getElementById('filterJobPriority').addEventListener('change', renderJobsTable);
  document.getElementById('sortJobBy').addEventListener('change', renderJobsTable);
  document.getElementById('searchJob').addEventListener('input', renderJobsTable);
  document.getElementById('chkShowReserveLines').addEventListener('change', renderCharts);

  // ==========================
  // МОДАЛКА: НОВАЯ СМЕНА
  // ==========================
  const modalNewSession = document.getElementById('modalNewSession');
  document.getElementById('btnOpenNewSession').addEventListener('click', () => {
    modalNewSession.classList.remove('hidden');
  });
  document.getElementById('btnCloseSessionModal').addEventListener('click', () => {
    modalNewSession.classList.add('hidden');
  });
  document.getElementById('btnCancelSessionModal').addEventListener('click', () => {
    modalNewSession.classList.add('hidden');
  });

  document.getElementById('selectScenarioPreset').addEventListener('change', updateScenarioDetails);

  // Загрузка файла пользователем
  const fileInput = document.getElementById('fileScenarioInput');
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      document.getElementById('fileScenarioName').textContent = file.name;
      const reader = new FileReader();
      reader.onload = (evt) => {
        try {
          AppState.customScenarioJson = JSON.parse(evt.target.result);
          document.getElementById('fileScenarioName').textContent = `${file.name} (успешно прочитан)`;
        } catch (err) {
          showAlert('Ошибка парсинга загруженного JSON: ' + err.message);
          AppState.customScenarioJson = null;
        }
      };
      reader.readAsText(file);
    }
  });

  // Тоггл блока экспериментальных параметров (overrides)
  const chkEnableOverrides = document.getElementById('chkEnableOverrides');
  const overridesBody = document.getElementById('overridesBody');
  if (document.getElementById('toggleOverrides')) {
    document.getElementById('toggleOverrides').addEventListener('click', () => {
      chkEnableOverrides.checked = !chkEnableOverrides.checked;
      if (chkEnableOverrides.checked) overridesBody.classList.remove('hidden');
      else overridesBody.classList.add('hidden');
    });
    chkEnableOverrides.addEventListener('change', () => {
      if (chkEnableOverrides.checked) overridesBody.classList.remove('hidden');
      else overridesBody.classList.add('hidden');
    });
  }

  document.getElementById('btnConfirmStartSession').addEventListener('click', async () => {
    const goal = document.querySelector('input[name="startGoal"]:checked').value;
    const algRadio = document.querySelector('input[name="startAlgorithm"]:checked');
    const algorithm = algRadio ? algRadio.value : 'smart';
    const scenarioId = document.getElementById('selectScenarioPreset').value;
    const customJson = AppState.customScenarioJson;

    let overrides = null;
    if (chkEnableOverrides && chkEnableOverrides.checked) {
      overrides = {};
      const satSoc = document.getElementById('overrideSocSat').value.trim();
      const valSoc = parseFloat(document.getElementById('overrideSocVal').value);
      if (satSoc && !isNaN(valSoc)) {
        overrides.initial_soc_pct = { satellite_id: satSoc, value: valSoc };
      }

      const solFactor = parseFloat(document.getElementById('overrideSolarFactor').value);
      const solSat = document.getElementById('overrideSolarSat').value.trim();
      if (!isNaN(solFactor)) {
        overrides.solar_factor = { value: solFactor };
        if (solSat && solSat.toLowerCase() !== 'все' && solSat.toLowerCase() !== 'all') {
          overrides.solar_factor.satellite_id = solSat;
        }
      }

      const jobId = document.getElementById('overrideJobId').value.trim();
      const jobPrio = parseInt(document.getElementById('overrideJobPriority').value, 10);
      if (jobId && !isNaN(jobPrio)) {
        overrides.priority = { job_id: jobId, value: jobPrio };
      }

      const outSat = document.getElementById('overrideOutageSat').value.trim();
      const outStart = parseInt(document.getElementById('overrideOutageStart').value, 10);
      const outEnd = parseInt(document.getElementById('overrideOutageEnd').value, 10);
      if (outSat && !isNaN(outStart) && !isNaN(outEnd)) {
        overrides.outage = { satellite_id: outSat, start_step: outStart, end_step: outEnd };
      }

      if (Object.keys(overrides).length === 0) {
        overrides = null;
      }
    }

    const success = await apiStartSession(scenarioId, goal, algorithm, customJson, overrides);
    if (success) {
      modalNewSession.classList.add('hidden');
    }
  });

  // ==========================
  // МОДАЛКА: ВВОД СОБЫТИЯ
  // ==========================
  const modalEvent = document.getElementById('modalEvent');
  const eventErrorBox = document.getElementById('eventErrorBox');
  const eventErrorText = document.getElementById('eventErrorText');

  const DEMO_EVENT_PRESETS = {
    preset_e1: {
      id: "E-01",
      at_step: 72,
      type: "add_jobs",
      jobs: [
        { id: "URG-P-01", kind: "relay", release_step: 72, deadline_step: 80, work_steps: 3, eligible_satellites: ["S08", "S10", "S12"], priority: 3, value_usd: 40 },
        { id: "URG-P-02", kind: "relay", release_step: 72, deadline_step: 82, work_steps: 4, eligible_satellites: ["S08", "S10", "S12"], priority: 3, value_usd: 70 },
        { id: "URG-P-03", kind: "downlink", release_step: 72, deadline_step: 84, work_steps: 1, eligible_satellites: ["S01"], priority: 3, value_usd: 30 }
      ]
    },
    preset_e2: {
      id: "E-02",
      at_step: 74,
      type: "satellite_outage",
      satellite_ids: ["S08", "S10"],
      end_step: 90
    },
    preset_e3: {
      id: "E-03",
      at_step: 144,
      type: "close_downlink",
      satellite_ids: Array.from({ length: 48 }, (_, i) => `S${String(i + 1).padStart(2, '0')}`),
      end_step: 156
    },
    preset_e4: {
      id: "E-04",
      at_step: 146,
      type: "add_jobs",
      jobs: [
        { id: "URG-P-04", kind: "downlink", release_step: 146, deadline_step: 150, work_steps: 2, eligible_satellites: ["S03"], priority: 3, value_usd: 50 }
      ]
    }
  };

  function loadEventIntoForm(evt) {
    if (!evt) return;
    document.getElementById('eventIdInput').value = evt.id || `E-${AppState.step + 1}`;
    document.getElementById('eventTypeSelect').value = evt.type || 'add_jobs';
    
    if (evt.type === 'add_jobs') {
      document.getElementById('fieldsOutageOrDownlink').classList.add('hidden');
      document.getElementById('fieldsAddJob').classList.remove('hidden');
      const j = (evt.jobs && evt.jobs[0]) || {};
      document.getElementById('newJobId').value = j.id || `JOB-NEW-${Date.now()}`;
      document.getElementById('newJobKind').value = j.kind || 'downlink';
      document.getElementById('newJobPriority').value = j.priority || 3;
      document.getElementById('newJobRelease').value = j.release_step !== undefined ? j.release_step : AppState.step;
      document.getElementById('newJobDeadline').value = j.deadline_step !== undefined ? j.deadline_step : (AppState.step + 12);
      document.getElementById('newJobWorkSteps').value = j.work_steps || 2;
      document.getElementById('newJobValue').value = j.value_usd || 25.0;
      document.getElementById('newJobSats').value = (j.eligible_satellites || ['S01']).join(', ');
    } else {
      document.getElementById('fieldsOutageOrDownlink').classList.remove('hidden');
      document.getElementById('fieldsAddJob').classList.add('hidden');
      document.getElementById('eventSatellitesInput').value = (evt.satellite_ids || []).join(', ');
      document.getElementById('eventEndStepInput').value = evt.end_step !== undefined ? evt.end_step : (AppState.step + 12);
    }
    document.getElementById('rawEventJson').value = JSON.stringify(evt, null, 2);
  }

  const selectEventPreset = document.getElementById('selectEventPreset');
  if (selectEventPreset) {
    selectEventPreset.addEventListener('change', (e) => {
      const key = e.target.value;
      if (DEMO_EVENT_PRESETS[key]) {
        const preset = JSON.parse(JSON.stringify(DEMO_EVENT_PRESETS[key]));
        loadEventIntoForm(preset);
        showAlert(`Пресет ${preset.id} (${preset.type}) загружен в форму.`);
      }
    });
  }

  const btnAdapt = document.getElementById('btnAdaptEventToCurrentStep');
  if (btnAdapt) {
    btnAdapt.addEventListener('click', () => {
      const isRaw = document.querySelector('.event-pill-tab.active').dataset.eventMode === 'raw';
      if (isRaw) {
        try {
          let parsed = JSON.parse(document.getElementById('rawEventJson').value);
          if (parsed.events && Array.isArray(parsed.events)) {
            parsed = parsed.events[0];
          }
          const delta = AppState.step - (parsed.at_step || 0);
          parsed.at_step = AppState.step;
          if (parsed.end_step !== undefined) parsed.end_step = Math.max(AppState.step + 1, parsed.end_step + delta);
          if (parsed.jobs && Array.isArray(parsed.jobs)) {
            parsed.jobs.forEach(j => {
              j.release_step = Math.max(AppState.step, (j.release_step || 0) + delta);
              j.deadline_step = Math.max(j.release_step + 1, (j.deadline_step || 0) + delta);
            });
          }
          document.getElementById('rawEventJson').value = JSON.stringify(parsed, null, 2);
          loadEventIntoForm(parsed);
        } catch (e) {}
      } else {
        const type = document.getElementById('eventTypeSelect').value;
        if (type === 'add_jobs') {
          const release = parseInt(document.getElementById('newJobRelease').value, 10) || 0;
          const deadline = parseInt(document.getElementById('newJobDeadline').value, 10) || 12;
          const dur = Math.max(2, deadline - release);
          document.getElementById('newJobRelease').value = AppState.step;
          document.getElementById('newJobDeadline').value = AppState.step + dur;
        } else {
          const endStep = parseInt(document.getElementById('eventEndStepInput').value, 10) || 0;
          const dur = Math.max(6, endStep - AppState.step);
          document.getElementById('eventEndStepInput').value = AppState.step + dur;
        }
      }
      showAlert(`Событие успешно адаптировано под текущий шаг (${AppState.step})!`);
    });
  }

  // Загрузка JSON файла событий
  const fileEventInput = document.getElementById('fileEventInput');
  if (fileEventInput) {
    fileEventInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (evt) => {
        try {
          const parsed = JSON.parse(evt.target.result);
          const noticeEl = document.getElementById('eventFileNotice');
          if (noticeEl) noticeEl.style.display = 'block';

          let targetEvent = parsed;
          if (parsed.events && Array.isArray(parsed.events)) {
            targetEvent = parsed.events.find(ev => ev.at_step === AppState.step) || parsed.events[0];
            if (noticeEl) noticeEl.textContent = `📁 Пакет ${file.name} (${parsed.events.length} событий). Выбрано: ${targetEvent.id} (Ш.${targetEvent.at_step}, ${targetEvent.type})`;
          } else {
            if (noticeEl) noticeEl.textContent = `📁 Загружено одиночное событие ${targetEvent.id || file.name}`;
          }
          loadEventIntoForm(targetEvent);
        } catch (err) {
          showAlert('Ошибка чтения файла события: ' + err.message);
        }
      };
      reader.readAsText(file);
    });
  }

  document.getElementById('btnOpenEventModal').addEventListener('click', () => {
    // Предзаполняем поля текущим шагом
    const badge = document.getElementById('currentStepBadgeInModal');
    if (badge) badge.textContent = AppState.step;

    document.getElementById('eventIdInput').value = `E-${AppState.step + 1}`;
    document.getElementById('eventEndStepInput').value = AppState.step + 12;
    document.getElementById('newJobRelease').value = AppState.step;
    document.getElementById('newJobDeadline').value = AppState.step + 12;
    document.getElementById('newJobId').value = `NEW-JOB-${AppState.jobs.length + 1}`;
    
    // Быстрые кнопки спутников
    const quickContainer = document.getElementById('quickSatsContainer');
    quickContainer.innerHTML = AppState.satellites.slice(0, 8).map(s => `
      <button type="button" class="btn-chip btn-quick-sat" data-id="${s.id}">${s.id}</button>
    `).join('');
    quickContainer.querySelectorAll('.btn-quick-sat').forEach(b => {
      b.addEventListener('click', () => {
        const inp = document.getElementById('eventSatellitesInput');
        const current = inp.value.split(',').map(x => x.trim()).filter(Boolean);
        if (!current.includes(b.dataset.id)) {
          current.push(b.dataset.id);
          inp.value = current.join(', ');
        }
      });
    });

    eventErrorBox.classList.add('hidden');
    modalEvent.classList.remove('hidden');
  });

  document.getElementById('btnCloseEventModal').addEventListener('click', () => {
    modalEvent.classList.add('hidden');
  });
  document.getElementById('btnCancelEventModal').addEventListener('click', () => {
    modalEvent.classList.add('hidden');
  });

  // Переключение режима формы (Интерактивный / Raw JSON)
  document.querySelectorAll('.event-pill-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.event-pill-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      if (btn.dataset.eventMode === 'form') {
        document.getElementById('eventModeForm').classList.remove('hidden');
        document.getElementById('eventModeRaw').classList.add('hidden');
      } else {
        document.getElementById('eventModeForm').classList.add('hidden');
        document.getElementById('eventModeRaw').classList.remove('hidden');
      }
    });
  });

  // Переключение типа события в форме
  document.getElementById('eventTypeSelect').addEventListener('change', (e) => {
    const type = e.target.value;
    if (type === 'add_jobs') {
      document.getElementById('fieldsOutageOrDownlink').classList.add('hidden');
      document.getElementById('fieldsAddJob').classList.remove('hidden');
    } else {
      document.getElementById('fieldsOutageOrDownlink').classList.remove('hidden');
      document.getElementById('fieldsAddJob').classList.add('hidden');
    }
  });

  // Отправка события
  document.getElementById('btnSubmitEvent').addEventListener('click', async () => {
    eventErrorBox.classList.add('hidden');
    const isRaw = document.querySelector('.event-pill-tab.active').dataset.eventMode === 'raw';

    let eventPayload = null;

    if (isRaw) {
      try {
        let rawParsed = JSON.parse(document.getElementById('rawEventJson').value);
        if (rawParsed.events && Array.isArray(rawParsed.events)) {
          // Авто-извлечение из events_demo.json
          const match = rawParsed.events.find(e => e.at_step === AppState.step) || rawParsed.events[0];
          eventPayload = match;
          showAlert(`Обнаружен пакет событий! Применено событие ${match.id} (Ш.${match.at_step})`);
        } else {
          eventPayload = rawParsed;
        }
      } catch (err) {
        eventErrorText.textContent = 'Некорректный синтаксис JSON: ' + err.message;
        eventErrorBox.classList.remove('hidden');
        return;
      }
    } else {
      const type = document.getElementById('eventTypeSelect').value;
      const eventId = document.getElementById('eventIdInput').value.trim() || `E-${Date.now()}`;
      
      if (type === 'add_jobs') {
        const sats = document.getElementById('newJobSats').value.split(',').map(s => s.trim()).filter(Boolean);
        eventPayload = {
          id: eventId,
          at_step: AppState.step,
          type: 'add_jobs',
          jobs: [{
            id: document.getElementById('newJobId').value.trim() || `JOB-NEW-${Date.now()}`,
            kind: document.getElementById('newJobKind').value,
            release_step: parseInt(document.getElementById('newJobRelease').value, 10) || AppState.step,
            deadline_step: parseInt(document.getElementById('newJobDeadline').value, 10) || (AppState.step + 12),
            work_steps: parseInt(document.getElementById('newJobWorkSteps').value, 10) || 2,
            eligible_satellites: sats.length ? sats : ['S01'],
            priority: parseInt(document.getElementById('newJobPriority').value, 10) || 3,
            value_usd: parseFloat(document.getElementById('newJobValue').value) || 20.0
          }]
        };
      } else {
        const sats = document.getElementById('eventSatellitesInput').value.split(',').map(s => s.trim()).filter(Boolean);
        const endStep = parseInt(document.getElementById('eventEndStepInput').value, 10);
        eventPayload = {
          id: eventId,
          at_step: AppState.step,
          type: type,
          satellite_ids: sats,
          end_step: endStep
        };
      }
    }

    const result = await apiSendEvent(eventPayload);
    if (!result.success) {
      eventErrorText.textContent = result.error;
      eventErrorBox.classList.remove('hidden');
    } else {
      modalEvent.classList.add('hidden');
      showAlert('Оперативное событие успешно применено!');
    }
  });

  // ==========================
  // МОДАЛКА: СРАВНЕНИЕ ВАРИАНТОВ
  // ==========================
  const modalCompare = document.getElementById('modalCompare');
  document.getElementById('btnCompare').addEventListener('click', async () => {
    modalCompare.classList.remove('hidden');
    const algA = document.getElementById('compareAlgA') ? document.getElementById('compareAlgA').value : 'smart';
    const algB = document.getElementById('compareAlgB') ? document.getElementById('compareAlgB').value : 'baseline';
    const goalA = document.getElementById('compareGoalA') ? document.getElementById('compareGoalA').value : 'priority';
    const goalB = document.getElementById('compareGoalB') ? document.getElementById('compareGoalB').value : 'revenue';
    const compData = await apiCompare(goalA, goalB, algA, algB);
    renderCompareModal(compData);
  });

  document.getElementById('btnCloseCompareModal').addEventListener('click', () => {
    modalCompare.classList.add('hidden');
  });
  document.getElementById('btnCloseCompareModalBtn').addEventListener('click', () => {
    modalCompare.classList.add('hidden');
  });

  document.getElementById('btnRunCompareRequest').addEventListener('click', async () => {
    const goalA = document.getElementById('compareGoalA').value;
    const goalB = document.getElementById('compareGoalB').value;
    const algA = document.getElementById('compareAlgA') ? document.getElementById('compareAlgA').value : 'smart';
    const algB = document.getElementById('compareAlgB') ? document.getElementById('compareAlgB').value : 'baseline';
    const compData = await apiCompare(goalA, goalB, algA, algB);
    renderCompareModal(compData);
  });

  // ==========================
  // МОДАЛКА: АУДИТ РЕШЕНИЙ (EXPLAIN · О7)
  // ==========================
  const modalExplain = document.getElementById('modalExplain');
  const btnOpenExplain = document.getElementById('btnOpenExplain');
  if (btnOpenExplain) {
    btnOpenExplain.addEventListener('click', () => openExplainModal());
  }
  const btnToolbarExplain = document.getElementById('btnToolbarExplain');
  if (btnToolbarExplain) {
    btnToolbarExplain.addEventListener('click', () => openExplainModal());
  }
  const btnCloseExplain = document.getElementById('btnCloseExplainModal');
  if (btnCloseExplain) {
    btnCloseExplain.addEventListener('click', () => modalExplain.classList.add('hidden'));
  }
  const btnCloseExplainBtn = document.getElementById('btnCloseExplainModalBtn');
  if (btnCloseExplainBtn) {
    btnCloseExplainBtn.addEventListener('click', () => modalExplain.classList.add('hidden'));
  }
  const btnRefreshExplain = document.getElementById('btnRefreshExplain');
  if (btnRefreshExplain) {
    btnRefreshExplain.addEventListener('click', () => openExplainModal());
  }

  // Вкладки внутри Explain
  const tabTop = document.getElementById('btnExplainTabTop');
  const tabDetail = document.getElementById('btnExplainTabJobDetail');
  const secTop = document.getElementById('explainSectionTop');
  const secDetail = document.getElementById('explainSectionDetail');

  if (tabTop && tabDetail && secTop && secDetail) {
    tabTop.addEventListener('click', () => {
      tabTop.classList.add('active');
      tabDetail.classList.remove('active');
      secTop.classList.remove('hidden');
      secDetail.classList.add('hidden');
    });
    tabDetail.addEventListener('click', () => {
      tabDetail.classList.add('active');
      tabTop.classList.remove('active');
      secDetail.classList.remove('hidden');
      secTop.classList.add('hidden');
    });
  }

  const btnRunJobExplain = document.getElementById('btnRunJobExplain');
  if (btnRunJobExplain) {
    btnRunJobExplain.addEventListener('click', () => {
      const jobId = (document.getElementById('explainJobIdInput').value || '').trim().toUpperCase();
      renderJobExplain(jobId);
    });
  }

  // Клик по строке в таблице Explain Top Jobs для перехода к деталям
  const explainTopTbody = document.getElementById('explainTopTbody');
  if (explainTopTbody) {
    explainTopTbody.addEventListener('click', (e) => {
      const btn = e.target.closest('.btn-explain-row-inspect');
      if (btn) {
        const jId = btn.getAttribute('data-job-id');
        if (tabDetail && tabTop && secTop && secDetail) {
          tabDetail.classList.add('active');
          tabTop.classList.remove('active');
          secDetail.classList.remove('hidden');
          secTop.classList.add('hidden');
        }
        const input = document.getElementById('explainJobIdInput');
        if (input) input.value = jId;
        renderJobExplain(jId);
      }
    });
  }

  // Клик по кнопке аудита в основной таблице заданий смены
  const jobsTbody = document.getElementById('jobsTbody');
  if (jobsTbody) {
    jobsTbody.addEventListener('click', (e) => {
      const btn = e.target.closest('.btn-job-explain');
      if (btn) {
        const jId = btn.getAttribute('data-job-id');
        openExplainModal(jId);
      }
    });
  }

  // ==========================
  // МОДАЛКА: СТАТИСТИКА ЗАГРУЗКИ ФЛОТА (STATS)
  // ==========================
  const modalStats = document.getElementById('modalStats');
  const btnOpenStats = document.getElementById('btnOpenStats');
  if (btnOpenStats) {
    btnOpenStats.addEventListener('click', () => openStatsModal());
  }
  const btnToolbarStats = document.getElementById('btnToolbarStats');
  if (btnToolbarStats) {
    btnToolbarStats.addEventListener('click', () => openStatsModal());
  }
  const btnCloseStats = document.getElementById('btnCloseStatsModal');
  if (btnCloseStats) {
    btnCloseStats.addEventListener('click', () => modalStats.classList.add('hidden'));
  }
  const btnCloseStatsBtn = document.getElementById('btnCloseStatsModalBtn');
  if (btnCloseStatsBtn) {
    btnCloseStatsBtn.addEventListener('click', () => modalStats.classList.add('hidden'));
  }
  const btnRefreshStats = document.getElementById('btnRefreshStats');
  if (btnRefreshStats) {
    btnRefreshStats.addEventListener('click', () => openStatsModal());
  }

  // ==========================
  // МОДАЛКА: ТЕЛЕМЕТРИЯ СПУТНИКА
  // ==========================
  const modalSatDetail = document.getElementById('modalSatDetail');
  document.getElementById('btnCloseSatDetailModal').addEventListener('click', () => {
    modalSatDetail.classList.add('hidden');
  });
  document.getElementById('btnCloseSatDetailModalBtn').addEventListener('click', () => {
    modalSatDetail.classList.add('hidden');
  });

  // ==========================
  // СКАЧИВАНИЕ РЕЗУЛЬТАТА
  // ==========================
  document.getElementById('btnDownloadResult').addEventListener('click', apiDownloadResult);

  // ===========================================================================
  // 8. ИНИЦИАЛИЗАЦИЯ WEBACTICS EXPERIENCE
  // ===========================================================================
  initSpaceCanvas();
  initKeyClickAudio();
  initCardSpotlights();
});

// =============================================================================
// 8. АТМОСФЕРНЫЙ ДВИЖОК WEBACTICS (Space Canvas, Ambient Audio, Dynamic Spotlight)
// =============================================================================

/**
 * 8.1. ХОЛСТ ОРБИТАЛЬНЫХ СОЗВЕЗДИЙ (#space-canvas)
 * Высокопроизводительный фоновый рендеринг звёздного поля и телеметрических узлов.
 * Поддерживает Retina/HiDPI экраны, плавное вращение и лазерные лучи к курсору.
 */
function initSpaceCanvas() {
  const canvas = document.getElementById('space-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  let width = 0;
  let height = 0;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  const mouse = { x: -9999, y: -9999, targetX: -9999, targetY: -9999, active: false };

  window.addEventListener('mousemove', (e) => {
    mouse.targetX = e.clientX;
    mouse.targetY = e.clientY;
    mouse.active = true;
  });

  window.addEventListener('mouseleave', () => {
    mouse.active = false;
    mouse.targetX = -9999;
    mouse.targetY = -9999;
  });

  // Поддержка касаний для мобильных устройств
  window.addEventListener('touchstart', (e) => {
    if (e.touches && e.touches.length > 0) {
      mouse.targetX = e.touches[0].clientX;
      mouse.targetY = e.touches[0].clientY;
      mouse.active = true;
    }
  }, { passive: true });

  window.addEventListener('touchmove', (e) => {
    if (e.touches && e.touches.length > 0) {
      mouse.targetX = e.touches[0].clientX;
      mouse.targetY = e.touches[0].clientY;
      mouse.active = true;
    }
  }, { passive: true });

  window.addEventListener('touchend', () => {
    mouse.active = false;
    mouse.targetX = -9999;
    mouse.targetY = -9999;
  }, { passive: true });

  function resize() {
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', resize);
  resize();

  // Глубокое звёздное поле (WebTactics deep void starfield)
  const starCount = Math.min(130, Math.floor((width * height) / 11000));
  const stars = [];
  for (let i = 0; i < starCount; i++) {
    stars.push({
      x: Math.random() * width,
      y: Math.random() * height,
      size: Math.random() * 1.4 + 0.4,
      baseAlpha: Math.random() * 0.65 + 0.15,
      twinkleSpeed: Math.random() * 0.02 + 0.006,
      twinklePhase: Math.random() * Math.PI * 2,
      vx: (Math.random() - 0.5) * 0.06,
      vy: (Math.random() - 0.5) * 0.06
    });
  }

  // Орбитальные ретрансляционные узлы (Constellation Telemetry Nodes)
  const nodeCount = Math.min(18, Math.max(10, Math.floor(width / 110)));
  const nodes = [];
  for (let i = 0; i < nodeCount; i++) {
    nodes.push({
      id: `S${String(i + 1).padStart(2, '0')}`,
      x: Math.random() * width,
      y: Math.random() * height,
      vx: (Math.random() - 0.5) * 0.32,
      vy: (Math.random() - 0.5) * 0.32,
      radius: Math.random() * 1.2 + 2.0,
      pulsePhase: Math.random() * Math.PI * 2,
      color: i % 4 === 0 ? 'rgba(16, 185, 129,' : 'rgba(56, 189, 248,'
    });
  }

  const MAX_LINK_DIST = 155;
  const MOUSE_LINK_DIST = 190;

  function render() {
    if (document.hidden) {
      requestAnimationFrame(render);
      return;
    }

    if (mouse.active) {
      mouse.x += (mouse.targetX - mouse.x) * 0.08;
      mouse.y += (mouse.targetY - mouse.y) * 0.08;
    } else {
      mouse.x = -9999;
      mouse.y = -9999;
    }

    ctx.clearRect(0, 0, width, height);

    // 1. Отрисовка звёзд
    for (let i = 0; i < stars.length; i++) {
      const s = stars[i];
      s.x += s.vx;
      s.y += s.vy;
      if (s.x < 0) s.x = width;
      else if (s.x > width) s.x = 0;
      if (s.y < 0) s.y = height;
      else if (s.y > height) s.y = 0;

      s.twinklePhase += s.twinkleSpeed;
      const alpha = s.baseAlpha * (0.65 + 0.35 * Math.sin(s.twinklePhase));

      ctx.fillStyle = `rgba(255, 255, 255, ${alpha.toFixed(3)})`;
      ctx.fillRect(s.x, s.y, s.size, s.size);
    }

    // 2. Обновление орбитальных узлов
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      n.x += n.vx;
      n.y += n.vy;

      if (n.x < 24) { n.x = 24; n.vx *= -1; }
      else if (n.x > width - 24) { n.x = width - 24; n.vx *= -1; }
      if (n.y < 24) { n.y = 24; n.vy *= -1; }
      else if (n.y > height - 24) { n.y = height - 24; n.vy *= -1; }

      n.pulsePhase += 0.035;

      // Магнитное притяжение к курсору оператора
      if (mouse.active) {
        const dx = mouse.x - n.x;
        const dy = mouse.y - n.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < MOUSE_LINK_DIST && dist > 12) {
          const pull = (1 - dist / MOUSE_LINK_DIST) * 0.16;
          n.x += (dx / dist) * pull;
          n.y += (dy / dist) * pull;
        }
      }
    }

    // 3. Лазерные каналы телеметрии между узлами
    ctx.lineWidth = 1;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const n1 = nodes[i];
        const n2 = nodes[j];
        const dx = n2.x - n1.x;
        const dy = n2.y - n1.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < MAX_LINK_DIST) {
          const alpha = (1 - dist / MAX_LINK_DIST) * 0.22;
          ctx.strokeStyle = `rgba(168, 85, 247, ${alpha.toFixed(3)})`;
          ctx.beginPath();
          ctx.moveTo(n1.x, n1.y);
          ctx.lineTo(n2.x, n2.y);
          ctx.stroke();
        }
      }

      // Луч на курсор
      if (mouse.active) {
        const dx = mouse.x - nodes[i].x;
        const dy = mouse.y - nodes[i].y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < MOUSE_LINK_DIST) {
          const alpha = (1 - dist / MOUSE_LINK_DIST) * 0.38;
          ctx.strokeStyle = `rgba(56, 189, 248, ${alpha.toFixed(3)})`;
          ctx.beginPath();
          ctx.moveTo(nodes[i].x, nodes[i].y);
          ctx.lineTo(mouse.x, mouse.y);
          ctx.stroke();
        }
      }
    }

    // 4. Отрисовка узлов спутников
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const pulse = Math.sin(n.pulsePhase) * 0.5 + 0.5;
      const glowR = n.radius + pulse * 3.8;

      ctx.beginPath();
      ctx.arc(n.x, n.y, glowR, 0, Math.PI * 2);
      ctx.fillStyle = `${n.color}${(0.16 + pulse * 0.18).toFixed(2)})`;
      ctx.fill();

      ctx.beginPath();
      ctx.arc(n.x, n.y, n.radius, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
    }

    requestAnimationFrame(render);
  }

  requestAnimationFrame(render);
}

/**
 * 8.2. ТИХИЕ ТАКТИЛЬНЫЕ ЗВУКИ КНОПОК И КЛАВИШ (Web Audio API)
 * Полностью исключены фоновые гулы, дроны, сирены и фанфары.
 * Оставлен только деликатный, ультра-тихий механический микро-клик
 * при нажатии на кнопки пульта, табы, селекторы и клавиши клавиатуры.
 */
let clickAudioCtx = null;

function playQuietClick(freq = 640, duration = 0.02) {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    if (!clickAudioCtx) {
      clickAudioCtx = new AudioContextClass();
    }
    if (clickAudioCtx.state === 'suspended') {
      clickAudioCtx.resume();
    }
    const now = clickAudioCtx.currentTime;
    const osc = clickAudioCtx.createOscillator();
    const gain = clickAudioCtx.createGain();

    // Мягкий синусоидальный щелчок
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, now);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.45, now + duration);

    // Ультра-тихий уровень громкости (0.015)
    gain.gain.setValueAtTime(0.015, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    osc.connect(gain);
    gain.connect(clickAudioCtx.destination);

    osc.start(now);
    osc.stop(now + duration);
  } catch (e) {}
}

function initKeyClickAudio() {
  // Тихий щелчок при нажатии на интерактивные кнопки, табы, карточки и селекты
  document.addEventListener('click', (e) => {
    const clickable = e.target.closest('button, .btn, .nav-tab, .sat-row, .fleet-sat-card, .event-pill-tab, .step-badge, select, input[type="checkbox"], input[type="radio"], .preset-badge');
    if (clickable) {
      playQuietClick(680, 0.022);
    }
  });

  // Тихий щелчок при нажатии на клавиши клавиатуры
  document.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    playQuietClick(520, 0.018);
  });
}

/**
 * 8.3. ИНТЕРАКТИВНЫЙ SPOTLIGHT НА КАРТОЧКАХ (WebTactics Radial Highlight)
 * Отслеживает курсор мыши над карточками и проецирует мягкое динамическое свечение.
 */
function initCardSpotlights() {
  window.addEventListener('mousemove', (e) => {
    const card = e.target.closest(
      '.kpi-panel, .fleet-sat-card, .risk-radar-panel, .chart-box, .compare-col, .modal-box, .panel-container'
    );
    if (card) {
      const rect = card.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      card.style.setProperty('--mouse-x', `${x}px`);
      card.style.setProperty('--mouse-y', `${y}px`);
    }
  });
}
