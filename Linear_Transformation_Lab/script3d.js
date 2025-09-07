const a11=document.getElementById('a11'),a12=document.getElementById('a12'),a13=document.getElementById('a13'),
      a21=document.getElementById('a21'),a22=document.getElementById('a22'),a23=document.getElementById('a23'),
      a31=document.getElementById('a31'),a32=document.getElementById('a32'),a33=document.getElementById('a33'),
      vx=document.getElementById('vx'),vy=document.getElementById('vy'),vz=document.getElementById('vz'),
      vx_val=document.getElementById('vx_val'),vy_val=document.getElementById('vy_val'),vz_val=document.getElementById('vz_val'),
      applyBtn=document.getElementById('apply'),resetBtn=document.getElementById('reset');

const viewer = document.getElementById('viewer');
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
const renderer = new THREE.WebGLRenderer({ antialias: true });
viewer.appendChild(renderer.domElement);

const controls = new THREE.OrbitControls(camera, renderer.domElement);
camera.position.set(5, 5, 5);
controls.update();

const axes = new THREE.AxesHelper(5);
scene.add(axes);

let vecArrow = null;
let resultArrow = null;

function resize() {
  const w = viewer.clientWidth;
  const h = viewer.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

function getMatrix() {
  return [
    [parseFloat(a11.value) || 0, parseFloat(a12.value) || 0, parseFloat(a13.value) || 0],
    [parseFloat(a21.value) || 0, parseFloat(a22.value) || 0, parseFloat(a23.value) || 0],
    [parseFloat(a31.value) || 0, parseFloat(a32.value) || 0, parseFloat(a33.value) || 0]
  ];
}

function getVector() {
  return new THREE.Vector3(parseFloat(vx.value), parseFloat(vy.value), parseFloat(vz.value));
}

function drawVector() {
  if (vecArrow) scene.remove(vecArrow);
  const v = getVector();
  vecArrow = new THREE.ArrowHelper(v.clone().normalize(), new THREE.Vector3(), v.length(), 0x00ffff);
  scene.add(vecArrow);
}

drawVector();

function applyTransform() {
  if (resultArrow) scene.remove(resultArrow);
  const A = getMatrix();
  const v = getVector();
  const r = new THREE.Vector3(
    A[0][0]*v.x + A[0][1]*v.y + A[0][2]*v.z,
    A[1][0]*v.x + A[1][1]*v.y + A[1][2]*v.z,
    A[2][0]*v.x + A[2][1]*v.y + A[2][2]*v.z
  );
  resultArrow = new THREE.ArrowHelper(r.clone().normalize(), new THREE.Vector3(), r.length(), 0xff0000);
  scene.add(resultArrow);
  document.getElementById('result').innerHTML = `\\(\\vec{v}' = (${r.x.toFixed(2)}, ${r.y.toFixed(2)}, ${r.z.toFixed(2)})\\)`;
  if (window.MathJax) MathJax.typesetPromise();
}

function resetAll() {
  a11.value = 1; a12.value = 0; a13.value = 0;
  a21.value = 0; a22.value = 1; a23.value = 0;
  a31.value = 0; a32.value = 0; a33.value = 1;
  vx.value = 1; vy.value = 1; vz.value = 1;
  vx_val.textContent = vy_val.textContent = vz_val.textContent = '1';
  if (vecArrow) scene.remove(vecArrow);
  if (resultArrow) scene.remove(resultArrow);
  document.getElementById('result').innerHTML = `\\(\\vec{v}' = (0,0,0)\\)`;
  drawVector();
  if (window.MathJax) MathJax.typesetPromise();
}

applyBtn.addEventListener('click', applyTransform);
resetBtn.addEventListener('click', resetAll);

const vectorInputs = [vx, vy, vz];
const labels = [vx_val, vy_val, vz_val];
vectorInputs.forEach((elem, idx) => {
  elem.addEventListener('input', () => {
    labels[idx].textContent = elem.value;
    drawVector();
  });
});

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();
