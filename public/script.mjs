import { initGameTimeTracking, updateStatsDisplay } from './gameStats.mjs';
import { generateGameLinks } from './generateGames.mjs';
import { initInputHandler } from './inputHandler.mjs';
import { initThemeSwitcher, applyTheme } from './themes.mjs';
import { initAccount } from './userData.mjs';
import {logVisit} from './visitsCounter.mjs';


window.onload = function () {
    generateGameLinks();
    initThemeSwitcher();
    initGameTimeTracking();
    updateStatsDisplay();
    initInputHandler();
    initAccount();
    logVisit();
};

// Cloud sync just pulled newer data from the user's account: refresh whatever the hub shows from it.
window.addEventListener('gamehub:sync-applied', (e) => {
    const keys = e.detail.keys;
    if (keys.includes('favorites')) generateGameLinks(false);
    if (keys.includes('gameHubTheme')) applyTheme(localStorage.getItem('gameHubTheme') || 'scifi');
    if (keys.includes('gameStats')) updateStatsDisplay();
});
