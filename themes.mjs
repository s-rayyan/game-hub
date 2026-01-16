export function initThemeSwitcher() {
    const $themeToggle = $('#theme-toggle');

    // Load saved theme or default
    const savedTheme = localStorage.getItem('gameHubTheme') || 'scifi';
    applyTheme(savedTheme);

    $themeToggle.on('click', () => {
        const currentTheme = localStorage.getItem('gameHubTheme') || 'scifi';
        let newTheme;

        switch (currentTheme) {
            case 'scifi': newTheme = 'minimal'; break;
            case 'minimal': newTheme = 'classic'; break;
            case 'classic': newTheme = 'glass'; break;
            case 'glass': newTheme = 'scifi'; break;
            default: newTheme = 'scifi';
        }

        applyTheme(newTheme);
        localStorage.setItem('gameHubTheme', newTheme);
    });
}

function applyTheme(theme) {
    const $themeStylesheet = $('#theme-stylesheet');
    const $themeToggle = $('#theme-toggle');

    const themeConfig = {
        classic: { href: 'dashstyle-classic.css', label: 'Classic', title: 'Switch Theme' },
        scifi: { href: 'dashstyle-scifi.css', label: 'Sci-Fi', title: 'Switch Theme' },
        minimal: { href: 'dashstyle-minimal.css', label: 'Minimal', title: 'Switch Theme' },
        glass: { href: 'dashstyle-glassy.css', label: 'Glass', title: 'Switch Theme' }
    };

    const config = themeConfig[theme] || themeConfig.scifi;
    $themeStylesheet.attr('href', config.href);
    $themeToggle.text(config.label).attr('title', config.title);
}
