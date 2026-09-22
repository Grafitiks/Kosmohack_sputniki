/**
 * БОРТОВОЙ ХРОНОЛОГИЧЕСКИЙ ЖУРНАЛ ДИРЕКТОРА ПОЛЕТОВ (Flight Director Mission Log)
 * КосмоХакатон 2026 — Аэрокосмический интерфейс ЦУП
 * 
 * Непрерывный журнал телеметрических событий смены:
 * 1. Хронология с таймкодами MET (Mission Elapsed Time) и номерами шагов
 * 2. Классификация по бортовым подсистемам: [СЭП], [СОТР], [СВЯЗЬ], [ЗАДАЧИ], [ОТКАЗЫ]
 * 3. Фильтрация по типам систем и поиск по ключевым словам
 * 4. Экспорт журнала смены в текстовый файл
 */

class FlightDirectorLog {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    this.entries = [];
    this.currentFilter = 'all';
    this.searchQuery = '';
    this.lastRecordedStep = -1;
  }

  addEntry(category, satelliteId, text, level = 'info') {
    const state = window.AppState;
    const step = state ? (state.step || 0) : 0;
    const totalMinutes = step * 5;
    const met = formatMinutesToHHMMSS(totalMinutes);

    this.entries.unshift({
      id: Date.now() + Math.random(),
      step,
      met,
      category,     // 'EPS', 'TCS', 'COMMS', 'PAYLOAD', 'OUTAGE'
      satelliteId,  // 'S01' or null
      text,
      level         // 'info', 'success', 'warning', 'danger'
    });

    // Ограничиваем историю 400 записями для оптимизации
    if (this.entries.length > 400) {
      this.entries.pop();
    }

    this.render();
  }

  recordStepEvents() {
    const state = window.AppState;
    if (!state) return;
    const currentStep = state.step || 0;

    // Не дублируем записи на одном и том же шаге
    if (currentStep === this.lastRecordedStep) return;
    this.lastRecordedStep = currentStep;

    const rows = state.lastStepRows || [];
    const sats = state.satellites || [];
    const model = state.model || {};

    // 1. Проверяем исполненные команды шага
    rows.forEach(r => {
      const sid = r.satellite_id;
      if (r.executed === 'job' && r.requested) {
        const jId = r.requested.job_id;
        const kind = r.requested.kind;
        this.addEntry('PAYLOAD', sid, `${sid}: Выполнение задания ${jId} [${kind}]. Передача целевой информации.`, 'info');
      } else if (r.executed === 'calibrate') {
        this.addEntry('PAYLOAD', sid, `${sid}: Завершена регламентная калибровка оптических сенсоров.`, 'success');
      }
    });

    // 2. Проверяем тепловой режим (обогреватели)
    sats.forEach(s => {
      const isHeater = (s.temp_c || 20) < (model.heater_below_c || 5.0);
      if (isHeater) {
        this.addEntry('TCS', s.id, `${s.id}: Температура ${Number(s.temp_c).toFixed(1)}°C < 5°C. Автономный обогреватель ВКЛ (+30 Вт).`, 'warning');
      }
      if ((s.soc_pct || 100) < (model.reserve_soc_pct || 30.0)) {
        this.addEntry('EPS', s.id, `${s.id}: ВНИМАНИЕ! Заряд аккумулятора ${Number(s.soc_pct).toFixed(1)}% ниже резерва (30%)!`, 'danger');
      }
      if (!s.available) {
        this.addEntry('OUTAGE', s.id, `${s.id}: АВАРИЯ / ОТКАЗ БОРТА (Outage). Аппарат исключен из распределения.`, 'danger');
      }
    });
  }

  setFilter(category) {
    this.currentFilter = category;
    this.render();
  }

  setSearch(query) {
    this.searchQuery = (query || '').toLowerCase().trim();
    this.render();
  }

  clear() {
    this.entries = [];
    this.render();
  }

  exportTxt() {
    let content = '=====================================================\n';
    content += 'ЖУРНАЛ ДИРЕКТОРА ПОЛЕТОВ (FLIGHT DIRECTOR MISSION LOG)\n';
    content += `Смена: ${window.AppState ? window.AppState.scenarioTitle : 'Миссия'}\n`;
    content += `Экспорт сформирован: ${new Date().toLocaleString()}\n`;
    content += '=====================================================\n\n';

    this.entries.slice().reverse().forEach(e => {
      content += `[MET ${e.met} | ШАГ ${String(e.step).padStart(3, '0')}] [${e.category.padEnd(7, ' ')}] ${e.text}\n`;
    });

    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `flight_log_step_${window.AppState ? window.AppState.step : 0}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  render() {
    if (!this.container) return;

    let filtered = this.entries;
    if (this.currentFilter !== 'all') {
      filtered = filtered.filter(e => e.category === this.currentFilter);
    }
    if (this.searchQuery) {
      filtered = filtered.filter(e => 
        e.text.toLowerCase().includes(this.searchQuery) ||
        (e.satelliteId && e.satelliteId.toLowerCase().includes(this.searchQuery)) ||
        e.met.includes(this.searchQuery)
      );
    }

    if (filtered.length === 0) {
      this.container.innerHTML = '<div class="table-empty">Журнал телеметрии пуст или записи не соответствуют фильтру</div>';
      return;
    }

    let html = '';
    filtered.forEach(e => {
      let catBadge = '';
      if (e.category === 'EPS') catBadge = '<span class="log-badge log-eps">СЭП · EPS</span>';
      else if (e.category === 'TCS') catBadge = '<span class="log-badge log-tcs">СОТР · TCS</span>';
      else if (e.category === 'COMMS') catBadge = '<span class="log-badge log-comms">СВЯЗЬ · COMMS</span>';
      else if (e.category === 'PAYLOAD') catBadge = '<span class="log-badge log-payload">ПН · PAYLOAD</span>';
      else if (e.category === 'OUTAGE') catBadge = '<span class="log-badge log-outage">ОТКАЗ · ALERT</span>';
      else catBadge = `<span class="log-badge">${e.category}</span>`;

      html += `
        <div class="flight-log-row log-lvl-${e.level}">
          <span class="log-time font-mono">${e.met} <span class="log-step-tag">ш.${e.step}</span></span>
          <span class="log-cat-col">${catBadge}</span>
          <span class="log-msg-col">${e.text}</span>
        </div>
      `;
    });

    this.container.innerHTML = html;
  }
}

window.FlightDirectorLog = FlightDirectorLog;
window.flightLogInstance = null;
