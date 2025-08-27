//id 가 graph 인 canvas를 저장
const canvas=document.getElementById("graph");
//2d 그림 도구 불러오기
const ctx=canvas.getContext("2d");

let DPR=1, CW=0, CH=0; // device pixel ratio & CSS canvas size

//보이는 격자의 한 변의 길이
let scale=70;
//한 격자가 나타내는 값
let scaleunit=1;
//좌표평면에서 1을 나타내는 가상의 격자의 한 변의 길이
let absscale=70;
//격자 단위 확대 배율
let scalefactor=2;
//확대 배율
let factor=1.10;

//숫자를 좌표축에서 띄우기
let labelgap=4;
//표시할 축 개수
let axisnum=20;
//최대 표시 좌표축+1 값
let maxaxisnum=16;
//최소 표시 좌표축
let minaxisnum=4;

//v 벡터의 i 성분
let vi=1;
//v 벡터의 j 성분
let vj=2;

//i벡터 모습 [x,y]
let ivector=[1,0];
//i벡터 모습 [x,y]
let jvector=[0,1];

//창 크기에 따라 자동으로 사이징
function sizingCanvas(){
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

//좌표평면 채우기
function drawPlane(){
    //배경색
    ctx.fillStyle = "#202020";////////////////////////////////////////////////////////////////////////////////////color
    //채우기
    ctx.fillRect(0, 0, CW, CH);
}

//x축 표시
function drawMainXAxis(){
    let diagonal=((CW)**2+(CH)**2)**(1/2);
    let ivangle=(Math.atan2(ivector[1], ivector[0])/Math.PI+2)%(2);
    let jvangle=(Math.atan2(jvector[1], jvector[0])/Math.PI+2)%(2);
    let iscale=((ivector[0])**2+(ivector[1])**2)**(1/2);
    let jscale=((jvector[0])**2+(jvector[1])**2)**(1/2);
    //새로 시작
    ctx.beginPath();
    //시작점
    ctx.moveTo((CW)/2+Math.cos(ivangle*Math.PI)*iscale*diagonal/2, CH/2-Math.sin(ivangle*Math.PI)*iscale*diagonal/2);
    //끝점
    ctx.lineTo((CW)/2-Math.cos(ivangle*Math.PI)*iscale*diagonal/2, CH/2+Math.sin(ivangle*Math.PI)*iscale*diagonal/2);
    //선 색
    ctx.strokeStyle = "#ffffff";////////////////////////////////////////////////////////////////////////////////////color
    //선 굵기
    ctx.lineWidth = 2;
    //선 그리기
    ctx.stroke();
    //폰트
    ctx.font = "10px sans-serif";
    //글자 색
    ctx.fillStyle = "white";////////////////////////////////////////////////////////////////////////////////////color
    for(let i=-(axisnum);i<=axisnum;i++){
        if(i){
            //숫자 적기
            ctx.fillText(scaleunit*(-i), (CW)/2+labelgap, (CH)/2+scale*i-labelgap);
        }
    }
}

//x축 방향 진하게 표시
function drawBoldXAxis(){
    //x축 방향 축
    for(let i=-(axisnum);i<=axisnum;i++){
        if(i===0){
            //새로 시작
            ctx.beginPath();
            //시작점
            ctx.moveTo(0, (CH)/2+scale*i);
            //끝점
            ctx.lineTo(CW, (CH)/2+scale*i);
            //선 색
            ctx.strokeStyle = "#ffffff";////////////////////////////////////////////////////////////////////////////////////color
            //선 두께
            ctx.lineWidth = 0.5;
            //선 그리기
            ctx.stroke();
        }
    }
}

//x축 방향 연하게 표시
function drawLightXAxis(){
    for(let i=-2*axisnum;i<=2*axisnum;i++){
        //새로 시작
        ctx.beginPath();
        //시작점
        ctx.moveTo(0, (CH)/2+scale*i*0.5);
        //끝점
        ctx.lineTo(CW, (CH)/2+scale*i*0.5);
        //선 색, 투명도
        ctx.strokeStyle = "rgba(225, 225, 255, 1)";////////////////////////////////////////////////////////////////////////////////////color
        //선 두께
        ctx.lineWidth = 0.125;
        //선 그리기
        ctx.stroke();
    }
}

//y축 표시
function drawMainYAxis(){
    let diagonal=((CW)**2+(CH)**2)**(1/2);
    let ivangle=(Math.atan2(ivector[1], ivector[0])/Math.PI+2)%(2);
    let jvangle=(Math.atan2(jvector[1], jvector[0])/Math.PI+2)%(2);
    let iscale=((ivector[0])**2+(ivector[1])**2)**(1/2);
    let jscale=((jvector[0])**2+(jvector[1])**2)**(1/2);
    //새로 시작
    ctx.beginPath();
    //시작점
    ctx.moveTo((CW)/2+Math.cos(jvangle*Math.PI)*jscale*diagonal/2, CH/2-Math.sin(jvangle*Math.PI)*jscale*diagonal/2);
    //끝점
    ctx.lineTo((CW)/2-Math.cos(jvangle*Math.PI)*jscale*diagonal/2, CH/2+Math.sin(jvangle*Math.PI)*jscale*diagonal/2);
    //선 색
    ctx.strokeStyle = "#ffffff";////////////////////////////////////////////////////////////////////////////////////color
    //선 두께
    ctx.lineWidth = 2;
    //선 그리기
    ctx.stroke();
    //폰트
    ctx.font = "10px sans-serif";
    //글자 색
    ctx.fillStyle = "white";////////////////////////////////////////////////////////////////////////////////////color
    for(let i=-(axisnum);i<=axisnum;i++){
        if(i){
            //숫자 적기
            ctx.fillText(scaleunit*i, (CW)/2+scale*i+labelgap, (CH)/2-labelgap);
        }
    }
}

//y축 방향 표시
function drawBoldYAxis(){
    //y방향 축
    for(let i=-(axisnum);i<=axisnum;i++){
        if(i===0){
            //새로 시작
            ctx.beginPath();
            //시작점
            ctx.moveTo((CW)/2+scale*i, 0);
            //끝점
            ctx.lineTo((CW)/2+scale*i, CH);
            //선 색
            ctx.strokeStyle = "#ffffff";////////////////////////////////////////////////////////////////////////////////////color
            //선 두께
            ctx.lineWidth = 0.5;
            //선 그리기
            ctx.stroke();
        }
    }
}

//y축 방향 연하게 표시
function drawLightYAxis(){
    //y방향 축
    for(let i=-2*axisnum;i<=2*axisnum;i++){
        //새로 시작
        ctx.beginPath();
        //시작점
        ctx.moveTo((CW)/2+scale*i*0.5, 0);
        //끝점
        ctx.lineTo((CW)/2+scale*i*0.5, CH);
        //선 색
        ctx.strokeStyle = "rgba(225, 225, 255, 1)";////////////////////////////////////////////////////////////////////////////////////color
        //선 두께
        ctx.lineWidth = 0.125;
        //선 그리기
        ctx.stroke();
    }
}

//원점 표시
function drawOrigin(){
    //폰트
    ctx.font = "10px sans-serif";
    //글자색
    ctx.fillStyle = "white";////////////////////////////////////////////////////////////////////////////////////color
    //원점 숫자
    ctx.fillText(0, (CW)/2+labelgap, (CH)/2-labelgap);

    //새로 시작
    ctx.beginPath();
    //점 위치
    ctx.arc((CW)/2, (CH)/2, 2.25, 0, Math.PI * 2);
    //점 색
    ctx.fillStyle = "#ff8000";////////////////////////////////////////////////////////////////////////////////////color
    //점 그리기
    ctx.fill();
}

//좌표평면 확대, 축소
function sizingPlane(sizing){
    //스크롤 올리면 확대
    if(sizing<0){
        if(absscale<700000){
            absscale*=factor;
        }else{
            console.log("stop!");
        }
    }
    //스크롤 내리면 축소
    else if(sizing>0){
        absscale*=1/factor;
    }
    //스케일 계산
    scale=absscale*scaleunit;
}

//좌표평면 축 스케일 변화
function scalingPlane(){
    //격자 단위 증가
    if(scale*maxaxisnum<(CW/2))scaleunit*=scalefactor;
    //격자 단위 감소
    if(scale*minaxisnum>(CW/2))scaleunit*=1/scalefactor;
}

//종합
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

    drawMovingYAxis();//
    drawMovingXAxis();//

    drawPoint();//
    drawVector();//
    drawIvectorPoint();//
    drawJvectorPoint();//
    drawIVector();//
    drawJVector();//
}

