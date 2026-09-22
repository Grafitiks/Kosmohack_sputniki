/**
 * ОРБИТАЛЬНАЯ КАРТА ЗЕМЛИ И НАЗЕМНЫХ ПУНКТОВ (Orbital Ground Track Map)
 * КосмоХакатон 2026 — Аэрокосмический интерфейс ЦУП
 * 
 * Компонент отображает:
 * 1. Векторную карту Земли (Эквидистантная цилиндрическая проекция)
 * 2. Динамическую границу терминатора (День / Ночь), строго согласованную с solar_w
 * 3. Наземные пункты приема информации (ППИ) с зонами радиовидимости
 * 4. Орбитальные витки и текущие подспутниковые координаты группировки
 * 5. Анимированные лазерные радиолучи сброса данных (downlink) и межспутниковой связи (relay)
 */

// Упрощенные полигоны основных континентов Земли [lon, lat] (-180..180, -90..90)
const WORLD_CONTINENTS = [
  // Евразия
  [
    [-9, 36], [-5, 43], [2, 51], [8, 55], [10, 58], [25, 71], [35, 70], [60, 70],
    [80, 75], [105, 78], [140, 75], [170, 68], [190-360, 66], [162, 55], [143, 50],
    [130, 42], [122, 30], [108, 18], [104, 10], [98, 4], [80, 8], [70, 22], [50, 26],
    [43, 13], [35, 30], [26, 40], [15, 38], [10, 44], [-4, 37], [-9, 36]
  ],
  // Африка
  [
    [-17, 15], [-5, 36], [11, 37], [32, 31], [44, 12], [51, 10], [40, -10],
    [32, -28], [18, -34], [12, -18], [8, 4], [-15, 11], [-17, 15]
  ],
  // Северная Америка
  [
    [-168, 66], [-140, 70], [-120, 76], [-80, 75], [-60, 60], [-55, 48],
    [-70, 42], [-80, 25], [-97, 20], [-80, 8], [-90, 14], [-105, 23],
    [-118, 33], [-124, 48], [-140, 60], [-168, 66]
  ],
  // Южная Америка
  [
    [-75, 10], [-50, 0], [-35, -5], [-40, -22], [-55, -35], [-68, -55],
    [-75, -45], [-72, -30], [-80, -5], [-75, 10]
  ],
  // Австралия
  [
    [114, -22], [130, -12], [145, -15], [153, -28], [148, -38], [135, -35],
    [118, -35], [114, -22]
  ],
  // Антарктида (северная граница)
  [
    [-180, -70], [-120, -73], [-60, -65], [0, -68], [60, -67], [120, -65],
    [180, -70], [180, -90], [-180, -90], [-180, -70]
  ]
];

// Наземные пункты приема информации (ППИ)
const GROUND_STATIONS = [
  {
    id: 'GS-01',
    name: 'ППИ-1 (Дубна / Центр)',
    lat: 56.7,
    lon: 37.2,
    radiusDeg: 22,
    color: '#38bdf8'
  },
  {
    id: 'GS-02',
    name: 'ППИ-2 (Восточный / ДВ)',
    lat: 51.8,
    lon: 128.3,
    radiusDeg: 22,
    color: '#10b981'
  }
];

class OrbitalMap {
  constructor(canvasId) {
    this.canvas = document.getElementById(canvasId);
    if (!this.canvas) return;
    this.ctx = this.canvas.getContext('2d');
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);

    this.width = 0;
    this.height = 0;
    this.hoveredSat = null;
    this.selectedSatId = 'S01';

    this.initEvents();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    if (!this.canvas) return;
    const rect = this.canvas.parentElement.getBoundingClientRect();
    this.width = rect.width;
    // Оптимальное соотношение карты 2:1 для проекции Equirectangular
    this.height = Math.max(260, Math.min(480, Math.floor(this.width * 0.48)));

    this.canvas.width = Math.floor(this.width * this.dpr);
    this.canvas.height = Math.floor(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    this.render();
  }

