/**
 * КИНЕМАТОГРАФИЧНЫЙ 3D ГЛОБУС ЗЕМЛИ И ОРБИТАЛЬНОЙ ГРУППИРОВКИ (3D Mission Globe)
 * КосмоХакатон 2026 — Аэрокосмический интерфейс ЦУП
 * 
 * Особенности:
 * 1. 100% автономный Three.js WebGL (работает без интернета из локального бандла)
 * 2. Все 16 аппаратов (S01..S16) сразу в воздухе на 4 наклонных орбитах ССО
 * 3. Непрерывный физический полёт в 60 FPS (спутники плавно летят по орбитам в реальном времени)
 * 4. Наземные станции приема (ППИ-1 Дубна и ППИ-2 Восточный) на поверхности Земли
 * 5. Текстовые 3D-бейджи станций и аппаратов (исключают путаницу между ППИ и спутниками)
 * 6. Динамические лазерные лучи с фотонами при Downlink и межспутниковом Relay
 * 7. Интерактивное вращение 360°, зум и клик для открытия приборного щита авионики
 */

// Векторные полигоны континентов для процедурной текстуры Земли
const GLOBE_CONTINENTS = [
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
  // Антарктида
  [
    [-180, -70], [-120, -73], [-60, -65], [0, -68], [60, -67], [120, -65],
    [180, -70], [180, -90], [-180, -90], [-180, -70]
  ]
];

class Globe3D {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    if (!this.container) return;

    this.scene = null;
    this.camera = null;
    this.renderer = null;

    // Иерархия сцены
    this.worldGroup = null;        // Вращается мышью и общим авто-вращением
    this.earthSpinGroup = null;    // Вращение Земли вокруг своей оси (суточное вращение)
    this.earthMesh = null;
    this.atmosphereMesh = null;
    this.groundStationsGroup = null;

    this.spaceGroup = null;        // Инерциальное пространство для орбит и спутников
    this.orbitRingsGroup = null;
    this.satellitesGroup = null;
    this.effectsGroup = null;

    this.satObjects = new Map();   // satId -> { group, mesh, badgeSprite, anomaly, speed, ... }
    this.groundStationObjects = [];

    // Управление камерой и вращением
    this.isDragging = false;
    this.previousMousePosition = { x: 0, y: 0 };
    this.targetRotation = { x: 0.35, y: -0.6 };
    this.currentRotation = { x: 0.35, y: -0.6 };
    this.targetDistance = 3.6;
    this.currentDistance = 3.6;
    this.autoRotate = true;

    // Скорость полёта спутников в реальном времени
    this.isFlightRunning = true;
    this.flightSpeedMultiplier = 1.0;

    // Raycaster для интерактивности
    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2(-9999, -9999);
    this.hoveredSatId = null;
    this.selectedSatId = 'S01';

    // Анимационные параметры
    this.clock = new THREE.Clock();
    this.activeLinks = []; // { from, to, points, line, type, offset }

