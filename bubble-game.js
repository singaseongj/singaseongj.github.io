// Bubble Pop Game Code
let canvas, ctx;
let bubbles = [];
let gameRunning = false;
let startTime, elapsedTime = 0;
let score = 0;
let animationId;
let leaderboard = [];
let bubblesPopped = 0;
let totalBubbles = 16;

// Google Apps Script URL for leaderboard
const GOOGLE_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwJx6EV1f8kgXKhElSJE4wMMAOq7hMDGw47H5asfSTeXIWt6jR9ETjJR5wepGZz2dqw/exec';

// Initialize game elements
window.onload = function() {
    canvas = document.getElementById('gameCanvas');
    ctx = canvas.getContext('2d');

    // Set canvas size dynamically
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    fetchLeaderboard();
    setupEventListeners();
};

function resizeCanvas() {
    const gameScreen = document.getElementById('gameScreen');
    const screenWidth = gameScreen.offsetWidth;

    if (window.innerWidth <= 480) {
        canvas.width = screenWidth - 4;
        canvas.height = 300;
    } else if (window.innerWidth <= 768) {
        canvas.width = screenWidth - 4;
        canvas.height = 350;
    } else {
        canvas.width = Math.min(screenWidth - 4, 600);
        canvas.height = 400;
    }
}

function setupEventListeners() {
    // Remove existing event listeners
    canvas.removeEventListener('touchstart', handleTouch);
    canvas.removeEventListener('touchmove', preventScroll);
    canvas.removeEventListener('click', handleClick);

    // Touch events for mobile
    canvas.addEventListener('touchstart', handleTouch, { passive: false });
    canvas.addEventListener('touchmove', preventScroll, { passive: false });

    // Mouse events for desktop
    canvas.addEventListener('click', handleClick);
}

function preventScroll(e) { e.preventDefault(); }

function handleTouch(e) {
    e.preventDefault();
    if (!gameRunning) return;

    const rect = canvas.getBoundingClientRect();
    const touch = e.touches[0];
    const x = (touch.clientX - rect.left) * (canvas.width / rect.width);
    const y = (touch.clientY - rect.top) * (canvas.height / rect.height);

    checkBubbleClick(x, y);
}

function handleClick(e) {
    if (!gameRunning) return;

    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (canvas.width / rect.width);
    const y = (e.clientY - rect.top) * (canvas.height / rect.height);

    checkBubbleClick(x, y);
}

function checkBubbleClick(x, y) {
    for (let i = bubbles.length - 1; i >= 0; i--) {
        const bubble = bubbles[i];
        const distance = Math.sqrt((x - bubble.x) ** 2 + (y - bubble.y) ** 2);

        if (distance < bubble.radius) {
            popBubble(i, x, y);
            break;
        }
    }
}

function popBubble(index, x, y) {
    const bubble = bubbles[index];
    const sizeBonus = Math.round(100 / bubble.radius * 10);
    score += sizeBonus;

    createPopEffect(bubble.x, bubble.y, bubble.color);

    bubbles.splice(index, 1);
    bubblesPopped++;

    updateStats();

    if (bubbles.length === 0) {
        gameOver();
    }
}

function createPopEffect(x, y, color) {
    for (let i = 0; i < 8; i++) {
        const particle = document.createElement('div');
        particle.className = 'particle';
        particle.style.left = x + 'px';
        particle.style.top = y + 'px';
        particle.style.background = color;
        particle.style.width = '6px';
        particle.style.height = '6px';

        const angle = (i / 8) * Math.PI * 2;
        const distance = 30 + Math.random() * 20;
        particle.style.transform = `translate(${Math.cos(angle) * distance}px, ${Math.sin(angle) * distance}px)`;

        canvas.parentElement.appendChild(particle);

        setTimeout(() => {
            if (particle.parentElement) {
                particle.parentElement.removeChild(particle);
            }
        }, 1000);
    }
}

