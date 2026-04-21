/**
 * Скрипт страницы настроек управляет формой конфигурации и live-preview интерфейса.
 */
document.addEventListener('DOMContentLoaded', async function () {
    const pageTitle = document.getElementById('settings-page-title');
    const pageDescription = document.getElementById('settings-page-description');
    const form = document.getElementById('settings-form');
    const folderInput = document.getElementById('settings-download-folder');
    const coverSelect = document.getElementById('settings-cover-resolution');
    const audioSelect = document.getElementById('settings-audio-quality');
    const downlodadCount = document.getElementById('settings-download-count');
    const savehistory = document.getElementById('settings-save-history');
    const numberingCheckbox = document.getElementById('settings-numbering-tracks');
    const trackExample = document.getElementById('settings-track-example');
    const themeSelect = document.getElementById('settings-theme-select');
    const saveStatus = document.getElementById('settings-save-status');
    const templateVariables = document.getElementById('settings-template-variables');
    const settingsKey = APP_CONFIG.storageKeys.settings;
    const themeMedia = window.matchMedia('(prefers-color-scheme: dark)');

    document.title = `${APP_CONFIG.appTitle} - ${APP_CONFIG.uiText.optionsTitle}`;
    pageTitle.textContent = APP_CONFIG.uiText.optionsTitle;
    pageDescription.textContent = APP_CONFIG.uiText.optionsSubtitle;

    /**
     * Показывает пример имени файла с учётом нумерации треков.
     * @returns {void}
     */
    const updateExample = () => {
        trackExample.textContent = numberingCheckbox.checked ? '01. music_name.mp3' : 'music_name.mp3';
    };

    /**
     * Применяет выбранную тему к странице настроек.
     * @param {'auto'|'light'|'dark'} theme Выбранная тема.
     * @returns {void}
     */
    const applyTheme = (theme) => {
        const resolvedTheme = theme === 'auto'
            ? (themeMedia.matches ? 'dark' : 'light')
            : theme;
        document.documentElement.setAttribute('data-bs-theme', resolvedTheme);
    };

    /**
     * Отрисовывает список доступных шаблонных переменных для пути загрузки.
     * @returns {void}
     */
    const renderTemplateVariables = () => {
        templateVariables.innerHTML = APP_CONFIG.templateVariables
            .map(({token, label}) => `<div><code>${token}</code> ${label}</div>`)
            .join('');
    };

    renderTemplateVariables();

    const data = await chrome.storage.local.get(settingsKey);
    const settings = normalizeSettings(data[settingsKey]);

    folderInput.value = settings.downloadFolder;
    coverSelect.value = String(settings.coverQuality);
    audioSelect.value = settings.audioQuality;
    downlodadCount.value = String(settings.downlodadCount);
    savehistory.value = settings.savehistory;
    numberingCheckbox.checked = settings.numberingTracks;
    themeSelect.value = settings.theme;
    updateExample();
    applyTheme(settings.theme);

    numberingCheckbox.addEventListener('change', updateExample);
    themeSelect.addEventListener('change', () => applyTheme(themeSelect.value));
    themeMedia.addEventListener('change', () => {
        if (themeSelect.value === 'auto') {
            applyTheme('auto');
        }
    });

    form.addEventListener('submit', async function (e) {
        e.preventDefault();

        const settingsSubmit = normalizeSettings({
            downloadFolder: folderInput.value.trim() || APP_CONFIG.defaults.downloadFolder,
            coverQuality: coverSelect.value,
            audioQuality: audioSelect.value,
            downlodadCount: downlodadCount.value,
            savehistory: savehistory.value,
            theme: themeSelect.value,
            numberingTracks: numberingCheckbox.checked
        });

        await chrome.storage.local.set({[settingsKey]: settingsSubmit});
        saveStatus.textContent = APP_CONFIG.uiText.optionsSaveSuccess;
        console.log('Настройки сохранены!', settingsSubmit);

        window.setTimeout(() => {
            if (saveStatus.textContent === APP_CONFIG.uiText.optionsSaveSuccess) {
                saveStatus.textContent = '';
            }
        }, 2500);
    });
});
