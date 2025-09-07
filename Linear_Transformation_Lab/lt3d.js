// Linear_Transformation_Lab/lt3d.js
// 3D Linear Transformation Lab (Three.js) — loads as a module

import * as THREE from 'https://unpkg.com/three@0.161.0/build/three.module.js';
import { OrbitControls } from 'https://unpkg.com/three@0.161.0/examples/jsm/controls/OrbitControls.js';

(() => {
  // ===== DOM helpers =====
  const $ = (id) => document.getElementById(id);
  const q = (sel) => document.querySelector(sel);
  const fmt = (n) => Math.round(n * 1000) / 1000;

  // ===== shared inputs (read from DOM) =====
  // v components (basis coefficients) — only used when mode3d checked
  let vi = 1, vj = 2, vk = 0;

  // basis vectors in R^3
  let ivector = [1, 0, 0];
  let jvector = [0, 1, 0];
  let kvector = [0, 0, 1];

  // three.js objects/state
  const S = {
    ready: false,
    renderer: null,
    camera: null,
    scene: null,
    controls: null,
    iArrow: null,
    jArrow: null,
    kArrow: null,
    vArrow: null,
    gridXY: null, gridXZ: null, gridYZ: null,
    parLine: null, parGeom: null,
    plane: null
  };

  // ===== utilities =====
  const is3D = () => $('mode3d')?.checked;

  function readMatrix3(){
    const v = (id) => parseFloat($(id)?.value) || 0;
    return [
      [v('a11'), v('a12'), v('a13')],
      [v('a21'), v('a22'), v('a23')],
      [v('a31'), v('a32'), v('a33')],
    ];
  }
  function det3(M){
    const [[a,b,c],[d,e,f],[g,h,i]] = M;
    return a*(e*i - f*h) - b*(d*i - f*g) + c*(d*h - e*g);
  }
  function invert3x3(M){
    const [[a,b,c],[d,e,f],[g,h,i]] = M;
    const A =  (e*i - f*h), B = -(d*i - f*g), C =  (d*h - e*g);
    const D = -(b*i - c*h), E =  (a*i - c*g), F = -(a*h - b*g);
    const G =  (b*f - c*e), H = -(a*f - c*d), I =  (a*e - b*d);
    const det = a*A + b*B + c*C;
    if (Math.abs(det) < 1e-12) return null;
    return [
      [A/det, D/det, G/det],
      [B/det, E/det, H/det],
      [C/det, F/det, I/det]
    ];
  }
  function basisMatrix3(){
    return [
      [ivector[0], jvector[0], kvector[0]],
      [ivector[1], jvector[1], kvector[1]],
      [ivector[2], jvector[2], kvector[2]]
    ];
  }

  function updateLabels3D(){
    if (!is3D()) return;

    const iBox = q('.unitvectori');
    const jBox = q('.unitvectorj');
    const kBox = q('.unitvectork');
    const vBox3 = q('.vector3');
    const matB3 = q('.matB3');
    const detB = q('.detB');
    const detA = q('.detA');
    const vol  = q('.vol');

    if (vBox3) vBox3.innerHTML = `\\(\\vec{v}=${fmt(vi)}\\hat{i}+${fmt(vj)}\\hat{j}+${fmt(vk)}\\hat{k}\\)`;
    if (iBox) iBox.innerHTML = `\\(\\hat{i}=(${fmt(ivector[0])},\\,${fmt(ivector[1])},\\,${fmt(ivector[2])})\\)`;
    if (jBox) jBox.innerHTML = `\\(\\hat{j}=(${fmt(jvector[0])},\\,${fmt(jvector[1])},\\,${fmt(jvector[2])})\\)`;
    if (kBox) kBox.innerHTML = `\\(\\hat{k}=(${fmt(kvector[0])},\\,${fmt(kvector[1])},\\,${fmt(kvector[2])})\\)`;
    if (matB3) matB3.innerHTML =
      `\\(B=\\begin{bmatrix}${fmt(ivector[0])}&${fmt(jvector[0])}&${fmt(kvector[0])}\\\\${fmt(ivector[1])}&${fmt(jvector[1])}&${fmt(kvector[1])}\\\\${fmt(ivector[2])}&${fmt(jvector[2])}&${fmt(kvector[2])}\\end{bmatrix}\\)`;

    const A = readMatrix3();
    const dA = det3(A);
    if (detA) detA.innerHTML = `\\(\\det(A)=${fmt(dA)}\\)`;

    const dB = det3(basisMatrix3());
    if (detB) detB.innerHTML = `\\(\\det(B)=${fmt(dB)}\\)`;
    if (vol) vol.innerHTML = `Volume scale \(=|\\det(A)|=${fmt(Math.abs(dA))}\\), orientation: ${dA>=0?'preserved':'reversed'}`;

    const warn = q('.warn');
    if (warn){
      const msgs = [];
      if (Math.abs(dA) < 1e-6) msgs.push('Warning: A is nearly singular (|det(A)| < 1e-6).');
      if (Math.abs(dB) < 1e-6) msgs.push('Warning: Current basis B is nearly singular (|det(B)| < 1e-6).');
      warn.style.display = msgs.length ? 'block' : 'none';
      warn.textContent = msgs.join(' ');
    }

    if (window.MathJax && window.MathJax.typeset) window.MathJax.typeset();
  }

  // ===== scene build =====
  function ensure3D(){
    if (S.ready) return;
    const host = $('scene3d');
    if (!host) return;

    const w = window.innerWidth - 205;
    const h = window.innerHeight - 50;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.setSize(w, h);
    host.innerHTML = '';
    host.appendChild(renderer.domElement);

    const camera = new THREE.PerspectiveCamera(45, w/h, 0.01, 5000);
    camera.position.set(3,3,3);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x202020);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    // lights
    scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const dir = new THREE.DirectionalLight(0xffffff, 0.6);
    dir.position.set(2,3,4);
    scene.add(dir);

    // grids
    const gridSize = 20, divs = 20;
    const gridXY = new THREE.GridHelper(gridSize, divs, 0x808080, 0x404040); // z=0
    const gridXZ = new THREE.GridHelper(gridSize, divs, 0x808080, 0x404040); gridXZ.rotation.x = Math.PI/2;
    const gridYZ = new THREE.GridHelper(gridSize, divs, 0x808080, 0x404040); gridYZ.rotation.z = Math.PI/2;
    scene.add(gridXY, gridXZ, gridYZ);

    // arrows
    function makeArrow(color){ return new THREE.ArrowHelper(new THREE.Vector3(1,0,0), new THREE.Vector3(0,0,0), 1, color, 0.15, 0.07); }
    const iArrow = makeArrow(0xff6868);
    const jArrow = makeArrow(0x68ff68);
    const kArrow = makeArrow(0x4868ff);
    const vArrow = makeArrow(0xff8000);
    scene.add(iArrow, jArrow, kArrow, vArrow);

    // invisible plane for click-to-set v
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(1000, 1000),
      new THREE.MeshBasicMaterial({ visible: false })
    );
    scene.add(plane);

    // parallelepiped wireframe
    const parGeom = new THREE.BufferGeometry();
    const parMat  = new THREE.LineBasicMaterial({ color: 0x99c2ff, transparent: true, opacity: 0.9 });
    const parLine = new THREE.LineSegments(parGeom, parMat);
    scene.add(parLine);

    Object.assign(S, {
      ready: true, renderer, camera, scene, controls,
      iArrow, jArrow, kArrow, vArrow, gridXY, gridXZ, gridYZ, plane, parLine, parGeom
    });

    // render loop
    (function loop(){
      requestAnimationFrame(loop);
      controls.update();
      renderer.render(scene, camera);
    })();

    // click-to-set on selected plane
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    renderer.domElement.addEventListener('click', (ev) => {
      if (!is3D()) return;
      const clickSet = $('clickSet');
      if (!clickSet || !clickSet.checked) return;

      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((ev.clientX - rect.left)/rect.width)*2 - 1;
      mouse.y = -((ev.clientY - rect.top)/rect.height)*2 + 1;
      raycaster.setFromCamera(mouse, camera);

      const sel = ($('planeSel')?.value) || 'XY';
      if (sel==='XY'){ S.plane.rotation.set(0,0,0); }
      if (sel==='XZ'){ S.plane.rotation.set(Math.PI/2,0,0); }
      if (sel==='YZ'){ S.plane.rotation.set(0,Math.PI/2,0); }

      const hit = raycaster.intersectObject(S.plane, false)[0];
      if (!hit) return;
      const p = hit.point;

      // convert world p to basis coords (vi,vj,vk)
      const Binv = invert3x3(basisMatrix3());
      if (!Binv){ alert('기저가 퇴화하여 v를 계산할 수 없습니다.'); return; }
      vi = Binv[0][0]*p.x + Binv[0][1]*p.y + Binv[0][2]*p.z;
      vj = Binv[1][0]*p.x + Binv[1][1]*p.y + Binv[1][2]*p.z;
      vk = Binv[2][0]*p.x + Binv[2][1]*p.y + Binv[2][2]*p.z;

      if ($('vi_in')) $('vi_in').value = vi;
      if ($('vj_in')) $('vj_in').value = vj;
      if ($('vk_in')) $('vk_in').value = vk;

      update3DObjects();
    });

    // resize
    window.addEventListener('resize', () => {
      const w2 = window.innerWidth - 205, h2 = window.innerHeight - 50;
      renderer.setPixelRatio(window.devicePixelRatio||1);
      renderer.setSize(w2,h2);
      camera.aspect = w2/h2;
      camera.updateProjectionMatrix();
    });

    // initial draw
    update3DObjects();
    fitToView3D();
  }

  function setArrow(arr, vx,vy,vz){
    const len = Math.max(1e-6, Math.hypot(vx,vy,vz));
    const dir = new THREE.Vector3(vx/len, vy/len, vz/len);
    arr.setDirection(dir);
    arr.setLength(len, Math.min(0.2*len, 0.4), Math.min(0.12*len, 0.25));
  }

  function updateParallelepiped(){
    if (!S.ready) return;
    const show = $('showPar')?.checked;
    S.parLine.visible = !!show;
    if (!show) return;

    const I = ivector, J = jvector, K = kvector;
    const add = (a,b)=>[a[0]+b[0], a[1]+b[1], a[2]+b[2]];
    const O = [0,0,0], IJ=add(I,J), IK=add(I,K), JK=add(J,K), IJK=add(IJ,K);

    // edges
    const edges = [
      O,I,  O,J,  O,K,
      I,IJ, I,IK,
      J,IJ, J,JK,
      K,IK, K,JK,
      IJ,IJK, IK,IJK, JK,IJK
    ];
    const pos = new Float32Array(edges.length*3);
    for (let e=0; e<edges.length; e++){
      const p = edges[e];
      pos[3*e+0] = p[0];
      pos[3*e+1] = p[1];
      pos[3*e+2] = p[2];
    }
    S.parGeom.setAttribute('position', new THREE.BufferAttribute(pos,3));
    S.parGeom.computeBoundingSphere();
  }

  function update3DObjects(){
    if (!S.ready) return;
    setArrow(S.iArrow, ivector[0], ivector[1], ivector[2]);
    setArrow(S.jArrow, jvector[0], jvector[1], jvector[2]);
    setArrow(S.kArrow, kvector[0], kvector[1], kvector[2]);

    const vx = vi*ivector[0] + vj*jvector[0] + vk*kvector[0];
    const vy = vi*ivector[1] + vj*jvector[1] + vk*kvector[1];
    const vz = vi*ivector[2] + vj*jvector[2] + vk*kvector[2];
    setArrow(S.vArrow, vx, vy, vz);

    updateParallelepiped();
    updateLabels3D();
  }

  function fitToView3D(){
    if (!S.ready) return;
    const I = ivector, J = jvector, K = kvector;
    const add = (a,b)=>[a[0]+b[0], a[1]+b[1], a[2]+b[2]];
    const pts = [ I, J, K, add(I,J), add(I,K), add(J,K), add(add(I,J),K) ];
    const vAbs = [
      vi*I[0] + vj*J[0] + vk*K[0],
      vi*I[1] + vj*J[1] + vk*K[1],
      vi*I[2] + vj*J[2] + vk*K[2],
    ];
    pts.push(vAbs);
    const maxR = Math.max(1, ...pts.map(p => Math.hypot(p[0],p[1],p[2])));
    const cam = S.camera, controls = S.controls;
    const fov = cam.fov * Math.PI/180;
    const dist = maxR / Math.sin(fov/2) * 1.3;
    cam.position.set(dist, dist, dist);
    controls.target.set(0,0,0);
    cam.lookAt(0,0,0);
    cam.updateProjectionMatrix();
  }

  // ===== animations for basis under A =====
  let goalI=null, goalJ=null, goalK=null, steps=0;
  function animateBasis3D(){
    if (!goalI || !goalJ || !goalK){ update3DObjects(); return; }
    steps = 64;
    const startI = [...ivector];
    const startJ = [...jvector];
    const startK = [...kvector];

    (function step(){
      if (steps <= 0){
        ivector = goalI; jvector = goalJ; kvector = goalK;
        goalI = goalJ = goalK = null;
        update3DObjects();
        return;
      }
      const t = 1 - (steps/64);
      const lerp = (a,b)=>a+(b-a)*t;
      ivector = [lerp(startI[0],goalI[0]), lerp(startI[1],goalI[1]), lerp(startI[2],goalI[2])];
      jvector = [lerp(startJ[0],goalJ[0]), lerp(startJ[1],goalJ[1]), lerp(startJ[2],goalJ[2])];
      kvector = [lerp(startK[0],goalK[0]), lerp(startK[1],goalK[1]), lerp(startK[2],goalK[2])];
      steps--;
      update3DObjects();
      requestAnimationFrame(step);
    })();
  }

  // ===== event handlers (only act in 3D mode) =====
  function onVectorInputs(){
    if (!is3D()) return;
    vi = parseFloat($('vi_in')?.value) || 0;
    vj = parseFloat($('vj_in')?.value) || 0;
    vk = parseFloat($('vk_in')?.value) || 0;
    if ($('vi_slider')) $('vi_slider').value = vi;
    if ($('vj_slider')) $('vj_slider').value = vj;
    if ($('vk_slider')) $('vk_slider').value = vk;
    update3DObjects();
  }

  function onVectorSliders(){
    if (!is3D()) return;
    vi = parseFloat($('vi_slider')?.value) || 0;
    vj = parseFloat($('vj_slider')?.value) || 0;
    vk = parseFloat($('vk_slider')?.value) || 0;
    if ($('vi_in')) $('vi_in').value = vi;
    if ($('vj_in')) $('vj_in').value = vj;
    if ($('vk_in')) $('vk_in').value = vk;
    update3DObjects();
  }
  function onApplyA(){
    if (!is3D()) return;
    const A = readMatrix3();
    goalI = [A[0][0], A[1][0], A[2][0]];
    goalJ = [A[0][1], A[1][1], A[2][1]];
    goalK = [A[0][2], A[1][2], A[2][2]];
    animateBasis3D();
  }
  function onComposeA(){
    if (!is3D()) return;
    const A = readMatrix3();
    const mul = (M, v) => [ M[0][0]*v[0]+M[0][1]*v[1]+M[0][2]*v[2],
                            M[1][0]*v[0]+M[1][1]*v[1]+M[1][2]*v[2],
                            M[2][0]*v[0]+M[2][1]*v[1]+M[2][2]*v[2] ];
    goalI = mul(A, ivector);
    goalJ = mul(A, jvector);
    goalK = mul(A, kvector);
    animateBasis3D();
  }
  function onFit(){
    if (!is3D()) return;
    fitToView3D();
  }
  function onReset(){
    if (!is3D()) return;
    ivector=[1,0,0]; jvector=[0,1,0]; kvector=[0,0,1];
    vi=1; vj=2; vk=0;
    if ($('vi_in')) $('vi_in').value = vi;
    if ($('vj_in')) $('vj_in').value = vj;
    if ($('vk_in')) $('vk_in').value = vk;
    if ($('vi_slider')) $('vi_slider').value = vi;
    if ($('vj_slider')) $('vj_slider').value = vj;
    if ($('vk_slider')) $('vk_slider').value = vk;
    // reset A to identity
    ['a11','a22','a33'].forEach(id => { if ($(id)) $(id).value = 1; });
    ['a12','a13','a21','a23','a31','a32'].forEach(id => { if ($(id)) $(id).value = 0; });
    update3DObjects();
    fitToView3D();
  }

  function onShowParToggle(){
    if (!is3D()) return;
    updateParallelepiped();
  }
  function onPlaneHotkeys(e){
    if (!is3D()) return;
    if (e.key==='1') $('planeSel').value='XY';
    if (e.key==='2') $('planeSel').value='XZ';
    if (e.key==='3') $('planeSel').value='YZ';
    if (e.key==='PageUp'){ $('vk_in').value = (parseFloat($('vk_in').value)||0) + (e.shiftKey?1:0.25); onVectorInputs(); }
    if (e.key==='PageDown'){ $('vk_in').value = (parseFloat($('vk_in').value)||0) - (e.shiftKey?1:0.25); onVectorInputs(); }
  }

  // ===== mode toggling (2D/3D) =====
  function applyModeVisibility(){
    const threeHost = $('scene3d');
    const canvas2d = $('graph');
    const show3D = is3D();
    if (threeHost) threeHost.style.display = show3D ? 'block' : 'none';
    if (canvas2d)  canvas2d.style.display  = show3D ? 'none'  : 'block';
    // toggle 3D-only rows
    document.querySelectorAll('.dim3d').forEach(el => el.style.display = show3D ? '' : 'none');
    const grid = $('matrixGrid');
    if (grid) grid.style.gridTemplateColumns = show3D ? 'repeat(3,64px)' : 'repeat(2,64px)';
  }

  function onModeChange(){
    applyModeVisibility();
    if (is3D()){
      ensure3D();
      update3DObjects();
      fitToView3D();
    }
  }

  // ===== init =====
  function init(){
    // wire controls (safe even if elements are missing)
    $('vi_in')?.addEventListener('input', onVectorInputs);
    $('vj_in')?.addEventListener('input', onVectorInputs);
    $('vk_in')?.addEventListener('input', onVectorInputs);
    $('vi_slider')?.addEventListener('input', onVectorSliders);
    $('vj_slider')?.addEventListener('input', onVectorSliders);
    $('vk_slider')?.addEventListener('input', onVectorSliders);

    $('applyA')?.addEventListener('click', onApplyA);
    $('composeA')?.addEventListener('click', onComposeA);
    $('fitView')?.addEventListener('click', onFit);
    $('resetAll')?.addEventListener('click', onReset);

    $('showPar')?.addEventListener('change', onShowParToggle);
    window.addEventListener('keydown', onPlaneHotkeys);

    $('mode2d')?.addEventListener('change', onModeChange);
    $('mode3d')?.addEventListener('change', onModeChange);

    // initial visibility
    applyModeVisibility();
    if (is3D()){
      ensure3D();
      update3DObjects();
      fitToView3D();
    }
  }

  if (document.readyState === 'loading'){
    window.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