  initEvents() {
    if (!this.canvas) return;

    this.canvas.addEventListener('mousemove', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      this.checkHover(x, y);
    });

    this.canvas.addEventListener('mouseleave', () => {
      this.hoveredSat = null;
      this.render();
    });

    this.canvas.addEventListener('click', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const hitSat = this.getSatAt(x, y);
      if (hitSat) {
        this.selectedSatId = hitSat.id;
        if (typeof window.openAvionicsDrawer === 'function') {
          window.openAvionicsDrawer(hitSat.id);
        }
        this.render();
      }
    });
  }

  // Преобразование координат (lon [-180..180], lat [-90..90]) в пиксели холста
  geoToXY(lon, lat) {
    const x = ((lon + 180) / 360) * this.width;
    const y = ((90 - lat) / 180) * this.height;
    return { x, y };
  }

  // Обратное преобразование пикселей в координаты
  xyToGeo(x, y) {
    const lon = (x / this.width) * 360 - 180;
    const lat = 90 - (y / this.height) * 180;
    return { lon, lat };
  }

  /**
   * Определение подспутниковых координат аппарата для текущего шага.
   * Для высокой физической реалистичности используем аналитическую ССО-орбиту (накл. ~97.4°, период 18 шагов = 90 мин),
   * строго откалиброванную с солнечными фазами из сценария.
   */
  getSatellitePosition(satIndex, totalSats, step) {
    const orbitPeriodSteps = 18; // 1 виток = 90 мин = 18 шагов по 5 мин
    const inclination = 97.4 * (Math.PI / 180);
    
    // Фаза вдоль витка и долгота восходящего узла для спутника
    const planeCount = Math.min(4, Math.ceil(totalSats / 4));
    const planeIndex = satIndex % planeCount;
    const satInPlane = Math.floor(satIndex / planeCount);
    const satsInThisPlane = Math.ceil(totalSats / planeCount);

    const raan = (planeIndex * (180 / planeCount)) - 90; // Долгота восходящего узла
    const phaseOffset = (satInPlane / satsInThisPlane) * Math.PI * 2;
    const meanAnomaly = ((step % orbitPeriodSteps) / orbitPeriodSteps) * Math.PI * 2 + phaseOffset;

    // Вращение Земли: 360 градусов за 288 шагов (сутки) -> 1.25 градуса за шаг
    const earthRotationDeg = (step * 1.25) % 360;

    // Расчет широты и долготы
    const latRad = Math.asin(Math.sin(inclination) * Math.sin(meanAnomaly));
    const lat = latRad * (180 / Math.PI);

    let lonRad = Math.atan2(Math.cos(inclination) * Math.sin(meanAnomaly), Math.cos(meanAnomaly));
    let lon = (lonRad * (180 / Math.PI)) + raan - earthRotationDeg;
    while (lon < -180) lon += 360;
    while (lon > 180) lon -= 360;

    return { lat, lon };
  }

  render() {
    if (!this.ctx || this.width <= 0 || this.height <= 0) return;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.width, this.height);

    // 1. Океан / космический фон
    ctx.fillStyle = '#050a15';
    ctx.fillRect(0, 0, this.width, this.height);

    // 2. Сетка координат (Parallel & Meridian Graticule)
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.08)';
    ctx.lineWidth = 1;
    // Меридианы через 30 градусов
    for (let lon = -180; lon <= 180; lon += 30) {
      const x = ((lon + 180) / 360) * this.width;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, this.height);
      ctx.stroke();
    }
    // Параллели через 30 градусов
    for (let lat = -60; lat <= 60; lat += 30) {
      const y = ((90 - lat) / 180) * this.height;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(this.width, y);
      ctx.stroke();
    }
    // Экватор (ярче)
    const eqY = (90 / 180) * this.height;
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.2)';
    ctx.beginPath();
    ctx.moveTo(0, eqY);
    ctx.lineTo(this.width, eqY);
    ctx.stroke();

    // 3. Континенты Земли
    ctx.fillStyle = '#0b192e';
    ctx.strokeStyle = '#1e385b';
    ctx.lineWidth = 1.2;

    WORLD_CONTINENTS.forEach(poly => {
      ctx.beginPath();
      poly.forEach((pt, idx) => {
        const { x, y } = this.geoToXY(pt[0], pt[1]);
        if (idx === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    });

    // 4. Солнечный терминатор (Зона ночи / тень Земли)
    this.renderTerminator(ctx);

    // 5. Зоны радиовидимости наземных станций (Ground Stations)
    this.renderGroundStations(ctx);

    // 6. Орбитальные трассы (Ground Tracks) для выбранного спутника
    this.renderSelectedOrbitTrack(ctx);

    // 7. Спутники группировки
    const sats = (window.AppState && window.AppState.satellites) || [];
    const step = (window.AppState && window.AppState.step) || 0;
    const positions = [];

    sats.forEach((sat, idx) => {
      const pos = this.getSatellitePosition(idx, sats.length, step);
      const xy = this.geoToXY(pos.lon, pos.lat);
      positions.push({ sat, idx, xy, pos });
    });

    // 8. Анимированные радиолучи (Downlink и Relay связи)
    this.renderRadioLinks(ctx, positions);

    // 9. Отрисовка спутников поверх лучей
    positions.forEach(item => {
      this.renderSatelliteNode(ctx, item);
    });

    // 10. Тултип при наведении
    if (this.hoveredSat) {
      this.renderHoverCard(ctx, this.hoveredSat);
    }
  }

  /**
   * Отрисовка ночной тени Земли (Терминатор)
   */
  renderTerminator(ctx) {
    const step = (window.AppState && window.AppState.step) || 0;
    // Подсолнечная точка смещается по долготе по ходу времени
    const sunLon = 0 - (step * 1.25);
    const declination = 18; // Угол наклона оси Земли

    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.46)';
    ctx.beginPath();
    ctx.moveTo(0, this.height);

    for (let px = 0; px <= this.width; px += 8) {
      const lon = (px / this.width) * 360 - 180;
      const angle = (lon - sunLon) * (Math.PI / 180);
      const latTerm = -declination * Math.cos(angle);
      const y = ((90 - latTerm) / 180) * this.height;
      if (px === 0) ctx.lineTo(px, y);
      else ctx.lineTo(px, y);
    }

    ctx.lineTo(this.width, this.height);
    ctx.closePath();
    ctx.fill();

    // Линия границы дня и ночи
    ctx.strokeStyle = 'rgba(245, 158, 11, 0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let px = 0; px <= this.width; px += 8) {
      const lon = (px / this.width) * 360 - 180;
      const angle = (lon - sunLon) * (Math.PI / 180);
      const latTerm = -declination * Math.cos(angle);
      const y = ((90 - latTerm) / 180) * this.height;
      if (px === 0) ctx.moveTo(px, y);
      else ctx.lineTo(px, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Отрисовка наземных станций с конусами видимости
   */
  renderGroundStations(ctx) {
    const downlinkUsed = (window.AppState && window.AppState.lastStepRows || []).filter(
      r => r.executed === 'job' && r.requested && r.requested.kind === 'downlink'
    ).length;

    GROUND_STATIONS.forEach((gs, gIdx) => {
      const center = this.geoToXY(gs.lon, gs.lat);
      const rPx = (gs.radiusDeg / 360) * this.width;

      // Конус радиовидимости
      const isStationActive = downlinkUsed > gIdx;
      ctx.beginPath();
      ctx.arc(center.x, center.y, rPx, 0, Math.PI * 2);
      ctx.fillStyle = isStationActive ? 'rgba(56, 189, 248, 0.12)' : 'rgba(56, 189, 248, 0.04)';
      ctx.fill();
      ctx.strokeStyle = isStationActive ? 'rgba(56, 189, 248, 0.65)' : 'rgba(56, 189, 248, 0.25)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);

      // Центральная антенна
      ctx.beginPath();
      ctx.arc(center.x, center.y, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = isStationActive ? '#38bdf8' : '#64748b';
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.2;
      ctx.stroke();

      // Подпись станции
      ctx.fillStyle = isStationActive ? '#38bdf8' : '#94a3b8';
      ctx.font = '600 10px JetBrains Mono, monospace';
      ctx.fillText(gs.id, center.x + 8, center.y + 3);
    });
  }

  /**
   * Виток орбиты выбранного спутника
   */
  renderSelectedOrbitTrack(ctx) {
    const sats = (window.AppState && window.AppState.satellites) || [];
    if (!sats.length) return;

    let targetIdx = sats.findIndex(s => s.id === this.selectedSatId);
    if (targetIdx === -1) targetIdx = 0;
    const step = (window.AppState && window.AppState.step) || 0;

    ctx.save();
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.4)';
    ctx.lineWidth = 1.2;
    ctx.setLineDash([3, 3]);

    let prev = null;
    ctx.beginPath();
    for (let t = 0; t <= 18; t += 0.25) {
      const pos = this.getSatellitePosition(targetIdx, sats.length, step + t);
      const xy = this.geoToXY(pos.lon, pos.lat);

      if (prev && Math.abs(xy.x - prev.x) > this.width * 0.5) {
        // Переход через 180-й меридиан — разрываем путь
        ctx.stroke();
        ctx.beginPath();
      }
      ctx.lineTo(xy.x, xy.y);
      prev = xy;
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  /**
   * Лазерные радиолучи передачи данных
   */
  renderRadioLinks(ctx, positions) {
    const lastRows = (window.AppState && window.AppState.lastStepRows) || [];
    const nowTime = Date.now() * 0.004;

    lastRows.forEach(row => {
      if (row.executed !== 'job' || !row.requested) return;
      const sid = row.satellite_id;
      const item = positions.find(p => p.sat.id === sid);
      if (!item) return;

      const kind = row.requested.kind;
      if (kind === 'downlink') {
        // Луч к ближайшей наземной станции
        let closestGs = GROUND_STATIONS[0];
        let minDist = 999999;
        GROUND_STATIONS.forEach(gs => {
          const c = this.geoToXY(gs.lon, gs.lat);
          const d = Math.hypot(item.xy.x - c.x, item.xy.y - c.y);
          if (d < minDist) {
            minDist = d;
            closestGs = gs;
          }
        });
        const target = this.geoToXY(closestGs.lon, closestGs.lat);

        // Пульсирующий луч связи
        ctx.save();
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.85)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(item.xy.x, item.xy.y);
        ctx.lineTo(target.x, target.y);
        ctx.stroke();

        // Бегущие пакеты данных
        const progress = (nowTime) % 1;
        const packetX = item.xy.x + (target.x - item.xy.x) * progress;
        const packetY = item.xy.y + (target.y - item.xy.y) * progress;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(packetX, packetY, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      } else if (kind === 'relay') {
        // Луч ретрансляции к соседнему спутнику
        const other = positions.find(p => p.sat.id !== sid && p.sat.available);
        if (other && Math.abs(item.xy.x - other.xy.x) < this.width * 0.4) {
          ctx.save();
          ctx.strokeStyle = 'rgba(217, 70, 239, 0.75)';
          ctx.lineWidth = 1.8;
          ctx.beginPath();
          ctx.moveTo(item.xy.x, item.xy.y);
          ctx.lineTo(other.xy.x, other.xy.y);
          ctx.stroke();
          ctx.restore();
        }
      }
    });
  }

  /**
   * Отрисовка отдельного спутника
   */
  renderSatelliteNode(ctx, { sat, xy }) {
    const isSelected = sat.id === this.selectedSatId;
    const isHovered = this.hoveredSat && this.hoveredSat.sat.id === sat.id;
    const isOutage = !sat.available;
    const isBelowReserve = (sat.soc_pct || 100) < 30;

    let nodeColor = '#38bdf8';
    if (isOutage) nodeColor = '#ef4444';
    else if (isBelowReserve) nodeColor = '#f59e0b';
    else if (sat.last_action === 'job') nodeColor = '#10b981';
    else if (sat.last_action === 'calibrate') nodeColor = '#a855f7';

    // Внешнее кольцо выделения
    if (isSelected || isHovered) {
      ctx.beginPath();
      ctx.arc(xy.x, xy.y, 11, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(56, 189, 248, 0.2)';
      ctx.fill();
      ctx.strokeStyle = isSelected ? '#38bdf8' : '#94a3b8';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // Тело спутника
    ctx.beginPath();
    ctx.arc(xy.x, xy.y, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = nodeColor;
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Подпись ID
    ctx.fillStyle = isSelected ? '#ffffff' : '#94a3b8';
    ctx.font = isSelected ? '700 10.5px JetBrains Mono, monospace' : '500 9.5px JetBrains Mono, monospace';
    ctx.fillText(sat.id, xy.x + 6, xy.y - 5);
  }

  checkHover(x, y) {
    const hit = this.getSatAt(x, y);
    if (hit !== this.hoveredSat) {
      this.hoveredSat = hit;
      this.canvas.style.cursor = hit ? 'pointer' : 'default';
      this.render();
    }
  }

  getSatAt(x, y) {
    const sats = (window.AppState && window.AppState.satellites) || [];
    const step = (window.AppState && window.AppState.step) || 0;
    const HIT_RADIUS = 12;

    for (let idx = 0; idx < sats.length; idx++) {
      const sat = sats[idx];
      const pos = this.getSatellitePosition(idx, sats.length, step);
      const xy = this.geoToXY(pos.lon, pos.lat);
      const dist = Math.hypot(x - xy.x, y - xy.y);
      if (dist <= HIT_RADIUS) {
        return { sat, idx, xy, pos };
      }
    }
    return null;
  }

  renderHoverCard(ctx, { sat, xy, pos }) {
    const boxW = 160;
    const boxH = 74;
    let boxX = xy.x + 12;
    let boxY = xy.y - boxH - 6;

    if (boxX + boxW > this.width) boxX = xy.x - boxW - 12;
    if (boxY < 10) boxY = xy.y + 12;

    ctx.save();
    ctx.fillStyle = 'rgba(5, 7, 14, 0.92)';
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(boxX, boxY, boxW, boxH, 4);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = '700 12px JetBrains Mono, monospace';
    ctx.fillText(`${sat.id} · Бортовой статус`, boxX + 10, boxY + 18);

    ctx.fillStyle = '#94a3b8';
    ctx.font = '10px Inter, sans-serif';
    ctx.fillText(`Заряд АКБ:`, boxX + 10, boxY + 34);
    ctx.fillStyle = (sat.soc_pct < 30) ? '#ef4444' : '#34d399';
    ctx.font = '700 10.5px JetBrains Mono, monospace';
    ctx.fillText(`${Number(sat.soc_pct || 0).toFixed(1)}%`, boxX + 85, boxY + 34);

    ctx.fillStyle = '#94a3b8';
    ctx.font = '10px Inter, sans-serif';
    ctx.fillText(`Температура:`, boxX + 10, boxY + 49);
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 10.5px JetBrains Mono, monospace';
    ctx.fillText(`${Number(sat.temp_c || 0).toFixed(1)}°C`, boxX + 85, boxY + 49);

    ctx.fillStyle = '#94a3b8';
    ctx.font = '10px Inter, sans-serif';
    ctx.fillText(`Координаты:`, boxX + 10, boxY + 64);
    ctx.fillStyle = '#38bdf8';
    ctx.font = '9px JetBrains Mono, monospace';
    ctx.fillText(`${pos.lat.toFixed(0)}°N, ${pos.lon.toFixed(0)}°E`, boxX + 85, boxY + 64);

    ctx.restore();
  }
}

// Экспорт экземпляра для управления
window.OrbitalMap = OrbitalMap;
window.orbitalMapInstance = null;
