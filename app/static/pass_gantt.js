/**
 * МАТРИЦА РАДИООКОН И ПРОХОДОВ ГАНТА (Pass Schedule & Contact Windows Gantt)
 * КосмоХакатон 2026 — Аэрокосмический интерфейс ЦУП
 * 
 * Компонент отображает:
 * 1. Временную ось смены (шаги 0..48 или 0..288)
 * 2. Полосы освещенности Солнцем vs теневые витки Земли (эклипс)
 * 3. Окна радиовидимости с наземными станциями (downlink) и межспутниковой связи (relay)
 * 4. Запланированные и исполненные команды планировщика
 * 5. Интерактивный курсор текущего шага и быстрый переход
 */

class PassGantt {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    if (!this.container) return;
    this.selectedSatId = 'S01';
    this.init();
  }

  init() {
    this.render();
  }

  render() {
    if (!this.container) return;
    const state = window.AppState;
    if (!state || !state.satellites || !state.satellites.length) {
      this.container.innerHTML = '<div class="table-empty">Ожидание инициализации смены...</div>';
      return;
    }

    const sats = state.satellites;
    const currentStep = state.step || 0;
    const totalSteps = state.totalSteps || 48;

    // Ограничиваем окно отображения по горизонтали для удобства (до 48 шагов или видимое окно)
    const maxCols = Math.min(totalSteps, 48);

    let html = `
      <div class="gantt-wrapper">
        <!-- Шапка шкалы времени -->
        <div class="gantt-header-row">
          <div class="gantt-label-col">Борт / Шкала</div>
          <div class="gantt-timeline-track">
    `;

    for (let t = 0; t < maxCols; t += (maxCols > 24 ? 4 : 2)) {
      const leftPct = (t / maxCols) * 100;
      const timeStr = formatMinutesToHHMM(t * 5);
      html += `
        <div class="gantt-time-tick" style="left: ${leftPct}%;">
          <span class="tick-step font-mono">ш.${t}</span>
          <span class="tick-time font-mono">${timeStr}</span>
        </div>
      `;
    }

    // Маркер текущего шага (Scrubber Needle)
    const needlePct = maxCols > 0 ? (currentStep / maxCols) * 100 : 0;
    html += `
            <div class="gantt-needle" style="left: ${needlePct}%;" title="Текущий шаг: ${currentStep}">
              <div class="needle-flag font-mono">ш.${currentStep}</div>
            </div>
          </div>
        </div>
        <!-- Строки аппаратов -->
        <div class="gantt-rows-container">
    `;

    // Отрисовываем до 16 аппаратов (или все выбранные)
    const displaySats = sats.slice(0, 16);

    displaySats.forEach(sat => {
      const isSelected = sat.id === this.selectedSatId;
      html += `
        <div class="gantt-sat-row ${isSelected ? 'selected' : ''}" data-sat-id="${sat.id}">
          <div class="gantt-label-col font-mono" onclick="window.openAvionicsDrawer('${sat.id}')">
            <strong>${sat.id}</strong>
            <span class="sat-soc-sub ${sat.soc_pct < 30 ? 'text-danger' : 'text-accent'}">${Number(sat.soc_pct || 0).toFixed(0)}%</span>
          </div>
          <div class="gantt-cells-track">
      `;

      for (let t = 0; t < maxCols; t++) {
        // Проверяем условия для данного шага
        const isPast = t < currentStep;
        const isCurrent = t === currentStep;

        // Определяем тень / солнце
        // В LEO период ~18 шагов, теневой отрезок обычно занимает 7-8 шагов витка
        const satIdx = parseInt(sat.id.replace(/\D/g, '') || '1', 10);
        const orbitPhase = (t + satIdx * 2) % 18;
        const isSunlight = orbitPhase < 11; // ~55-60% времени на солнце

        // Окна связи (повторяются периодически)
        const isDownlink = (t + satIdx) % 8 === 0 || (t + satIdx) % 8 === 1;
        const isRelay = (t + satIdx * 3) % 6 === 0;

        let cellClass = isSunlight ? 'cell-sun' : 'cell-eclipse';
        if (isPast) cellClass += ' cell-past';
        if (isCurrent) cellClass += ' cell-current';

        // Исполнение действия на текущем шаге
        let badgeHtml = '';
        if (isCurrent && sat.last_action === 'job') {
          badgeHtml = '<div class="gantt-action-pip pip-job" title="Исполняется задание">✓</div>';
        } else if (isCurrent && sat.last_action === 'calibrate') {
          badgeHtml = '<div class="gantt-action-pip pip-calib" title="Калибровка">🔧</div>';
        }

        let contactPip = '';
        if (isDownlink) contactPip += '<span class="contact-pip-downlink" title="Окно связи с Землей (Downlink)"></span>';
        if (isRelay) contactPip += '<span class="contact-pip-relay" title="Окно межспутниковой связи (Relay)"></span>';

        html += `
          <div class="gantt-cell ${cellClass}" title="${sat.id} · шаг ${t} (${formatMinutesToHHMM(t * 5)})\n${isSunlight ? '☀️ Освещен (125 Вт)' : '🌑 Тень Земли (0 Вт)'}${isDownlink ? '\n📡 Окно связи Downlink' : ''}${isRelay ? '\n🟣 Окно Relay' : ''}">
            ${contactPip}
            ${badgeHtml}
          </div>
        `;
      }

      html += `
          </div>
        </div>
      `;
    });

    html += `
        </div>
        <!-- Легенда матрицы -->
        <div class="gantt-legend">
          <div class="legend-item"><span class="legend-box sun"></span> Солнечный виток (125 Вт)</div>
          <div class="legend-item"><span class="legend-box eclipse"></span> Тень Земли (эклипс 0 Вт)</div>
          <div class="legend-item"><span class="legend-pip downlink"></span> Окно сброса на Землю (Downlink)</div>
          <div class="legend-item"><span class="legend-pip relay"></span> Окно ретрансляции (Relay)</div>
          <div class="legend-item"><span class="legend-pip job"></span> Работа над задачей</div>
          <div class="legend-item"><span class="legend-pip calib"></span> Калибровка сенсоров</div>
        </div>
      </div>
    `;

    this.container.innerHTML = html;

    // Клик по строке спутника
    this.container.querySelectorAll('.gantt-sat-row').forEach(row => {
      row.addEventListener('click', (e) => {
        const sid = row.getAttribute('data-sat-id');
        this.selectedSatId = sid;
        if (typeof window.openAvionicsDrawer === 'function') {
          window.openAvionicsDrawer(sid);
        }
        if (window.orbitalMapInstance) {
          window.orbitalMapInstance.selectedSatId = sid;
          window.orbitalMapInstance.render();
        }
        this.render();
      });
    });
  }
}

window.PassGantt = PassGantt;
window.passGanttInstance = null;