    this.init();
  }

  init() {
    if (typeof THREE === 'undefined') {
      console.warn('Three.js не загружен, ожидаем инициализацию...');
      return;
    }

    const width = this.container.clientWidth || 800;
    const height = this.container.clientHeight || 480;

    // 1. Сцена и перспективная камера
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 100);
    this.camera.position.set(0, 0, this.currentDistance);

    // 2. Рендерер WebGL
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.25;

    this.container.innerHTML = '';
    this.container.appendChild(this.renderer.domElement);

    // 3. Освещение сцены
    const ambientLight = new THREE.AmbientLight(0x1a2e4c, 1.5);
    this.scene.add(ambientLight);

    const sunLight = new THREE.DirectionalLight(0xffffff, 2.4);
    sunLight.position.set(5, 3, 5);
    this.scene.add(sunLight);

    const rimLight = new THREE.DirectionalLight(0x38bdf8, 1.2);
    rimLight.position.set(-5, -2, -4);
    this.scene.add(rimLight);

    // 4. Корневая группа мира (вращается оператором)
    this.worldGroup = new THREE.Group();
    this.scene.add(this.worldGroup);

    // 5. Группа суточного вращения Земли
    this.earthSpinGroup = new THREE.Group();
    this.worldGroup.add(this.earthSpinGroup);

    this.buildEarth();
    this.buildAtmosphere();
    this.buildGroundStations();

    // 6. Инерциальное космическое пространство (орбиты и спутники)
    this.spaceGroup = new THREE.Group();
    this.worldGroup.add(this.spaceGroup);

    this.orbitRingsGroup = new THREE.Group();
    this.spaceGroup.add(this.orbitRingsGroup);

    this.satellitesGroup = new THREE.Group();
    this.spaceGroup.add(this.satellitesGroup);

    this.effectsGroup = new THREE.Group();
    this.spaceGroup.add(this.effectsGroup);

    // 7. Мгновенная инициализация всех 16 спутников группировки
    this.setupSatellites();

    // 8. Обработчики мыши и изменения размеров
    this.initInteraction();
    window.addEventListener('resize', () => this.onResize());

    // 9. Запуск 60 FPS цикла анимации
    this.animate = this.animate.bind(this);
    requestAnimationFrame(this.animate);

    // 10. Первичная синхронизация с состоянием ЦУП
    this.updateState();
  }

  onResize() {
    if (!this.container || !this.renderer || !this.camera) return;
    const width = this.container.clientWidth;
    const height = this.container.clientHeight || 480;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  /**
   * Генерация процедурной текстуры Земли с кибер-сеткой и материками
   */
  createEarthTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 2048;
    canvas.height = 1024;
    const ctx = canvas.getContext('2d');

    // Глубокий космический океан
    ctx.fillStyle = '#030816';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Координатная сетка
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.09)';
    ctx.lineWidth = 1;
    for (let x = 0; x <= canvas.width; x += canvas.width / 24) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, canvas.height);
      ctx.stroke();
    }
    for (let y = 0; y <= canvas.height; y += canvas.height / 12) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(canvas.width, y);
      ctx.stroke();
    }
    // Линия экватора
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.28)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, canvas.height / 2);
    ctx.lineTo(canvas.width, canvas.height / 2);
    ctx.stroke();

    // Отрисовка контуров материков
    const continents = GLOBE_CONTINENTS;
    ctx.fillStyle = '#0a172c';
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 2.5;

    continents.forEach(poly => {
      ctx.beginPath();
      poly.forEach((pt, idx) => {
        const x = ((pt[0] + 180) / 360) * canvas.width;
        const y = ((90 - pt[1]) / 180) * canvas.height;
        if (idx === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    });

    // Светящиеся узлы матрицы суши (Кибер-сетка)
    ctx.fillStyle = 'rgba(56, 189, 248, 0.28)';
    for (let x = 0; x < canvas.width; x += 16) {
      for (let y = 0; y < canvas.height; y += 16) {
        const pixel = ctx.getImageData(x, y, 1, 1).data;
        if (pixel[0] > 6 && pixel[1] > 18) {
          ctx.fillRect(x, y, 2, 2);
        }
      }
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    return texture;
  }

  /**
   * Построение сферы Земли
   */
  buildEarth() {
    const radius = 1.0;
    const geometry = new THREE.SphereGeometry(radius, 64, 48);
    const texture = this.createEarthTexture();

    const material = new THREE.MeshStandardMaterial({
      map: texture,
      roughness: 0.65,
      metalness: 0.2,
      emissive: 0x020815,
      emissiveIntensity: 0.4
    });

    this.earthMesh = new THREE.Mesh(geometry, material);
    this.earthSpinGroup.add(this.earthMesh);
  }

  /**
   * Свечение атмосферы
   */
  buildAtmosphere() {
    const geometry = new THREE.SphereGeometry(1.035, 48, 36);
    const material = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.12,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending
    });
    this.atmosphereMesh = new THREE.Mesh(geometry, material);
    this.earthSpinGroup.add(this.atmosphereMesh);
  }

  /**
   * Наземные пункты приема информации (ППИ) с кругами радиовидимости и 3D-бейджами
   */
  buildGroundStations() {
    this.groundStationsGroup = new THREE.Group();
    this.earthSpinGroup.add(this.groundStationsGroup);

    const stations = [
      { id: 'GS-01', name: 'ППИ-1 (Дубна)', shortName: '📡 ППИ-1 Дубна', lat: 56.7, lon: 37.2, color: 0x38bdf8 },
      { id: 'GS-02', name: 'ППИ-2 (Восточный)', shortName: '📡 ППИ-2 Восточный', lat: 51.8, lon: 128.3, color: 0x10b981 }
    ];

    stations.forEach(gs => {
      const pos = this.latLonToVector3(gs.lat, gs.lon, 1.002);

      // Антенна-маркер
      const beaconGeo = new THREE.SphereGeometry(0.024, 16, 16);
      const beaconMat = new THREE.MeshBasicMaterial({ color: gs.color });
      const beaconMesh = new THREE.Mesh(beaconGeo, beaconMat);
      beaconMesh.position.copy(pos);
      this.groundStationsGroup.add(beaconMesh);

      // Кольцо радиовидимости
      const ringGeo = new THREE.RingGeometry(0.04, 0.22, 32);
      const ringMat = new THREE.MeshBasicMaterial({
        color: gs.color,
        transparent: true,
        opacity: 0.32,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending
      });
      const ringMesh = new THREE.Mesh(ringGeo, ringMat);
      ringMesh.position.copy(pos.clone().multiplyScalar(1.001));
      ringMesh.lookAt(pos.clone().multiplyScalar(2));
      this.groundStationsGroup.add(ringMesh);

      // 3D Текстовый бейдж станции
      const labelSprite = this.createBadgeSprite(gs.shortName, gs.color === 0x38bdf8 ? '#38bdf8' : '#10b981');
      labelSprite.position.copy(pos.clone().multiplyScalar(1.12));
      this.groundStationsGroup.add(labelSprite);

      this.groundStationObjects.push({ gs, pos, beaconMesh, ringMesh, labelSprite });
    });
  }

  latLonToVector3(lat, lon, radius = 1.0) {
    const phi = (90 - lat) * (Math.PI / 180);
    const theta = (lon + 180) * (Math.PI / 180);
    const x = -(radius * Math.sin(phi) * Math.cos(theta));
    const z = (radius * Math.sin(phi) * Math.sin(theta));
    const y = (radius * Math.cos(phi));
    return new THREE.Vector3(x, y, z);
  }

  /**
   * Создание текстового 3D-спрайта
   */
  createBadgeSprite(text, colorHex = '#38bdf8') {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = 'rgba(5, 12, 26, 0.88)';
    ctx.strokeStyle = colorHex;
    ctx.lineWidth = 2;
    if (ctx.roundRect) ctx.roundRect(4, 4, 248, 56, 8);
    else ctx.rect(4, 4, 248, 56);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = colorHex;
    ctx.font = 'bold 22px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 128, 32);

    const texture = new THREE.CanvasTexture(canvas);
    const spriteMat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
    const sprite = new THREE.Sprite(spriteMat);
    sprite.scale.set(0.28, 0.07, 1);
    return sprite;
  }

  /**
   * Создание 3D модели космического аппарата
   */
  createSatelliteMesh(satId) {
    const satGroup = new THREE.Group();

    // 1. Центральный приборный корпус
    const busGeo = new THREE.BoxGeometry(0.035, 0.035, 0.05);
    const busMat = new THREE.MeshStandardMaterial({
      color: 0x273b54,
      metalness: 0.85,
      roughness: 0.2,
      emissive: 0x0e2035,
      emissiveIntensity: 0.5
    });
    const busMesh = new THREE.Mesh(busGeo, busMat);
    satGroup.add(busMesh);

    // 2. Панели солнечных батарей (левая и правая)
    const panelGeo = new THREE.BoxGeometry(0.08, 0.003, 0.032);
    const panelMat = new THREE.MeshStandardMaterial({
      color: 0x1d4ed8,
      metalness: 0.92,
      roughness: 0.1,
      emissive: 0x1e40af,
      emissiveIntensity: 0.4
    });

    const leftPanel = new THREE.Mesh(panelGeo, panelMat);
    leftPanel.position.set(-0.06, 0, 0);
    satGroup.add(leftPanel);

    const rightPanel = new THREE.Mesh(panelGeo, panelMat);
    rightPanel.position.set(0.06, 0, 0);
    satGroup.add(rightPanel);

    // 3. Антенна полезной нагрузки
    const dishGeo = new THREE.ConeGeometry(0.014, 0.018, 12);
    const dishMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8 });
    const dishMesh = new THREE.Mesh(dishGeo, dishMat);
    dishMesh.rotation.x = Math.PI;
    dishMesh.position.set(0, -0.022, 0);
    satGroup.add(dishMesh);

    // 4. Неоновый светодиод состояния борта
    const ledGeo = new THREE.SphereGeometry(0.013, 12, 12);
    const ledMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8 });
    const ledMesh = new THREE.Mesh(ledGeo, ledMat);
    ledMesh.position.set(0, 0.022, 0);
    satGroup.add(ledMesh);

    // 5. Текстовая метка спутника
    const labelSprite = this.createBadgeSprite(satId, '#38bdf8');
    labelSprite.position.set(0, 0.07, 0);
    labelSprite.scale.set(0.18, 0.045, 1);
    satGroup.add(labelSprite);

    satGroup.userData = { satId, ledMat, busMat, labelSprite };
    return satGroup;
  }

  /**
   * Светящееся наклонное кольцо орбиты
   */
  createOrbitRing(planeIndex, totalPlanes, inclinationDeg = 97.4, radius = 1.34) {
    const points = [];
    const segments = 96;
    for (let i = 0; i <= segments; i++) {
      const theta = (i / segments) * Math.PI * 2;
      points.push(new THREE.Vector3(Math.cos(theta) * radius, 0, Math.sin(theta) * radius));
    }
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.26,
      blending: THREE.AdditiveBlending
    });
    const ring = new THREE.LineLoop(geometry, material);

    const raan = (planeIndex * (Math.PI / totalPlanes));
    ring.rotation.x = inclinationDeg * (Math.PI / 180);
    ring.rotation.y = raan;

    return { ring, raan, inclination: inclinationDeg * (Math.PI / 180), radius };
  }

  /**
   * Первичная инициализация всех 16 спутников (4 орбитальные плоскости по 4 аппарата)
   */
  setupSatellites() {
    const planeCount = 4;
    const satsPerPlane = 4;
    const totalSats = 16;
    const radius = 1.34;
    const inclination = 97.4 * (Math.PI / 180); // ССО наклонение

    // 1. Создаем 4 орбитальных кольца
    this.orbitRingsGroup.clear();
    for (let p = 0; p < planeCount; p++) {
      const orbit = this.createOrbitRing(p, planeCount, 97.4, radius);
      this.orbitRingsGroup.add(orbit.ring);
    }

    // 2. Создаем 16 спутников S01..S16
    for (let idx = 0; idx < totalSats; idx++) {
      const satNum = (idx + 1).toString().padStart(2, '0');
      const satId = `S${satNum}`;

      const planeIdx = idx % planeCount;
      const satInPlane = Math.floor(idx / planeCount);
      const phaseOffset = (satInPlane / satsPerPlane) * Math.PI * 2;
      const raan = planeIdx * (Math.PI / planeCount);

      const mesh = this.createSatelliteMesh(satId);
      this.satellitesGroup.add(mesh);

      // Орбитальная скорость для 60 FPS полета (~0.18 рад/сек)
      const orbitSpeed = 0.16 + (planeIdx * 0.01);

      this.satObjects.set(satId, {
        satId,
        group: mesh,
        planeIdx,
        phaseOffset,
        radius,
        inclination,
        raan,
        orbitSpeed,
        currentAnomaly: phaseOffset,
        satData: { id: satId, soc_pct: 80, temp_c: 20, available: true, last_action: 'idle' }
      });
    }
  }

  /**
   * Синхронизация телеметрии и состояний аппаратов с AppState
   */
  updateState() {
    const state = window.AppState;
    const sats = (state && state.satellites && state.satellites.length > 0)
      ? state.satellites
      : null;

    const currentStep = (state && state.step) || 0;

    // Обновление телеметрии существующих аппаратов
    this.satObjects.forEach((item, satId) => {
      let sat = sats ? sats.find(s => s.id === satId) : null;
      if (sat) {
        item.satData = sat;
      } else {
        sat = item.satData;
      }

      // Цветовая индикация состояния
      const ledMat = item.group.userData.ledMat;
      const labelSprite = item.group.userData.labelSprite;

      if (ledMat) {
        if (!sat.available) {
          ledMat.color.setHex(0xef4444); // Отказ (красный)
          if (labelSprite) labelSprite.material.color.setHex(0xef4444);
        } else if (sat.soc_pct < 30) {
          ledMat.color.setHex(0xf59e0b); // Дефицит АКБ (оранжевый)
          if (labelSprite) labelSprite.material.color.setHex(0xf59e0b);
        } else if (sat.last_action === 'job') {
          ledMat.color.setHex(0x10b981); // Работа над заданием (зеленый)
          if (labelSprite) labelSprite.material.color.setHex(0x10b981);
        } else if (sat.last_action === 'calibrate') {
          ledMat.color.setHex(0xa855f7); // Калибровка сенсоров (фиолетовый)
          if (labelSprite) labelSprite.material.color.setHex(0xa855f7);
        } else {
          ledMat.color.setHex(0x38bdf8); // Дежурный штатный режим (голубой)
          if (labelSprite) labelSprite.material.color.setHex(0x38bdf8);
        }
      }

      // Выделенный оператором спутник
      const isSelected = sat.id === this.selectedSatId;
      item.group.scale.setScalar(isSelected ? 1.45 : 1.0);
    });

    // Создание спецэффектов лучей сброса данных (Downlink) и связи (Relay)
    this.updateActionEffects();
  }

  /**
   * Создание лазерных лучей и световых эффектов при выполнении заданий
   */
  updateActionEffects() {
    while (this.effectsGroup.children.length > 0) {
      const obj = this.effectsGroup.children[0];
      this.effectsGroup.remove(obj);
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) obj.material.dispose();
    }
    this.activeLinks = [];

    const lastRows = (window.AppState && window.AppState.lastStepRows) || [];

    lastRows.forEach(row => {
      if (row.executed !== 'job' || !row.requested) return;
      const sid = row.satellite_id;
      const satItem = this.satObjects.get(sid);
      if (!satItem) return;

      const fromPos = satItem.group.position.clone();
      const kind = row.requested.kind;

      if (kind === 'downlink') {
        // Луч к ближайшей наземной станции ППИ
        let closestGs = this.groundStationObjects[0];
        let minDist = 999;
        this.groundStationObjects.forEach(g => {
          const worldGsPos = new THREE.Vector3();
          g.beaconMesh.getWorldPosition(worldGsPos);
          const d = fromPos.distanceTo(worldGsPos);
          if (d < minDist) { minDist = d; closestGs = g; }
        });

        const toPos = new THREE.Vector3();
        closestGs.beaconMesh.getWorldPosition(toPos);

        this.createLaserBeam(fromPos, toPos, 0x38bdf8, 0x0ea5e9, 'downlink');
        this.triggerShockwave(toPos, 0x38bdf8);
      } else if (kind === 'relay') {
        // Межспутниковый луч к соседнему аппарату
        const otherSats = Array.from(this.satObjects.entries()).filter(([id]) => id !== sid);
        if (otherSats.length > 0) {
          const targetItem = otherSats[0][1];
          const toPos = targetItem.group.position.clone();
          this.createLaserBeam(fromPos, toPos, 0xd946ef, 0xa855f7, 'relay');
        }
      }
    });
  }

  /**
   * Лазерный луч с летящими квантовыми фотонами
   */
  createLaserBeam(from, to, coreColor = 0x38bdf8, glowColor = 0x0ea5e9, type = 'downlink') {
    const lineGeo = new THREE.BufferGeometry().setFromPoints([from, to]);
    const lineMat = new THREE.LineBasicMaterial({
      color: coreColor,
      linewidth: 3,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending
    });
    const line = new THREE.Line(lineGeo, lineMat);
    this.effectsGroup.add(line);

    // Частицы фотонов
    const particleCount = 18;
    const pGeo = new THREE.BufferGeometry();
    const positions = new Float32Array(particleCount * 3);

    for (let i = 0; i < particleCount; i++) {
      const alpha = i / particleCount;
      positions[i * 3] = from.x + (to.x - from.x) * alpha;
      positions[i * 3 + 1] = from.y + (to.y - from.y) * alpha;
      positions[i * 3 + 2] = from.z + (to.z - from.z) * alpha;
    }
    pGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const pMat = new THREE.PointsMaterial({
      color: 0xffffff,
      size: 0.038,
      transparent: true,
      opacity: 0.92,
      blending: THREE.AdditiveBlending
    });
    const points = new THREE.Points(pGeo, pMat);
    this.effectsGroup.add(points);

    this.activeLinks.push({ from, to, points, line, type, offset: 0 });
  }

  /**
   * Импульсная ударная волна захвата несущей на наземной станции
   */
  triggerShockwave(centerPos, color = 0x38bdf8) {
    const ringGeo = new THREE.RingGeometry(0.01, 0.08, 24);
    const ringMat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.copy(centerPos.clone().multiplyScalar(1.002));
    ring.lookAt(centerPos.clone().multiplyScalar(2));
    this.effectsGroup.add(ring);

    ring.userData = { isShockwave: true, scale: 1.0, opacity: 0.85 };
  }

  /**
   * Интерактивность мыши: вращение сцены, зум, клик по аппарату
   */
  initInteraction() {
    const dom = this.renderer.domElement;

    dom.addEventListener('mousedown', (e) => {
      this.isDragging = true;
      this.autoRotate = false;
      this.previousMousePosition = { x: e.clientX, y: e.clientY };
    });

    window.addEventListener('mouseup', () => {
      this.isDragging = false;
    });

    dom.addEventListener('mousemove', (e) => {
      const rect = dom.getBoundingClientRect();
      this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      if (this.isDragging) {
        const deltaX = e.clientX - this.previousMousePosition.x;
        const deltaY = e.clientY - this.previousMousePosition.y;

        this.targetRotation.y += deltaX * 0.007;
        this.targetRotation.x += deltaY * 0.007;
        this.targetRotation.x = Math.max(-1.4, Math.min(1.4, this.targetRotation.x));

        this.previousMousePosition = { x: e.clientX, y: e.clientY };
      }
    });

    dom.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.targetDistance += e.deltaY * 0.0025;
      this.targetDistance = Math.max(2.2, Math.min(6.5, this.targetDistance));
    }, { passive: false });

    // Клик по спутнику открывает авионику
    dom.addEventListener('click', (e) => {
      const satHit = this.checkSatIntersection();
      if (satHit) {
        this.selectedSatId = satHit;
        if (typeof window.openAvionicsDrawer === 'function') {
          window.openAvionicsDrawer(satHit);
        }
        this.updateState();
      }
    });
  }

  checkSatIntersection() {
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const meshes = [];
    this.satObjects.forEach(item => {
      item.group.traverse(child => {
        if (child.isMesh) meshes.push(child);
      });
    });

    const intersects = this.raycaster.intersectObjects(meshes);
    if (intersects.length > 0) {
      let cur = intersects[0].object;
      while (cur && (!cur.userData || !cur.userData.satId)) {
        cur = cur.parent;
      }
      if (cur && cur.userData && cur.userData.satId) {
        return cur.userData.satId;
      }
    }
    return null;
  }

  resetView() {
    this.targetRotation = { x: 0.35, y: -0.6 };
    this.targetDistance = 3.6;
    this.autoRotate = true;
  }

  toggleAutoRotate() {
    this.autoRotate = !this.autoRotate;
  }

  toggleFlight() {
    this.isFlightRunning = !this.isFlightRunning;
    return this.isFlightRunning;
  }

  setSpeedMultiplier(speed) {
    this.flightSpeedMultiplier = speed;
  }

  /**
   * Непрерывный 60 FPS цикл анимации
   */
  animate() {
    requestAnimationFrame(this.animate);

    const delta = this.clock.getDelta();

    // 1. Авто-вращение сцены оператора
    if (this.autoRotate) {
      this.targetRotation.y += 0.0018;
    }

    // Плавная интерполяция вращения и зума
    this.currentRotation.x += (this.targetRotation.x - this.currentRotation.x) * 0.08;
    this.currentRotation.y += (this.targetRotation.y - this.currentRotation.y) * 0.08;
    this.currentDistance += (this.targetDistance - this.currentDistance) * 0.08;

    this.worldGroup.rotation.x = this.currentRotation.x;
    this.worldGroup.rotation.y = this.currentRotation.y;
    this.camera.position.z = this.currentDistance;

    // 2. Суточное вращение Земли вокруг своей оси
    this.earthSpinGroup.rotation.y += delta * 0.05;

    // 3. НЕПРЕРЫВНЫЙ 60-FPS ПОЛЁТ ВСЕХ 16 СПУТНИКОВ ПО ОРБИТАМ
    this.satObjects.forEach(item => {
      if (this.isFlightRunning) {
        item.currentAnomaly += item.orbitSpeed * this.flightSpeedMultiplier * delta;
      }

      // Вычисление пространственной 3D позиции
      const xOrb = Math.cos(item.currentAnomaly) * item.radius;
      const zOrb = Math.sin(item.currentAnomaly) * item.radius;

      const v = new THREE.Vector3(xOrb, 0, zOrb);
      v.applyAxisAngle(new THREE.Vector3(1, 0, 0), item.inclination);
      v.applyAxisAngle(new THREE.Vector3(0, 1, 0), item.raan);

      item.group.position.copy(v);
      item.group.lookAt(0, 0, 0); // Антенна ориентирована на центр Земли
    });

    // 4. Анимация бегущих фотонов по лазерным лучам
    const nowSec = this.clock.getElapsedTime();
    this.activeLinks.forEach(link => {
      const posAttr = link.points.geometry.attributes.position;
      const count = posAttr.count;
      link.offset = (link.offset + delta * 2.0) % 1;

      for (let i = 0; i < count; i++) {
        const pFrac = ((i / count) + link.offset) % 1;
        posAttr.setXYZ(
          i,
          link.from.x + (link.to.x - link.from.x) * pFrac,
          link.from.y + (link.to.y - link.from.y) * pFrac,
          link.from.z + (link.to.z - link.from.z) * pFrac
        );
      }
      posAttr.needsUpdate = true;
    });

    // 5. Ударные волны на наземных станциях
    this.effectsGroup.children.forEach(child => {
      if (child.userData && child.userData.isShockwave) {
        child.userData.scale += delta * 1.5;
        child.userData.opacity -= delta * 0.65;
        child.scale.setScalar(child.userData.scale);
        child.material.opacity = Math.max(0, child.userData.opacity);
        if (child.userData.opacity <= 0) {
          this.effectsGroup.remove(child);
        }
      }
    });

    // 6. Пульсация колец наземных станций
    this.groundStationObjects.forEach((g, idx) => {
      const pulse = Math.sin(nowSec * 3 + idx) * 0.15 + 0.95;
      g.ringMesh.scale.setScalar(pulse);
    });

    this.renderer.render(this.scene, this.camera);
  }
}

window.Globe3D = Globe3D;
window.globe3dInstance = null;