function drawPoint(){
    //새로 시작
    ctx.beginPath();
    //점 위치
    ctx.arc((CW)/2+absscale*(vi*ivector[0]+vj*jvector[0]), (CH)/2-absscale*(vi*ivector[1]+vj*jvector[1]), 2.25, 0, Math.PI * 2);
    //점 색
    ctx.fillStyle = "#ff8000";////////////////////////////////////////////////////////////////////////////////////color
    //점 그리기
    ctx.fill(); 
}

function drawVector(){
    //새로 시작
    ctx.beginPath();
    //시작점
    ctx.moveTo((CW)/2, (CH)/2);
    //끝점
    ctx.lineTo((CW)/2+absscale*(vi*ivector[0]+vj*jvector[0]), (CH)/2-absscale*(vi*ivector[1]+vj*jvector[1]));
    //선 색
    ctx.strokeStyle = "#ff8000";////////////////////////////////////////////////////////////////////////////////////color
    //선 두께
    ctx.lineWidth = 2;
    //선 그리기
    ctx.stroke();
}

function drawMovingYAxis(){
    let diagonal=((CW)**2+(CH)**2)**(1/2);
    let ivangle=(Math.atan2(ivector[1], ivector[0])/Math.PI+2)%(2);
    let jvangle=(Math.atan2(jvector[1], jvector[0])/Math.PI+2)%(2);
    let iscale=((ivector[0])**2+(ivector[1])**2)**(1/2);
    let jscale=((jvector[0])**2+(jvector[1])**2)**(1/2);
    let movingyaxisnum=1;
    if(jvangle%1===1/2){
        if(ivangle%1!=1/2){
            movingyaxisnum=Math.floor(Math.abs((CW/2)/(Math.cos(ivangle*Math.PI)*scale*iscale)));
            console.log("1_11");
        }else{
            movingyaxisnum=1;
            console.log("1_12");
        }
    }else if(jvangle%1===0){
        if(ivangle%1!=0){
            movingyaxisnum=Math.floor(Math.abs((CH/2)/(Math.sin(ivangle*Math.PI)*scale*iscale)));
            console.log("1_21");
        }else{
            movingyaxisnum=1;
            console.log("1_22");
        }
    }else{
        const tanAngle = Math.tan(jvangle*Math.PI);
        movingyaxisnum = Math.floor((Math.abs((CH/2)/tanAngle) + CW/2)/scale);
        console.log("1_31");
    }

    console.log(movingyaxisnum);
    //movingyaxisnum=movingyaxisnum>100?100:movingyaxisnum;

    for(let i=-1*Math.abs(movingyaxisnum);i<=Math.abs(movingyaxisnum);i++){
        if(i){
            //새로 시작
            ctx.beginPath();
            //시작점
            ctx.moveTo((CW)/2+Math.cos(ivangle*Math.PI)*scale*iscale*i+Math.cos(jvangle*Math.PI)*jscale*diagonal/2, CH/2-Math.sin(ivangle*Math.PI)*scale*iscale*i-Math.sin(jvangle*Math.PI)*jscale*diagonal/2);
            //끝점
            ctx.lineTo((CW)/2+Math.cos(ivangle*Math.PI)*scale*iscale*i-Math.cos(jvangle*Math.PI)*jscale*diagonal/2, CH/2-Math.sin(ivangle*Math.PI)*scale*iscale*i+Math.sin(jvangle*Math.PI)*jscale*diagonal/2);
            //선 색
            ctx.strokeStyle = "#4868ff";////////////////////////////////////////////////////////////////////////////////////color
            //선 두께
            ctx.lineWidth = 1.5;
            //선 그리기
            ctx.stroke();
        }
    }
}

