/**
 * ПРИБОРНЫЙ ЩИТ АВИОНИКИ СПУТНИКА (Spacecraft Subsystem Avionics Drawer)
 * КосмоХакатон 2026 — Аэрокосмический интерфейс ЦУП
 * 
 * Выдвижная панель детальной бортовой телеметрии (NASA Open MCT / SpaceX HUD):
 * 1. СЭП (Система электропитания / EPS): SOC %, баланс мощности Вт, резерв 30%
 * 2. СОТР (Система обеспечения теплового режима / TCS): градусник, обогреватель 30W
 * 3. ОЭК (Полезная нагрузка / Payload): возраст калибровки, таймер блокировки
 * 4. БРТК (Бортовой радиотехнический комплекс / Comms): статус несущей, каналы станций
 */

function openAvionicsDrawer(satId) {
  const drawer = document.getElementById('avionicsDrawer');
  if (!drawer) return;

  window.currentAvionicsSatId = satId;
  drawer.classList.add('open');
  renderAvionicsDrawer(satId);

  // Синхронизируем выбор на карте и в Ганте
  if (window.orbitalMapInstance) {
    window.orbitalMapInstance.selectedSatId = satId;
    window.orbitalMapInstance.render();
  }
  if (window.passGanttInstance) {
    window.passGanttInstance.selectedSatId = satId;
    window.passGanttInstance.render();
  }
}

function closeAvionicsDrawer() {
  const drawer = document.getElementById('avionicsDrawer');
  if (drawer) {
    drawer.classList.remove('open');
  }
}

