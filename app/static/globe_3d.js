/**
 * КИНЕМАТОГРАФИЧНЫЙ 3D ГЛОБУС ЗЕМЛИ И ОРБИТАЛЬНОЙ ГРУППИРОВКИ (3D Mission Globe)
 * КосмоХакатон 2026 — Аэрокосмический интерфейс ЦУП
 * 
 * Технологический стек:
 * - Three.js WebGL Engine (локальный бандл app/static/vendor/three.min.js)
 * - Процедурная текстура Земли с кибер-континентами и атмосферой
 * - Реалистичные 3D модели спутников с солнечными батареями и витками орбит
 * - Лазерные лучи и фотонные частицы при сбросе данных (downlink) и ретрансляции (relay)
 * - Интерактивное вращение мышью (360°), плавный зум и клик для открытия авионики
 */

class Globe3D {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    if (!this.container) return;

    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.earthGroup = null;
    this.earthMesh = null;
    this.atmosphereMesh = null;

    this.satellitesGroup = null;
    this.orbitRingsGroup = null;
    this.effectsGroup = null;
    this.groundStationsGroup = null;

    this.satObjects = new Map(); // satId -> { group, mesh, satData, orbitData }
    this.groundStationObjects = [];

    // Состояние управления камерой (Damped Orbit Controls)
    this.isDragging = false;
    this.previousMousePosition = { x: 0, y: 0 };
    this.targetRotation = { x: 0.35, y: -0.6 };
    this.currentRotation = { x: 0.35, y: -0.6 };
    this.targetDistance = 3.6;
    this.currentDistance = 3.6;
    this.autoRotate = true;

    // Raycaster для интерактивности
    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2(-9999, -9999);
    this.hoveredSatId = null;
    this.selectedSatId = 'S01';

    // Анимационные параметры
    this.clock = new THREE.Clock();
    this.activeLinks = []; // { beam, particles, fromPos, toPos, type }