function drawMovingXAxis(){
    let diagonal=((CW)**2+(CH)**2)**(1/2);
    let ivangle=(Math.atan2(ivector[1], ivector[0])/Math.PI+2)%(2);
    let jvangle=(Math.atan2(jvector[1], jvector[0])/Math.PI+2)%(2);
    let iscale=((ivector[0])**2+(ivector[1])**2)**(1/2);
    let jscale=((jvector[0])**2+(jvector[1])**2)**(1/2);
    let movingxaxisnum=1;
    if(ivangle%1===1/2){
        if(jvangle%1!=1/2){
            movingxaxisnum=Math.floor(Math.abs((CW/2)/(Math.cos(jvangle*Math.PI)*scale*jscale)));
            console.log("2_11");
        }else{
            movingxaxisnum=1;
            console.log("2_12");
        }
    }else if(ivangle%1===0){
        if(jvangle%1!=0){
            movingxaxisnum=Math.floor(Math.abs((CH/2)/(Math.sin(jvangle*Math.PI)*scale*jscale)));
            console.log("2_21");
        }else{
            movingxaxisnum=1;
            console.log("2_22");
        }
    }else{
        const tanAngle = Math.tan(ivangle*Math.PI);
        movingxaxisnum = Math.floor((Math.abs((CW/2)*tanAngle) + CH/2)/scale);
        console.log("2_31");
    }

    console.log(movingxaxisnum);
    //movingxaxisnum=movingxaxisnum>100?100:movingxaxisnum;

    for(let i=-1*Math.abs(movingxaxisnum);i<=Math.abs(movingxaxisnum);i++){
        if(i){
            //새로 시작
            ctx.beginPath();
            //시작점
            ctx.moveTo((CW)/2+Math.cos(jvangle*Math.PI)*scale*jscale*i+Math.cos(ivangle*Math.PI)*iscale*diagonal/2, CH/2-Math.sin(jvangle*Math.PI)*jscale*scale*i-Math.sin(ivangle*Math.PI)*iscale*diagonal/2);
            //끝점
            ctx.lineTo((CW)/2+Math.cos(jvangle*Math.PI)*scale*jscale*i-Math.cos(ivangle*Math.PI)*iscale*diagonal/2, CH/2-Math.sin(jvangle*Math.PI)*jscale*scale*i+Math.sin(ivangle*Math.PI)*iscale*diagonal/2);
            //선 색
            ctx.strokeStyle = "#4868ff";////////////////////////////////////////////////////////////////////////////////////color
            //선 두께
            ctx.lineWidth = 1.5;
            //선 그리기
            ctx.stroke();
        }
    }
}

