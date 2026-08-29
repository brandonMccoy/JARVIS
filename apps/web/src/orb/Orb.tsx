import { Canvas, useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { store } from "../state/store.ts";
import { getLevel } from "../voice/audio.ts";

/**
 * The orb (PLAN §5). Everything animated lives in refs and is driven from
 * useFrame; nothing here re-renders React per frame (JOBS J1.7).
 */
const NODE_COUNT = 220;
const K = 3;
const CYAN = new THREE.Color("#38bdf8");
const CYAN_SOFT = new THREE.Color("#7dd3fc");
const GOLD = new THREE.Color("#e0b14c");
const WHITE = new THREE.Color("#e6f6ff");
const REDUCED = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
/** Orb sits above the HUD/dock. */
const ORB_Y = 0.8;

function fibonacciSphere(n: number): Float32Array {
  const pts = new Float32Array(n * 3);
  const phi = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const t = phi * i;
    pts[i * 3] = Math.cos(t) * r;
    pts[i * 3 + 1] = y;
    pts[i * 3 + 2] = Math.sin(t) * r;
  }
  return pts;
}

function knnEdges(pts: Float32Array, n: number, k: number): Float32Array {
  const pairs = new Set<string>();
  const out: number[] = [];
  for (let a = 0; a < n; a++) {
    const d: [number, number][] = [];
    for (let b = 0; b < n; b++) {
      if (a === b) continue;
      const dx = pts[a * 3]! - pts[b * 3]!;
      const dy = pts[a * 3 + 1]! - pts[b * 3 + 1]!;
      const dz = pts[a * 3 + 2]! - pts[b * 3 + 2]!;
      d.push([dx * dx + dy * dy + dz * dz, b]);
    }
    d.sort((p, q) => p[0] - q[0]);
    for (let i = 0; i < k; i++) {
      const b = d[i]![1];
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      if (pairs.has(key)) continue;
      pairs.add(key);
      out.push(pts[a * 3]!, pts[a * 3 + 1]!, pts[a * 3 + 2]!, pts[b * 3]!, pts[b * 3 + 1]!, pts[b * 3 + 2]!);
    }
  }
  return new Float32Array(out);
}

