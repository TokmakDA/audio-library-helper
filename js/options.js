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
    const changelogTitle = document.getElementById('settings-changelog-title');
    const changelogRoot = document.getElementById('settings-changelog');
    const settingsKey = APP_CONFIG.storageKeys.settings;
    const themeMedia = window.matchMedia('(prefers-color-scheme: dark)');

    document.title = `${APP_CONFIG.appTitle} - ${APP_CONFIG.uiText.optionsTitle}`;
    pageTitle.textContent = APP_CONFIG.uiText.optionsTitle;
    pageDescription.textContent = APP_CONFIG.uiText.optionsSubtitle;
    changelogTitle.textContent = APP_CONFIG.uiText.optionsChangelogTitle;

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

    /**
     * Рисует историю изменений из внешнего JSON-файла.
     * @param {Array<{version:string,title?:string,summary?:string,changes?:string[]}>} releases Список релизов.
     * @returns {void}
     */
    const renderChangelog = (releases) => {
        changelogRoot.replaceChildren();

        if (!Array.isArray(releases) || releases.length === 0) {
            const emptyNode = document.createElement('div');
            emptyNode.className = 'release-notes-empty';
            emptyNode.textContent = 'Список изменений пока пуст.';
            changelogRoot.appendChild(emptyNode);
            return;
        }

        releases.forEach((release) => {
            const card = document.createElement('article');
            const title = document.createElement('h3');
            const summary = document.createElement('p');
            const list = document.createElement('ul');

            card.className = 'release-note-card';
            title.textContent = release.title || release.version || 'Без версии';
            card.appendChild(title);

            if (release.summary) {
                summary.textContent = release.summary;
                card.appendChild(summary);
            }

            (release.changes || []).forEach((item) => {
                const listItem = document.createElement('li');
                listItem.textContent = item;
                list.appendChild(listItem);
            });

            if (list.children.length > 0) {
                card.appendChild(list);
            }

            changelogRoot.appendChild(card);
        });
    };

    /**
     * Загружает changelog из расширения.
     * @returns {Promise<void>}
     */
    const loadChangelog = async () => {
        try {
            const response = await fetch(chrome.runtime.getURL('data/changelog.json'));
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const releases = await response.json();
            renderChangelog(releases);
        } catch (error) {
            console.error('Не удалось загрузить changelog:', error);
            renderChangelog([]);
        }
    };

    renderTemplateVariables();
    await loadChangelog();

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
