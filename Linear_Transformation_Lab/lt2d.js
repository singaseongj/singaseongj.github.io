// Linear_Transformation_Lab/lt2d.js
// 2D Linear Transformation Lab (standalone, safe to load with <script defer>)

(() => {
  'use strict';

  // ===== helpers =====
  const $ = (id) => document.getElementById(id);
  const q = (sel) => document.querySelector(sel);
  const fmt = (n) => Math.round(n * 1000) / 1000;

  // ===== state =====
  let canvas, ctx;
  let DPR = 1, CW = 0, CH = 0;      // device pixel ratio & CSS canvas size

  // grid/scales
  let scale = 70;        // px per grid unit (visible)
  let scaleunit = 1;     // value per grid cell
  let absscale = 70;     // px per "1" in world coordinates
  const scalefactor = 2; // grid unit change factor
  const factor = 1.10;   // zoom multiplier per wheel step

  // labels & axes
  const labelgap = 4;
  const axisnum = 20;
  const maxaxisnum = 16;
  const minaxisnum = 4;

  // vector & basis (2D)
  let vi = 1, vj = 2;
  let ivector = [1, 0];
  let jvector = [0, 1];

  // animation (2D basis tween)
  let igole = [0, -1];
  let jgole = [0, -1];
  let animatetimes = 500;

  // ===== sizing & drawing =====
  function sizingCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = window.innerWidth - 205;
    const cssHeight = window.innerHeight - 50;
    canvas.style.width = cssWidth + 'px';
    canvas.style.height = cssHeight + 'px';
    canvas.width = Math.floor(cssWidth * dpr);
    canvas.height = Math.floor(cssHeight * dpr);
    DPR = dpr; CW = cssWidth; CH = cssHeight;
    if (ctx.resetTransform) ctx.resetTransform();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function drawPlane() {
    ctx.fillStyle = "#202020";
    ctx.fillRect(0, 0, CW, CH);
  }

  function drawMainXAxis(){
    const diagonal = Math.hypot(CW, CH);
    const ivangle = (Math.atan2(ivector[1], ivector[0]) / Math.PI + 2) % 2;
    const iscale = Math.hypot(ivector[0], ivector[1]);

    ctx.beginPath();
    ctx.moveTo(CW/2 + Math.cos(ivangle*Math.PI)*iscale*diagonal/2,
               CH/2 - Math.sin(ivangle*Math.PI)*iscale*diagonal/2);
    ctx.lineTo(CW/2 - Math.cos(ivangle*Math.PI)*iscale*diagonal/2,
               CH/2 + Math.sin(ivangle*Math.PI)*iscale*diagonal/2);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.font = "10px sans-serif";
    ctx.fillStyle = "white";
    for (let i = -axisnum; i <= axisnum; i++){
      if (i) ctx.fillText(scaleunit*(-i), CW/2 + labelgap, CH/2 + scale*i - labelgap);
    }
  }

  function drawBoldXAxis(){
    ctx.beginPath();
    ctx.moveTo(0, CH/2);
    ctx.lineTo(CW, CH/2);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 0.5;
    ctx.stroke();
  }

  function drawLightXAxis(){
    for (let i = -2*axisnum; i <= 2*axisnum; i++){
      ctx.beginPath();
      ctx.moveTo(0, CH/2 + scale*i*0.5);
      ctx.lineTo(CW, CH/2 + scale*i*0.5);
      ctx.strokeStyle = "rgba(225, 225, 255, 1)";
      ctx.lineWidth = 0.125;
      ctx.stroke();
    }
  }

  function drawMainYAxis(){
    const diagonal = Math.hypot(CW, CH);
    const jvangle = (Math.atan2(jvector[1], jvector[0]) / Math.PI + 2) % 2;
    const jscale = Math.hypot(jvector[0], jvector[1]);

    ctx.beginPath();
    ctx.moveTo(CW/2 + Math.cos(jvangle*Math.PI)*jscale*diagonal/2,
               CH/2 - Math.sin(jvangle*Math.PI)*jscale*diagonal/2);
    ctx.lineTo(CW/2 - Math.cos(jvangle*Math.PI)*jscale*diagonal/2,
               CH/2 + Math.sin(jvangle*Math.PI)*jscale*diagonal/2);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.font = "10px sans-serif";
    ctx.fillStyle = "white";
    for (let i = -axisnum; i <= axisnum; i++){
      if (i) ctx.fillText(scaleunit*i, CW/2 + scale*i + labelgap, CH/2 - labelgap);
    }
  }

  function drawBoldYAxis(){
    ctx.beginPath();
    ctx.moveTo(CW/2, 0);
    ctx.lineTo(CW/2, CH);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 0.5;
    ctx.stroke();
  }

  function drawLightYAxis(){
    for (let i = -2*axisnum; i <= 2*axisnum; i++){
      ctx.beginPath();
      ctx.moveTo(CW/2 + scale*i*0.5, 0);
      ctx.lineTo(CW/2 + scale*i*0.5, CH);
      ctx.strokeStyle = "rgba(225, 225, 255, 1)";
      ctx.lineWidth = 0.125;
      ctx.stroke();
    }
  }

  function drawOrigin(){
    ctx.font = "10px sans-serif";
    ctx.fillStyle = "white";
    ctx.fillText(0, CW/2 + labelgap, CH/2 - labelgap);

    ctx.beginPath();
    ctx.arc(CW/2, CH/2, 2.25, 0, Math.PI * 2);
    ctx.fillStyle = "#ff8000";
    ctx.fill();
  }

  function drawPoint(){
    ctx.beginPath();
    ctx.arc(CW/2 + absscale*(vi*ivector[0] + vj*jvector[0]),
            CH/2 - absscale*(vi*ivector[1] + vj*jvector[1]),
            2.25, 0, Math.PI * 2);
    ctx.fillStyle = "#ff8000";
    ctx.fill();
  }

  function drawVector(){
    ctx.beginPath();
    ctx.moveTo(CW/2, CH/2);
    ctx.lineTo(CW/2 + absscale*(vi*ivector[0] + vj*jvector[0]),
               CH/2 - absscale*(vi*ivector[1] + vj*jvector[1]));
    ctx.strokeStyle = "#ff8000";
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  function drawIvectorPoint(){
    ctx.beginPath();
    ctx.arc(CW/2 + absscale*ivector[0], CH/2 - absscale*ivector[1], 2.25, 0, Math.PI * 2);
    ctx.fillStyle = "#ff6868";
    ctx.fill();
  }

  function drawIVector(){
    ctx.beginPath();
    ctx.moveTo(CW/2, CH/2);
    ctx.lineTo(CW/2 + absscale*ivector[0], CH/2 - absscale*ivector[1]);
    ctx.strokeStyle = "#ff6868";
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  function drawJvectorPoint(){
    ctx.beginPath();
    ctx.arc(CW/2 + absscale*jvector[0], CH/2 - absscale*jvector[1], 2.25, 0, Math.PI * 2);
    ctx.fillStyle = "#68ff68";
    ctx.fill();
  }

  function drawJVector(){
    ctx.beginPath();
    ctx.moveTo(CW/2, CH/2);
    ctx.lineTo(CW/2 + absscale*jvector[0], CH/2 - absscale*jvector[1]);
    ctx.strokeStyle = "#68ff68";
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  function drawMovingYAxis(){
    const diagonal = Math.hypot(CW, CH);
    const ivangle = (Math.atan2(ivector[1], ivector[0]) / Math.PI + 2) % 2;
    const jvangle = (Math.atan2(jvector[1], jvector[0]) / Math.PI + 2) % 2;
    const iscale = Math.hypot(ivector[0], ivector[1]);
    const jscale = Math.hypot(jvector[0], jvector[1]);

    let movingyaxisnum = 1;
    if (jvangle % 1 === 0.5){
      if (ivangle % 1 !== 0.5){
        movingyaxisnum = Math.floor(Math.abs((CW/2) / (Math.cos(ivangle*Math.PI) * scale * iscale)));
      } else movingyaxisnum = 1;
    } else if (jvangle % 1 === 0){
      if (ivangle % 1 !== 0){
        movingyaxisnum = Math.floor(Math.abs((CH/2) / (Math.sin(ivangle*Math.PI) * scale * iscale)));
      } else movingyaxisnum = 1;
    } else {
      const tanAngle = Math.tan(jvangle * Math.PI);
      movingyaxisnum = Math.floor((Math.abs((CH/2)/tanAngle) + CW/2) / scale);
    }

    for (let i = -Math.abs(movingyaxisnum); i <= Math.abs(movingyaxisnum); i++){
      if (i){
        ctx.beginPath();
        ctx.moveTo(
          CW/2 + Math.cos(ivangle*Math.PI)*scale*iscale*i + Math.cos(jvangle*Math.PI)*jscale*diagonal/2,
          CH/2 - Math.sin(ivangle*Math.PI)*scale*iscale*i - Math.sin(jvangle*Math.PI)*jscale*diagonal/2
        );
        ctx.lineTo(
          CW/2 + Math.cos(ivangle*Math.PI)*scale*iscale*i - Math.cos(jvangle*Math.PI)*jscale*diagonal/2,
          CH/2 - Math.sin(ivangle*Math.PI)*scale*iscale*i + Math.sin(jvangle*Math.PI)*jscale*diagonal/2
        );
        ctx.strokeStyle = "#4868ff";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
  }

  function drawMovingXAxis(){
    const diagonal = Math.hypot(CW, CH);
    const ivangle = (Math.atan2(ivector[1], ivector[0]) / Math.PI + 2) % 2;
    const jvangle = (Math.atan2(jvector[1], jvector[0]) / Math.PI + 2) % 2;
    const iscale = Math.hypot(ivector[0], ivector[1]);
    const jscale = Math.hypot(jvector[0], jvector[1]);

    let movingxaxisnum = 1;
    if (ivangle % 1 === 0.5){
      if (jvangle % 1 !== 0.5){
        movingxaxisnum = Math.floor(Math.abs((CW/2) / (Math.cos(jvangle*Math.PI) * scale * jscale)));
      } else movingxaxisnum = 1;
    } else if (ivangle % 1 === 0){
      if (jvangle % 1 !== 0){
        movingxaxisnum = Math.floor(Math.abs((CH/2) / (Math.sin(jvangle*Math.PI) * scale * jscale)));
      } else movingxaxisnum = 1;
    } else {
      const tanAngle = Math.tan(ivangle * Math.PI);
      movingxaxisnum = Math.floor((Math.abs((CW/2)*tanAngle) + CH/2) / scale);
    }

    for (let i = -Math.abs(movingxaxisnum); i <= Math.abs(movingxaxisnum); i++){
      if (i){
        ctx.beginPath();
        ctx.moveTo(
          CW/2 + Math.cos(jvangle*Math.PI)*scale*jscale*i + Math.cos(ivangle*Math.PI)*iscale*diagonal/2,
          CH/2 - Math.sin(jvangle*Math.PI)*jscale*scale*i - Math.sin(ivangle*Math.PI)*iscale*diagonal/2
        );
        ctx.lineTo(
          CW/2 + Math.cos(jvangle*Math.PI)*scale*jscale*i - Math.cos(ivangle*Math.PI)*iscale*diagonal/2,
          CH/2 - Math.sin(jvangle*Math.PI)*jscale*scale*i + Math.sin(ivangle*Math.PI)*iscale*diagonal/2
        );
        ctx.strokeStyle = "#4868ff";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
  }

  // ===== zoom & rescale (with crisp 0.5-grid snapping) =====
  function sizingPlane(dir){
    if (dir < 0){ // wheel up -> zoom in
      if (absscale < 700000) absscale *= factor;
    } else if (dir > 0){ // wheel down -> zoom out
      absscale /= factor;
    }
    scale = absscale * scaleunit;
  }

  function scalingPlane(){
    // adjust grid unit so a reasonable number of lines stay visible
    if (scale * maxaxisnum < (CW/2)) scaleunit *= scalefactor;
    if (scale * minaxisnum > (CW/2)) scaleunit /= scalefactor;

    // recompute & snap so half-grid lands on integer pixels
    scale = absscale * scaleunit;
    const half = Math.round(scale * 0.5);
    scale = half * 2;
  }

  // ===== math helpers & UI =====
  function basisMatrix(){
    return [[ivector[0], jvector[0]],[ivector[1], jvector[1]]];
  }

  function invert2x2(M){
    const [a,b] = M[0], [c,d] = M[1];
    const det = a*d - b*c;
    if (Math.abs(det) < 1e-12) return null;
    return [[ d/det, -b/det],[-c/det,  a/det]];
  }

  function mulMatVec(A, v){
    return [
      A[0][0]*v[0] + A[0][1]*v[1],
      A[1][0]*v[0] + A[1][1]*v[1]
    ];
  }

  function readMatrix(){
    const a11 = parseFloat($('a11')?.value) || 0;
    const a12 = parseFloat($('a12')?.value) || 0;
    const a21 = parseFloat($('a21')?.value) || 0;
    const a22 = parseFloat($('a22')?.value) || 0;
    return [[a11,a12],[a21,a22]];
  }

  function fitToView(){
    const center = 0.45 * Math.min(CW, CH);
    const vAbs = [
      vi*ivector[0] + vj*jvector[0],
      vi*ivector[1] + vj*jvector[1]
    ];
    const maxR = Math.max(
      Math.hypot(ivector[0], ivector[1]),
      Math.hypot(jvector[0], jvector[1]),
      Math.hypot(vAbs[0],   vAbs[1]),
      1
    );
    absscale = center / maxR;
    scale = absscale * scaleunit;
    handleResize();
  }

  function updateLabels(){
    const vBox = q('.vector');
    const iBox = q('.unitvectori');
    const jBox = q('.unitvectorj');
    if (vBox) vBox.innerHTML = `\\(\\vec{v}=${fmt(vi)}\\hat{i}+${fmt(vj)}\\hat{j}\\)`;
    if (iBox) iBox.innerHTML = `\\(\\hat{i}=(${fmt(ivector[0])},\\,${fmt(ivector[1])})\\)`;
    if (jBox) jBox.innerHTML = `\\(\\hat{j}=(${fmt(jvector[0])},\\,${fmt(jvector[1])})\\)`;
    if (window.MathJax && MathJax.typeset) MathJax.typeset();
  }

  // ===== redraw =====
  function handleResize() {
    sizingCanvas();
    drawPlane();

    drawLightYAxis();
    drawLightXAxis();

    drawBoldYAxis();
    drawBoldXAxis();

    drawMainYAxis();
    drawMainXAxis();

    drawOrigin();

    drawMovingYAxis();
    drawMovingXAxis();

    drawPoint();
    drawVector();
    drawIvectorPoint();
    drawJvectorPoint();
    drawIVector();
    drawJVector();
  }

  // ===== animation (2D basis tween) =====
  function animateVector(){
    let aigoleangle = (Math.atan2(igole[1], igole[0]) / Math.PI - 2) % 2;
    let aiangle     = (Math.atan2(ivector[1], ivector[0]) / Math.PI - 2) % 2;
    let aidiffangle = aigoleangle - aiangle;
    let aigolesize  = Math.hypot(igole[0], igole[1]);
    let aisize      = Math.hypot(ivector[0], ivector[1]);
    let aidiffsize  = aigolesize - aisize;

    let ajgoleangle = (Math.atan2(jgole[1], jgole[0]) / Math.PI - 2) % 2;
    let ajangle     = (Math.atan2(jvector[1], jvector[0]) / Math.PI - 2) % 2;
    let ajdiffangle = ajgoleangle - ajangle;
    let ajgolesize  = Math.hypot(jgole[0], jgole[1]);
    let ajsize      = Math.hypot(jvector[0], jvector[1]);
    let ajdiffsize  = ajgolesize - ajsize;

    if (aidiffangle > 1) aidiffangle -= 2;
    else if (aidiffangle < -1) aidiffangle += 2;
    if (ajdiffangle > 1) ajdiffangle -= 2;
    else if (ajdiffangle < -1) ajdiffangle += 2;

    if (animatetimes > 0){
      aiangle += aidiffangle/64;
      aisize  += aidiffsize/64;
      ivector = [Math.cos(aiangle*Math.PI)*aisize, Math.sin(aiangle*Math.PI)*aisize];

      ajangle += ajdiffangle/64;
      ajsize  += ajdiffsize/64;
      jvector = [Math.cos(ajangle*Math.PI)*ajsize, Math.sin(ajangle*Math.PI)*ajsize];

      animatetimes -= 1;
      handleResize();
      requestAnimationFrame(animateVector);
    } else {
      ivector = igole;
      jvector = jgole;
      animatetimes = 500;
      handleResize();
    }
  }

  // ===== events =====
  function onWheel(event){
    event.preventDefault();
    event.stopPropagation();
    const dir = Math.sign(event.deltaY); // normalize trackpads/mice
    if (dir === 0) return;
    sizingPlane(dir);
    scalingPlane();
    handleResize();
  }

  function onCanvasClick(e){
    const clickSetEl = $('clickSet');
    if (!clickSetEl || !clickSetEl.checked) return;

    const rect = canvas.getBoundingClientRect();
    const xpx = e.clientX - rect.left - CW/2;
    const ypx = CH/2 - (e.clientY - rect.top);
    const X = xpx / absscale;
    const Y = ypx / absscale;

    const B = basisMatrix();
    const Binv = invert2x2(B);
    if (!Binv){
      alert('기저가 퇴화하여 v를 계산할 수 없습니다.');
      return;
    }
    vi = Binv[0][0]*X + Binv[0][1]*Y;
    vj = Binv[1][0]*X + Binv[1][1]*Y;
    setInputsFromVector();
    handleResize();
  }

  function setVectorFromInputs(){
    vi = parseFloat($('vi_in')?.value) || 0;
    vj = parseFloat($('vj_in')?.value) || 0;
    if ($('vi_slider')) $('vi_slider').value = vi;
    if ($('vj_slider')) $('vj_slider').value = vj;
    handleResize();
    updateLabels();
  }

  function setInputsFromVector(){
    if ($('vi_in')) $('vi_in').value = vi;
    if ($('vj_in')) $('vj_in').value = vj;
    if ($('vi_slider')) $('vi_slider').value = vi;
    if ($('vj_slider')) $('vj_slider').value = vj;
    updateLabels();
  }

  function setVectorFromSliders(){
    vi = parseFloat($('vi_slider')?.value) || 0;
    vj = parseFloat($('vj_slider')?.value) || 0;
    if ($('vi_in')) $('vi_in').value = vi;
    if ($('vj_in')) $('vj_in').value = vj;
    handleResize();
    updateLabels();
  }

  function fitToViewClick(){
    fitToView();
  }

  function applyAClick(){
    const A = readMatrix();
    igole = [A[0][0], A[1][0]];
    jgole = [A[0][1], A[1][1]];
    animateVector();
    updateLabels();
  }

  function composeAClick(){
    const A = readMatrix();
    igole = mulMatVec(A, ivector);
    jgole = mulMatVec(A, jvector);
    animateVector();
    updateLabels();
  }

  function resetAllClick(){
    // reset scales
    scale = 70; scaleunit = 1; absscale = 70;
    // reset basis & vector
    ivector = [1,0]; jvector = [0,1]; vi = 1; vj = 2;
    // reset A inputs
    if ($('a11')) { $('a11').value = 1; $('a12').value = 0; $('a21').value = 0; $('a22').value = 1; }
    setInputsFromVector();
    scalingPlane();
    handleResize();
  }

  function onKeydown(e){
    const step = (e.shiftKey ? 1 : 0.25);
    if (e.key === 'ArrowLeft') vi -= step;
    if (e.key === 'ArrowRight') vi += step;
    if (e.key === 'ArrowDown') vj -= step;
    if (e.key === 'ArrowUp') vj += step;
    if (['ArrowLeft','ArrowRight','ArrowDown','ArrowUp'].includes(e.key)){
      setInputsFromVector();
      handleResize();
      e.preventDefault();
    }
  }

  // ===== init =====
  function init(){
    canvas = $('graph');
    if (!canvas) return console.error('[lt2d] #graph canvas not found');
    ctx = canvas.getContext('2d');

    // initial draw
    handleResize();

    // listeners
    window.addEventListener('resize', handleResize);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('click', onCanvasClick);

    $('vi_in')?.addEventListener('input', setVectorFromInputs);
    $('vj_in')?.addEventListener('input', setVectorFromInputs);
    $('vi_slider')?.addEventListener('input', setVectorFromSliders);
    $('vj_slider')?.addEventListener('input', setVectorFromSliders);

    $('applyA')?.addEventListener('click', applyAClick);
    $('composeA')?.addEventListener('click', composeAClick);
    $('fitView')?.addEventListener('click', fitToViewClick);
    $('resetAll')?.addEventListener('click', resetAllClick);

    window.addEventListener('keydown', onKeydown);

    updateLabels();
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', init);
  } else {
    init(); // safe because we recommend <script defer>
  }
})();