function drawIvectorPoint(){
    //새로 시작
    ctx.beginPath();
    //점 위치
    ctx.arc((CW)/2+absscale*ivector[0], (CH)/2-absscale*ivector[1], 2.25, 0, Math.PI * 2);
    //점 색
    ctx.fillStyle = "#ff6868";////////////////////////////////////////////////////////////////////////////////////color
    //점 그리기
    ctx.fill(); 
}

function drawIVector(){
    //새로 시작
    ctx.beginPath();
    //시작점
    ctx.moveTo((CW)/2, (CH)/2);
    //끝점
    ctx.lineTo((CW)/2+absscale*ivector[0], (CH)/2-absscale*ivector[1]);
    //선 색
    ctx.strokeStyle = "#ff6868";////////////////////////////////////////////////////////////////////////////////////color
    //선 두께
    ctx.lineWidth = 2;
    //선 그리기
    ctx.stroke();
}

function drawJvectorPoint(){
    //새로 시작
    ctx.beginPath();
    //점 위치
    ctx.arc((CW)/2+absscale*jvector[0], (CH)/2-absscale*jvector[1], 2.25, 0, Math.PI * 2);
    //점 색
    ctx.fillStyle = "#68ff68";////////////////////////////////////////////////////////////////////////////////////color
    //점 그리기
    ctx.fill(); 
}

