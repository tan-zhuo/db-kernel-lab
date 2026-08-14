import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Grid, OrbitControls } from '@react-three/drei';
import { PALETTE, layoutTree, type TreeLayout } from '@dbkl/visualization';
import { useLabState, useSimStore } from '@/state/store';
import { BTreeView } from './BTreeView';
import { BufferPoolView, bufferPoolExtent } from './BufferPoolView';

/** 供「导出截图」使用的渲染器引用（在 Canvas 内部登记）。 */
let glRef: THREE.WebGLRenderer | null = null;

export function captureScreenshot(): string | null {
  if (!glRef) return null;
  return glRef.domElement.toDataURL('image/png');
}

export function SceneRoot() {
  return (
    <Canvas
      dpr={[1, 2]}
      gl={{ antialias: true, preserveDrawingBuffer: true }}
      camera={{ position: [0, 7, 26], fov: 45, near: 0.1, far: 800 }}
      onCreated={({ gl }) => {
        glRef = gl;
      }}
    >
      <color attach="background" args={[PALETTE.background]} />
      <ambientLight intensity={0.75} />
      <hemisphereLight args={['#8ab4ff', '#0a0f1a', 0.6]} />
      <directionalLight position={[14, 26, 18]} intensity={1.1} />
      <directionalLight position={[-18, 10, -12]} intensity={0.35} color="#7c5cff" />
      <SceneContent />
      <Grid
        position={[0, -1.6, 0]}
        args={[200, 200]}
        cellSize={2}
        cellThickness={0.6}
        cellColor={PALETTE.grid}
        sectionSize={10}
        sectionThickness={1}
        sectionColor="#1d2a44"
        fadeDistance={90}
        fadeStrength={1.4}
        infiniteGrid
      />
      <OrbitControls makeDefault enableDamping dampingFactor={0.12} maxPolarAngle={Math.PI * 0.495} />
    </Canvas>
  );
}

function SceneContent() {
  const state = useLabState();
  const showBufferPool = useSimStore((s) => s.showBufferPool);
  // 布局只算一次，B+ 树视图与缓冲池视图共用（缓冲池要按树的包围盒定位）。
  const layout = useMemo(() => layoutTree(state), [state, state.appliedSeq, state.config]);

  // 「适应视图」要把缓冲池面板也框进来，否则它会长期停在画面之外。
  const bounds = useMemo(() => {
    const b = { ...layout.bounds };
    if (!showBufferPool) return b;
    const bp = bufferPoolExtent(layout, state.buffer.frames.length);
    return {
      minX: Math.min(b.minX, bp.minX),
      maxX: Math.max(b.maxX, bp.maxX),
      minY: Math.min(b.minY, bp.minY),
      maxY: Math.max(b.maxY, bp.maxY),
    };
  }, [layout, showBufferPool, state.buffer.frames.length]);

  // 雾必须跟着场景尺度走：索引变多之后树会横向铺开很远，
  // 固定的雾距会把整个森林都吃掉（画面全黑）。
  const span = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, 40);

  return (
    <>
      <fog attach="fog" args={[PALETTE.background, span * 0.9, span * 3.6]} />
      <BTreeView layout={layout} />
      {showBufferPool && <BufferPoolView layout={layout} />}
      <CameraRig layout={layout} bounds={bounds} />
    </>
  );
}

/** OrbitControls 的最小接口（避免直接依赖 drei 的间接依赖 three-stdlib）。 */
interface OrbitLike {
  target: THREE.Vector3;
  update: () => void;
}

const tmpTarget = new THREE.Vector3();
const tmpPos = new THREE.Vector3();

/**
 * 相机控制：
 *  - 选中页 + 按 F → 平滑飞入该页；
 *  - 「适应视图」→ 根据整棵树的包围盒退到合适距离。
 */
function CameraRig({ layout, bounds }: { layout: TreeLayout; bounds: TreeLayout['bounds'] }) {
  const focusNonce = useSimStore((s) => s.focusNonce);
  const selectedPageId = useSimStore((s) => s.selectedPageId);
  const controls = useThree((s) => s.controls) as unknown as OrbitLike | null;
  const camera = useThree((s) => s.camera);
  const goal = useRef<{ target: THREE.Vector3; position: THREE.Vector3 } | null>(null);

  useEffect(() => {
    if (focusNonce === 0) return;
    const node = selectedPageId !== null ? layout.byId.get(selectedPageId) : undefined;
    if (node) {
      goal.current = {
        target: new THREE.Vector3(node.x, node.y, node.z),
        position: new THREE.Vector3(node.x, node.y + 2.4, node.z + 7.5),
      };
    } else {
      const { minX, maxX, minY, maxY } = bounds;
      const margin = 2.5;
      const width = Math.max(maxX - minX, 6) + margin * 2;
      const height = Math.max(maxY - minY, 4) + margin * 2;
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      // 按透视相机的 fov / aspect 反推刚好装下包围盒的距离。
      const perspective = camera as THREE.PerspectiveCamera;
      const halfFov = ((perspective.fov ?? 45) * Math.PI) / 360;
      const distH = height / 2 / Math.tan(halfFov);
      const distW = width / 2 / (Math.tan(halfFov) * (perspective.aspect || 1.6));
      const dist = Math.min(Math.max(distH, distW, 12) * 1.05, 600);
      goal.current = {
        target: new THREE.Vector3(cx, cy, 0),
        position: new THREE.Vector3(cx, cy + dist * 0.22, dist),
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusNonce]);

  useFrame((_, delta) => {
    if (!goal.current || !controls) return;
    const alpha = 1 - Math.exp(-6 * delta);
    tmpTarget.copy(controls.target).lerp(goal.current.target, alpha);
    tmpPos.copy(camera.position).lerp(goal.current.position, alpha);
    controls.target.copy(tmpTarget);
    camera.position.copy(tmpPos);
    controls.update();
    if (tmpPos.distanceTo(goal.current.position) < 0.05) goal.current = null;
  });

  return null;
}
