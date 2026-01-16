import { initGameTimeTracking, updateStatsDisplay } from './gameStats.mjs';
import { generateGameLinks } from './generateGames.mjs';
import { initInputHandler } from './inputHandler.mjs';
import { initThemeSwitcher } from './themes.mjs';
import {logVisit} from './visitsCounter.mjs';


window.onload = function () {
    generateGameLinks();
    initThemeSwitcher();
    initGameTimeTracking();
    updateStatsDisplay();
    initInputHandler();
    logVisit();
};

