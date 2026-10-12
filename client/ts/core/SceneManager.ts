/**
 * 场景管理器
 * 负责 Three.js 场景、天空、地面、光照、车辆模型的创建与管理
 */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { CarState } from '../car/CarPhysics.js';

export class SceneManager {
  public scene: THREE.Scene;
  public carGroup: THREE.Group;

  private directionalLight: THREE.DirectionalLight;
  private frontWheels: THREE.Mesh[] = [];
  private wheelMeshes: THREE.Mesh[] = [];

  // 实例化渲染
  private treeTrunks: THREE.InstancedMesh | null = null;
  private treeLeaves: THREE.InstancedMesh | null = null;
  private treePositions: Float32Array = new Float32Array(); // 每棵树的 x,z
  private coneMesh: THREE.InstancedMesh | null = null;
  private conePositions: Float32Array = new Float32Array();

  // 剔除缓存
  private lastCullX: number = 9999;
  private lastCullZ: number = 9999;
  private readonly cullThreshold: number = 5; // 移动5米才更新剔除

  constructor() {
    this.scene = new THREE.Scene();

    // 环境贴图（让材质有真实反射）
    const tmpRenderer = new THREE.WebGLRenderer();
    const pmrem = new THREE.PMREMGenerator(tmpRenderer);
    const envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = envMap;
    pmrem.dispose();
    tmpRenderer.dispose();

    // 渐变天空
    this.createSkyDome();

    // 雾效
    this.scene.fog = new THREE.Fog(0xc8dce8, 80, 350);

    // 光照
    const ambient = new THREE.AmbientLight(0xffffff, 0.35);
    this.scene.add(ambient);

    this.directionalLight = new THREE.DirectionalLight(0xfff5e0, 2.5);
    this.directionalLight.position.set(40, 60, 25);
    this.directionalLight.castShadow = true;
    this.directionalLight.shadow.mapSize.width = 2048;
    this.directionalLight.shadow.mapSize.height = 2048;
    this.directionalLight.shadow.camera.near = 1;
    this.directionalLight.shadow.camera.far = 200;
    this.directionalLight.shadow.camera.left = -35;
    this.directionalLight.shadow.camera.right = 35;
    this.directionalLight.shadow.camera.top = 35;
    this.directionalLight.shadow.camera.bottom = -35;
    this.directionalLight.shadow.bias = -0.0005;
    this.scene.add(this.directionalLight);

    // 补光
    const fillLight = new THREE.DirectionalLight(0xb0d0ff, 0.6);
    fillLight.position.set(-30, 40, -20);
    this.scene.add(fillLight);

    // 地面
    this.createGround();

    // 环境装饰
    this.createDecorations();

    // 测试赛道标记
    this.createTestTrackMarkers();

    // 创建车辆
    this.carGroup = this.createCarModel();
    this.scene.add(this.carGroup);
  }

  /**
   * 渐变天空穹顶
   */
  private createSkyDome(): void {
    const skyGeo = new THREE.SphereGeometry(500, 32, 16);
    const skyMat = new THREE.ShaderMaterial({
      uniforms: {
        topColor: { value: new THREE.Color(0x4a90d9) },
        bottomColor: { value: new THREE.Color(0xdceef5) },
        offset: { value: 20 },
        exponent: { value: 0.6 },
      },
      vertexShader: `
        varying vec3 vWorldPosition;
        void main() {
          vec4 worldPosition = modelMatrix * vec4(position, 1.0);
          vWorldPosition = worldPosition.xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 topColor;
        uniform vec3 bottomColor;
        uniform float offset;
        uniform float exponent;
        varying vec3 vWorldPosition;
        void main() {
          float h = normalize(vWorldPosition + offset).y;
          gl_FragColor = vec4(mix(bottomColor, topColor, max(pow(max(h, 0.0), exponent), 0.0)), 1.0);
        }
      `,
      side: THREE.BackSide,
    });
    const sky = new THREE.Mesh(skyGeo, skyMat);
    this.scene.add(sky);
  }