function createBubble(x, y, size) {
    const colors = [
        '#ff6b6b', '#4ecdc4', '#45b7d1', '#96ceb4', '#feca57',
        '#ff9ff3', '#54a0ff', '#5f27cd', '#00d2d3', '#ff9f43',
        '#48dbfb', '#0abde3', '#ee5a24', '#009432', '#006ba6'
    ];
    return {
        x, y, radius: size,
        color: colors[Math.floor(Math.random() * colors.length)],
        vx: (Math.random() - 0.5) * 1.5,
        vy: (Math.random() - 0.5) * 1.5,
        floatOffset: Math.random() * Math.PI * 2,
        floatSpeed: 0.02 + Math.random() * 0.02
    };
}

function startGame() {
    document.getElementById('gameMenu').style.display = 'none';
    canvas.style.display = 'block';
    document.getElementById('gameStats').style.display = 'flex';
    document.getElementById('gameBackBtn').style.display = 'block';

    bubbles = [];
    score = 0;
    bubblesPopped = 0;
    gameRunning = true;
    startTime = Date.now();

    const bubbleSizes = [
        20, 25, 30, 20, 35, 25, 40, 30,
        20, 25, 20, 35, 25, 30, 20, 25
    ];

    for (let i = 0; i < totalBubbles; i++) {
        let x, y, attempts = 0;
        const radius = bubbleSizes[i];

        do {
            x = radius + Math.random() * (canvas.width - radius * 2);
            y = radius + Math.random() * (canvas.height - radius * 2);
            attempts++;
        } while (attempts < 50 && bubbles.some(bubble => {
            const distance = Math.sqrt((x - bubble.x) ** 2 + (y - bubble.y) ** 2);
            return distance < radius + bubble.radius + 10;
        }));

        bubbles.push(createBubble(x, y, radius));
    }

    updateStats();
    gameLoop();
}

function goBackToMenu() {
    gameRunning = false;
    if (animationId) cancelAnimationFrame(animationId);

    document.getElementById('gameCanvas').style.display = 'none';
    document.getElementById('gameStats').style.display = 'none';
    document.getElementById('gameBackBtn').style.display = 'none';
    document.getElementById('gameOver').style.display = 'none';

    document.getElementById('gameMenu').style.display = 'block';
}

function updateBubbles() {
    bubbles.forEach(bubble => {
        bubble.floatOffset += bubble.floatSpeed;
        bubble.x += Math.sin(bubble.floatOffset) * 0.5;
        bubble.y += Math.cos(bubble.floatOffset * 0.7) * 0.3;

        bubble.x += bubble.vx * 0.3;
        bubble.y += bubble.vy * 0.3;

        if (bubble.x - bubble.radius < 0 || bubble.x + bubble.radius > canvas.width) bubble.vx *= -1;
        if (bubble.y - bubble.radius < 0 || bubble.y + bubble.radius > canvas.height) bubble.vy *= -1;

        bubble.x = Math.max(bubble.radius, Math.min(canvas.width - bubble.radius, bubble.x));
        bubble.y = Math.max(bubble.radius, Math.min(canvas.height - bubble.radius, bubble.y));
    });
}

function draw() {
    const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
    gradient.addColorStop(0, '#0f0f23');
    gradient.addColorStop(1, '#1a1a3a');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    bubbles.forEach(bubble => {
        ctx.save(); ctx.globalAlpha = 0.3; ctx.fillStyle = '#000';
        ctx.beginPath(); ctx.arc(bubble.x + 2, bubble.y + 2, bubble.radius, 0, Math.PI * 2); ctx.fill(); ctx.restore();

        const bubbleGradient = ctx.createRadialGradient(
            bubble.x - bubble.radius * 0.3, bubble.y - bubble.radius * 0.3, 0,
            bubble.x, bubble.y, bubble.radius
        );
        bubbleGradient.addColorStop(0, 'rgba(255, 255, 255, 0.8)');
        bubbleGradient.addColorStop(0.3, bubble.color + 'CC');
        bubbleGradient.addColorStop(1, bubble.color);

        ctx.fillStyle = bubbleGradient;
        ctx.beginPath(); ctx.arc(bubble.x, bubble.y, bubble.radius, 0, Math.PI * 2); ctx.fill();

        ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
        ctx.beginPath(); ctx.arc(bubble.x - bubble.radius * 0.3, bubble.y - bubble.radius * 0.3, bubble.radius * 0.3, 0, Math.PI * 2); ctx.fill();

        ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(bubble.x, bubble.y, bubble.radius, 0, Math.PI * 2); ctx.stroke();
    });
}