    this.init();
  }

  init() {
    if (typeof THREE === 'undefined') {
      console.warn('Three.js не загружен, ожидаем бандл...');
      return;
    }

    const width = this.container.clientWidth || 800;
    const height = this.container.clientHeight || 480;

    // 1. Сцена и камера
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 100);
    this.camera.position.set(0, 0, this.currentDistance);

    // 2. Рендерер с антиалиасингом и высоким качеством
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.25;

    // Очищаем контейнер и добавляем канвас
    this.container.innerHTML = '';
    this.container.appendChild(this.renderer.domElement);

    // 3. Освещение
    const ambientLight = new THREE.AmbientLight(0x1a2e4c, 1.4);
    this.scene.add(ambientLight);

    const sunLight = new THREE.DirectionalLight(0xffffff, 2.2);
    sunLight.position.set(5, 3, 5);
    this.scene.add(sunLight);

    const rimLight = new THREE.DirectionalLight(0x38bdf8, 1.2);
    rimLight.position.set(-5, -2, -4);
    this.scene.add(rimLight);

    // 4. Группа Земли
    this.earthGroup = new THREE.Group();
    this.scene.add(this.earthGroup);

    this.buildEarth();
    this.buildAtmosphere();
    this.buildGroundStations();

    // 5. Группы спутников и орбит
    this.orbitRingsGroup = new THREE.Group();
    this.earthGroup.add(this.orbitRingsGroup);

    this.satellitesGroup = new THREE.Group();
    this.earthGroup.add(this.satellitesGroup);

    this.effectsGroup = new THREE.Group();
    this.earthGroup.add(this.effectsGroup);

    // 6. События мыши и окна
    this.initInteraction();
    window.addEventListener('resize', () => this.onResize());

    // 7. Запуск цикла анимации
    this.animate = this.animate.bind(this);
    requestAnimationFrame(this.animate);
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
   * Генерация процедурной текстуры Земли в стиле космического командного центра
   */
  createEarthTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 2048;
    canvas.height = 1024;
    const ctx = canvas.getContext('2d');

    // Базовый космический океан
    ctx.fillStyle = '#030816';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Сетка параллелей и меридианов
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.08)';
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
    // Экватор
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.25)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, canvas.height / 2);
    ctx.lineTo(canvas.width, canvas.height / 2);
    ctx.stroke();

    // Отрисовка материков
    const continents = window.WORLD_CONTINENTS || [
      [[-9, 36], [2, 51], [25, 71], [80, 75], [140, 75], [162, 55], [122, 30], [98, 4], [50, 26], [10, 44], [-9, 36]],
      [[-17, 15], [11, 37], [44, 12], [32, -28], [18, -34], [8, 4], [-17, 15]],
      [[-168, 66], [-120, 76], [-60, 60], [-80, 25], [-118, 33], [-168, 66]],
      [[-75, 10], [-35, -5], [-55, -35], [-75, -45], [-80, -5], [-75, 10]],
      [[114, -22], [145, -15], [148, -38], [118, -35], [114, -22]]
    ];

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

    // Добавляем точечную матрицу по суше (Sci-Fi Grid Overlay)
    ctx.fillStyle = 'rgba(56, 189, 248, 0.25)';
    for (let x = 0; x < canvas.width; x += 16) {
      for (let y = 0; y < canvas.height; y += 16) {
        // Проверяем цвет пикселя: если суша — ставим светящуюся точку
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
   * Создание сферы Земли
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
    this.earthGroup.add(this.earthMesh);
  }

  /**
   * Свечение атмосферы (Atmospheric Glow)
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
    this.earthGroup.add(this.atmosphereMesh);
  }

  /**
   * Наземные станции приема информации (ППИ) с кругами радиовидимости
   */
  buildGroundStations() {
    this.groundStationsGroup = new THREE.Group();
    this.earthGroup.add(this.groundStationsGroup);

    const stations = [
      { id: 'GS-01', name: 'ППИ-1 (Дубна)', lat: 56.7, lon: 37.2, color: 0x38bdf8 },
      { id: 'GS-02', name: 'ППИ-2 (Восточный)', lat: 51.8, lon: 128.3, color: 0x10b981 }
    ];

    stations.forEach(gs => {
      const pos = this.latLonToVector3(gs.lat, gs.lon, 1.002);

      // Антенна-маркер
      const beaconGeo = new THREE.SphereGeometry(0.02, 16, 16);
      const beaconMat = new THREE.MeshBasicMaterial({ color: gs.color });
      const beaconMesh = new THREE.Mesh(beaconGeo, beaconMat);
      beaconMesh.position.copy(pos);
      this.groundStationsGroup.add(beaconMesh);

      // Концентрические кольца зоны радиовидимости
      const ringGeo = new THREE.RingGeometry(0.04, 0.24, 32);
      const ringMat = new THREE.MeshBasicMaterial({
        color: gs.color,
        transparent: true,
        opacity: 0.28,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending
      });
      const ringMesh = new THREE.Mesh(ringGeo, ringMat);
      ringMesh.position.copy(pos.clone().multiplyScalar(1.001));
      ringMesh.lookAt(pos.clone().multiplyScalar(2));
      this.groundStationsGroup.add(ringMesh);

      this.groundStationObjects.push({ gs, pos, beaconMesh, ringMesh });
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
   * Создание 3D модели спутника (Корпус + Панели солнечных батарей + Антенна)
   */
  createSatelliteMesh(satId) {
    const satGroup = new THREE.Group();

    // 1. Центральный приборный отсек (золотой/титановый композит)
    const busGeo = new THREE.BoxGeometry(0.032, 0.032, 0.045);
    const busMat = new THREE.MeshStandardMaterial({
      color: 0x22354c,
      metalness: 0.85,
      roughness: 0.2,
      emissive: 0x0f2238,
      emissiveIntensity: 0.5
    });
    const busMesh = new THREE.Mesh(busGeo, busMat);
    satGroup.add(busMesh);

    // 2. Панели солнечных батарей (левая и правая)
    const panelGeo = new THREE.BoxGeometry(0.075, 0.003, 0.03);
    const panelMat = new THREE.MeshStandardMaterial({
      color: 0x1e40af,
      metalness: 0.9,
      roughness: 0.1,
      emissive: 0x1d4ed8,
      emissiveIntensity: 0.35
    });

    const leftPanel = new THREE.Mesh(panelGeo, panelMat);
    leftPanel.position.set(-0.055, 0, 0);
    satGroup.add(leftPanel);

    const rightPanel = new THREE.Mesh(panelGeo, panelMat);
    rightPanel.position.set(0.055, 0, 0);
    satGroup.add(rightPanel);

    // 3. Антенна полезной нагрузки
    const dishGeo = new THREE.ConeGeometry(0.012, 0.015, 12);
    const dishMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8 });
    const dishMesh = new THREE.Mesh(dishGeo, dishMat);
    dishMesh.rotation.x = Math.PI;
    dishMesh.position.set(0, -0.02, 0);
    satGroup.add(dishMesh);

    // 4. Неоновый светодиод состояния
    const ledGeo = new THREE.SphereGeometry(0.012, 12, 12);
    const ledMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8 });
    const ledMesh = new THREE.Mesh(ledGeo, ledMat);
    ledMesh.position.set(0, 0.02, 0);
    satGroup.add(ledMesh);

    satGroup.userData = { satId, ledMat, busMat };
    return satGroup;
  }

  /**
   * Отрисовка светящегося кольца орбиты
   */
  createOrbitRing(planeIndex, totalPlanes, inclinationDeg = 97.4, radius = 1.32) {
    const points = [];
    const segments = 90;
    for (let i = 0; i <= segments; i++) {
      const theta = (i / segments) * Math.PI * 2;
      points.push(new THREE.Vector3(Math.cos(theta) * radius, 0, Math.sin(theta) * radius));
    }
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.22,
      blending: THREE.AdditiveBlending
    });
    const ring = new THREE.LineLoop(geometry, material);

    // Наклон и долгота восходящего узла
    const raan = (planeIndex * (Math.PI / totalPlanes));
    ring.rotation.x = inclinationDeg * (Math.PI / 180);
    ring.rotation.y = raan;

    return { ring, raan, inclination: inclinationDeg * (Math.PI / 180), radius };
  }

  /**
   * Обновление состояния 3D сцены на основе AppState
   */
  updateState() {
    const state = window.AppState;
    if (!state || !state.satellites) return;

    const sats = state.satellites;
    const currentStep = state.step || 0;
    const planeCount = Math.min(4, Math.ceil(sats.length / 4));

    // 1. Инициализация орбит при необходимости
    if (this.orbitRingsGroup.children.length === 0) {
      for (let p = 0; p < planeCount; p++) {
        const orbit = this.createOrbitRing(p, planeCount);
        this.orbitRingsGroup.add(orbit.ring);
      }
    }

    // 2. Создание или обновление спутников
    sats.forEach((sat, idx) => {
      let item = this.satObjects.get(sat.id);
      if (!item) {
        const mesh = this.createSatelliteMesh(sat.id);
        this.satellitesGroup.add(mesh);

        const planeIdx = idx % planeCount;
        const satInPlane = Math.floor(idx / planeCount);
        const satsInThisPlane = Math.ceil(sats.length / planeCount);
        const phaseOffset = (satInPlane / satsInThisPlane) * Math.PI * 2;

        item = {
          group: mesh,
          planeIdx,
          phaseOffset,
          radius: 1.32,
          inclination: 97.4 * (Math.PI / 180),
          raan: (planeIdx * (Math.PI / planeCount))
        };
        this.satObjects.set(sat.id, item);
      }

      // Вычисление 3D позиции вдоль орбиты
      const orbitPeriodSteps = 18;
      const meanAnomaly = ((currentStep % orbitPeriodSteps) / orbitPeriodSteps) * Math.PI * 2 + item.phaseOffset;

      // Позиция на наклонной плоскости
      const xOrb = Math.cos(meanAnomaly) * item.radius;
      const zOrb = Math.sin(meanAnomaly) * item.radius;

      // Применяем матрицы вращения орбиты (наклон и восходящий узел)
      const v = new THREE.Vector3(xOrb, 0, zOrb);
      v.applyAxisAngle(new THREE.Vector3(1, 0, 0), item.inclination);
      v.applyAxisAngle(new THREE.Vector3(0, 1, 0), item.raan);

      item.group.position.copy(v);
      item.group.lookAt(0, 0, 0); // Панели ориентированы по касательной, антенна на Землю

      // Цветовая индикация состояния
      const ledMat = item.group.userData.ledMat;
      if (ledMat) {
        if (!sat.available) ledMat.color.setHex(0xef4444); // Отказ
        else if (sat.soc_pct < 30) ledMat.color.setHex(0xf59e0b); // Дефицит
        else if (sat.last_action === 'job') ledMat.color.setHex(0x10b981); // Работа
        else if (sat.last_action === 'calibrate') ledMat.color.setHex(0xa855f7); // Калибровка
        else ledMat.color.setHex(0x38bdf8); // Дежурный
      }

      // Подсветка выделенного спутника
      const isSelected = sat.id === this.selectedSatId;
      item.group.scale.setScalar(isSelected ? 1.5 : 1.0);
    });

    // 3. Создание лазерных лучей и эффектов активных заданий
    this.updateActionEffects();
  }

  /**
   * Спецэффекты при выполнении заданий (Downlink и Relay лазеры)
   */
  updateActionEffects() {
    // Очищаем старые лучи
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
        // Луч к ближайшей наземной станции
        let closestGs = this.groundStationObjects[0];
        let minDist = 999;
        this.groundStationObjects.forEach(g => {
          const d = fromPos.distanceTo(g.pos);
          if (d < minDist) { minDist = d; closestGs = g; }
        });

        const toPos = closestGs.pos.clone();
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
   * Создание пульсирующего лазерного луча с летящими фотонами
   */
  createLaserBeam(from, to, coreColor = 0x38bdf8, glowColor = 0x0ea5e9, type = 'downlink') {
    // 1. Центральная светящаяся линия
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

    // 2. Частицы фотонов, бегущие по лучу
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
      size: 0.035,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending
    });
    const points = new THREE.Points(pGeo, pMat);
    this.effectsGroup.add(points);

    this.activeLinks.push({ from, to, points, line, type, offset: 0 });
  }

  /**
   * Импульсное кольцо радиозахвата на наземной станции
   */
  triggerShockwave(centerPos, color = 0x38bdf8) {
    const ringGeo = new THREE.RingGeometry(0.01, 0.08, 24);
    const ringMat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.8,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.copy(centerPos.clone().multiplyScalar(1.002));
    ring.lookAt(centerPos.clone().multiplyScalar(2));
    this.effectsGroup.add(ring);

    ring.userData = { isShockwave: true, scale: 1.0, opacity: 0.8 };
  }

  /**
   * Управление мышью (Orbit Controls & Raycasting)
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
        // Ограничение наклона
        this.targetRotation.x = Math.max(-1.4, Math.min(1.4, this.targetRotation.x));

        this.previousMousePosition = { x: e.clientX, y: e.clientY };
      }
    });

    dom.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.targetDistance += e.deltaY * 0.0025;
      this.targetDistance = Math.max(2.2, Math.min(6.5, this.targetDistance));
    }, { passive: false });

    // Клик по спутнику
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

  /**
   * Основной цикл анимации (60 FPS)
   */
  animate() {
    requestAnimationFrame(this.animate);

    const delta = this.clock.getDelta();

    // 1. Авто-вращение Земли
    if (this.autoRotate) {
      this.targetRotation.y += 0.0018;
    }

    // 2. Плавная интерполяция вращения и зума (Damping)
    this.currentRotation.x += (this.targetRotation.x - this.currentRotation.x) * 0.08;
    this.currentRotation.y += (this.targetRotation.y - this.currentRotation.y) * 0.08;
    this.currentDistance += (this.targetDistance - this.currentDistance) * 0.08;

    this.earthGroup.rotation.x = this.currentRotation.x;
    this.earthGroup.rotation.y = this.currentRotation.y;
    this.camera.position.z = this.currentDistance;

    // 3. Анимация фотонных частиц по лазерным лучам
    const nowSec = this.clock.getElapsedTime();
    this.activeLinks.forEach(link => {
      const posAttr = link.points.geometry.attributes.position;
      const count = posAttr.count;
      link.offset = (link.offset + delta * 1.8) % 1;

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

    // 4. Анимация ударных волн на наземных станциях
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

    // 5. Пульсация колец наземных станций
    this.groundStationObjects.forEach((g, idx) => {
      const pulse = Math.sin(nowSec * 3 + idx) * 0.15 + 0.95;
      g.ringMesh.scale.setScalar(pulse);
    });

    this.renderer.render(this.scene, this.camera);
  }
}

window.Globe3D = Globe3D;
window.globe3dInstance = null;