function drawJVector(){
    //새로 시작
    ctx.beginPath();
    //시작점
    ctx.moveTo((CW)/2, (CH)/2);
    //끝점
    ctx.lineTo((CW)/2+absscale*jvector[0], (CH)/2-absscale*jvector[1]);
    //선 색
    ctx.strokeStyle = "#68ff68";////////////////////////////////////////////////////////////////////////////////////color
    //선 두께
    ctx.lineWidth = 2;
    //선 그리기
    ctx.stroke();
}


function resetCanvas(){
    //보이는 격자의 한 변의 길이
    scale=70;
    //한 격자가 나타내는 값
    scaleunit=1;
    //좌표평면에서 1을 나타내는 가상의 격자의 한 변의 길이
    absscale=70;
    //격자 단위 확대 배율
    scalefactor=2;
    //확대 배율
    factor=1.10;
    scalingPlane();
    handleResize();
}

let igole=[0,-1];
let jgole=[0,-1];
let aigoleangle=0;
let ajgoleangle=0;
let aiangle=0;
let ajangle=0;
let aidiffangle=0;
let ajdiffangle=0;
let aigolesize=0;
let ajgolesize=0;
let aisize=0;
let ajsize=0;
let aidiffsize=0;
let ajdiffsize=0;
let animatetimes=500;


function animateVector(){
    aigoleangle=(Math.atan2(igole[1],igole[0])/Math.PI-2)%2;
    aiangle=(Math.atan2(ivector[1],ivector[0])/Math.PI-2)%2;
    aidiffangle=aigoleangle-aiangle;
    aigolesize=((igole[0])**2+(igole[1])**2)**(1/2);
    aisize=((ivector[0])**2+(ivector[1])**2)**(1/2);
    aidiffsize=aigolesize-aisize;

    ajgoleangle=(Math.atan2(jgole[1],jgole[0])/Math.PI-2)%2;
    ajangle=(Math.atan2(jvector[1],jvector[0])/Math.PI-2)%2;
    ajdiffangle=ajgoleangle-ajangle;
    ajgolesize=((jgole[0])**2+(jgole[1])**2)**(1/2);
    ajsize=((jvector[0])**2+(jvector[1])**2)**(1/2);
    ajdiffsize=ajgolesize-ajsize;

    if(aidiffangle>1){
        aidiffangle-=2;
    }else if(aidiffangle<-1){
        aidiffangle+=2;
    }
    if(ajdiffangle>1){
        ajdiffangle-=2;
    }else if(ajdiffangle<-1){
        ajdiffangle+=2;
    }

    if (animatetimes>0){
        aiangle+=aidiffangle/64;
        aisize+=aidiffsize/64;
        ivector=[Math.cos(aiangle*Math.PI)*aisize,Math.sin(aiangle*Math.PI)*aisize];

        ajangle+=ajdiffangle/64;
        ajsize+=ajdiffsize/64;
        jvector=[Math.cos(ajangle*Math.PI)*ajsize,Math.sin(ajangle*Math.PI)*ajsize];

        animatetimes-=1;
        handleResize();
        drawIVector();
        drawIvectorPoint();

        drawJVector();
        drawJvectorPoint();

        requestAnimationFrame(animateVector);
    }else{
        ivector=igole;
        jvector=jgole;
        animatetimes=500;
        handleResize();
        drawIVector();
        drawIvectorPoint();
        drawJVector();
        drawJvectorPoint();

        console.log("done");

    }
}

const drawVecor = drawVector; // backward compatibility
const drawIvecor = drawIVector; // backward compatibility
const drawJvecor = drawJVector; // backward compatibility

/////////////////

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

//화면 변화 감지
handleResize();
window.addEventListener("resize", handleResize);

