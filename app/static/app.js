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
  customScenarioJson: null
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
  setConnectionStatus('checking', 'Подключение к API...');
  try {
    const res = await fetch('/api/scenarios', { method: 'GET' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const scenarios = await res.json();
    AppState.scenariosList = scenarios;
    AppState.isMockMode = false;
    setConnectionStatus('online', 'Бэкенд онлайн');
    populateScenariosSelect(scenarios);
  } catch (err) {
    console.warn('Бэкенд недоступен, переключаемся на app/mock:', err.message);
    AppState.isMockMode = true;
    setConnectionStatus('mock', 'Демо-режим (app/mock)');
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
async function apiStartSession(scenarioId, goal, customJson = null) {
  showLoader('Создание новой смены...');
  hideAlert();
  
  if (!AppState.isMockMode) {
    try {
      const payload = customJson 
        ? { scenario: customJson, goal: goal }
        : { scenario_id: scenarioId, goal: goal };
        
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
      console.warn('Ошибка вызова POST /api/sessions, используем мок:', err);
      showAlert(`Бэкенд вернул ошибку (${err.message}). Загружен эталонный пример.`);
      AppState.isMockMode = true;
      setConnectionStatus('mock', 'Демо-режим (app/mock)');
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
 * Сравнение вариантов: POST /api/sessions/{id}/compare
 */
async function apiCompare(goalA, goalB) {
  showLoader('Расчёт сравнения стратегий...');
  hideAlert();

  if (!AppState.isMockMode && AppState.sessionId) {
    try {
      const res = await fetch(`/api/sessions/${AppState.sessionId}/compare`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal_a: goalA, goal_b: goalB })
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

  renderAll();
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
  renderSatellitesTable();
  renderJobsTable();
  renderLastStepTable();
  renderCharts();
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

  // Шаг и время (1 шаг = 5 мин)
  const currentMinutes = AppState.step * 5;
  const totalMinutes = AppState.totalSteps * 5;
  const curTimeStr = formatMinutesToHHMM(currentMinutes);
  const totTimeStr = formatMinutesToHHMM(totalMinutes);
  
  document.getElementById('kpiStep').textContent = `${AppState.step} / ${AppState.totalSteps}`;
  document.getElementById('kpiTime').textContent = `Время: ${curTimeStr} / ${totTimeStr}`;

  // Выполнено заданий
  const completed = AppState.summary.jobs_completed || 0;
  const due = AppState.summary.jobs_due || AppState.summary.jobs_total || AppState.jobs.length;
  document.getElementById('kpiJobs').textContent = `${completed} / ${due}`;
  document.getElementById('kpiJobsSub').textContent = `завершено из ${due} плановых`;

  // Срочные задания (приоритет 3)
  const critDone = AppState.summary.critical_jobs_completed_on_time || 0;
  const critDue = AppState.summary.critical_jobs_due || 0;
  document.getElementById('kpiCriticalJobs').textContent = `${critDone} / ${critDue}`;
  document.getElementById('kpiCriticalSub').textContent = critDue > 0 
    ? `срочные (выполнено ${Math.round((critDone / critDue) * 100)}%)`
    : `нет срочных с наступившим сроком`;

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

    const isChecked = AppState.selectedSatellites.has(sat.id);

    html += `
      <tr class="${isBelowReserve ? 'row-reserve-alert' : ''}">
        <td>
          <input type="checkbox" class="sat-checkbox" data-sat-id="${sat.id}" ${isChecked ? 'checked' : ''} />
        </td>
        <td>
          <strong>${sat.id}</strong>
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
      if (AppState.step >= job.deadline_step) {
        comment = `<span class="text-danger">Истёк срок на шаге ${job.deadline_step}</span>`;
      } else {
        comment = `<span class="text-danger">Сорвано (дефицит ресурсов)</span>`;
      }
    } else if (job.status === 'done') {
      comment = `<span class="text-success">Завершено на шаге ${job.completed_step || '—'}</span>`;
    } else if (job.status === 'active') {
      comment = `Выполняется`;
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
        <td>${comment}</td>
      </tr>
    `;
  });

  tbody.innerHTML = html;
}

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

    let reasonBadge = '';
    if (row.reason === 'accepted') {
      reasonBadge = '<span class="badge badge-success">accepted</span>';
    } else if (row.reason === 'idle') {
      reasonBadge = '<span class="badge badge-muted">idle</span>';
    } else {
      reasonBadge = `<span class="badge badge-danger" title="${row.reason}">${row.reason}</span>`;
    }

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

  document.getElementById('compNameA').textContent = a.goal || 'A';
  document.getElementById('compNameB').textContent = b.goal || 'B';

  document.getElementById('compA_jobsCompleted').textContent = sumA.jobs_completed !== undefined ? sumA.jobs_completed : '—';
  document.getElementById('compB_jobsCompleted').textContent = sumB.jobs_completed !== undefined ? sumB.jobs_completed : '—';

  document.getElementById('compA_critJobs').textContent = 
    `${sumA.critical_jobs_completed_on_time || 0} / ${sumA.critical_jobs_due || 0}`;
  document.getElementById('compB_critJobs').textContent = 
    `${sumB.critical_jobs_completed_on_time || 0} / ${sumB.critical_jobs_due || 0}`;

  document.getElementById('compA_revenue').textContent = `$${(sumA.revenue_usd || 0).toFixed(2)}`;
  document.getElementById('compB_revenue').textContent = `$${(sumB.revenue_usd || 0).toFixed(2)}`;

  document.getElementById('compA_minSoc').textContent = `${(sumA.minimum_soc_pct || 0).toFixed(1)}%`;
  document.getElementById('compB_minSoc').textContent = `${(sumB.minimum_soc_pct || 0).toFixed(1)}%`;

  document.getElementById('compA_belowReserve').textContent = `${sumA.below_reserve_satellite_steps || 0} шагов`;
  document.getElementById('compB_belowReserve').textContent = `${sumB.below_reserve_satellite_steps || 0} шагов`;

  // Вердикт
  document.getElementById('verdictText').textContent = compData.verdict || 'Сравнение выполнено успешно.';
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
  const toggleBtn = document.getElementById('btnModeToggle');

  dot.className = 'status-dot ' + (type === 'online' ? 'online' : 'mock');
  txt.textContent = text;

  if (type === 'online') {
    toggleBtn.textContent = 'Перейти в Демо';
  } else {
    toggleBtn.textContent = 'Подключить Бэкенд';
  }
}

function showLoader(text = 'Выполняется расчёт...') {
  const loader = document.getElementById('operationLoader');
  document.getElementById('loaderText').textContent = text;
  loader.classList.remove('hidden');

  // Блокируем кнопки
  document.querySelectorAll('.btn-step').forEach(b => b.disabled = true);
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

  // Переключение источника (Бэкенд / Демо)
  document.getElementById('btnModeToggle').addEventListener('click', () => {
    if (AppState.isMockMode) {
      initBackendConnection();
    } else {
      AppState.isMockMode = true;
      setConnectionStatus('mock', 'Демо-режим (app/mock)');
      showAlert('Переключено в локальный демо-режим (данные из app/mock)');
    }
  });

  // Закрытие алерта
  document.getElementById('alertClose').addEventListener('click', hideAlert);

  // Табы рабочей зоны
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

      btn.classList.add('active');
      const targetTab = document.getElementById(btn.dataset.tab);
      if (targetTab) targetTab.classList.add('active');

      // Если переключились на графики — перерисовываем
      if (btn.dataset.tab === 'tabCharts') {
        renderCharts();
      }
    });
  });

  // Управление шагами
  document.getElementById('btnStep1').addEventListener('click', () => apiStep(1));
  document.getElementById('btnStep12').addEventListener('click', () => apiStep(12));

  document.getElementById('btnRunUntil').addEventListener('click', () => {
    const inputVal = parseInt(document.getElementById('inputUntilStep').value, 10);
    if (isNaN(inputVal) || inputVal <= 0) {
      showAlert('Введите корректный номер целевого шага');
      return;
    }
    apiRunUntil(inputVal);
  });

  document.getElementById('btnPause').addEventListener('click', () => {
    hideLoader();
    showAlert('Расчёт приостановлен оператором.');
  });

  // Смена цели управления
  document.getElementById('goalSelect').addEventListener('change', (e) => {
    apiChangeGoal(e.target.value);
  });

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

  document.getElementById('btnConfirmStartSession').addEventListener('click', async () => {
    const goal = document.querySelector('input[name="startGoal"]:checked').value;
    const scenarioId = document.getElementById('selectScenarioPreset').value;
    const customJson = AppState.customScenarioJson;

    const success = await apiStartSession(scenarioId, goal, customJson);
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

  document.getElementById('btnOpenEventModal').addEventListener('click', () => {
    // Предзаполняем поля текущим шагом
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
  document.querySelectorAll('.event-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.event-tab-btn').forEach(b => b.classList.remove('active'));
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
    const isRaw = document.querySelector('.event-tab-btn.active').dataset.eventMode === 'raw';

    let eventPayload = null;

    if (isRaw) {
      try {
        eventPayload = JSON.parse(document.getElementById('rawEventJson').value);
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
    const compData = await apiCompare('priority', 'revenue');
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
    const compData = await apiCompare(goalA, goalB);
    renderCompareModal(compData);
  });

  // ==========================
  // СКАЧИВАНИЕ РЕЗУЛЬТАТА
  // ==========================
  document.getElementById('btnDownloadResult').addEventListener('click', apiDownloadResult);
});