function glowTexture(): THREE.Texture {
  const size = 256;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.18, "rgba(255,255,255,0.6)");
  grad.addColorStop(0.45, "rgba(255,255,255,0.16)");
  grad.addColorStop(0.75, "rgba(255,255,255,0.04)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

interface Visual {
  core: number; // emissive intensity
  glow: number; // sprite scale factor
  edge: number; // edge opacity
  fire: number; // neuron firing rate
  ring: number; // screen ring opacity
  hue: THREE.Color;
  spin: number;
}

function NeuralOrb({ onClick }: { onClick: () => void }) {
  const group = useRef<THREE.Group>(null);
  const nodes = useRef<THREE.InstancedMesh>(null);
  const edgeMat = useRef<THREE.LineBasicMaterial>(null);
  const coreMat = useRef<THREE.MeshStandardMaterial>(null);
  const glowInner = useRef<THREE.Sprite>(null);
  const glowOuter = useRef<THREE.Sprite>(null);
  const ring = useRef<THREE.Mesh>(null);
  const ringMat = useRef<THREE.MeshBasicMaterial>(null);
  const nodeMat = useRef<THREE.MeshBasicMaterial>(null);

  const points = useMemo(() => fibonacciSphere(NODE_COUNT), []);
  const edges = useMemo(() => knnEdges(points, NODE_COUNT, K), [points]);
  const phases = useMemo(() => Float32Array.from({ length: NODE_COUNT }, () => Math.random() * Math.PI * 2), []);
  const tex = useMemo(() => glowTexture(), []);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const cur = useRef<Visual>({ core: 0.6, glow: 1, edge: 0.3, fire: 0.3, ring: 0, hue: CYAN.clone(), spin: 0.0015 });
  const tmpColor = useMemo(() => new THREE.Color(), []);

  useFrame((state, delta) => {
    const t = state.clock.elapsedTime;
    const { activity, screen, micOpen, awake } = store.getState();
    const level = getLevel();
    const breathe = 0.5 + 0.5 * Math.sin(t * 1.4);

    // --- targets from state -------------------------------------------------
    let target: Visual;
    const kind = micOpen && activity.kind === "idle" ? "listening" : activity.kind;
    switch (kind) {
      case "listening":
        target = { core: 0.95 + 0.35 * (0.5 + 0.5 * Math.sin(t * 3.2)), glow: 1.15, edge: 0.45, fire: 0.6, ring: 0, hue: CYAN_SOFT, spin: 0.002 };
        break;
      case "thinking":
        target = { core: 1.15 + 0.12 * Math.sin(t * 11), glow: 1.25, edge: 0.55, fire: 1.6, ring: 0, hue: CYAN, spin: 0.0035 };
        break;
      case "researching":
        target = { core: 1.1 + 0.15 * Math.sin(t * 6), glow: 1.3, edge: 0.6 + 0.25 * Math.sin(t * 4), fire: 1.2, ring: 0, hue: CYAN, spin: 0.004 };
        break;
      case "tool":
      case "awaiting_confirmation":
        target = { core: 1.0 + 0.1 * breathe, glow: 1.2, edge: 0.5, fire: 0.9, ring: 0, hue: GOLD, spin: 0.002 };
        break;
      case "viewing_screen":
        target = { core: 1.05, glow: 1.2, edge: 0.5, fire: 0.8, ring: 1, hue: CYAN, spin: 0.002 };
        break;
      case "speaking":
        target = { core: 0.9 + level * 2.6, glow: 1.1 + level * 1.4, edge: 0.4 + level * 0.6, fire: 0.5 + level * 1.5, ring: 0, hue: CYAN, spin: 0.002 };
        break;
      default:
        target = { core: awake ? 0.55 + 0.2 * breathe : 0.35 + 0.1 * breathe, glow: 0.95 + 0.08 * breathe, edge: 0.3, fire: 0.3, ring: 0, hue: CYAN, spin: 0.0015 };
    }
    if (screen.active) target.ring = Math.max(target.ring, 0.55);

    // --- lerp ---------------------------------------------------------------
    const c = cur.current;
    const a = Math.min(1, delta * (kind === "speaking" ? 18 : 6));
    c.core += (target.core - c.core) * a;
    c.glow += (target.glow - c.glow) * a;
    c.edge += (target.edge - c.edge) * a;
    c.fire += (target.fire - c.fire) * a;
    c.ring += (target.ring - c.ring) * Math.min(1, delta * 4);
    c.hue.lerp(target.hue, Math.min(1, delta * 3));
    c.spin += (target.spin - c.spin) * Math.min(1, delta * 2);

    // --- apply --------------------------------------------------------------
    if (group.current) {
      if (!REDUCED) {
        group.current.rotation.y += c.spin * 60 * delta;
        group.current.rotation.x = 0.18 + Math.sin(t * 0.35) * 0.08;
        group.current.position.y = ORB_Y + Math.sin(t * 0.8) * 0.05;
      }
    }
    if (coreMat.current) {
      coreMat.current.emissive.copy(c.hue);
      coreMat.current.emissiveIntensity = c.core;
    }
    if (glowInner.current) {
      glowInner.current.scale.setScalar(1.15 * c.glow);
      const m = glowInner.current.material as THREE.SpriteMaterial;
      m.color.copy(c.hue);
      m.opacity = Math.min(1, 0.5 * c.core);
    }
    if (glowOuter.current) {
      glowOuter.current.scale.setScalar(3.2 * c.glow);
      const m = glowOuter.current.material as THREE.SpriteMaterial;
      m.color.copy(c.hue);
      m.opacity = Math.min(0.7, 0.26 * c.core);
    }
    if (edgeMat.current) {
      edgeMat.current.color.copy(tmpColor.copy(c.hue).lerp(WHITE, 0.15));
      edgeMat.current.opacity = Math.min(1, c.edge);
    }
    if (nodeMat.current) nodeMat.current.color.copy(tmpColor.copy(c.hue).lerp(WHITE, 0.5));
    if (ringMat.current) ringMat.current.opacity = c.ring;
    if (ring.current) ring.current.rotation.z = t * 0.3;

    if (nodes.current) {
      const fire = c.fire;
      for (let i = 0; i < NODE_COUNT; i++) {
        const pulse = Math.max(0, Math.sin(t * (1.5 + fire * 2.5) + phases[i]!));
        const spark = pulse > 0.92 ? (pulse - 0.92) * 12 : 0;
        const s = 1 + spark * (0.6 + fire) + (kind === "speaking" ? level * 0.6 : 0);
        dummy.position.set(points[i * 3]!, points[i * 3 + 1]!, points[i * 3 + 2]!);
        dummy.scale.setScalar(s);
        dummy.updateMatrix();
        nodes.current.setMatrixAt(i, dummy.matrix);
      }
      nodes.current.instanceMatrix.needsUpdate = true;
    }
  });

  return (
    <group ref={group} position={[0, ORB_Y, 0]} onClick={onClick}>
      {/* invisible hit sphere so clicks register anywhere on the orb */}
      <mesh>
        <sphereGeometry args={[1.05, 16, 16]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>

      <mesh>
        <sphereGeometry args={[0.42, 48, 48]} />
        <meshStandardMaterial ref={coreMat} color="#04101c" emissive="#38bdf8" emissiveIntensity={0.6} roughness={0.5} metalness={0.05} toneMapped={false} />
      </mesh>

      {/* Glow halos are drawn after everything with depth testing off so the core lights the lattice from inside. */}
      <sprite ref={glowInner} renderOrder={20}>
        <spriteMaterial map={tex} transparent blending={THREE.AdditiveBlending} depthWrite={false} depthTest={false} toneMapped={false} />
      </sprite>
      <sprite ref={glowOuter} renderOrder={21}>
        <spriteMaterial map={tex} transparent blending={THREE.AdditiveBlending} depthWrite={false} depthTest={false} toneMapped={false} />
      </sprite>

      <lineSegments>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[edges, 3]} />
        </bufferGeometry>
        <lineBasicMaterial ref={edgeMat} color="#38bdf8" transparent opacity={0.3} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </lineSegments>

      <instancedMesh ref={nodes} args={[undefined, undefined, NODE_COUNT]}>
        <sphereGeometry args={[0.016, 8, 8]} />
        <meshBasicMaterial ref={nodeMat} color="#bde9ff" toneMapped={false} />
      </instancedMesh>

      <mesh>
        <sphereGeometry args={[1.03, 48, 48]} />
        <meshBasicMaterial color="#38bdf8" transparent opacity={0.035} side={THREE.BackSide} depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>

      <mesh ref={ring} rotation={[Math.PI / 2.4, 0, 0]}>
        <torusGeometry args={[1.28, 0.008, 8, 128]} />
        <meshBasicMaterial ref={ringMat} color="#7dd3fc" transparent opacity={0} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </mesh>
    </group>
  );
}

export function Orb({ onClick }: { onClick: () => void }) {
  return (
    <div className="orb-stage" aria-hidden="true">
      <Canvas
        dpr={[1, 1.5]}
        camera={{ position: [0, 0.2, 6.4], fov: 42 }}
        gl={{ alpha: true, antialias: true, powerPreference: "high-performance" }}
        onCreated={({ gl }) => gl.setClearColor(0x000000, 0)}
      >
        <ambientLight intensity={0.35} />
        <pointLight position={[3, 3, 4]} intensity={6} color="#9fdcff" />
        <NeuralOrb onClick={onClick} />
      </Canvas>
    </div>
  );
}