  /**
   * 地面
   */
  private createGround(): void {
    const groundGeo = new THREE.CircleGeometry(300, 64);
    const groundMat = new THREE.MeshStandardMaterial({
      color: 0x4a7c3f,
      roughness: 0.95,
      metalness: 0.0,
    });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    // 中心圆形跑道区域（深灰色沥青）
    const trackGeo = new THREE.RingGeometry(28, 44, 64);
    const trackMat = new THREE.MeshStandardMaterial({
      color: 0x3a3a3a,
      roughness: 0.9,
      metalness: 0.05,
    });
    const track = new THREE.Mesh(trackGeo, trackMat);
    track.rotation.x = -Math.PI / 2;
    track.position.y = 0.01;
    track.receiveShadow = true;
    this.scene.add(track);

    // 赛道中心线（白色虚线）
    const centerLineGeo = new THREE.RingGeometry(36.9, 37.1, 64);
    const centerLineMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.4 });
    const centerLine = new THREE.Mesh(centerLineGeo, centerLineMat);
    centerLine.rotation.x = -Math.PI / 2;
    centerLine.position.y = 0.02;
    this.scene.add(centerLine);
  }

  /**
   * 环境装饰：树木（InstancedMesh）和远景山丘
   */
  private createDecorations(): void {
    const treeCount = 50;

    // 预生成树木位置
    this.treePositions = new Float32Array(treeCount * 2);
    const trunkGeo = new THREE.CylinderGeometry(0.15, 0.2, 1.2, 5);
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5d4037, roughness: 0.9 });
    const leavesGeo = new THREE.ConeGeometry(0.8, 2.0, 6);
    const leavesMat = new THREE.MeshStandardMaterial({ color: 0x2e7d32, roughness: 0.8 });

    this.treeTrunks = new THREE.InstancedMesh(trunkGeo, trunkMat, treeCount);
    this.treeLeaves = new THREE.InstancedMesh(leavesGeo, leavesMat, treeCount);
    this.treeTrunks.castShadow = false;
    this.treeLeaves.castShadow = false;

    const dummy = new THREE.Object3D();

    for (let i = 0; i < treeCount; i++) {
      const angle = Math.random() * Math.PI * 2;
      const dist = 55 + Math.random() * 130;
      const x = Math.sin(angle) * dist;
      const z = Math.cos(angle) * dist;
      const s = 0.8 + Math.random() * 1.2;

      this.treePositions[i * 2] = x;
      this.treePositions[i * 2 + 1] = z;

      // 树干
      dummy.position.set(x, 0.6 * s, z);
      dummy.scale.setScalar(s);
      dummy.updateMatrix();
      this.treeTrunks.setMatrixAt(i, dummy.matrix);

      // 树叶
      dummy.position.set(x, 2.0 * s, z);
      dummy.scale.setScalar(s);
      dummy.updateMatrix();
      this.treeLeaves.setMatrixAt(i, dummy.matrix);
    }

    this.treeTrunks.instanceMatrix.needsUpdate = true;
    this.treeLeaves.instanceMatrix.needsUpdate = true;
    this.scene.add(this.treeTrunks);
    this.scene.add(this.treeLeaves);

    // 远景山丘（静态，不需要每帧更新）
    const hillMat = new THREE.MeshStandardMaterial({ color: 0x5d8a4e, roughness: 1.0 });
    for (let i = 0; i < 6; i++) {
      const angle = (i / 6) * Math.PI * 2 + Math.random() * 0.3;
      const dist = 250;
      const hillGeo = new THREE.ConeGeometry(50, 30, 6);
      const hill = new THREE.Mesh(hillGeo, hillMat);
      hill.position.set(Math.sin(angle) * dist, 0, Math.cos(angle) * dist);
      this.scene.add(hill);
    }
  }

  /**
   * 创建车辆模型（金属车漆效果）
   */
  private createCarModel(): THREE.Group {
    const car = new THREE.Group();

    // 车漆材质：clearcoat 模拟金属漆
    const paintMat = new THREE.MeshPhysicalMaterial({
      color: 0xd32f2f,
      metalness: 0.8,
      roughness: 0.25,
      clearcoat: 1.0,
      clearcoatRoughness: 0.1,
    });

    const glassMat = new THREE.MeshPhysicalMaterial({
      color: 0x88ccee,
      metalness: 0.0,
      roughness: 0.05,
      transmission: 0.9,
      transparent: true,
      opacity: 0.4,
    });

    const darkMat = new THREE.MeshStandardMaterial({
      color: 0x1a1a1a,
      roughness: 0.6,
      metalness: 0.3,
    });

    // 车身下半部分
    const lowerBody = new THREE.Mesh(
      new THREE.BoxGeometry(1.9, 0.45, 4.4),
      paintMat
    );
    lowerBody.position.y = 0.55;
    lowerBody.castShadow = true;
    car.add(lowerBody);

    // 车身上半部分（驾驶舱）
    const upperBody = new THREE.Mesh(
      new THREE.BoxGeometry(1.65, 0.55, 2.2),
      paintMat
    );
    upperBody.position.set(0, 1.05, -0.3);
    upperBody.castShadow = true;
    car.add(upperBody);

    // 挡风玻璃（斜面前窗）
    const windshield = new THREE.Mesh(
      new THREE.BoxGeometry(1.55, 0.5, 0.06),
      glassMat
    );
    windshield.position.set(0, 1.05, 0.85);
    windshield.rotation.x = -0.35;
    car.add(windshield);

    // 后窗
    const rearWindow = new THREE.Mesh(
      new THREE.BoxGeometry(1.55, 0.5, 0.06),
      glassMat
    );
    rearWindow.position.set(0, 1.05, -1.35);
    rearWindow.rotation.x = 0.3;
    car.add(rearWindow);

    // 侧窗
    const sideWindowGeo = new THREE.BoxGeometry(0.04, 0.4, 1.5);
    const sideWindowL = new THREE.Mesh(sideWindowGeo, glassMat);
    sideWindowL.position.set(-0.83, 1.08, -0.3);
    car.add(sideWindowL);
    const sideWindowR = new THREE.Mesh(sideWindowGeo, glassMat);
    sideWindowR.position.set(0.83, 1.08, -0.3);
    car.add(sideWindowR);

    // 车轮
    const tireGeo = new THREE.CylinderGeometry(0.36, 0.36, 0.28, 20);
    const tireMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9 });
    const rimGeo = new THREE.CylinderGeometry(0.2, 0.2, 0.3, 12);
    const rimMat = new THREE.MeshStandardMaterial({ color: 0xcccccc, metalness: 0.9, roughness: 0.2 });

    const wheelPositions = [
      { x: -0.95, z: 1.4, front: true },
      { x: 0.95, z: 1.4, front: true },
      { x: -0.95, z: -1.4, front: false },
      { x: 0.95, z: -1.4, front: false },
    ];

    for (const pos of wheelPositions) {
      // 轮胎
      const tire = new THREE.Mesh(tireGeo, tireMat);
      tire.rotation.z = Math.PI / 2;
      tire.position.set(pos.x, 0.36, pos.z);
      tire.castShadow = true;
      car.add(tire);
      this.wheelMeshes.push(tire);
      if (pos.front) this.frontWheels.push(tire);

      // 轮毂
      const rim = new THREE.Mesh(rimGeo, rimMat);
      rim.rotation.z = Math.PI / 2;
      rim.position.set(pos.x, 0.36, pos.z);
      car.add(rim);
    }

    // 车头灯（发光）
    const headlightMat = new THREE.MeshStandardMaterial({
      color: 0xffffee,
      emissive: 0xfff8cc,
      emissiveIntensity: 1.5,
    });
    const headlightGeo = new THREE.BoxGeometry(0.35, 0.12, 0.08);
    const hl = new THREE.Mesh(headlightGeo, headlightMat);
    hl.position.set(-0.6, 0.55, 2.22);
    car.add(hl);
    const hr = new THREE.Mesh(headlightGeo, headlightMat);
    hr.position.set(0.6, 0.55, 2.22);
    car.add(hr);

    // 尾灯
    const taillightMat = new THREE.MeshStandardMaterial({
      color: 0xff0000,
      emissive: 0xff0000,
      emissiveIntensity: 0.8,
    });
    const tl = new THREE.Mesh(headlightGeo, taillightMat);
    tl.position.set(-0.6, 0.55, -2.22);
    car.add(tl);
    const tr = new THREE.Mesh(headlightGeo, taillightMat);
    tr.position.set(0.6, 0.55, -2.22);
    car.add(tr);

    // 前保险杠
    const bumper = new THREE.Mesh(
      new THREE.BoxGeometry(1.8, 0.15, 0.15),
      darkMat
    );
    bumper.position.set(0, 0.35, 2.25);
    car.add(bumper);

    return car;
  }

  /**
   * 测试赛道标记（锥桶，InstancedMesh）
   */
  private createTestTrackMarkers(): void {
    const coneCount = 32;
    const coneGeo = new THREE.ConeGeometry(0.35, 0.9, 8);
    const coneMat = new THREE.MeshStandardMaterial({ color: 0xff6f00, roughness: 0.6 });

    this.conePositions = new Float32Array(coneCount * 2);
    this.coneMesh = new THREE.InstancedMesh(coneGeo, coneMat, coneCount);
    this.coneMesh.castShadow = true;

    const dummy = new THREE.Object3D();
    const radius = 40;

    for (let i = 0; i < coneCount; i++) {
      const angle = (i / coneCount) * Math.PI * 2;
      const x = Math.sin(angle) * radius;
      const z = Math.cos(angle) * radius;
      this.conePositions[i * 2] = x;
      this.conePositions[i * 2 + 1] = z;

      dummy.position.set(x, 0.45, z);
      dummy.updateMatrix();
      this.coneMesh.setMatrixAt(i, dummy.matrix);
    }

    this.coneMesh.instanceMatrix.needsUpdate = true;
    this.scene.add(this.coneMesh);
  }

  /**
   * 根据车辆物理状态更新车辆模型和距离剔除
   */
  updateCar(state: CarState): void {
    this.carGroup.position.set(state.x, state.y, state.z);
    this.carGroup.rotation.y = state.heading;

    // 前轮转向动画
    for (const wheel of this.frontWheels) {
      wheel.rotation.y = state.steerAngle;
    }

    // 距离剔除：只渲染附近的树木和锥桶
    this.updateCulling(state.x, state.z);
  }

  /**
   * 距离剔除：远处的物体不渲染（只在车辆移动一定距离后更新）
   */
  private updateCulling(carX: number, carZ: number): void {
    // 只在移动超过阈值时才更新
    const dx = carX - this.lastCullX;
    const dz = carZ - this.lastCullZ;
    if (dx * dx + dz * dz < this.cullThreshold * this.cullThreshold) return;
    this.lastCullX = carX;
    this.lastCullZ = carZ;

    const dummy = new THREE.Object3D();

    // 树木：100米外不渲染
    if (this.treeTrunks && this.treeLeaves) {
      const treeVisibleDist = 100;
      const treeCount = this.treePositions.length / 2;
      for (let i = 0; i < treeCount; i++) {
        const dx = this.treePositions[i * 2] - carX;
        const dz = this.treePositions[i * 2 + 1] - carZ;
        const distSq = dx * dx + dz * dz;

        if (distSq < treeVisibleDist * treeVisibleDist) {
          const s = 1.0; // 保持原始缩放
          dummy.position.set(this.treePositions[i * 2], 0.6, this.treePositions[i * 2 + 1]);
          dummy.scale.setScalar(s);
          dummy.updateMatrix();
          this.treeTrunks.setMatrixAt(i, dummy.matrix);

          dummy.position.y = 2.0;
          dummy.updateMatrix();
          this.treeLeaves.setMatrixAt(i, dummy.matrix);
        } else {
          // 缩放到0
          dummy.position.set(0, -100, 0);
          dummy.scale.setScalar(0);
          dummy.updateMatrix();
          this.treeTrunks.setMatrixAt(i, dummy.matrix);
          this.treeLeaves.setMatrixAt(i, dummy.matrix);
        }
      }
      this.treeTrunks.instanceMatrix.needsUpdate = true;
      this.treeLeaves.instanceMatrix.needsUpdate = true;
    }

    // 锥桶：60米外不渲染
    if (this.coneMesh) {
      const coneVisibleDist = 60;
      const coneCount = this.conePositions.length / 2;
      for (let i = 0; i < coneCount; i++) {
        const dx = this.conePositions[i * 2] - carX;
        const dz = this.conePositions[i * 2 + 1] - carZ;
        const distSq = dx * dx + dz * dz;

        if (distSq < coneVisibleDist * coneVisibleDist) {
          dummy.position.set(this.conePositions[i * 2], 0.45, this.conePositions[i * 2 + 1]);
          dummy.scale.setScalar(1);
        } else {
          dummy.position.set(0, -100, 0);
          dummy.scale.setScalar(0);
        }
        dummy.updateMatrix();
        this.coneMesh.setMatrixAt(i, dummy.matrix);
      }
      this.coneMesh.instanceMatrix.needsUpdate = true;
    }
  }

  /**
   * 销毁场景资源
   */
  dispose(): void {
    this.scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        if (Array.isArray(obj.material)) {
          obj.material.forEach((m) => m.dispose());
        } else {
          obj.material.dispose();
        }
      }
    });
  }
}