function renderAvionicsDrawer(satId) {
  const state = window.AppState;
  if (!state || !state.satellites) return;

  const sat = state.satellites.find(s => s.id === satId) || state.satellites[0];
  if (!sat) return;

  const model = state.model || {};
  const currentStep = state.step || 0;

  // 1. Шапка
  const titleEl = document.getElementById('avionicsDrawerTitle');
  if (titleEl) titleEl.textContent = `БОРТ ${sat.id} · АВИОНИКА И ПОДСИСТЕМЫ`;

  const statusBadgeEl = document.getElementById('avionicsStatusBadge');
  if (statusBadgeEl) {
    if (!sat.available) {
      statusBadgeEl.className = 'audit-badge audit-badge-danger';
      statusBadgeEl.textContent = 'АВАРИЯ / ОТКАЗ (OUTAGE)';
    } else if (sat.soc_pct < (model.reserve_soc_pct || 30)) {
      statusBadgeEl.className = 'audit-badge audit-badge-danger';
      statusBadgeEl.textContent = 'ДЕФИЦИТ ЭНЕРГИИ (< 30%)';
    } else if (sat.last_action === 'job') {
      statusBadgeEl.className = 'audit-badge audit-badge-success';
      statusBadgeEl.textContent = 'СЕАНС СВЯЗИ / ЗАДАЧА';
    } else if (sat.last_action === 'calibrate') {
      statusBadgeEl.className = 'audit-badge audit-badge-info';
      statusBadgeEl.textContent = 'КАЛИБРОВКА СЕНСОРОВ';
    } else {
      statusBadgeEl.className = 'audit-badge audit-badge-info';
      statusBadgeEl.textContent = 'ДЕЖУРНЫЙ РЕЖИМ (NOMINAL)';
    }
  }

  // 2. СЭП (Система электропитания)
  const socVal = sat.soc_pct || 0;
  const capacityWh = sat.capacity_wh || 120.0;
  const currentWh = (socVal / 100) * capacityWh;
  const reserveWh = ((model.reserve_soc_pct || 30) / 100) * capacityWh;
  const marginWh = Math.max(0, currentWh - reserveWh);

  const socGauge = document.getElementById('avionicsSocGauge');
  if (socGauge) socGauge.textContent = `${Number(socVal).toFixed(1)}%`;

  const socBar = document.getElementById('avionicsSocBar');
  if (socBar) {
    socBar.style.width = `${Math.min(100, Math.max(0, socVal))}%`;
    if (socVal < 30) socBar.className = 'hud-bar-fill bg-danger';
    else if (socVal < 40) socBar.className = 'hud-bar-fill bg-warning';
    else socBar.className = 'hud-bar-fill bg-accent';
  }

  const elSocDetails = document.getElementById('avionicsSocDetails');
  if (elSocDetails) {
    elSocDetails.innerHTML = `
      <div class="hud-metric-line">
        <span>Текущая емкость:</span>
        <strong class="font-mono">${currentWh.toFixed(1)} / ${capacityWh.toFixed(1)} Вт·ч</strong>
      </div>
      <div class="hud-metric-line">
        <span>Запас до резерва (30%):</span>
        <strong class="font-mono ${marginWh <= 0 ? 'text-danger' : 'text-success'}">+${marginWh.toFixed(1)} Вт·ч</strong>
      </div>
    `;
  }

  // Потребление нагрузок
  const baseW = 18.0;
  const isHeaterActive = (sat.temp_c || 20) < (model.heater_below_c || 5.0);
  const heaterW = isHeaterActive ? 30.0 : 0.0;
  const isDownlink = sat.last_action === 'job' && sat.last_requested_kind === 'downlink';
  const isRelay = sat.last_action === 'job' && sat.last_requested_kind === 'relay';
  const isCalib = sat.last_action === 'calibrate';

  const commsW = isDownlink ? 90.0 : (isRelay ? 65.0 : 0.0);
  const calibW = isCalib ? 20.0 : 0.0;
  const totalLoadW = baseW + heaterW + commsW + calibW;

  // Освещенность (Солнце / Тень)
  const satIdx = parseInt(sat.id.replace(/\D/g, '') || '1', 10);
  const orbitPhase = (currentStep + satIdx * 2) % 18;
  const isSun = orbitPhase < 11;
  const solarGenW = isSun ? 125.0 : 0.0;
  const netPowerW = (solarGenW * (model.charge_efficiency || 0.92)) - totalLoadW;

  const elPowerFlux = document.getElementById('avionicsPowerFlux');
  if (elPowerFlux) {
    elPowerFlux.innerHTML = `
      <div class="hud-power-grid">
        <div class="power-box ${isSun ? 'sun' : 'eclipse'}">
          <span class="power-lbl">${isSun ? '☀️ СОЛНЕЧНЫЕ БАТАРЕИ' : '🌑 ТЕНЬ ЗЕМЛИ'}</span>
          <strong class="power-val font-mono">${solarGenW.toFixed(0)} Вт</strong>
        </div>
        <div class="power-box load">
          <span class="power-lbl">⚡ СУММАРНАЯ НАГРУЗКА</span>
          <strong class="power-val font-mono">${totalLoadW.toFixed(0)} Вт</strong>
        </div>
      </div>
      <div class="hud-sub-specs">
        <span>Базовые системы: 18 Вт</span> · 
        <span>Обогрев: ${heaterW} Вт</span> · 
        <span>БРТК: ${commsW} Вт</span> · 
        <span>Баланс: <strong class="${netPowerW >= 0 ? 'text-success' : 'text-danger'} font-mono">${netPowerW >= 0 ? '+' : ''}${netPowerW.toFixed(1)} Вт</strong></span>
      </div>
    `;
  }

  // 3. СОТР (Система обеспечения теплового режима)
  const tempC = sat.temp_c || 20;
  const elTempGauge = document.getElementById('avionicsTempGauge');
  if (elTempGauge) elTempGauge.textContent = `${Number(tempC).toFixed(1)}°C`;

  const minTemp = model.payload_min_c || -5.0;
  const maxTemp = model.payload_max_c || 45.0;
  const tempPct = Math.min(100, Math.max(0, ((tempC - minTemp) / (maxTemp - minTemp)) * 100));

  const elTempBar = document.getElementById('avionicsTempBar');
  if (elTempBar) {
    elTempBar.style.width = `${tempPct}%`;
    if (tempC < minTemp || tempC > maxTemp) elTempBar.className = 'hud-bar-fill bg-danger';
    else if (tempC < minTemp + 5 || tempC > maxTemp - 5) elTempBar.className = 'hud-bar-fill bg-warning';
    else elTempBar.className = 'hud-bar-fill bg-accent';
  }

  const elHeaterBadge = document.getElementById('avionicsHeaterBadge');
  if (elHeaterBadge) {
    if (isHeaterActive) {
      elHeaterBadge.className = 'audit-badge audit-badge-warn';
      elHeaterBadge.textContent = 'АКТИВЕН (+30 Вт)';
    } else {
      elHeaterBadge.className = 'audit-badge audit-badge-info';
      elHeaterBadge.textContent = 'ДЕЖУРНЫЙ / ВЫКЛЮЧЕН';
    }
  }

  // 4. ОЭК (Оптико-электронный комплекс и сенсоры)
  const calAge = sat.calibration_age_steps || 0;
  const calMax = sat.calibration_valid_steps || model.calibration_valid_steps || 48;
  const calRem = Math.max(0, calMax - calAge);

  const elCalibAge = document.getElementById('avionicsCalibAge');
  if (elCalibAge) elCalibAge.textContent = `${calAge} / ${calMax} шагов`;

  const elCalibBar = document.getElementById('avionicsCalibBar');
  if (elCalibBar) {
    const pct = Math.min(100, (calAge / calMax) * 100);
    elCalibBar.style.width = `${pct}%`;
    if (calRem <= 0) elCalibBar.className = 'hud-bar-fill bg-danger';
    else if (calRem <= 6) elCalibBar.className = 'hud-bar-fill bg-warning';
    else elCalibBar.className = 'hud-bar-fill bg-success';
  }

  const elCalibStatus = document.getElementById('avionicsCalibStatus');
  if (elCalibStatus) {
    if (calRem <= 0) {
      elCalibStatus.innerHTML = '<span class="text-danger font-bold">⚠️ КАЛИБРОВКА ИСТЕКЛА: съемка заблокирована!</span>';
    } else if (calRem <= 6) {
      elCalibStatus.innerHTML = `<span class="text-warning font-bold">⏳ До калибровки: осталось ${calRem} шагов (требуется сеанс)</span>`;
    } else {
      elCalibStatus.innerHTML = `<span class="text-success">✓ Точность сенсоров в норме (запас: ${calRem} шагов)</span>`;
    }
  }

  // 5. БРТК (Радиотехнический комплекс)
  const elCarrierLock = document.getElementById('avionicsCarrierLock');
  if (elCarrierLock) {
    if (sat.last_action === 'job') {
      elCarrierLock.innerHTML = '<span class="text-success font-bold font-mono">LOCKED (ПРИЕМ/ПЕРЕДАЧА)</span>';
    } else {
      elCarrierLock.innerHTML = '<span class="text-secondary font-mono">STANDBY (ОЖИДАНИЕ ОКНА)</span>';
    }
  }
}

// Привязка клавиши ESC для закрытия
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeAvionicsDrawer();
});

window.openAvionicsDrawer = openAvionicsDrawer;
window.closeAvionicsDrawer = closeAvionicsDrawer;
window.renderAvionicsDrawer = renderAvionicsDrawer;
