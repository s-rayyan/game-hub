export function initGameTimeTracking() {
    $(window).on('beforeunload', () => {
        const lastClick = JSON.parse(sessionStorage.getItem('lastGameClick'));
        if (lastClick) {
            const minutesPlayed = (Date.now() - lastClick.startTime) / 1000 / 60;
            addMinutesToStorage(lastClick.game, minutesPlayed);
            sessionStorage.removeItem('lastGameClick');
        }
    });

    $(document).on('visibilitychange', () => {
        if (document.hidden) return;

        const lastClick = JSON.parse(sessionStorage.getItem('lastGameClick'));
        if (lastClick && Date.now() - lastClick.startTime > 5000) {
            const minutesPlayed = (Date.now() - lastClick.startTime) / 1000 / 60;
            addMinutesToStorage(lastClick.game, minutesPlayed);
            sessionStorage.setItem('lastGameClick', JSON.stringify({
                game: lastClick.game,
                startTime: Date.now()
            }));
        }
    });
}

export function trackGameClick(gameName) {
    const currentTime = Date.now();
    sessionStorage.setItem('lastGameClick', JSON.stringify({
        game: gameName,
        startTime: currentTime
    }));
}

export function addMinutesToStorage(gameName, minutes) {
    const stats = JSON.parse(localStorage.getItem('gameStats')) || {};
    stats[gameName] = (stats[gameName] || 0) + minutes;
    stats.totalMinutes = (stats.totalMinutes || 0) + minutes;
    localStorage.setItem('gameStats', JSON.stringify(stats));
    console.log(`Tracked ${minutes.toFixed(1)} minutes for ${gameName}. Total: ${stats[gameName].toFixed(1)}m`);
}

export function getGameStats() {
    return JSON.parse(localStorage.getItem('gameStats')) || {};
}

export function formatMinutes(minutes) {
    const hours = Math.floor(minutes / 60);
    const mins = Math.floor(minutes % 60);
    return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
}

export function updateStatsDisplay() {
    const stats = getGameStats();
    const $statsBox = $('#stats-box');
    const $totalTimeEl = $('#total-time');
    const $recentGamesEl = $('#recent-games');

    const totalMinutes = stats.totalMinutes || 0;

    if (totalMinutes === 0) {
        $statsBox.addClass('hidden');
        return;
    }

    $statsBox.removeClass('hidden');
    $totalTimeEl.text(formatMinutes(totalMinutes));

    const gameStats = Object.entries(stats)
        .filter(([key]) => key !== 'totalMinutes')
        .sort(([, a], [, b]) => b - a)
        .slice(0, 3);

    $recentGamesEl.html(
        gameStats.map(([game, minutes]) =>
            `<div class="game-stat">${game}: <span>${formatMinutes(minutes)}</span></div>`
        ).join('')
    );
}