//마우스 휠 감지
canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    sizingPlane(event.deltaY);
    scalingPlane();
    handleResize();
});

// ===== controls & helpers =====
const q = s => document.querySelector(s);
const $ = id => document.getElementById(id);

function fmt(n){ return Math.round(n*1000)/1000; }

function updateLabels(){
  const vBox = document.querySelector('.vector');
  const iBox = document.querySelector('.unitvectori');
  const jBox = document.querySelector('.unitvectorj');
  vBox.innerHTML = `\\(\\vec{v}=${fmt(vi)}\\hat{i}+${fmt(vj)}\\hat{j}\\)`;
  iBox.innerHTML = `\\(\\hat{i}=(${fmt(ivector[0])},\\,${fmt(ivector[1])})\\)`;
  jBox.innerHTML = `\\(\\hat{j}=(${fmt(jvector[0])},\\,${fmt(jvector[1])})\\)`;
  if (window.MathJax && MathJax.typeset) MathJax.typeset();
}

function readMatrix(){
  const a11 = parseFloat($('a11').value) || 0;
  const a12 = parseFloat($('a12').value) || 0;
  const a21 = parseFloat($('a21').value) || 0;
  const a22 = parseFloat($('a22').value) || 0;
  return [[a11,a12],[a21,a22]];
}

function setVectorFromInputs(){
  vi = parseFloat($('vi_in').value) || 0;
  vj = parseFloat($('vj_in').value) || 0;
  handleResize();
  updateLabels();
}

function setInputsFromVector(){
  $('vi_in').value = vi;
  $('vj_in').value = vj;
  updateLabels();
}

function mulMatVec(A, v){
  return [
    A[0][0]*v[0] + A[0][1]*v[1],
    A[1][0]*v[0] + A[1][1]*v[1]
  ];
}

function invert2x2(M){
  const [a,b] = M[0], [c,d] = M[1];
  const det = a*d - b*c;
  if (Math.abs(det) < 1e-12) return null;
  const inv = [[ d/det, -b/det],[-c/det,  a/det]];
  return inv;
}

function basisMatrix(){
  return [[ivector[0], jvector[0]],[ivector[1], jvector[1]]];
}

function fitToView(){
  const w = CW, h = CH;
  const center = 0.45 * Math.min(w, h);
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

$('vi_in').addEventListener('change', setVectorFromInputs);
$('vj_in').addEventListener('change', setVectorFromInputs);

$('applyA').addEventListener('click', () => {
  const A = readMatrix();
  igole = [A[0][0], A[1][0]];
  jgole = [A[0][1], A[1][1]];
  animateVector();
  updateLabels();
});

$('composeA').addEventListener('click', () => {
  const A = readMatrix();
  igole = mulMatVec(A, ivector);
  jgole = mulMatVec(A, jvector);
  animateVector();
  updateLabels();
});

$('fitView').addEventListener('click', fitToView);

$('resetAll').addEventListener('click', () => {
  resetCanvas();
  ivector = [1,0];
  jvector = [0,1];
  vi = 1; vj = 2;
  $('a11').value = 1; $('a12').value = 0;
  $('a21').value = 0; $('a22').value = 1;
  setInputsFromVector();
  handleResize();
});

canvas.addEventListener('click', (e) => {
  if (!$('clickSet').checked) return;
  const rect = canvas.getBoundingClientRect();
  const xpx = e.clientX - rect.left - CW/2;
  const ypx = CH/2 - (e.clientY - rect.top);
  const X = xpx / absscale;
  const Y = ypx / absscale;
  const B = basisMatrix();
  const Binv = invert2x2(B);
  if (!Binv){
    console.warn('기저가 퇴화(Det=0)되어 v를 계산할 수 없음');
    alert('기저가 퇴화하여 v를 계산할 수 없습니다.');
    return;
  }
  vi = Binv[0][0]*X + Binv[0][1]*Y;
  vj = Binv[1][0]*X + Binv[1][1]*Y;
  setInputsFromVector();
  handleResize();
});

window.addEventListener('keydown', (e) => {
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
});

updateLabels();