function updateStats() {
    elapsedTime = ((Date.now() - startTime) / 1000).toFixed(1);
    document.getElementById('timer').textContent = elapsedTime;
    document.getElementById('bubblesLeft').textContent = bubbles.length;
    document.getElementById('score').textContent = score;
}

function gameLoop() {
    if (!gameRunning) return;
    updateBubbles(); draw(); updateStats();
    animationId = requestAnimationFrame(gameLoop);
}

function gameOver() {
    gameRunning = false;
    cancelAnimationFrame(animationId);

    const timeBonus = Math.max(0, 1000 - Math.floor(elapsedTime * 10));
    const finalScore = score + timeBonus;

    document.getElementById('finalTime').textContent = elapsedTime;
    document.getElementById('finalScore').textContent = finalScore;
    document.getElementById('gameOver').style.display = 'block';
}

function saveScore() {
    const name = document.getElementById('playerName').value.trim();
    if (name) {
        const finalScore = score + Math.max(0, 1000 - Math.floor(elapsedTime * 10));
        const newScore = {
            name,
            score: finalScore,
            time: parseFloat(elapsedTime),
            date: new Date().toISOString()
        };
/*
        fetch(GOOGLE_SCRIPT_URL, {
            method: 'POST', mode: 'no-cors',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(newScore)
        }).then(() => {
            const localScores = JSON.parse(localStorage.getItem('bubblePopLeaderboard') || '[]');
            localScores.push(newScore);
            localScores.sort((a, b) => b.score - a.score);
            localStorage.setItem('bubblePopLeaderboard', JSON.stringify(localScores.slice(0, 10)));
            fetchLeaderboard();
        }).catch(error => {
            console.error('Failed to save score:', error);
        });
*/
        restartGame();
    }
}

function showLeaderboard() {
    document.getElementById('leaderboard').style.display = 'flex';
    fetchLeaderboard();
}
function hideLeaderboard() { document.getElementById('leaderboard').style.display = 'none'; }

function restartGame() {
    document.getElementById('gameOver').style.display = 'none';
    document.getElementById('gameCanvas').style.display = 'none';
    document.getElementById('gameStats').style.display = 'none';
    document.getElementById('gameBackBtn').style.display = 'none';
    document.getElementById('gameMenu').style.display = 'block';
    document.getElementById('playerName').value = '';
    hideLeaderboard();
}

// Fetch global leaderboard from Google Sheets
async function fetchLeaderboard() {
    try {
        const response = await fetch(GOOGLE_SCRIPT_URL);
        const data = await response.json();
        leaderboard = data.scores || [];
        updateLeaderboard();
    } catch (error) {
        console.error('Failed to fetch leaderboard:', error);
        leaderboard = JSON.parse(localStorage.getItem('bubblePopLeaderboard') || '[]');
        updateLeaderboard();
    }
}

// FIXED: brace/call structure
function updateLeaderboard() {
    const list = document.getElementById('leaderboardList');
    list.innerHTML = '';

    if (!leaderboard || leaderboard.length === 0) {
        list.innerHTML = '<div class="leaderboard-entry" style="text-align: center; color: #a5b4fc; font-style: italic;">No scores yet! Be the first to play!</div>';
        return;
    }

    leaderboard.slice(0, 10).forEach((entry, index) => {
        const div = document.createElement('div');
        div.className = 'leaderboard-entry';

        let trophy = '';
        if (index === 0) trophy = '🥇 ';
        else if (index === 1) trophy = '🥈 ';
        else if (index === 2) trophy = '🥉 ';
        else trophy = `${index + 1}. `;

        const dateLabel = entry.date
            ? new Date(entry.date).toLocaleDateString(undefined, {
                year: 'numeric', month: 'short', day: 'numeric'
              })
            : '';

        div.innerHTML = `
            <span>${trophy}${entry.name}</span>
            <span style="display: flex; flex-direction: column; align-items: flex-end;">
                <span style="font-weight: bold;">${entry.score} pts</span>
                <span style="font-size: 0.8rem; opacity: 0.7;">${dateLabel}</span>
            </span>
        `;
        list.appendChild(div);
    });
}
